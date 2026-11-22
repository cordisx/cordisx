import type { SharedProfilePluginConfigFence } from '../config/profile-plugin-config-fence.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import type { HostServiceConfigMutationResult } from '../launcher/service-config.js'
import { isCurrentManagerOriginFence, type ManagerOriginFence } from './manager-origin-fence.js'
import type { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import type {
  ServiceRendererBootstrapEntry,
  ServiceRendererConfiguredChannelInput,
} from './service-renderer-bootstrap-state.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/** Hand an owner-committed Channel service generation to the current Manager cohort. */
export async function mutateServiceRendererConfiguredChannel(
  input: {
    readonly generation: string
    readonly channel: ServiceRendererConfiguredChannelInput | undefined
    readonly pluginFence: SharedProfilePluginConfigFence | undefined
    readonly entries: Map<string, ServiceRendererBootstrapEntry>
    readonly participants: ServiceRendererParticipants
    readonly lifecycle: OwnerRendererLifecycle
    readonly readLifetimes: ManagerRendererReadLifetimes
    readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
  },
  origin: ManagerOriginFence,
  action: () => Promise<HostServiceConfigMutationResult>,
): Promise<HostServiceConfigMutationResult> {
  const rendererId = origin.rendererId
  const channel = input.channel
  const pluginFence = input.pluginFence
  const ownerLive = () => {
    try {
      return isCurrentManagerOriginFence(origin, input.participants, input.lifecycle)
    } catch {
      return false
    }
  }
  if (!channel || !pluginFence || !ownerLive()) throw new Error('renderer-configured-channel-unavailable')
  const cohort = input.participants.ownerPeers().map(peer => {
    const id = peer.identity.rendererId
    const entry = input.entries.get(id)
    const configured = entry?.configuredChannel
    if (
      !entry || entry.peer !== peer || !configured || entry.channelTransition || entry.lifecycleTransition
      || !input.current(id, entry) || !configured.isCurrent()
    ) throw new Error('renderer-configured-channel-unavailable')
    return { id, entry, configured, peer }
  })
  if (!cohort.some(item => item.id === rendererId) || !ownerLive()) {
    throw new Error('renderer-configured-channel-unavailable')
  }
  for (const { entry } of cohort) entry.channelTransition = { isCurrent: ownerLive }
  let reservation: Awaited<ReturnType<ReadonlyChannelRendererBridge['suspendAll']>> | undefined
  try {
    await Promise.allSettled(cohort.flatMap(({ entry }) => [...entry.checks]))
    if (
      !ownerLive() || cohort.some(({ id, entry, configured }) => !input.current(id, entry) || !configured.isCurrent())
    ) throw new Error('renderer-configured-channel-unavailable')
    reservation = await channel.bridge.suspendAll(cohort.map(item => item.id))
    const drained = await Promise.all(cohort.map(async item => await input.readLifetimes.drainCurrent(item.id)))
    if (drained.some(value => !value) || !reservation.isCurrent() || !ownerLive()) {
      throw new Error('renderer-configured-channel-unavailable')
    }
    const result = await pluginFence.runServiceMutation({
      pluginId: 'channel',
      serviceId: 'runtime',
      isCurrent: () =>
        ownerLive() && reservation!.isCurrent() && cohort.every(({ id, entry }) => input.current(id, entry)),
    }, async () => {
      const value = await action()
      if (value.status === 'applied') {
        for (const { id, configured } of cohort) {
          await configured.handoff(reservation!.forRenderer(id), {
            generation: value.serviceGeneration,
            revision: value.revision,
          })
        }
      } else if (value.status === 'conflict' || value.status === 'rejected') {
        for (const { id, configured } of cohort) await configured.handoff(reservation!.forRenderer(id))
      } else {
        throw new Error('renderer-configured-channel-result-uncertain')
      }
      return value
    })
    if (!ownerLive() || !reservation.release()) throw new Error('renderer-configured-channel-result-uncertain')
    for (const { entry } of cohort) delete entry.channelTransition
    if (result.status === 'applied') {
      // The writer adopts its own receipt; other pages confirm the new view
      // before the write fence is released, without unmounting their drafts.
      await Promise.all(
        cohort.filter(item => item.id !== rendererId).map(async item => {
          const receipt = await item.peer.request('channel-configuration', {
            rendererId: item.id,
            ownerGeneration: input.generation,
            revision: result.revision,
            projection: item.configured.handoffProjection(),
          })
          if (
            !attachmentEqual(receipt, {
              rendererId: item.id,
              ownerGeneration: input.generation,
              revision: result.revision,
              adopted: true,
            })
          ) throw new Error('renderer-configured-channel-result-uncertain')
        }),
      )
    }
    if (!ownerLive()) throw new Error('renderer-configured-channel-result-uncertain')
    return result
  } catch (error) {
    reservation?.fence()
    for (const { entry } of cohort) {
      delete entry.channelTransition
      entry.peer.close()
    }
    throw error
  }
}
