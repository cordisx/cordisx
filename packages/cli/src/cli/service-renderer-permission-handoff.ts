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
import { serviceRendererPermissionInputsCurrent } from './service-renderer-permission-inputs.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'
import type { ManagerPolicyTarget } from './service-renderer-installed-permission.js'

/** A separate owner must cover every policy consumer outside the Manager cohort. */
export interface ServiceRendererPermissionConsumerFence {
  isCurrent(): boolean
  /**
   * Adopt or fence every covered consumer before returning an exact readback.
   * Abort or fence must prevent any late adoption from reopening stale consumers.
   * This is owner-private: policy identities here have not been renderer-projected.
   */
  adopt(input: {
    readonly profileId: string
    readonly ownerGeneration: string
    readonly requestId: string
    readonly expected: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly updates: readonly CordisXPersistedPermissionPolicyRecord[]
    readonly candidate: readonly CordisXPersistedPermissionPolicyRecord[]
  }, signal: AbortSignal): unknown | Promise<unknown>
  release(): boolean
  fence(): void
}

/** Bound the wait and cancel the consumer if the writer disconnects. */
async function adoptOtherConsumers(
  consumers: ServiceRendererPermissionConsumerFence,
  input: Parameters<ServiceRendererPermissionConsumerFence['adopt']>[0],
  writerSignal: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  writerSignal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 15_000)
  timer.unref()
  let onAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('renderer-permission-consumers-unavailable'))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  if (writerSignal.aborted) cancel()
  let completed = false
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted()
        return consumers.adopt(structuredClone(input), controller.signal)
      }),
      aborted,
    ])
    completed = true
    return result
  } finally {
    clearTimeout(timer)
    writerSignal.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', onAbort)
    if (!completed) controller.abort()
  }
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
  readonly target: (context: ManagerRendererChannelContext, pluginId: string) => ManagerPolicyTarget
}

