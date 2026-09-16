import { randomUUID } from 'node:crypto'
import { waitForInitialDocument } from './cdp-document-ready.js'
import * as support from './cdp-installation-support.js'
import type { NativeSubmissionInstallation } from './native-submission-composition.js'
import {
  installNativeResourceInterception,
  type NativeResourceInterception,
} from './native-predispatch-interception.js'

interface RendererBootstrapOptions {
  readonly session: support.CdpSession
  readonly target: support.CdpTarget
  readonly installId: string
  readonly viteDevelopment: boolean
  readonly nativeSubmission?: NativeSubmissionInstallation
  readonly signal?: AbortSignal
}

export interface InstallDocumentBootstrapOptions {
  readonly session: support.CdpSession
  readonly target: support.CdpTarget
  readonly documentSource: string
  readonly evaluationSource: string
  readonly viteDevelopment: boolean
  readonly loopbackModules: boolean
  readonly nativeSubmission?: NativeSubmissionInstallation
  readonly signal?: AbortSignal
}

export interface DocumentInstallationState {
  identifier: string | undefined
  loopbackReloadStarted: boolean
  nativeInterception: NativeResourceInterception | undefined
}

export function createDocumentInstallationState(): DocumentInstallationState {
  return { identifier: undefined, loopbackReloadStarted: false, nativeInterception: undefined }
}

async function waitForRendererBootstrap(
  options: RendererBootstrapOptions,
  deadline: number,
): Promise<void> {
  const { session, installId, viteDevelopment, signal } = options
  if (viteDevelopment) await support.waitForViteBootstrap(session, installId, deadline, signal)
  else await support.waitForProductionBootstrap(session, installId, deadline, signal)
}

async function bootstrapInstalledDocument(
  options: RendererBootstrapOptions,
): Promise<NativeResourceInterception | undefined> {
  const { session, target, nativeSubmission, signal } = options
  const deadline = Date.now() + support.CDP_INJECTION_TIMEOUT_MS
  await support.abortable(waitForInitialDocument(session, support.CDP_INJECTION_TIMEOUT_MS, signal), signal)
  let nativeInterception: NativeResourceInterception | undefined
  if (nativeSubmission !== undefined) {
    nativeInterception = await installNativeResourceInterception({
      session,
      target,
      transforms: nativeSubmission.transforms,
      reloadDocument: async () => {
        await support.abortable(
          session.send('Page.reload', { ignoreCache: true }, support.CDP_INJECTION_TIMEOUT_MS),
          signal,
        )
      },
      timeoutMs: support.CDP_INJECTION_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    })
    if (nativeInterception.status !== 'active') {
      throw new Error(`Native submission interception unavailable: ${JSON.stringify(nativeInterception.evidence)}`)
    }
    await waitForRendererBootstrap(options, deadline)
  } else {
    await support.reloadAndWaitForBootstrap(
      session,
      options.viteDevelopment ? { ignoreCache: true } : {},
      async () => await waitForRendererBootstrap(options, deadline),
    )
  }
  return nativeInterception
}

export async function installDocumentBootstrap(
  options: InstallDocumentBootstrapOptions,
  state: DocumentInstallationState,
): Promise<void> {
  const {
    session,
    target,
    documentSource,
    evaluationSource,
    viteDevelopment,
    loopbackModules,
    nativeSubmission,
    signal,
  } = options
  const reloadInstallId = viteDevelopment || loopbackModules ? randomUUID() : undefined
  const productionDocumentSource = reloadInstallId === undefined || viteDevelopment
    ? undefined
    : support.productionBootstrapSource(documentSource, reloadInstallId)
  const added = await support.abortable(
    session.send(
      'Page.addScriptToEvaluateOnNewDocument',
      {
        source: reloadInstallId === undefined
          ? documentSource
          : viteDevelopment
          ? `globalThis.__cordisxViteInstallId = ${JSON.stringify(reloadInstallId)};\n${documentSource}`
          : productionDocumentSource!,
      },
      support.CDP_INJECTION_TIMEOUT_MS,
    ),
    signal,
  )
  const identifier = added.identifier
  if (typeof identifier !== 'string') throw new Error('CDP did not return an injection identifier')
  state.identifier = identifier
  state.loopbackReloadStarted = viteDevelopment || loopbackModules || nativeSubmission !== undefined
  if (!state.loopbackReloadStarted) {
    const evaluated = await session.send(
      'Runtime.evaluate',
      { expression: evaluationSource, allowUnsafeEvalBlockedByCSP: true },
      support.CDP_INJECTION_TIMEOUT_MS,
    )
    const exception = support.runtimeEvaluationException(evaluated)
    if (exception !== undefined) throw new Error(`CordisX renderer injection evaluation failed: ${exception}`)
    return
  }
  state.nativeInterception = await bootstrapInstalledDocument({
    session,
    target,
    installId: reloadInstallId!,
    viteDevelopment,
    ...(nativeSubmission === undefined ? {} : { nativeSubmission }),
    ...(signal === undefined ? {} : { signal }),
  })
}
