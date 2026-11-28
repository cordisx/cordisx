import type { CdpSession } from './cdp-session.js'
import {
  inspectMarketplaceArtifactPackage,
  type MarketplaceArtifactBindingRequest,
  parseMarketplaceArtifactBindingRequest,
  previewMarketplaceArtifactPackage,
} from './marketplace-artifact.js'
import type { PluginLifecycleBridgeHandler } from './plugin-lifecycle-rpc.js'

export const MARKETPLACE_ARTIFACT_BINDING = '__cordisxMarketplaceArtifactRequestV1'
export const MARKETPLACE_ARTIFACT_RECEIVER = '__cordisxMarketplaceArtifactReceiveV1'

interface MarketplaceArtifactRequestGate {
  run<Value>(task: () => Promise<Value>, respond: (value: Value) => Promise<void>): Promise<void>
}

export interface RemoteMarketplaceArtifactBinding {
  request(
    request: Exclude<MarketplaceArtifactBindingRequest, { readonly kind: 'cancel' }>,
    signal: AbortSignal,
  ): Promise<unknown>
}

async function sendMarketplaceArtifactBindingResponse(
  session: CdpSession,
  payload: Record<string, unknown>,
): Promise<void> {
  await session.send('Runtime.evaluate', {
    expression: `void globalThis.${MARKETPLACE_ARTIFACT_RECEIVER}?.(${JSON.stringify(JSON.stringify(payload))})`,
    allowUnsafeEvalBlockedByCSP: true,
  })
}

export function installMarketplaceArtifactBinding(options: {
  readonly session: CdpSession
  readonly handler?: PluginLifecycleBridgeHandler
  readonly remote?: RemoteMarketplaceArtifactBinding
  readonly gate: MarketplaceArtifactRequestGate
  readonly signal: AbortSignal
}): () => void {
  if ((options.handler === undefined) === (options.remote === undefined)) {
    throw new Error('Marketplace artifact authority is ambiguous')
  }
  const artifactRequests = new Map<string, AbortController>()
  const abortRequests = (): void => {
    for (const controller of artifactRequests.values()) controller.abort()
    artifactRequests.clear()
  }
  options.signal.addEventListener('abort', abortRequests, { once: true })
  const removeListener = options.session.onEvent('Runtime.bindingCalled', params => {
    if (params.name !== MARKETPLACE_ARTIFACT_BINDING || typeof params.payload !== 'string') return
    const payload = params.payload
    void (async () => {
      let requestId = 'invalid'
      try {
        const request = parseMarketplaceArtifactBindingRequest(JSON.parse(payload) as unknown)
        requestId = request.requestId
        if (request.kind === 'cancel') {
          artifactRequests.get(request.targetRequestId)?.abort()
          return
        }
        if (artifactRequests.has(requestId)) throw new Error('duplicate Marketplace artifact request id')
        if (artifactRequests.size >= 2) throw new Error('too many concurrent Marketplace artifact requests')
        const controller = new AbortController()
        artifactRequests.set(requestId, controller)
        try {
          const signal = AbortSignal.any([options.signal, controller.signal])
          if (options.remote !== undefined) {
            // The service can call back into this renderer while inspecting a
            // candidate, so the native CDP generation gate must remain free.
            const value = await options.remote.request(request, signal)
            await sendMarketplaceArtifactBindingResponse(options.session, { requestId, ok: true, value })
          } else if (request.kind === 'preview') {
            const value = await previewMarketplaceArtifactPackage(options.handler!, request.request, signal)
            await sendMarketplaceArtifactBindingResponse(options.session, { requestId, ok: true, value })
          } else {
            await options.gate.run(
              async () => await inspectMarketplaceArtifactPackage(options.handler!, request.request, signal),
              async value =>
                await sendMarketplaceArtifactBindingResponse(options.session, { requestId, ok: true, value }),
            )
          }
        } finally {
          artifactRequests.delete(requestId)
        }
      } catch (error) {
        await sendMarketplaceArtifactBindingResponse(options.session, {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined)
      }
    })()
  })
  return () => {
    options.signal.removeEventListener('abort', abortRequests)
    abortRequests()
    removeListener()
  }
}
