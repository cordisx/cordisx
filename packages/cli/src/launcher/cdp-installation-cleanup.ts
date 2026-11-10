import type { DocumentInstallationState } from './cdp-installation-bootstrap.js'
import {
  RENDERER_DISPOSE_EXPRESSION,
  restoreViteLoopbackPermission,
  VITE_DISPOSE_EXPRESSION,
  type ViteLoopbackPermissionCoordinator,
} from './cdp-installation-support.js'
import {
  CDP_REQUEST_TIMEOUT_MS,
  CdpConnectionClosedError,
  type CdpSession,
  type CdpTarget,
  evaluateRuntimeOperation,
} from './cdp-session.js'

/** Published only after the retired document's Host resources and browser permission lease are released. */
export class CdpInstallationTargetRetiredError extends Error {
  constructor(readonly target: CdpTarget, cause: CdpConnectionClosedError) {
    super('CordisX native target retired during renderer installation', { cause })
    this.name = 'CdpInstallationTargetRetiredError'
  }
}

interface FailedInstallation {
  readonly error: unknown
  readonly session: CdpSession
  readonly target: CdpTarget
  readonly document: DocumentInstallationState
  readonly disposeHost: () => Promise<void>
  readonly nativeChannel?: { dispose(): Promise<void> }
  readonly viteDevelopment: boolean
  readonly loopbackModules: boolean
  readonly permission?: { readonly name: string; readonly origin: string }
  readonly permissions?: ViteLoopbackPermissionCoordinator
  readonly timeoutMs: number
  readonly confirmRetirement?: () => Promise<void>
}

/** Renderer retirement removes document authority, but cannot remove browser-scoped permission grants. */
export async function failInstallation(input: FailedInstallation): Promise<never> {
  const { session, document, error } = input
  if (error instanceof CdpConnectionClosedError) await input.confirmRetirement?.()
  const strict = input.loopbackModules && !input.viteDevelopment
  const failures: unknown[] = []
  const attempt = async (operation: Promise<unknown>, hostResource = false): Promise<boolean> => {
    try {
      await operation
      return true
    } catch (failure) {
      if (strict || hostResource) failures.push(failure)
      return false
    }
  }
  const documentOperation = async (operation: () => Promise<unknown>): Promise<boolean> => {
    if (session.isTargetClosed()) return true
    try {
      await operation()
      return true
    } catch (failure) {
      if (session.isTargetClosed() && failure instanceof CdpConnectionClosedError) return true
      if (strict) failures.push(failure)
      return false
    }
  }
  try {
    await attempt(input.disposeHost(), true)
    if (input.nativeChannel !== undefined) await attempt(input.nativeChannel.dispose(), true)
    if (document.nativeInterception !== undefined) await attempt(document.nativeInterception.dispose(), true)
    const scriptRemoved = document.identifier === undefined
      || await documentOperation(async () =>
        await session.send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: document.identifier,
        })
      )
    if (input.viteDevelopment) {
      await documentOperation(async () =>
        await session.send('Runtime.evaluate', {
          expression: VITE_DISPOSE_EXPRESSION,
          awaitPromise: true,
          allowUnsafeEvalBlockedByCSP: true,
        })
      )
    } else if (input.loopbackModules) {
      await documentOperation(async () =>
        await evaluateRuntimeOperation(session, RENDERER_DISPOSE_EXPRESSION, input.timeoutMs)
      )
    }
    const cspRestored = !input.loopbackModules
      || await documentOperation(async () =>
        await session.send('Page.setBypassCSP', { enabled: false }, CDP_REQUEST_TIMEOUT_MS)
      )
    await attempt(
      input.permissions === undefined
        ? restoreViteLoopbackPermission(session, input.permission)
        : input.permissions.release(session, input.permission),
      true,
    )
    if (
      input.loopbackModules && !input.viteDevelopment && document.loopbackReloadStarted
      && scriptRemoved && cspRestored && !session.isTargetClosed()
    ) await documentOperation(async () => await session.send('Page.reload', {}, input.timeoutMs))
  } finally {
    session.close()
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [error, ...failures],
      `CordisX production renderer installation failed and cleanup was incomplete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  if (session.isTargetClosed() && error instanceof CdpConnectionClosedError) {
    throw new CdpInstallationTargetRetiredError(input.target, error)
  }
  throw error
}
