import { CdpCertifiedPermissionChannel } from './certified-permission-cdp.js'
import {
  abortable,
  cdpInstallationAborted,
  CdpSession,
  type CdpTarget,
  evaluateRuntimeOperation,
} from './cdp-session.js'
import { AGENT_HISTORY_BINDING, AGENT_HISTORY_RECEIVER } from './agent-history-rpc.js'
import { CHANNEL_ACTIONS_BINDING, CHANNEL_ACTIONS_RECEIVER } from './channel-actions-rpc.js'
import { CHANNEL_CREDENTIAL_BINDING, CHANNEL_CREDENTIAL_RECEIVER } from './channel-credential-rpc.js'
import { CONFIG_BINDING, CONFIG_RECEIVER } from './config-rpc.js'
import { ICON_THEME_PREFERENCE_BINDING, ICON_THEME_PREFERENCE_RECEIVER } from './icon-theme-rpc.js'
import { OWNER_DOCUMENT_BINDING, OWNER_DOCUMENT_RECEIVER } from './owner-document-rpc.js'
import { PERMISSION_BINDING, PERMISSION_RECEIVER } from './permission-rpc.js'
import { PLUGIN_LIFECYCLE_BINDING, PLUGIN_LIFECYCLE_RECEIVER } from './plugin-lifecycle-rpc.js'
import { PROVIDER_BINDING, PROVIDER_RECEIVER } from './provider-rpc.js'
import { PUBLISHER_GRANT_BINDING, PUBLISHER_GRANT_RECEIVER } from './publisher-grant-rpc.js'
import { SERVICE_CONFIG_BINDING, SERVICE_CONFIG_RECEIVER } from './service-config-rpc.js'

export type { ProviderFleet } from '../providers/fleet.js'
export type { CdpTarget } from './cdp-session.js'
export { CdpPluginLifecycleRuntime } from './cdp-plugin-lifecycle-runtime.js'
export type { CodexAgentHistoryHost } from './agent-history.js'
export {
  AGENT_HISTORY_BINDING,
  handleAgentHistoryBindingRequest,
  MAX_AGENT_HISTORY_REQUEST_BYTES,
  MAX_AGENT_HISTORY_REQUESTS,
  parseAgentHistoryBindingRequest,
} from './agent-history-rpc.js'
export { CHANNEL_ACTIONS_BINDING, type ChannelActionsBridgeHandler } from './channel-actions-rpc.js'
export {
  CHANNEL_CREDENTIAL_BINDING,
  type ChannelCredentialBridgeHandler,
  MAX_CHANNEL_CREDENTIAL_REQUEST_BYTES,
} from './channel-credential-rpc.js'
export {
  CONFIG_BINDING,
  configBridgeError,
  type ConfigBridgeHandler,
  MAX_CONFIG_REQUEST_BYTES,
  parseConfigBindingRequest,
} from './config-rpc.js'
export { isEntityBindingRequest } from './entity-rpc.js'
export {
  ICON_THEME_PREFERENCE_BINDING,
  iconThemePreferenceBridgeError,
  IconThemePreferenceBroadcastHub,
  type IconThemePreferencePersistenceContext,
  type IconThemePreferenceReadyResponseAck,
  MAX_ICON_THEME_PREFERENCE_REQUEST_BYTES,
  parseIconThemePreferenceBindingRequest,
  parseIconThemePreferenceDocumentReadyRequest,
  persistIconThemePreference,
} from './icon-theme-rpc.js'
export type { LauncherMarketplaceCertifiedAuthority } from './marketplace-certified-authority.js'
export { fetchMarketplaceFeed } from './marketplace.js'
export {
  MAX_OWNER_DOCUMENT_REQUEST_BYTES,
  MAX_OWNER_DOCUMENT_REQUESTS,
  OWNER_DOCUMENT_BINDING,
  ownerDocumentBridgeError,
  type OwnerDocumentBridgeHandler,
  parseOwnerDocumentBindingRequest,
} from './owner-document-rpc.js'
export {
  MAX_PERMISSION_REQUEST_BYTES,
  MAX_PERMISSION_REQUESTS,
  parsePermissionBindingRequest,
  PERMISSION_BINDING,
  type PermissionPersistenceContext,
  persistPermissionPolicies,
} from './permission-rpc.js'
export {
  handlePluginLifecycleBindingRequest,
  MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES,
  parsePluginLifecycleBindingRequest,
  PLUGIN_LIFECYCLE_BINDING,
  type PluginLifecycleBridgeHandler,
} from './plugin-lifecycle-rpc.js'
export { runPluginLifecycleRequestWithProjection } from './plugin-lifecycle-projection.js'
export {
  handleProviderBindingRequest,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_REQUESTS,
  parseProviderBindingRequest,
  PROVIDER_BINDING,
} from './provider-rpc.js'
export {
  MAX_PUBLISHER_GRANT_REQUEST_BYTES,
  parsePublisherGrantBindingRequest,
  PUBLISHER_GRANT_BINDING,
  type PublisherGrantBridgeHandler,
} from './publisher-grant-rpc.js'
export { CdpLifecycleRequestGate, productionBootstrapSource } from './production-graph-admission.js'
export {
  MAX_SERVICE_CONFIG_REQUEST_BYTES,
  parseServiceConfigBindingRequest,
  SERVICE_CONFIG_BINDING,
  serviceConfigBridgeError,
  type ServiceConfigBridgeHandler,
} from './service-config-rpc.js'
export { CdpCertifiedPermissionChannel } from './certified-permission-cdp.js'
export {
  abortable,
  CdpInstallationAbortedError,
  CdpSession,
  evaluateRuntimeOperation,
  runtimeEvaluationException,
} from './cdp-session.js'

