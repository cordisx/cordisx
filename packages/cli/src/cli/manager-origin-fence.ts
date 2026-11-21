import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'

export interface ManagerOriginFence {
  readonly rendererId: string
  isCurrent(): boolean
  release(): boolean
  fence(): void
}

const issued = new WeakMap<ManagerOriginFence, {
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: OwnerRendererLifecycle
  readonly current: () => boolean
}>()

/** Read-only verification: callers cannot fabricate an origin reservation. */
export function isCurrentManagerOriginFence(
  fence: ManagerOriginFence,
  participants: ServiceRendererParticipants,
  lifecycle: OwnerRendererLifecycle,
): boolean {
  const record = issued.get(fence)
  return record?.participants === participants && record.lifecycle === lifecycle && record.current()
}

/**
 * Keep one admitted Manager alive for a write receipt while reserving its
 * owner's lifecycle. Refuse other Manager peers rather than discard drafts.
 * The caller must separately fence readers, profile writers and service state.
 */
export async function fenceManagerOrigin(input: {
  readonly sessions: ManagerRendererSessions
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: ServiceRendererLifecycle
  readonly timeoutMs?: number
}): Promise<ManagerOriginFence> {
  if (!input.participants.isBoundTo(input.lifecycle)) throw new Error('manager-origin-fence-scope-invalid')
  const writes = await input.sessions.suspendMutationsForCurrentWrite(input.timeoutMs)
  let lifecycle: ReturnType<ServiceRendererLifecycle['reserveExternalMutation']>
  let peer: NonNullable<ReturnType<ServiceRendererParticipants['peer']>>
  try {
    const peers = input.participants.ownerPeers()
    const origin = input.participants.peer(writes.rendererId)
    if (peers.length !== 1 || !origin || peers[0] !== origin || !input.participants.isLive(origin.identity)) {
      throw new Error('manager-origin-fence-unavailable')
    }
    peer = origin
    lifecycle = input.lifecycle.reserveExternalMutation(peers)
  } catch {
    if (!writes.release()) writes.fence()
    throw new Error('manager-origin-fence-unavailable')
  }
  let ended = false
  let unsubscribe = () => {}
  const fence = () => {
    if (ended) return
    ended = true
    unsubscribe()
    try {
      lifecycle.fence()
    } finally {
      writes.fence()
    }
  }
  unsubscribe = peer.onDisconnect(fence)
  const current = () => {
    try {
      const peers = input.participants.ownerPeers()
      return !ended && writes.isCurrent() && lifecycle.isCurrent() && peers.length === 1 && peers[0] === peer
        && input.participants.peer(writes.rendererId) === peer && input.participants.isLive(peer.identity)
    } catch {
      return false
    }
  }
  const result: ManagerOriginFence = Object.freeze({
    rendererId: writes.rendererId,
    isCurrent: current,
    release() {
      if (ended) return false
      if (!current()) {
        fence()
        return false
      }
      ended = true
      unsubscribe()
      let lifecycleReleased = false
      try {
        lifecycleReleased = lifecycle.release()
        if (lifecycleReleased && writes.release()) return true
      } catch {
        // A lifecycle exception must never leave the Manager gate open.
      }
      writes.fence()
      if (lifecycleReleased) {
        try {
          input.lifecycle.terminal(new Error('manager-origin-fence-unavailable'))
        } catch { /* remain fenced */ }
      }
      return false
    },
    fence,
  })
  issued.set(result, { participants: input.participants, lifecycle: input.lifecycle, current })
  return result
}
