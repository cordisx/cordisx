import {
  applyManagementPermissionReview,
  type PermissionReviewOperation,
} from '../launcher/permission-review-management.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { ManagerRendererSessions } from './manager-renderer-sessions.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/** Coordinate an out-of-band lifecycle review without retiring Manager drafts. */
export function coordinateManagerPermissionReview(input: {
  readonly sessions: ManagerRendererSessions
  readonly participants?: ServiceRendererParticipants
  readonly lifecycle?: ServiceRendererLifecycle
  readonly coordinator: PluginLifecycleCoordinator
  readonly profileId: string
  readonly generation: string
}): (operation: PermissionReviewOperation) => Promise<unknown> {
  const unavailable = () => ({ status: 'unavailable' as const, reason: 'profile-coordination-unavailable' })
  return async operation => {
    if (
      !input.participants || !input.lifecycle || !input.participants.isBoundTo(input.lifecycle)
      || input.sessions.hasLiveRenderers()
    ) return unavailable()
    let writes: Awaited<ReturnType<ManagerRendererSessions['suspendMutations']>>
    try {
      // Reserve synchronously after checking for live renderers; a pending
      // open must observe the reservation before it can create a peer.
      writes = await input.sessions.suspendMutations()
    } catch {
      return input.sessions.mutationAvailability() === 'busy'
        ? { status: 'rejected', reason: 'review-busy' }
        : unavailable()
    }
    let lifecycle: ReturnType<ServiceRendererLifecycle['reserveExternalMutation']>
    try {
      lifecycle = input.lifecycle.reserveExternalMutation(input.participants.ownerPeers())
    } catch {
      writes.release()
      return unavailable()
    }
    try {
      const result = await lifecycle.runExclusive(async () =>
        await applyManagementPermissionReview({
          coordinator: input.coordinator,
          profileId: input.profileId,
          generation: input.generation,
          operation,
        })
      )
      if (result.status === 'unknown') {
        lifecycle.fence()
        writes.fence()
        return result
      }
      const active = await input.coordinator.store.loadActive()
      if (!writes.isCurrent() || !lifecycle.adoptCommitted(active) || !lifecycle.release()) {
        lifecycle.fence()
        writes.fence()
        return { status: 'unknown', reason: 'review-not-confirmed' }
      }
      if (!writes.release()) {
        input.lifecycle.terminal(new Error('manager-permission-review-unavailable'))
        return { status: 'unknown', reason: 'review-not-confirmed' }
      }
      return result
    } catch {
      lifecycle.fence()
      writes.fence()
      return { status: 'unknown', reason: 'review-not-confirmed' }
    }
  }
}
