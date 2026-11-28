import { timingSafeEqual } from 'node:crypto'
import type { CdpLifecycleRequestGate } from './production-graph-admission.js'
import type { CdpSession } from './cdp-session.js'
import {
  MAX_PERMISSION_REQUEST_BYTES,
  MAX_PERMISSION_REQUESTS,
  parsePermissionBindingRequest,
  PERMISSION_BINDING,
  PERMISSION_ONCE_BINDING,
  PERMISSION_ONCE_RECEIVER,
  type PermissionPersistenceContext,
  persistPermissionPolicies,
} from './permission-rpc.js'
import { sendPermissionBindingResponse } from './cdp-installation-support.js'

/** A native document registers its key before plugins load; subsequent writes stay owner-coordinated. */
export function installPermissionCdpBinding(
  session: CdpSession,
  permission: PermissionPersistenceContext,
  lifecycleRequests: CdpLifecycleRequestGate,
  controller: AbortController,
): () => void {
  let active = 0
  const keys = new Map<number, string>()
  const removeDestroyed = session.onEvent('Runtime.executionContextDestroyed', params => {
    if (typeof params.executionContextId === 'number') keys.delete(params.executionContextId)
  })
  const removeCleared = session.onEvent('Runtime.executionContextsCleared', () => keys.clear())
  const removeBinding = session.onEvent('Runtime.bindingCalled', params => {
    if (
      params.name !== PERMISSION_BINDING && params.name !== PERMISSION_ONCE_BINDING
      || typeof params.payload !== 'string'
    ) return
    const payload = params.payload
    const once = params.name === PERMISSION_ONCE_BINDING
    const contextId = typeof params.executionContextId === 'number' ? params.executionContextId : undefined
    const reply = async (value: Record<string, unknown>) => {
      if (!once) return await sendPermissionBindingResponse(session, value, contextId)
      await session.send('Runtime.evaluate', {
        expression: `void globalThis.${PERMISSION_ONCE_RECEIVER}?.(${JSON.stringify(JSON.stringify(value))})`,
        allowUnsafeEvalBlockedByCSP: true,
        ...(contextId === undefined ? {} : { contextId }),
      })
    }
    void (async () => {
      let requestId = 'invalid'
      let dispatched = false
      try {
        if (Buffer.byteLength(payload) > MAX_PERMISSION_REQUEST_BYTES) throw new Error('permission-request-too-large')
        const raw: unknown = JSON.parse(payload)
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('permission-request-invalid')
        const item = raw as Record<string, unknown>
        if (typeof item.requestId === 'string') requestId = item.requestId
        if (controller.signal.aborted || active >= MAX_PERMISSION_REQUESTS) {
          throw new Error('permission-bridge-unavailable')
        }
        active += 1
        try {
          let value: unknown
          if (once) {
            if (
              !permission.remote || contextId === undefined || Object.keys(item).length !== 5
              || item.decision !== 'allow-once' && item.decision !== 'deny-once'
              || !item.proof || typeof item.proof !== 'object' || Array.isArray(item.proof)
              || keys.get(contextId) !== (item.proof as Record<string, unknown>).keyId
            ) throw new Error('permission-once-unavailable')
            const request = parsePermissionBindingRequest({
              token: item.token,
              requestId: item.requestId,
              records: [item.record],
            }, permission)
            value = await permission.remote.once({
              requestId: request.requestId,
              record: request.records[0]!,
              decision: item.decision,
              proof: item.proof,
            })
          } else if (item.kind === 'register' || item.kind === 'retire') {
            const token = typeof item.token === 'string' ? Buffer.from(item.token) : Buffer.alloc(0)
            const expected = Buffer.from(permission.token)
            if (
              !permission.remote || contextId === undefined
              || Object.keys(item).length !== (item.kind === 'register' ? 5 : 4)
              || typeof item.keyId !== 'string' || !/^[a-f0-9]{64}$/u.test(item.keyId)
              || !/^[A-Za-z0-9-]{1,96}$/u.test(requestId)
              || token.length !== expected.length || !timingSafeEqual(token, expected)
            ) throw new Error('permission-key-invalid')
            if (item.kind === 'register') {
              if (!Object.hasOwn(item, 'key')) throw new Error('permission-key-invalid')
              value = await permission.remote.register(item.keyId, item.key)
              if (value !== true || controller.signal.aborted) throw new Error('permission-key-unavailable')
              keys.set(contextId, item.keyId)
            } else {
              if (keys.get(contextId) !== item.keyId) throw new Error('permission-key-unavailable')
              permission.remote.uncertain()
              value = true
            }
          } else {
            const { proof, ...binding } = item
            const request = parsePermissionBindingRequest(binding, permission)
            if (permission.remote) {
              if (
                !proof || typeof proof !== 'object' || Array.isArray(proof) || contextId === undefined
                || keys.get(contextId) !== (proof as Record<string, unknown>).keyId
              ) {
                throw new Error('permission-proof-unavailable')
              }
              // The owner calls back into this CDP fleet while the write is pending.
              dispatched = true
              value = await permission.remote.write(request, proof)
            } else {
              if (proof !== undefined) throw new Error('permission-proof-unavailable')
              value = await lifecycleRequests.exclusive(async () =>
                await persistPermissionPolicies(permission, request.records)
              )
            }
          }
          await reply({ requestId, ok: true, value })
        } finally {
          active -= 1
        }
      } catch {
        if (dispatched) permission.remote?.uncertain()
        await reply({ requestId, ok: false, error: 'Permission request was rejected' }).catch(() => undefined)
      }
    })()
  })
  return () => {
    keys.clear()
    removeBinding()
    removeDestroyed()
    removeCleared()
  }
}
