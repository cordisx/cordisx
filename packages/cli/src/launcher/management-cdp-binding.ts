import type { CdpLifecycleRequestGate } from './production-graph-admission.js'
import type { CdpSession } from './cdp-session.js'
import {
  handlePluginManagementRpcRequest,
  MANAGEMENT_BINDING,
  MAX_MANAGEMENT_REQUEST_BYTES,
  parsePluginManagementRpcRequest,
  type PluginManagementBridgeHandler,
} from './management-rpc.js'
import { sendPluginManagementBindingResponse } from './cdp-installation-support.js'

export interface ManagementCdpBinding {
  readonly controller?: AbortController
  readonly installed: boolean
  readonly removeBindingListener: () => void
  readonly unsubscribe: () => void
}

export async function installManagementCdpBinding(
  session: CdpSession,
  management: PluginManagementBridgeHandler | undefined,
  lifecycleRequests: CdpLifecycleRequestGate,
): Promise<ManagementCdpBinding> {
  if (management === undefined) {
    return {
      installed: false,
      removeBindingListener: () => undefined,
      unsubscribe: () => undefined,
    }
  }
  const controller = new AbortController()
  await session.send('Runtime.addBinding', { name: MANAGEMENT_BINDING })
  const removeBindingListener = session.onEvent('Runtime.bindingCalled', params => {
    if (params.name !== MANAGEMENT_BINDING || typeof params.payload !== 'string') return
    const payload = params.payload
    void (async () => {
      let requestId = 'invalid'
      try {
        if (Buffer.byteLength(payload) > MAX_MANAGEMENT_REQUEST_BYTES) {
          throw new Error('plugin management request exceeds maximum size')
        }
        const request = parsePluginManagementRpcRequest(JSON.parse(payload) as unknown, management)
        requestId = request.requestId
        if (controller.signal.aborted) throw new Error('plugin management bridge is closed')
        const value = await lifecycleRequests.exclusive(
          async () => await handlePluginManagementRpcRequest(management.service, request),
        )
        await sendPluginManagementBindingResponse(session, { requestId, ok: true, value })
      } catch (error) {
        await sendPluginManagementBindingResponse(session, {
          requestId,
          ok: false,
          error: error instanceof Error ? error.message : 'plugin management request was rejected',
        }).catch(() => undefined)
      }
    })()
  })
  const unsubscribe = management.service.subscribe(snapshot => {
    if (controller.signal.aborted) return
    void sendPluginManagementBindingResponse(session, {
      version: 1,
      kind: 'snapshot',
      profileId: management.profileId,
      generation: management.generation,
      snapshot,
    }).catch(() => undefined)
  })
  return { controller, installed: true, removeBindingListener, unsubscribe }
}
