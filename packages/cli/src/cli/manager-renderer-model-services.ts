import { MODEL_SERVICE_SAFE_WRITE_CONTRACT, STANDALONE_MODEL_SERVICES_MARKER } from '../model-service-contracts.js'
import { parseModelServicesSaveRequest } from '../launcher/model-service-store.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'

/** The authenticated owner is the only source of model-service data and writes. */
export function createManagerRendererModelServicesChannel(input: {
  readonly profileId: string
  readonly generation: string
  readonly isCurrent: (context: ManagerRendererChannelContext) => boolean
  readonly call: (operation: string, request: unknown) => Promise<unknown>
}): ManagerRendererChannel {
  const seen = new WeakMap<AbortSignal, Set<string>>()
  const current = (context: ManagerRendererChannelContext) => {
    try {
      return !context.signal.aborted && context.profileId === input.profileId
        && context.ownerGeneration === input.generation && input.isCurrent(context)
    } catch {
      return false
    }
  }
  return {
    prepare(payload, context) {
      if (!current(context) || typeof payload !== 'string' || Buffer.byteLength(payload) > 256 * 1024) {
        throw new Error('MODEL_SERVICES_UNAVAILABLE')
      }
      const value: unknown = JSON.parse(payload)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('MODEL_SERVICES_INVALID')
      }
      const item = value as Record<string, unknown>
      const keys = item.operation === 'read'
        ? ['version', 'token', 'requestId', 'operation']
        : item.operation === 'save'
        ? ['version', 'token', 'requestId', 'operation', 'request']
        : []
      if (
        keys.length === 0 || Object.keys(item).length !== keys.length
        || Object.keys(item).some(key => !keys.includes(key))
        || item.version !== 1 || item.token !== STANDALONE_MODEL_SERVICES_MARKER
        || typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(item.requestId)
        || item.operation === 'save' && context.admitted !== true
      ) throw new Error('MODEL_SERVICES_INVALID')
      const requestId = item.requestId
      const request = item.operation === 'save' ? parseModelServicesSaveRequest(item.request) : undefined
      if (item.operation === 'save' && !request) throw new Error('MODEL_SERVICES_INVALID')
      const write = item.operation === 'save'
      return {
        mode: write ? 'write' : 'read',
        dispatch: async () => {
          if (!current(context) || write && context.admitted !== true) throw new Error('MODEL_SERVICES_UNAVAILABLE')
          const requests = seen.get(context.signal) ?? new Set<string>()
          if (requests.has(requestId) || requests.size >= 4096) throw new Error('MODEL_SERVICES_UNAVAILABLE')
          requests.add(requestId)
          seen.set(context.signal, requests)
          const raw = await input.call('model-services:read', {})
          if (!current(context)) throw new Error('MODEL_SERVICES_UNAVAILABLE')
          const capability = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
            ? raw as Record<string, unknown>
            : undefined
          if (
            capability?.status !== 'ok' || capability.managerSafeWrite !== MODEL_SERVICE_SAFE_WRITE_CONTRACT
            || typeof capability.revision !== 'string' || !Array.isArray(capability.services)
          ) {
            return { requestId, ok: true, value: { status: 'rejected', code: 'unavailable' } }
          }
          if (!write) {
            return {
              requestId,
              ok: true,
              value: { status: 'ok', revision: capability.revision, services: capability.services },
            }
          }
          const result = await input.call('model-services:save', request)
          if (!current(context)) throw new Error('MODEL_SERVICES_UNAVAILABLE')
          const saved = result !== null && typeof result === 'object' && !Array.isArray(result)
            ? result as Record<string, unknown>
            : undefined
          if (saved?.status === 'applied' && saved.applies === 'app-restart' && typeof saved.revision === 'string') {
            return {
              requestId,
              ok: true,
              value: { status: 'applied', applies: 'app-restart', revision: saved.revision },
            }
          }
          // The existing store can report a persistence failure after the
          // atomic replacement. Fence the session and report an unknown write.
          if (saved?.status === 'rejected' && saved.code === 'persist-failed') {
            throw new Error('MODEL_SERVICES_RESULT_UNKNOWN')
          }
          if (saved?.status === 'rejected') {
            const code = ['conflict', 'invalid', 'unavailable'].includes(String(saved.code))
              ? saved.code
              : 'invalid'
            return { requestId, ok: true, value: { status: 'rejected', code } }
          }
          throw new Error('MODEL_SERVICES_RESULT_UNKNOWN')
        },
      }
    },
  }
}