export const MARKETPLACE_BINDING = '__cordisxMarketplaceRequestV1'
export const MARKETPLACE_RECEIVER = '__cordisxMarketplaceReceiveV1'
export const MAX_MARKETPLACE_REQUESTS = 4
const DEFAULT_CDP_INJECTION_TIMEOUT_MS = 60_000
const MIN_CDP_INJECTION_TIMEOUT_MS = 5_000
const MAX_CDP_INJECTION_TIMEOUT_MS = 600_000
const MAX_RENDERER_DIAGNOSTIC_BYTES = 8_192

export function resolveCdpInjectionTimeoutMs(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_CDP_INJECTION_TIMEOUT_MS
  if (!/^\d+$/u.test(value)) {
    throw new Error('CORDISX_CDP_INJECTION_TIMEOUT_MS must be an integer number of milliseconds')
  }
  const timeoutMs = Number(value)
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_CDP_INJECTION_TIMEOUT_MS
    || timeoutMs > MAX_CDP_INJECTION_TIMEOUT_MS
  ) {
    throw new Error(
      `CORDISX_CDP_INJECTION_TIMEOUT_MS must be between ${MIN_CDP_INJECTION_TIMEOUT_MS} and ${MAX_CDP_INJECTION_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}

export const CDP_INJECTION_TIMEOUT_MS = resolveCdpInjectionTimeoutMs(process.env.CORDISX_CDP_INJECTION_TIMEOUT_MS)
export const VITE_DISPOSE_EXPRESSION = `(async () => {
  try {
    try { await globalThis.__cordisxViteClient?.dispose(); }
    finally { globalThis.__cordisxSharedReactRuntime?.dispose(); }
  } finally {
    try { await globalThis.__cordisxViteHmrDispose?.(); }
    finally {
      delete globalThis.__cordisxViteClient;
      delete globalThis.__cordisxSharedReactRuntime;
      delete globalThis.__cordisxViteBoot;
      delete globalThis.__cordisxViteInstallId;
      delete globalThis.__cordisxViteHmrDispose;
    }
  }
})()`
export const RENDERER_DISPOSE_EXPRESSION = `(async () => {
  const errors = []
  try {
    await globalThis.__cordisxRuntime?.dispose?.()
  } catch (error) {
    errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  try {
    globalThis.__cordisxPluginGenerationResourcesV1?.dispose?.()
  } catch (error) {
    errors.push(error instanceof Error ? error.stack ?? error.message : String(error))
  }
  delete globalThis.__cordisxProductionBootstrapState
  delete globalThis.__cordisxProductionInstallId
  return errors.length === 0
    ? { ok: true }
    : { ok: false, error: errors.join('\\n') }
})()`

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', finish, { once: true })
    if (signal?.aborted === true) finish()
  })
}

export interface InstalledScript {
  readonly viteDevelopment?: boolean
  readonly loopbackModules?: boolean
  readonly viteLoopbackPermission?: {
    readonly name: string
    readonly origin: string
  }
  readonly target: CdpTarget
  readonly identifier: string
  /** Exact bootstrap registered for a future document; retained for compensating a failed promotion. */
  readonly documentSource: string
  readonly session: CdpSession
  readonly marketplaceController: AbortController
  readonly removeBindingListener: () => void
  readonly providerController?: AbortController
  readonly removeProviderBindingListener?: () => void
  readonly providerBindingInstalled: boolean
  readonly historyController?: AbortController
  readonly removeHistoryBindingListener?: () => void
  readonly historyBindingInstalled: boolean
  readonly configController?: AbortController
  readonly removeConfigBindingListener?: () => void
  readonly configBindingInstalled: boolean
  readonly ownerDocumentController?: AbortController
  readonly removeOwnerDocumentBindingListener?: () => void
  readonly ownerDocumentBindingInstalled: boolean
  readonly serviceConfigController?: AbortController
  readonly removeServiceConfigBindingListener?: () => void
  readonly serviceConfigBindingInstalled: boolean
  readonly credentialController?: AbortController
  readonly removeCredentialBindingListener?: () => void
  readonly credentialBindingInstalled: boolean
  readonly actionsController?: AbortController
  readonly removeActionsBindingListener?: () => void
  readonly actionsBindingInstalled: boolean
  readonly permissionController?: AbortController
  readonly removePermissionBindingListener?: () => void
  readonly permissionBindingInstalled: boolean
  readonly iconThemePreferenceController?: AbortController
  readonly removeIconThemePreferenceBindingListener?: () => void
  readonly iconThemePreferenceBindingInstalled: boolean
  readonly unregisterIconThemePreferenceBroadcast?: () => void
  readonly lifecycleController?: AbortController
  readonly removeLifecycleBindingListener?: () => void
  readonly lifecycleBindingInstalled: boolean
  readonly unregisterLifecycleSession: () => void
  readonly publisherGrantController?: AbortController
  readonly removePublisherGrantBindingListener?: () => void
  readonly publisherGrantBindingInstalled: boolean
  readonly certifiedPermissionChannel?: CdpCertifiedPermissionChannel
}

const VITE_LOOPBACK_PERMISSIONS = ['loopback-network', 'local-network-access'] as const

function targetOrigin(target: CdpTarget): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/iu.exec(target.url)
  if (match === null) throw new Error(`target ${target.id} has no permission origin`)
  return match[0]
}

export async function enableViteLoopbackPermission(
  session: CdpSession,
  target: CdpTarget,
): Promise<{ readonly name: string; readonly origin: string } | undefined> {
  const origin = targetOrigin(target)
  const failures: string[] = []
  for (const name of VITE_LOOPBACK_PERMISSIONS) {
    try {
      await session.send('Browser.setPermission', {
        permission: { name },
        setting: 'granted',
        origin,
        embeddedOrigin: origin,
      })
      return { name, origin }
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const version: Record<string, unknown> = await session.send('Browser.getVersion').catch(() => ({}))
  const product = typeof version.product === 'string' ? version.product : ''
  const major = Number(/\/(\d+)/u.exec(product)?.[1])
  if (Number.isFinite(major) && major < 142) return undefined
  throw new Error(`CordisX could not grant renderer loopback access (${failures.join('; ')})`)
}

export async function restoreViteLoopbackPermission(
  session: CdpSession,
  permission: { readonly name: string; readonly origin: string } | undefined,
): Promise<void> {
  if (permission === undefined) return
  await session.send('Browser.setPermission', {
    permission: { name: permission.name },
    setting: 'prompt',
    origin: permission.origin,
    embeddedOrigin: permission.origin,
  })
}

async function connectBrowserCdpSession(port: number): Promise<CdpSession> {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`CDP browser version returned HTTP ${response.status}`)
  const value = await response.json() as { readonly webSocketDebuggerUrl?: unknown }
  if (typeof value.webSocketDebuggerUrl !== 'string') throw new Error('CDP browser endpoint is unavailable')
  return await CdpSession.connect(value.webSocketDebuggerUrl)
}

export class ViteLoopbackPermissionCoordinator {
  readonly #origins = new Map<string, {
    readonly permission: { readonly name: string; readonly origin: string }
    references: number
  }>()

  constructor(private readonly port: number) {}

  async acquire(
    session: CdpSession,
    target: CdpTarget,
  ): Promise<{ readonly name: string; readonly origin: string } | undefined> {
    const origin = targetOrigin(target)
    const current = this.#origins.get(origin)
    if (current !== undefined) {
      current.references += 1
      return current.permission
    }
    const permission = await enableViteLoopbackPermission(session, target)
    if (permission !== undefined) this.#origins.set(origin, { permission, references: 1 })
    return permission
  }

  async release(
    session: CdpSession,
    permission: { readonly name: string; readonly origin: string } | undefined,
  ): Promise<void> {
    if (permission === undefined) return
    const current = this.#origins.get(permission.origin)
    if (current === undefined) return
    if (current.references === 0) return
    current.references -= 1
    if (current.references > 0) return
    try {
      await restoreViteLoopbackPermission(session, current.permission)
    } catch (targetError) {
      let browser: CdpSession | undefined
      try {
        browser = await connectBrowserCdpSession(this.port)
        await restoreViteLoopbackPermission(browser, current.permission)
      } catch (browserError) {
        // Retain the zero-reference grant so a later live target can restore it.
        throw new AggregateError(
          [targetError, browserError],
          `CordisX could not restore Vite loopback permission for ${permission.origin}`,
        )
      } finally {
        browser?.close()
      }
    }
    this.#origins.delete(permission.origin)
  }
}

export async function waitForNativeDocumentReadiness(
  session: CdpSession,
  expectedUrl: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw cdpInstallationAborted()
    try {
      await abortable(
        evaluateRuntimeOperation(
          session,
          `(() => { try {
        const bridge = globalThis.electronBridge
        if (
          globalThis.location?.href !== ${JSON.stringify(expectedUrl)}
          || globalThis.document?.readyState !== 'complete'
          || globalThis.codexWindowType !== 'electron'
          || typeof bridge?.sendMessageFromView !== 'function'
          || typeof bridge?.getSentryInitOptions !== 'function'
        ) return { ok: false, error: 'cordisx:native-document-pending' }
        return { ok: true }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      )
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const transient = lastError.message === 'cordisx:native-document-pending'
        || /Execution context was destroyed|Cannot find context|Inspected target navigated|CDP request timed out: Runtime\.evaluate/i
          .test(lastError.message)
      if (!transient || session.isClosed()) throw lastError
      await delay(100, signal)
    }
  }
  throw new Error(
    `CordisX native document readiness timed out${lastError === undefined ? '' : `: ${lastError.message}`}`,
  )
}

export async function waitForViteBootstrap(
  session: CdpSession,
  installId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw cdpInstallationAborted()
    try {
      await abortable(
        evaluateRuntimeOperation(
          session,
          `(async () => { try {
        if (globalThis.__cordisxViteInstallId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'cordisx:vite-boot-pending' }
        if (!globalThis.__cordisxViteBoot) return { ok: false, error: 'cordisx:vite-boot-pending' }
        await globalThis.__cordisxViteBoot
        return { ok: globalThis.__cordisxRuntime !== undefined }
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      )
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const transient = lastError.message === 'cordisx:vite-boot-pending'
        || /Execution context was destroyed|Cannot find context|Inspected target navigated|CDP request timed out: Runtime\.evaluate/i
          .test(lastError.message)
      if (!transient || session.isClosed()) throw lastError
      await delay(100, signal)
    }
  }
  throw new Error(`CordisX Vite bootstrap timed out${lastError === undefined ? '' : `: ${lastError.message}`}`)
}

export async function reloadAndWaitForBootstrap(
  session: CdpSession,
  params: Record<string, unknown>,
  waitForBootstrap: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await abortable(session.send('Page.reload', params), signal)
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    if (failure.message !== 'CDP request timed out: Page.reload' || session.isClosed()) throw failure
  }
  await waitForBootstrap()
}

export async function waitForProductionBootstrap(
  session: CdpSession,
  installId: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<void> {
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (signal?.aborted === true) throw cdpInstallationAborted()
    try {
      await abortable(
        evaluateRuntimeOperation(
          session,
          `(async () => { try {
        if (globalThis.__cordisxProductionInstallId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'cordisx:production-boot-pending' }
        const state = globalThis.__cordisxProductionBootstrapState
        if (state?.installId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'CordisX production bootstrap state does not match its install marker' }
        if (state.status === 'failed') return { ok: false, error: state.error }
        if (state.status !== 'evaluated') return { ok: false, error: 'cordisx:production-boot-pending' }
        const boot = globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot
        if (!boot) return { ok: false, error: 'CordisX production bootstrap defined no boot promise' }
        await boot
        if (globalThis.__cordisxProductionInstallId !== ${
            JSON.stringify(installId)
          }) return { ok: false, error: 'CordisX production bootstrap was superseded during boot' }
        if (globalThis.__cordisxRuntime === undefined) {
          return { ok: false, error: 'CordisX production runtime is undefined after boot' }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      } })()`,
          Math.max(1, deadline - Date.now()),
        ),
        signal,
      )
      return
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      const transient = lastError.message === 'cordisx:production-boot-pending'
        || /Execution context was destroyed|Cannot find context|Inspected target navigated|CDP request timed out: Runtime\.evaluate/i
          .test(lastError.message)
      if (!transient || session.isClosed()) throw lastError
      await delay(100, signal)
    }
  }
  throw new Error(`CordisX production bootstrap timed out${lastError === undefined ? '' : `: ${lastError.message}`}`)
}

export function installedBindingNames(installed: InstalledScript): readonly string[] {
  return [
    MARKETPLACE_BINDING,
    ...(installed.providerBindingInstalled ? [PROVIDER_BINDING] : []),
    ...(installed.historyBindingInstalled ? [AGENT_HISTORY_BINDING] : []),
    ...(installed.configBindingInstalled ? [CONFIG_BINDING] : []),
    ...(installed.ownerDocumentBindingInstalled ? [OWNER_DOCUMENT_BINDING] : []),
    ...(installed.serviceConfigBindingInstalled ? [SERVICE_CONFIG_BINDING] : []),
    ...(installed.credentialBindingInstalled ? [CHANNEL_CREDENTIAL_BINDING] : []),
    ...(installed.actionsBindingInstalled ? [CHANNEL_ACTIONS_BINDING] : []),
    ...(installed.permissionBindingInstalled ? [PERMISSION_BINDING] : []),
    ...(installed.iconThemePreferenceBindingInstalled ? [ICON_THEME_PREFERENCE_BINDING] : []),
    ...(installed.lifecycleBindingInstalled ? [PLUGIN_LIFECYCLE_BINDING] : []),
    ...(installed.publisherGrantBindingInstalled ? [PUBLISHER_GRANT_BINDING] : []),
  ]
}

interface MarketplaceBindingRequest {
  readonly requestId: string
  readonly url: string
}

export function parseMarketplaceBindingRequest(value: unknown): MarketplaceBindingRequest {
  if (value === null || typeof value !== 'object') throw new Error('invalid marketplace bridge request')
  const requestId = (value as { requestId?: unknown }).requestId
  const url = (value as { url?: unknown }).url
  if (typeof requestId !== 'string' || !/^[a-z0-9-]{1,96}$/i.test(requestId)) {
    throw new Error('invalid marketplace bridge request id')
  }
  if (typeof url !== 'string' || url.length === 0 || url.length > 2048) {
    throw new Error('invalid marketplace bridge URL')
  }
  return { requestId, url }
}

export async function sendMarketplaceBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${MARKETPLACE_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendProviderBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PROVIDER_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendAgentHistoryBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${AGENT_HISTORY_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendConfigBindingResponse(session: CdpSession, payload: Record<string, unknown>): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${CONFIG_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendOwnerDocumentBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${OWNER_DOCUMENT_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendIconThemePreferenceBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
  executionContextId?: number,
): Promise<void> {
  const response = await session.send('Runtime.evaluate', {
    expression: `(() => {
      const receiver = globalThis.${ICON_THEME_PREFERENCE_RECEIVER}
      if (typeof receiver !== 'function') throw new Error('icon theme preference receiver is unavailable')
      receiver(${JSON.stringify(JSON.stringify(payload))})
      return true
    })()`,
    allowUnsafeEvalBlockedByCSP: true,
    returnByValue: true,
    ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
  })
  const remote = response.result
  if (remote === null || typeof remote !== 'object' || (remote as { value?: unknown }).value !== true) {
    throw new Error('icon theme preference response delivery failed')
  }
}

export function iconThemePreferenceDeliveryEvaluation(
  payload: Record<string, unknown>,
  documentEpoch: string,
  minimumRevision: number,
  executionContextId: number,
): Record<string, unknown> {
  return {
    expression: `(() => {
      const receiver = globalThis.${ICON_THEME_PREFERENCE_RECEIVER}
      if (typeof receiver !== 'function') throw new Error('icon theme preference receiver is unavailable')
      const ack = receiver(${JSON.stringify(JSON.stringify(payload))})
      if (ack === null || typeof ack !== 'object'
        || ack.documentEpoch !== ${JSON.stringify(documentEpoch)}
        || !Number.isSafeInteger(ack.currentRevision)
        || ack.currentRevision < ${minimumRevision}) {
        throw new Error('icon theme preference delivery acknowledgement is invalid')
      }
      return ack
    })()`,
    allowUnsafeEvalBlockedByCSP: true,
    returnByValue: true,
    contextId: executionContextId,
  }
}

export async function deliverIconThemePreferenceToDocument(
  session: CdpSession,
  payload: Record<string, unknown>,
  documentEpoch: string,
  minimumRevision: number,
  executionContextId: number,
  signal?: AbortSignal,
): Promise<{
  readonly documentEpoch: string
  readonly currentRevision: number
  readonly readyLeaseToken?: string
  readonly readyLeaseRevision?: number
}> {
  const evaluation = session.send(
    'Runtime.evaluate',
    iconThemePreferenceDeliveryEvaluation(
      payload,
      documentEpoch,
      minimumRevision,
      executionContextId,
    ),
  )
  let response
  if (signal === undefined) {
    response = await evaluation
  } else {
    let rejectCancelled!: (error: Error) => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject
    })
    const onAbort = (): void => rejectCancelled(new Error('icon theme preference document delivery was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      response = await Promise.race([evaluation, cancelled])
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
  const remote = response.result
  const value = remote !== null && typeof remote === 'object'
    ? (remote as { value?: unknown }).value
    : undefined
  if (value === null || typeof value !== 'object') throw new Error('icon theme preference delivery failed')
  const ack = value as {
    documentEpoch?: unknown
    currentRevision?: unknown
    readyLeaseToken?: unknown
    readyLeaseRevision?: unknown
  }
  if (
    ack.documentEpoch !== documentEpoch || !Number.isSafeInteger(ack.currentRevision)
    || (ack.currentRevision as number) < minimumRevision
  ) {
    throw new Error('icon theme preference delivery acknowledgement is invalid')
  }
  return {
    documentEpoch,
    currentRevision: ack.currentRevision as number,
    ...(typeof ack.readyLeaseToken === 'string' ? { readyLeaseToken: ack.readyLeaseToken } : {}),
    ...(Number.isSafeInteger(ack.readyLeaseRevision) ? { readyLeaseRevision: ack.readyLeaseRevision as number } : {}),
  }
}
export async function sendPublisherGrantBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PUBLISHER_GRANT_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export function serviceConfigResponseEvaluation(
  payload: Record<string, unknown>,
  executionContextId?: number,
): Record<string, unknown> {
  return {
    expression:
      `(() => { const receiver = globalThis.${SERVICE_CONFIG_RECEIVER}; if (typeof receiver !== 'function') return false; receiver(${
        JSON.stringify(JSON.stringify(payload))
      }); return true })()`,
    allowUnsafeEvalBlockedByCSP: true,
    returnByValue: true,
    ...(executionContextId === undefined ? {} : { contextId: executionContextId }),
  }
}

function serviceConfigResponseDelivered(result: Record<string, unknown>): boolean {
  const remote = result.result
  return remote !== null && typeof remote === 'object' && (remote as Record<string, unknown>).value === true
}

export async function sendServiceConfigBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
  executionContextId?: number,
): Promise<void> {
  const exact = await session.send('Runtime.evaluate', serviceConfigResponseEvaluation(payload, executionContextId))
  if (serviceConfigResponseDelivered(exact) || executionContextId === undefined) return
  await session.send('Runtime.evaluate', serviceConfigResponseEvaluation(payload))
}

export async function sendChannelCredentialBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${CHANNEL_CREDENTIAL_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendChannelActionsBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${CHANNEL_ACTIONS_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendPermissionBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PERMISSION_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function sendPluginLifecycleBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${PLUGIN_LIFECYCLE_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export async function uninstall(
  installed: InstalledScript,
  viteLoopbackPermissions?: ViteLoopbackPermissionCoordinator,
): Promise<void> {
  installed.marketplaceController.abort()
  installed.providerController?.abort()
  installed.historyController?.abort()
  installed.configController?.abort()
  installed.ownerDocumentController?.abort()
  installed.serviceConfigController?.abort()
  installed.credentialController?.abort()
  installed.actionsController?.abort()
  installed.permissionController?.abort()
  installed.iconThemePreferenceController?.abort()
  installed.lifecycleController?.abort()
  installed.publisherGrantController?.abort()
  installed.removeBindingListener()
  installed.removeProviderBindingListener?.()
  installed.removeHistoryBindingListener?.()
  installed.removeConfigBindingListener?.()
  installed.removeOwnerDocumentBindingListener?.()
  installed.removeServiceConfigBindingListener?.()
  installed.removeCredentialBindingListener?.()
  installed.removeActionsBindingListener?.()
  installed.removePermissionBindingListener?.()
  installed.removeIconThemePreferenceBindingListener?.()
  installed.unregisterIconThemePreferenceBroadcast?.()
  installed.removeLifecycleBindingListener?.()
  installed.unregisterLifecycleSession()
  installed.removePublisherGrantBindingListener?.()
  await installed.certifiedPermissionChannel?.dispose()
  try {
    const strictProductionCleanup = installed.loopbackModules === true && installed.viteDevelopment !== true
    const cleanupFailures: unknown[] = []
    const attemptCleanup = async (operation: Promise<unknown>): Promise<boolean> => {
      try {
        await operation
        return true
      } catch (error) {
        if (strictProductionCleanup) cleanupFailures.push(error)
        return false
      }
    }
    if (installed.viteDevelopment) {
      await attemptCleanup(installed.session.send('Runtime.evaluate', {
        expression: VITE_DISPOSE_EXPRESSION,
        awaitPromise: true,
        allowUnsafeEvalBlockedByCSP: true,
      }))
    }
    const rendererCleanup = await Promise.allSettled([
      installed.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed.identifier }),
      evaluateRuntimeOperation(installed.session, RENDERER_DISPOSE_EXPRESSION, CDP_INJECTION_TIMEOUT_MS),
      installed.session.send('Runtime.removeBinding', { name: MARKETPLACE_BINDING }),
      ...(installed.providerBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PROVIDER_BINDING })]
        : []),
      ...(installed.historyBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: AGENT_HISTORY_BINDING })]
        : []),
      ...(installed.configBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: CONFIG_BINDING })]
        : []),
      ...(installed.ownerDocumentBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: OWNER_DOCUMENT_BINDING })]
        : []),
      ...(installed.serviceConfigBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: SERVICE_CONFIG_BINDING })]
        : []),
      ...(installed.credentialBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: CHANNEL_CREDENTIAL_BINDING })]
        : []),
      ...(installed.actionsBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: CHANNEL_ACTIONS_BINDING })]
        : []),
      ...(installed.permissionBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PERMISSION_BINDING })]
        : []),
      ...(installed.iconThemePreferenceBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: ICON_THEME_PREFERENCE_BINDING })]
        : []),
      ...(installed.lifecycleBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PLUGIN_LIFECYCLE_BINDING })]
        : []),
      ...(installed.publisherGrantBindingInstalled
        ? [installed.session.send('Runtime.removeBinding', { name: PUBLISHER_GRANT_BINDING })]
        : []),
    ])
    const rendererGone = installed.session.isClosed()
    if (strictProductionCleanup && !rendererGone) {
      cleanupFailures.push(
        ...rendererCleanup.flatMap(result => result.status === 'rejected' ? [result.reason] : []),
      )
    }
    const scriptRemoved = rendererGone || rendererCleanup[0]?.status === 'fulfilled'
    if (installed.loopbackModules) {
      const cspRestored = rendererGone
        || await attemptCleanup(installed.session.send('Page.setBypassCSP', { enabled: false }))
      if (viteLoopbackPermissions === undefined) {
        await attemptCleanup(restoreViteLoopbackPermission(installed.session, installed.viteLoopbackPermission))
      } else {
        await attemptCleanup(viteLoopbackPermissions.release(installed.session, installed.viteLoopbackPermission))
      }
      if (!rendererGone && !installed.viteDevelopment && scriptRemoved && cspRestored) {
        await attemptCleanup(installed.session.send('Page.reload', {}, CDP_INJECTION_TIMEOUT_MS))
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'CordisX production renderer cleanup was incomplete')
    }
  } finally {
    installed.session.close()
  }
}