/**
 * Reserve the exact owner-selected UI target and Manager cohort for one policy write.
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
  adapterTarget?: ManagerPolicyTarget,
): Promise<ManagerPermissionPolicyBarrier> {
  try {
    return await reserve(input, origin, context, requestId, expected, updates, consumers, adapterTarget)
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
  adapterTarget?: ManagerPolicyTarget,
): Promise<ManagerPermissionPolicyBarrier> {
  const channel = input.channel
  const permissionFence = input.permissionFence
  const previous = expected.map(record => normalizePersistedPermissionPolicyRecord(record))
  const changes = updates.map(record => normalizePersistedPermissionPolicyRecord(record))
  const ownerLive = () => {
    try {
      return context.admitted === true && !context.signal.aborted && context.rendererId === origin.rendererId
        && context.profileId === input.profileId && context.ownerGeneration === input.generation
        && (adapterTarget?.isCurrent() ?? true)
        && consumers.isCurrent() && isCurrentManagerOriginFence(origin, input.participants, input.lifecycle)
    } catch {
      return false
    }
  }
  if (
    !permissionFence || !ownerLive() || !/^[A-Za-z0-9._:-]{1,160}$/u.test(requestId)
  ) throw new Error('renderer-permission-handoff-unavailable')
  const snapshot = input.lifecycle.snapshot()
  const targetIdentity = changes[0]?.key.identity
  if (
    !targetIdentity || changes.some(record =>
      record.key.identity.pluginId !== targetIdentity.pluginId
      || record.key.identity.source !== targetIdentity.source
    )
  ) throw new Error('renderer-permission-handoff-unavailable')
  const cohort = input.participants.ownerPeers().map(peer => {
    const id = peer.identity.rendererId
    const entry = input.entries.get(id)
    const configured = entry?.configuredChannel
    if (
      !entry || entry.peer !== peer || !entry.bootstrapConfirmed || !entry.policies
      || entry.channelTransition || entry.lifecycleTransition || entry.pendingIdentity
      || !input.current(id, entry) || Boolean(channel) !== Boolean(configured)
      || configured && !configured.isCurrent() || !attachmentEqual(entry.snapshot, snapshot)
      || !attachmentEqual(entry.policies, previous)
    ) throw new Error('renderer-permission-handoff-unavailable')
    const configuredPlugin = entry.configuredPlugins?.find(plugin => plugin.pluginId === targetIdentity.pluginId)
    const binding = entry.identityContext ?? configured?.permissionContext() ?? configuredPlugin?.permissionContext()
    if (!binding || binding.rendererId !== id) throw new Error('renderer-permission-handoff-unavailable')
    if (adapterTarget?.kind === 'installed' && entry.unavailableInstalledPlugins?.has(targetIdentity.pluginId)) {
      const unavailable = entry.unavailableInstalledPlugins
      const projection = entry.identity
      const alias = entry.identityAliases?.get(targetIdentity.pluginId)
      const active = snapshot.active.plugins.find(plugin => plugin.id === targetIdentity.pluginId)
      const omittedCurrent = () => {
        try {
          if (
            !projection || !alias || !active || !active.enabled || active.digest !== adapterTarget.digest
            || active.moduleGeneration !== adapterTarget.moduleGeneration
            || entry.unavailableInstalledPlugins !== unavailable || !unavailable.has(targetIdentity.pluginId)
            || entry.identity !== projection || entry.identityAliases?.get(targetIdentity.pluginId) !== alias
            || entry.leases.some(lease => lease.pluginId === targetIdentity.pluginId)
          ) return false
          const resolved = projection.resolveLifecycle(binding, alias, targetIdentity.pluginId, active)
          return resolved.source === targetIdentity.source && resolved.digest === adapterTarget.digest
        } catch {
          return false
        }
      }
      if (!omittedCurrent()) throw new Error('renderer-permission-handoff-unavailable')
      // This renderer has an owner-verified placeholder and no graph lease, so
      // it cannot retain a grant. Its owner snapshot still advances below.
      return { id, entry, configured, peer, target: undefined, omittedCurrent }
    }
    const target = input.target({ ...binding, admitted: true }, targetIdentity.pluginId)
    if (
      !target.isCurrent() || target.ownerIdentity.id !== targetIdentity.pluginId
      || target.ownerIdentity.source !== targetIdentity.source
    ) throw new Error('renderer-permission-handoff-unavailable')
    return { id, entry, configured, peer, target, omittedCurrent: undefined }
  })
  const writer = cohort.find(item => item.id === origin.rendererId)
  if (
    changes.length === 0 || changes.length > 2
    || adapterTarget === undefined && (!writer?.target || cohort.length === 0)
    || adapterTarget !== undefined && (writer !== undefined || !adapterTarget.isCurrent()
        || !origin.additionalPeers?.some(peer => peer.identity.rendererId === origin.rendererId))
  ) {
    throw new Error('renderer-permission-handoff-unavailable')
  }
  const writerTarget = adapterTarget ?? writer!.target!
  if (
    writerTarget.ownerIdentity.id !== targetIdentity.pluginId
    || writerTarget.ownerIdentity.source !== targetIdentity.source
  ) throw new Error('renderer-permission-handoff-unavailable')
  if (
    cohort.some(item =>
      item.target !== undefined && (
        item.target.kind !== writerTarget.kind || item.target.digest !== writerTarget.digest
        || !attachmentEqual(item.target.artifact, writerTarget.artifact)
        || item.target.kind === 'installed' && item.target.moduleGeneration !== writerTarget.moduleGeneration
      )
    )
  ) {
    throw new Error('renderer-permission-handoff-unavailable')
  }
  const projected = writerTarget.project(changes)
  if (!attachmentEqual(writerTarget.resolve(projected.policies), changes)) {
    throw new Error('renderer-permission-handoff-unavailable')
  }
  let reservation: Awaited<ReturnType<ReadonlyChannelRendererBridge['suspendAll']>> | undefined
  let ended = false
  let started = false
  let wrote = false
  let completing = false
  let originReleaseAttempted = false
  const transition = { isCurrent: () => current() }
  const current = () => {
    try {
      return !ended && ownerLive() && (reservation?.isCurrent() ?? true)
        && attachmentEqual(input.lifecycle.snapshot(), snapshot)
        && cohort.every(({ id, entry, configured, target, omittedCurrent }) =>
          entry.lifecycleTransition === transition && input.current(id, entry)
          && (target?.isCurrent() ?? omittedCurrent?.() === true)
          && (configured === undefined || configured.isCurrent())
        )
    } catch {
      return false
    }
  }
  const inputsCurrent = async () => {
    if (!current()) return false
    const checks = await Promise.all([
      ...cohort.map(async ({ entry }) =>
        await serviceRendererPermissionInputsCurrent({
          entry,
          profileId: input.profileId,
          pluginId: targetIdentity.pluginId,
          signal: context.signal,
          isCurrent: current,
        })
      ),
      ...(adapterTarget?.verifyCurrent === undefined ? [] : [adapterTarget.verifyCurrent()]),
    ])
    return current() && checks.every(Boolean)
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
    if (originReleaseAttempted) {
      // The origin may already have released the lifecycle fence, so its
      // fence() can no longer prevent a fresh attachment after an uncertain
      // final consumer release. Require owner reconciliation instead.
      try {
        input.lifecycle.terminal(new Error('renderer-permission-handoff-unavailable'))
      } catch { /* continue closing the Manager cohort */ }
    }
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
    if (channel) reservation = await channel.bridge.suspendAll(cohort.map(item => item.id))
    const drained = await Promise.all(cohort.map(async item => await input.readLifetimes.drainCurrent(item.id)))
    if (
      drained.some(value => !value) || !await inputsCurrent()
      || !attachmentEqual(await input.policies(), previous) || !current()
    ) {
      throw new Error('renderer-permission-handoff-unavailable')
    }
    return {
      isCurrent: inputsCurrent,
      async run<T>(action: () => Promise<T>): Promise<T> {
        try {
          if (started || !await inputsCurrent()) throw new Error('renderer-permission-handoff-unavailable')
          started = true
          const value = await permissionFence.runPolicyMutation({
            expected: previous,
            updates: changes,
            isCurrent: current,
          }, action)
          wrote = true
          if (!await inputsCurrent()) throw new Error('renderer-permission-handoff-unavailable')
          return value
        } catch (error) {
          fence()
          throw error
        }
      },
      async complete(raw): Promise<boolean> {
        if (!wrote || completing || !await inputsCurrent()) {
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
          // A paused consumer may still hold the old policy. Require an exact
          // owner-scoped readback before either fleet is allowed to resume.
          const receipt = await adoptOtherConsumers(consumers, {
            profileId: input.profileId,
            ownerGeneration: input.generation,
            requestId,
            expected: previous,
            updates: changes,
            candidate,
          }, context.signal)
          if (
            !await inputsCurrent() || !attachmentEqual(receipt, {
              profileId: input.profileId,
              ownerGeneration: input.generation,
              requestId,
              adopted: true,
              candidate,
            })
          ) throw new Error('renderer-permission-handoff-unavailable')
          const scope = writer?.peer.scope
            ?? origin.additionalPeers?.find(peer => peer.identity.rendererId === origin.rendererId)?.scope
          if (!scope) throw new Error('renderer-permission-handoff-unavailable')
          const confirm = async (items: typeof cohort) =>
            await synchronizeServiceRendererPolicies({
              scope,
              peers: items.flatMap(item => {
                const target = item.target
                return target === undefined ? [] : [{
                  peer: item.peer,
                  origin: item === writer,
                  project: (records: readonly CordisXPersistedPermissionPolicyRecord[]) => target.project(records),
                }]
              }),
              requestId,
              expected: previous,
              updates: changes,
              candidate,
              isCurrent: current,
              fence,
            })
          // The writer must have an explicit in-flight adoption path; ordinary
          // peer adoption waits for its own write and would deadlock here.
          if (!await confirm(cohort.filter(item => item !== writer)) || writer && !await confirm([writer])) {
            throw new Error('renderer-permission-handoff-unavailable')
          }
          for (const { entry } of cohort) entry.policies = candidate
          if (reservation) {
            for (const item of cohort) await item.configured!.handoff(reservation.forRenderer(item.id))
          }
          if (!await inputsCurrent() || reservation && !reservation.release()) {
            throw new Error('renderer-permission-handoff-unavailable')
          }
          for (const { entry } of cohort) delete entry.lifecycleTransition
          originReleaseAttempted = true
          if (!origin.release()) throw new Error('renderer-permission-handoff-unavailable')
          // Keep other consumers fenced until every earlier release succeeds.
          if (!consumers.release()) throw new Error('renderer-permission-handoff-unavailable')
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
