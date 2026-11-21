import type { ManagerChannelCredentialOperation } from '../launcher/manager-channel-credentials.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { fenceManagerConsumers } from './manager-consumer-fence.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/**
 * Coordinate sidecar-originated Channel configuration writes with the Manager
 * consumers known to this service owner. This does not cover other writers or
 * adapters; configured-plugin admission still requires a wider profile barrier.
 */
export function coordinateManagerChannelCredentials(input: {
  readonly sessions: ManagerRendererSessions
  readonly participants?: ServiceRendererParticipants
  readonly lifecycle?: ServiceRendererLifecycle
  readonly handle: (operation: ManagerChannelCredentialOperation) => Promise<unknown>
}): (operation: ManagerChannelCredentialOperation) => Promise<unknown> {
  return async operation => {
    if (!['commit', 'resolve-tenant', 'set-enabled'].includes(operation.action)) {
      return await input.handle(operation)
    }
    // The current quiescence protocol disconnects a renderer. It cannot yet
    // safely hand an originating renderer's outstanding write back to it.
    if (!input.participants || !input.lifecycle || input.sessions.hasBrowserSession(operation.sessionId)) {
      return { status: 'unavailable', code: 'PROFILE_COORDINATION_UNAVAILABLE' }
    }
    let fence: Awaited<ReturnType<typeof fenceManagerConsumers>>
    try {
      // No await may be inserted between the origin check and reserving the
      // Manager gate: an in-progress open must see the reservation.
      fence = await fenceManagerConsumers({
        sessions: input.sessions,
        participants: input.participants,
        lifecycle: input.lifecycle,
      })
    } catch {
      return { status: 'unavailable', code: 'PROFILE_COORDINATION_UNAVAILABLE' }
    }
    if (!fence.isCurrent()) {
      fence.fence()
      return { status: 'unavailable', code: 'PROFILE_COORDINATION_UNAVAILABLE' }
    }
    try {
      const result = await input.handle(operation)
      const status = result !== null && typeof result === 'object' && !Array.isArray(result)
        ? (result as Record<string, unknown>).status
        : undefined
      if (!['applied', 'conflict', 'rejected', 'unavailable'].includes(String(status))) {
        fence.fence()
        return { status: 'unknown', code: 'RESULT_UNKNOWN' }
      }
      if (!fence.isCurrent() || !fence.release()) {
        fence.fence()
        return { status: 'unknown', code: 'RESULT_UNKNOWN' }
      }
      return result
    } catch {
      // A failed dispatch may already have persisted or restarted the service.
      fence.fence()
      return { status: 'unknown', code: 'RESULT_UNKNOWN' }
    }
  }
}
