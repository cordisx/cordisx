import type { SharedProfilePermissionFence } from '../config/profile-permission-fence.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import {
  type CordisXPersistedPermissionPolicyRecord,
  mergePersistedPermissionPolicies,
  normalizePersistedPermissionPolicyRecord,
} from '../permission-persistence.js'
import { isCurrentManagerOriginFence, type ManagerOriginFence } from './manager-origin-fence.js'
import type { ManagerPermissionPolicyBarrier } from './manager-renderer-permission.js'
import type { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import type {
  ServiceRendererBootstrapEntry,
  ServiceRendererConfiguredChannelInput,
} from './service-renderer-bootstrap-state.js'
import { synchronizeServiceRendererPolicies } from './service-renderer-permission-fleet.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/** A separate owner must cover every policy consumer outside the Manager cohort. */
export interface ServiceRendererPermissionConsumerFence {
  isCurrent(): boolean
  release(): boolean
  fence(): void
}

type HandoffInput = {
  readonly profileId: string
  readonly generation: string
  readonly channel: ServiceRendererConfiguredChannelInput | undefined
  readonly permissionFence: SharedProfilePermissionFence | undefined
  readonly entries: Map<string, ServiceRendererBootstrapEntry>
  readonly participants: ServiceRendererParticipants
  readonly lifecycle: ServiceRendererLifecycle
  readonly readLifetimes: ManagerRendererReadLifetimes
  readonly policies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
  readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
}

/**
 * Reserve the exact configured Channel and Manager cohort for one policy write.
 * This primitive does not prove a user decision or supply the other-consumer fence.
 */
export async function reserveServiceRendererPermissionHandoff(
  input: HandoffInput,
  origin: ManagerOriginFence,
  context: ManagerRendererChannelContext,
  requestId: string,
  expected: readonly CordisXPersistedPermissionPolicyRecord[],
  updates: readonly CordisXPersistedPermissionPolicyRecord[],
  consumers: ServiceRendererPermissionConsumerFence,
): Promise<ManagerPermissionPolicyBarrier> {
  try {
    return await reserve(input, origin, context, requestId, expected, updates, consumers)
  } catch (error) {
    try {
      consumers.fence()
    } catch { /* continue fencing every participant */ }
    try {
      origin.fence()
    } catch { /* continue fencing every participant */ }
    input.participants.disconnectAll()
    throw error
  }
}

async function reserve(
  input: HandoffInput,
  origin: ManagerOriginFence,
  context: ManagerRendererChannelContext,
  requestId: string,
  expected: readonly CordisXPersistedPermissionPolicyRecord[],
  updates: readonly CordisXPersistedPermissionPolicyRecord[],
  consumers: ServiceRendererPermissionConsumerFence,
): Promise<ManagerPermissionPolicyBarrier> {
  const channel = input.channel
  const permissionFence = input.permissionFence
  const previous = expected.map(record => normalizePersistedPermissionPolicyRecord(record))
  const changes = updates.map(record => normalizePersistedPermissionPolicyRecord(record))
  const ownerLive = () => {
    try {
      return context.admitted === true && !context.signal.aborted && context.rendererId === origin.rendererId
        && context.profileId === input.profileId && context.ownerGeneration === input.generation
        && consumers.isCurrent() && isCurrentManagerOriginFence(origin, input.participants, input.lifecycle)
    } catch {
      return false
    }
  }
  if (
    !channel || !permissionFence || !ownerLive() || !/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId)
  ) throw new Error('renderer-permission-handoff-unavailable')
  const snapshot = input.lifecycle.snapshot()
  const cohort = input.participants.ownerPeers().map(peer => {
    const id = peer.identity.rendererId
    const entry = input.entries.get(id)
    const configured = entry?.configuredChannel
    if (
      !entry || entry.peer !== peer || !entry.bootstrapConfirmed || !configured || !entry.policies
      || entry.channelTransition || entry.lifecycleTransition || entry.pendingIdentity
      || !input.current(id, entry) || !configured.isCurrent() || !attachmentEqual(entry.snapshot, snapshot)
      || !attachmentEqual(entry.policies, previous)
    ) throw new Error('renderer-permission-handoff-unavailable')
    return { id, entry, configured, peer }
  })
  const writer = cohort.find(item => item.id === origin.rendererId)
  if (!writer || cohort.length === 0 || changes.length === 0 || changes.length > 2) {
    throw new Error('renderer-permission-handoff-unavailable')
  }
  const projected = writer.configured.projectPermissionPolicies(changes)
  if (!attachmentEqual(writer.configured.resolvePermissionPolicies(context, projected.policies), changes)) {
    throw new Error('renderer-permission-handoff-unavailable')
  }
  let reservation: Awaited<ReturnType<ReadonlyChannelRendererBridge['suspendAll']>> | undefined
  let ended = false
  let started = false
  let wrote = false
  let completing = false
  const transition = { isCurrent: () => current() }
  const current = () => {
    try {
      return !ended && ownerLive() && (reservation?.isCurrent() ?? true)
        && attachmentEqual(input.lifecycle.snapshot(), snapshot)
        && cohort.every(({ id, entry, configured }) =>
          entry.lifecycleTransition === transition && input.current(id, entry) && configured.isCurrent()
        )
    } catch {
      return false
    }
  }
  const fence = () => {
    if (ended) return
    ended = true
    try {
      reservation?.fence()
    } catch { /* continue fencing every participant */ }
    try {
      consumers.fence()
    } catch { /* continue fencing every participant */ }
    try {
      origin.fence()
    } catch { /* continue fencing every participant */ }
    for (const { entry, peer } of cohort) {
      if (entry.lifecycleTransition === transition) delete entry.lifecycleTransition
      peer.close()
    }
  }
  for (const { entry } of cohort) entry.lifecycleTransition = transition
  try {
    const checks = await Promise.allSettled(cohort.flatMap(({ entry }) => [...entry.checks]))
    if (checks.some(result => result.status !== 'fulfilled' || !result.value) || !current()) {
      throw new Error('renderer-permission-handoff-unavailable')
    }
    reservation = await channel.bridge.suspendAll(cohort.map(item => item.id))
    const drained = await Promise.all(cohort.map(async item => await input.readLifetimes.drainCurrent(item.id)))
    if (
      drained.some(value => !value) || !current() || !attachmentEqual(await input.policies(), previous) || !current()
    ) {
      throw new Error('renderer-permission-handoff-unavailable')
    }
    return {
      isCurrent: current,
      async run<T>(action: () => Promise<T>): Promise<T> {
        try {
          if (started || !current()) throw new Error('renderer-permission-handoff-unavailable')
          started = true
          const value = await permissionFence.runPolicyMutation({
            expected: previous,
            updates: changes,
            isCurrent: current,
          }, action)
          if (!current()) throw new Error('renderer-permission-handoff-unavailable')
          wrote = true
          return value
        } catch (error) {
          fence()
          throw error
        }
      },
      async complete(raw): Promise<boolean> {
        if (!wrote || completing || !current()) {
          fence()
          return false
        }
        completing = true
        try {
          const candidate = raw.map(record => normalizePersistedPermissionPolicyRecord(record))
          if (
            !attachmentEqual(candidate, mergePersistedPermissionPolicies(previous, changes))
            || !attachmentEqual(await input.policies(), candidate) || !current()
          ) throw new Error('renderer-permission-handoff-unavailable')
          const confirm = async (items: typeof cohort) =>
            await synchronizeServiceRendererPolicies({
              scope: writer.peer.scope,
              peers: items.map(item => ({
                peer: item.peer,
                origin: item === writer,
                project: records => item.configured.projectPermissionPolicies(records),
              })),
              requestId,
              expected: previous,
              updates: changes,
              candidate,
              isCurrent: current,
              fence,
            })
          // The writer must have an explicit in-flight adoption path; ordinary
          // peer adoption waits for its own write and would deadlock here.
          if (!await confirm(cohort.filter(item => item !== writer)) || !await confirm([writer])) {
            throw new Error('renderer-permission-handoff-unavailable')
          }
          for (const { entry } of cohort) entry.policies = candidate
          for (const item of cohort) await item.configured.handoff(reservation!.forRenderer(item.id))
          if (!current() || !consumers.release() || !reservation!.release()) {
            throw new Error('renderer-permission-handoff-unavailable')
          }
          for (const { entry } of cohort) delete entry.lifecycleTransition
          if (!origin.release()) throw new Error('renderer-permission-handoff-unavailable')
          ended = true
          return true
        } catch {
          fence()
          return false
        }
      },
      fence,
    }
  } catch (error) {
    fence()
    throw error
  }
}
