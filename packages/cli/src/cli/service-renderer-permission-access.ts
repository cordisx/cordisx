import type { SharedProfilePermissionFence } from '../config/profile-permission-fence.js'
import { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../permission-persistence.js'
import type { ManagerOriginFence } from './manager-origin-fence.js'
import type { ManagerRendererReadLifetimes } from './manager-renderer-read-lifetimes.js'
import type { ManagerRendererChannelContext } from './manager-renderer-sessions.js'
import type { OwnerRendererLifecycle } from './owner-renderer-lifecycle.js'
import type {
  ServiceRendererBootstrapEntry,
  ServiceRendererConfiguredChannelInput,
} from './service-renderer-bootstrap-state.js'
import {
  reserveServiceRendererPermissionHandoff,
  type ServiceRendererPermissionConsumerFence,
} from './service-renderer-permission-handoff.js'
import type { ServiceRendererParticipants } from './service-renderer-participant.js'

/** Owner-private access to the exact configured Channel and its policy cohort. */
export class ServiceRendererPermissionAccess {
  constructor(
    private readonly input: {
      readonly profileId: string
      readonly generation: string
      readonly channel: () => ServiceRendererConfiguredChannelInput | undefined
      readonly permissionFence: SharedProfilePermissionFence | undefined
      readonly entries: Map<string, ServiceRendererBootstrapEntry>
      readonly participants: ServiceRendererParticipants
      readonly lifecycle: OwnerRendererLifecycle
      readonly readLifetimes: ManagerRendererReadLifetimes
      readonly policies: () => Promise<readonly CordisXPersistedPermissionPolicyRecord[]>
      readonly current: (rendererId: string, entry: ServiceRendererBootstrapEntry) => boolean
    },
  ) {}

  private entry(context: ManagerRendererChannelContext): ServiceRendererBootstrapEntry {
    const entry = this.input.entries.get(context.rendererId)
    if (
      !entry?.bootstrapConfirmed || !entry.policies || !entry.configuredChannel
      || !this.input.current(context.rendererId, entry) || !entry.configuredChannel.isPermissionContextCurrent(context)
      || entry.lifecycleTransition && !entry.lifecycleTransition.isCurrent()
      || entry.channelTransition && !entry.channelTransition.isCurrent()
    ) throw new Error('renderer-permission-handoff-unavailable')
    return entry
  }

  snapshot(context: ManagerRendererChannelContext): readonly CordisXPersistedPermissionPolicyRecord[] {
    return structuredClone(this.entry(context).policies!)
  }

  resolve(records: readonly CordisXPersistedPermissionPolicyRecord[], context: ManagerRendererChannelContext) {
    return this.entry(context).configuredChannel!.resolvePermissionPolicies(context, records)
  }

  project(records: readonly CordisXPersistedPermissionPolicyRecord[], context: ManagerRendererChannelContext) {
    return this.entry(context).configuredChannel!.projectPermissionPolicies(records).policies
  }

  evidence(context: ManagerRendererChannelContext) {
    const configured = this.entry(context).configuredChannel!
    return { ...configured.projectPermissionPolicies([]), artifact: configured.permissionArtifact(context) }
  }

  async reserve(
    origin: ManagerOriginFence,
    context: ManagerRendererChannelContext,
    requestId: string,
    expected: readonly CordisXPersistedPermissionPolicyRecord[],
    updates: readonly CordisXPersistedPermissionPolicyRecord[],
    consumers: ServiceRendererPermissionConsumerFence,
  ) {
    if (!(this.input.lifecycle instanceof ServiceRendererLifecycle)) {
      try {
        consumers.fence()
      } catch { /* the reservation remains unavailable */ }
      try {
        origin.fence()
      } catch { /* the reservation remains unavailable */ }
      throw new Error('renderer-permission-handoff-unavailable')
    }
    return await reserveServiceRendererPermissionHandoff(
      {
        profileId: this.input.profileId,
        generation: this.input.generation,
        channel: this.input.channel(),
        permissionFence: this.input.permissionFence,
        entries: this.input.entries,
        participants: this.input.participants,
        lifecycle: this.input.lifecycle,
        readLifetimes: this.input.readLifetimes,
        policies: this.input.policies,
        current: this.input.current,
      },
      origin,
      context,
      requestId,
      expected,
      updates,
      consumers,
    )
  }
}
