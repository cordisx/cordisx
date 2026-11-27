import type { CdpSession } from './cdp-session.js'
import {
  MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES,
  parsePluginLifecycleBindingRequest,
  PLUGIN_LIFECYCLE_BINDING,
  type PluginLifecycleBindingScope,
} from './plugin-lifecycle-rpc.js'

export interface RemotePluginLifecycleBinding {
  readonly scope: PluginLifecycleBindingScope
  readonly request: (envelope: unknown) => Promise<unknown>
}

/** Do not hold the native CDP mutation gate while the owner calls this renderer back. */
export function installRemotePluginLifecycleBinding(input: {
  readonly session: CdpSession
  readonly binding: RemotePluginLifecycleBinding
  readonly signal: AbortSignal
  readonly respond: (payload: Record<string, unknown>) => Promise<void>
  readonly error: (error: unknown) => { readonly code: string; readonly error: string }
}): () => void {
  let busy = false
  return input.session.onEvent('Runtime.bindingCalled', params => {
    if (params.name !== PLUGIN_LIFECYCLE_BINDING || typeof params.payload !== 'string') return
    const payload = params.payload
    void (async () => {
      let requestId = 'invalid'
      try {
        if (Buffer.byteLength(payload) > MAX_PLUGIN_LIFECYCLE_REQUEST_BYTES) throw new Error('request is too large')
        const envelope = JSON.parse(payload) as Record<string, unknown>
        // Even an unsupported but well-formed operation must settle its own
        // browser promise. In particular, startup probes bundle support before
        // the native renderer has joined the service owner.
        const operation = envelope?.request ?? envelope?.privateRequest
        if (operation !== null && typeof operation === 'object' && !Array.isArray(operation)) {
          const candidate = (operation as Record<string, unknown>).requestId
          if (typeof candidate === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)) {
            requestId = candidate
          }
        }
        const parsed = parsePluginLifecycleBindingRequest(envelope, input.binding.scope)
        requestId = parsed.requestId
        if (input.signal.aborted || busy) throw new Error('plugin lifecycle bridge is unavailable')
        busy = true
        let value: unknown
        try {
          const { token: _token, ...request } = envelope
          void _token
          value = await input.binding.request(request)
        } finally {
          // Delivering the response can synchronously start the next renderer
          // request (for example, applying the permission plan just returned).
          // The owner call has finished, so release before entering that callback.
          busy = false
        }
        if (!input.signal.aborted) await input.respond({ requestId, ok: true, value })
      } catch (error) {
        if (!input.signal.aborted) await input.respond({ requestId, ok: false, ...input.error(error) }).catch(() => {})
      }
    })()
  })
}
