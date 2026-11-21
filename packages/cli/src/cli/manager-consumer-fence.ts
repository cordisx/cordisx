import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/**
 * Owner-private building block for a profile barrier. It covers only Manager
 * sessions: an integrating authority must also fence every other consumer and
 * writer, and reconcile any uncertain outcome before releasing it.
 */
export async function fenceManagerConsumers(input: {
  readonly sessions: ManagerRendererSessions
  readonly participants: ServiceRendererParticipants
  readonly timeoutMs?: number
}): Promise<{ release(): boolean; fence(): void }> {
  const writes = await input.sessions.suspendMutations(input.timeoutMs)
  try {
    const consumers = await input.participants.quiesceManagers()
    let ended = false
    return {
      release() {
        if (ended) return false
        ended = true
        if (!consumers.release()) {
          writes.fence()
          return false
        }
        return writes.release()
      },
      fence() {
        if (ended) return
        ended = true
        consumers.fence()
        writes.fence()
      },
    }
  } catch {
    writes.fence()
    throw new Error('manager-consumer-fence-unavailable')
  }
}
