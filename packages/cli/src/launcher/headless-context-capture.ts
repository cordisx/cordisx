import type { CodexAppServerRpc } from '../providers/codex-app-server.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'
import type { NativeStaticCatalogReceipt } from './native-context-budget-provenance.js'
import { deriveNativeBudgetProvenance } from './native-context-budget-provenance.js'
import { resolveNativeContextBudget } from './native-context-budget.js'
import type { NativeContextObserver } from './native-context-observer.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
type Prepared = { status: 'ready'; configPatch: Record<string, unknown>; handle: object } | { status: 'unavailable' }
interface CaptureModule {
  prepareNativeContextCapture(input: unknown): Prepared
  finishNativeContextCapture(
    handle: object,
    receipt: unknown,
    derive: typeof deriveNativeBudgetProvenance,
  ): ReturnType<typeof deriveNativeBudgetProvenance>
}

/** Captures only actual prepared requests on the launch-owned server. */
export class HeadlessContextCapture {
  private readonly models = new Map<string, string>()
  private module?: Promise<CaptureModule>
  constructor(
    private readonly server: CodexAppServerRpc,
    private readonly startup: NativeStaticCatalogReceipt,
    private readonly observer: NativeContextObserver,
  ) {}

  async dispatch(
    method: NativeBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    next: (params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  ): Promise<unknown> {
    const sessionId = typeof params.threadId === 'string' ? params.threadId : undefined
    if (sessionId && this.models.has(sessionId)) {
      const config = object(params.config)
      if (
        method === 'thread/resume' || method === 'thread/settings/update' && params.model != null
          && params.model !== this.models.get(sessionId)
        || method === 'turn/start' && (params.model != null && params.model !== this.models.get(sessionId)
            || Object.keys(config).some(key =>
              key.startsWith('features') || key.startsWith('model_context_window')
              || key.startsWith('model_auto_compact') || key.startsWith('model_post_turn_compact')
            ))
      ) {
        this.models.delete(sessionId)
        this.observer.track(sessionId, 1, { status: 'unavailable', reason: 'unknown' })
      }
    }
    if (method !== 'thread/start' || !this.server.requestWithReceipt || typeof params.cwd !== 'string') {
      return next(params)
    }
    let config: Record<string, unknown>, featureRequirements: unknown, capture: CaptureModule
    try {
      config = object(
        object(await this.server.request('config/read', { cwd: params.cwd, includeLayers: false })).config,
      )
      const requirements = object(await this.server.request('configRequirements/read', {})).requirements
      featureRequirements = requirements === null ? null : object(requirements).featureRequirements
      const asset = '../../assets/launcher/native-context-capture.mjs'
      capture = await (this.module ??= import(asset) as Promise<CaptureModule>)
    } catch {
      return next(params)
    }
    const submitted = { ...params }
    const candidate = submitted.model == null && typeof config.model === 'string'
      ? { ...submitted, model: config.model }
      : submitted
    let prepared: Prepared | undefined
    const receipt = await this.server.requestWithReceipt(method, submitted, undefined, requestId => {
      try {
        prepared = capture.prepareNativeContextCapture({
          startup: this.startup,
          preflight: {
            serverId: this.server.generation,
            cwd: params.cwd,
            originator: 'cordisx',
            config,
            featureRequirements,
          },
          request: { id: requestId, method, params: candidate },
        })
        if (prepared.status === 'ready') {
          Object.assign(submitted, candidate)
          submitted.config = { ...object(submitted.config), ...prepared.configPatch }
        }
      } catch {
        prepared = undefined
      }
    })
    if (prepared?.status === 'ready') {
      try {
        const result = capture.finishNativeContextCapture(prepared.handle, {
          serverId: this.server.generation,
          requestId: receipt.requestId,
          submittedParams: submitted,
          response: { id: receipt.responseRequestId, result: receipt.result },
        }, deriveNativeBudgetProvenance)
        if (result.status === 'verified') {
          const budget = resolveNativeContextBudget(result.evidence)
          if (budget.status === 'resolved') {
            this.models.set(result.evidence.sessionId, result.evidence.model)
            this.observer.track(result.evidence.sessionId, 1, budget, {
              model: result.evidence.model,
              providerId: this.startup.providerId,
            })
          }
        }
      } catch { /* Observation failure cannot turn a successful native start into a failed send. */ }
    }
    return receipt.result
  }
}
