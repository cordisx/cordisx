import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { ManagerRendererChannel, ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import { fenceManagerOrigin } from './manager-origin-fence.js'

/** Coordinate managed-service actions only when the owner can reserve their complete Manager cohort. */
export function coordinateManagerManagedServiceMutations(input: {
  readonly channel: ManagerRendererChannel
  readonly sessions: () => ManagerRendererSessions
  readonly participants?: ServiceRendererParticipants
  readonly lifecycle?: ServiceRendererLifecycle
}): ManagerRendererChannel {
  return {
    prepare(payload, context) {
      const prepared = input.channel.prepare(payload, context)
      if (prepared.mode !== 'write') return prepared
      if (typeof payload !== 'string') throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      const value = JSON.parse(payload) as { requestId?: unknown }
      if (!value || typeof value.requestId !== 'string') throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
      const requestId = value.requestId
      if (!input.participants || !input.lifecycle) {
        return {
          mode: 'read',
          async dispatch() {
            return { requestId, ok: false, code: 'unsupported' }
          },
        }
      }
      const participants = input.participants
      const lifecycle = input.lifecycle
      return {
        mode: 'write',
        async dispatch() {
          let origin: Awaited<ReturnType<typeof fenceManagerOrigin>>
          try {
            origin = await fenceManagerOrigin({ sessions: input.sessions(), participants, lifecycle })
          } catch {
            // No action was dispatched when the cohort could not be reserved.
            return { requestId, ok: false, code: 'owner-unavailable' }
          }
          try {
            if (origin.rendererId !== context.rendererId || !origin.isCurrent() || context.signal.aborted) {
              throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            }
            const result = await prepared.dispatch()
            if (!origin.isCurrent() || !origin.release()) throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
            return result
          } catch {
            origin.fence()
            throw new Error('MANAGED_SERVICE_UI_UNAVAILABLE')
          }
        },
      }
    },
  }
}
