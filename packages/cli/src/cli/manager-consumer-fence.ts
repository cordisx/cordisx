import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'

/**
 * Owner-private building block for a profile barrier. It covers only Manager
 * sessions: an integrating authority must also fence every other consumer and
 * writer, and reconcile any uncertain outcome before releasing it.
 */
export async function fenceManagerConsumers(input: {
  readonly sessions: ManagerRendererSessions
  readonly participants: ServiceRendererParticipants
  readonly lifecycle?: ServiceRendererLifecycle
  readonly timeoutMs?: number
}): Promise<{ isCurrent(): boolean; release(): boolean; fence(): void }> {
  if (input.lifecycle && !input.participants.isBoundTo(input.lifecycle)) {
    throw new Error('manager-consumer-fence-scope-invalid')
  }
  const writes = await input.sessions.suspendMutations(input.timeoutMs)
  let lifecycle: ReturnType<ServiceRendererLifecycle['reserveExternalMutation']> | undefined
  try {
    lifecycle = input.lifecycle?.reserveExternalMutation(input.participants.ownerPeers())
  } catch {
    // No consumer was asked to quiesce and no external write was dispatched.
    writes.release()
    throw new Error('manager-consumer-fence-unavailable')
  }
  try {
    const consumers = await input.participants.quiesceManagers()
    let ended = false
    const current = () => !ended && writes.isCurrent() && consumers.isCurrent() && (lifecycle?.isCurrent() ?? true)
    return {
      isCurrent: current,
      release() {
        if (ended) return false
        if (!current()) {
          ended = true
          lifecycle?.fence()
          consumers.fence()
          writes.fence()
          return false
        }
        ended = true
        if (lifecycle && !lifecycle.release()) {
          consumers.fence()
          writes.fence()
          return false
        }
        if (!consumers.release()) {
          input.lifecycle?.terminal(new Error('manager-consumer-fence-unavailable'))
          writes.fence()
          return false
        }
        if (!writes.release()) {
          input.lifecycle?.terminal(new Error('manager-consumer-fence-unavailable'))
          return false
        }
        return true
      },
      fence() {
        if (ended) return
        ended = true
        lifecycle?.fence()
        consumers.fence()
        writes.fence()
      },
    }
  } catch {
    lifecycle?.fence()
    writes.fence()
    throw new Error('manager-consumer-fence-unavailable')
  }
}
