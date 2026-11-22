import type { DesktopConfigurationReservation } from '../launcher/desktop-configuration-reservation.js'
import type { AttachedRendererPeer } from '../launcher/renderer-lifecycle-peer.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'

export interface ManagerOriginFence {
  readonly rendererId: string
  readonly desktopConfiguration?: DesktopConfigurationReservation['desktopConfiguration']
  isCurrent(): boolean
  release(): boolean
  fence(): void
}

type ExternalReservation = {
  isCurrent(): boolean
  release(): boolean
  fence(): void
  readonly desktopConfiguration?: DesktopConfigurationReservation['desktopConfiguration']
}
type ExternalLifecycle = OwnerRendererLifecycle & {
  reserveExternalMutation(peers: readonly AttachedRendererPeer[]): ExternalReservation | Promise<ExternalReservation>
  terminal(error: unknown): void
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
 * Keep the originating Manager alive for its write receipt. Other admitted
 * Managers are accepted only when the caller can hand off all of their views;
 * unadmitted and non-Manager peers remain outside that authority. The caller
 * must separately fence readers, profile writers and service state.
 */
export async function fenceManagerOrigin(input: {
  readonly sessions: ManagerRendererSessions
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: ExternalLifecycle
  readonly allowAdditionalManagers?: boolean
  readonly timeoutMs?: number
}): Promise<ManagerOriginFence> {
  if (!input.participants.isBoundTo(input.lifecycle)) throw new Error('manager-origin-fence-scope-invalid')
  const writes = await input.sessions.suspendMutationsForCurrentWrite(input.timeoutMs)
  let lifecycle: ExternalReservation
  let peers: readonly NonNullable<ReturnType<ServiceRendererParticipants['peer']>>[]
  try {
    peers = input.participants.ownerPeers()
    const origin = input.participants.peer(writes.rendererId)
    if (
      !origin || !peers.includes(origin) || (!input.allowAdditionalManagers && peers.length !== 1)
      || peers.some(peer => !input.participants.isLive(peer.identity) || !input.sessions.hasAdmittedPeer(peer))
    ) {
      throw new Error('manager-origin-fence-unavailable')
    }
    lifecycle = await input.lifecycle.reserveExternalMutation(peers)
  } catch {
    if (!writes.release()) writes.fence()
    throw new Error('manager-origin-fence-unavailable')
  }
  let ended = false
  const subscriptions: Array<() => void> = []
  const unsubscribe = () => {
    for (const dispose of subscriptions.splice(0)) dispose()
  }
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
  for (const peer of peers) {
    const dispose = peer.onDisconnect(fence)
    if (ended) {
      dispose()
      unsubscribe()
      throw new Error('manager-origin-fence-unavailable')
    }
    subscriptions.push(dispose)
  }
  const current = () => {
    try {
      const live = input.participants.ownerPeers()
      return !ended && writes.isCurrent() && lifecycle.isCurrent() && live.length === peers.length
        && peers.every(peer =>
          live.includes(peer) && input.participants.peer(peer.identity.rendererId) === peer
          && input.participants.isLive(peer.identity) && input.sessions.hasAdmittedPeer(peer)
        )
    } catch {
      return false
    }
  }
  const result: ManagerOriginFence = Object.freeze({
    rendererId: writes.rendererId,
    isCurrent: current,
    ...(lifecycle.desktopConfiguration === undefined ? {} : {
      desktopConfiguration: {
        seat: lifecycle.desktopConfiguration.seat,
        proof: async (pluginId: string) => {
          if (!current()) throw new Error('manager-origin-fence-unavailable')
          const proof = await lifecycle.desktopConfiguration!.proof(pluginId)
          if (!current()) throw new Error('manager-origin-fence-unavailable')
          return proof
        },
        update: async (operation: Parameters<DesktopConfigurationReservation['desktopConfiguration']['update']>[0]) => {
          if (!current()) throw new Error('manager-origin-fence-unavailable')
          const value = await lifecycle.desktopConfiguration!.update(operation)
          if (!current()) throw new Error('manager-origin-fence-unavailable')
          return value
        },
        confirm: () => current() && lifecycle.desktopConfiguration!.confirm(),
      },
    }),
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
      if (!lifecycleReleased) {
        try {
          lifecycle.fence()
        } catch { /* Continue fencing the Manager write gate. */ }
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
