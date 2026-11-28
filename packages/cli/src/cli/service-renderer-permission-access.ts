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
import { installedManagerPermissionTarget, type ManagerPolicyTarget } from './service-renderer-installed-permission.js'
import { configuredManagerPermissionTarget } from './service-renderer-configured-permission.js'
import { attachmentEqual } from '../launcher/renderer-lifecycle-peer.js'
import { ServiceRendererRuntimeGrants } from './service-renderer-runtime-grants.js'

export interface ServiceRendererPermissionEvidence {
  readonly kind: ManagerPolicyTarget['kind']
  readonly identity: { readonly id: string; readonly source: string }
  readonly ownerIdentity: { readonly id: string; readonly source: string }
  readonly moduleGeneration: string
  readonly digest: `sha256:${string}`
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
  readonly policies: readonly CordisXPersistedPermissionPolicyRecord[]
  isCurrent(): boolean
}

/** Owner-private access to exact renderer-projected policy targets. */
export class ServiceRendererPermissionAccess {
  readonly runtimeOnceGrants = new ServiceRendererRuntimeGrants()
  private readonly issuedEvidence = new WeakSet<ServiceRendererPermissionEvidence>()
  constructor(
    private readonly input: {
      readonly profileId: string
      readonly generation: string
      readonly configuredPolicyEnabled: boolean
      readonly configuredPluginPolicyEnabled: boolean
      readonly installedPolicyEnabled: boolean
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

  /** Hold the same profile policy fence for an admitted native adapter. */
  async acquireAdapterPermissionFence(): Promise<() => Promise<void>> {
    if (!this.input.permissionFence) throw new Error('renderer-permission-handoff-unavailable')
    return await this.input.permissionFence.acquire()
  }

  private entry(context: ManagerRendererChannelContext): ServiceRendererBootstrapEntry {
    const entry = this.input.entries.get(context.rendererId)
    if (
      !entry?.bootstrapConfirmed || !entry.policies || context.admitted !== true || context.signal.aborted
      || context.profileId !== this.input.profileId || context.ownerGeneration !== this.input.generation
      || entry.peer.identity.rendererId !== context.rendererId || !this.input.current(context.rendererId, entry)
      || entry.lifecycleTransition && !entry.lifecycleTransition.isCurrent()
      || entry.channelTransition && !entry.channelTransition.isCurrent()
    ) throw new Error('renderer-permission-handoff-unavailable')
    return entry
  }

  snapshot(context: ManagerRendererChannelContext): readonly CordisXPersistedPermissionPolicyRecord[] {
    return structuredClone(this.entry(context).policies!)
  }

  resolve(records: readonly CordisXPersistedPermissionPolicyRecord[], context: ManagerRendererChannelContext) {
    const pluginId = records[0]?.key.identity.pluginId
    if (!pluginId || records.some(record => record.key.identity.pluginId !== pluginId)) {
      throw new Error('renderer-permission-handoff-unavailable')
    }
    return this.target(context, pluginId).resolve(records)
  }

  project(
    records: readonly CordisXPersistedPermissionPolicyRecord[],
    context: ManagerRendererChannelContext,
    pluginId = 'channel',
  ) {
    return this.target(context, pluginId).project(records).policies
  }

  evidence(context: ManagerRendererChannelContext, pluginId = 'channel'): ServiceRendererPermissionEvidence {
    const target = this.target(context, pluginId)
    const evidence: ServiceRendererPermissionEvidence = {
      ...target.project([]),
      kind: target.kind,
      artifact: target.artifact,
      ownerIdentity: target.ownerIdentity,
      digest: target.digest,
      isCurrent: target.isCurrent,
    }
    Object.freeze(evidence.ownerIdentity)
    Object.freeze(evidence.identity)
    Object.freeze(evidence.artifact)
    Object.freeze(evidence)
    this.issuedEvidence.add(evidence)
    return evidence
  }

  isCurrentEvidence(evidence: ServiceRendererPermissionEvidence): boolean {
    try {
      return this.issuedEvidence.has(evidence) && evidence.isCurrent() === true
    } catch {
      return false
    }
  }

  /** History is read-only and remains visible when an installed plugin is disabled. */
  historyIdentity(context: ManagerRendererChannelContext, pluginId: string): {
    readonly ownerIdentity: { readonly id: string; readonly source: string }
    isCurrent(): boolean
  } {
    const entry = this.entry(context)
    const alias = entry.identityAliases?.get(pluginId)
    if (!alias) {
      const evidence = this.evidence(context, pluginId)
      return { ownerIdentity: evidence.ownerIdentity, isCurrent: () => this.isCurrentEvidence(evidence) }
    }
    const identity = entry.identity
    const snapshot = entry.snapshot
    const item = snapshot?.active.plugins.find(plugin => plugin.id === pluginId)
    if (!identity || !snapshot || !item || !attachmentEqual(snapshot, this.input.lifecycle.snapshot())) {
      throw new Error('renderer-permission-history-unavailable')
    }
    const ownerIdentity = Object.freeze(identity.resolveHistory(context, alias, item))
    const current = () => {
      try {
        return this.entry(context) === entry && entry.identity === identity && entry.snapshot === snapshot
          && entry.identityAliases?.get(pluginId) === alias
          && attachmentEqual(snapshot, this.input.lifecycle.snapshot())
          && attachmentEqual(ownerIdentity, identity.resolveHistory(context, alias, item))
      } catch {
        return false
      }
    }
    if (!current()) throw new Error('renderer-permission-history-unavailable')
    return Object.freeze({ ownerIdentity, isCurrent: current })
  }

  private target(context: ManagerRendererChannelContext, pluginId: string): ManagerPolicyTarget {
    const entry = this.entry(context)
    if (entry.identityAliases?.has(pluginId)) {
      if (!this.input.installedPolicyEnabled) throw new Error('renderer-permission-handoff-unavailable')
      return installedManagerPermissionTarget({
        entry,
        context,
        pluginId,
        lifecycle: this.input.lifecycle,
        current: () => this.input.current(context.rendererId, entry),
      })
    }
    const plugins = entry.configuredPlugins?.filter(plugin => plugin.pluginId === pluginId) ?? []
    if (plugins.length > 0) {
      if (!this.input.configuredPluginPolicyEnabled || plugins.length !== 1) {
        throw new Error('renderer-permission-handoff-unavailable')
      }
      return configuredManagerPermissionTarget({
        entry,
        context,
        plugin: plugins[0]!,
        lifecycle: this.input.lifecycle,
        current: () => this.input.current(context.rendererId, entry),
      })
    }
    const configured = entry.configuredChannel
    const channel = this.input.channel()
    if (
      !this.input.configuredPolicyEnabled || pluginId !== 'channel'
      || !configured?.isPermissionContextCurrent(context) || !channel?.plugin.source
      || !channel.plugin.configuredArchiveDigest
    ) throw new Error('renderer-permission-handoff-unavailable')
    const projection = configured.projectPermissionPolicies([])
    const ownerIdentity = Object.freeze({ id: 'channel', source: channel.plugin.source })
    const artifact = Object.freeze(configured.permissionArtifact(context))
    const digest = channel.plugin.configuredArchiveDigest
    const current = () =>
      this.input.current(context.rendererId, entry) && entry.configuredChannel === configured
      && this.input.channel() === channel && configured.isPermissionContextCurrent(context)
    return Object.freeze({
      kind: 'configured-channel' as const,
      identity: Object.freeze({ ...projection.identity }),
      ownerIdentity,
      moduleGeneration: projection.moduleGeneration,
      digest,
      artifact,
      isCurrent: current,
      project(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
        if (!current()) throw new Error('renderer-permission-handoff-unavailable')
        const value = configured.projectPermissionPolicies(records)
        if (
          !current() || !attachmentEqual(value.identity, projection.identity)
          || value.moduleGeneration !== projection.moduleGeneration
        ) {
          throw new Error('renderer-permission-handoff-unavailable')
        }
        return value
      },
      resolve(records: readonly CordisXPersistedPermissionPolicyRecord[]) {
        if (!current()) throw new Error('renderer-permission-handoff-unavailable')
        const value = configured.resolvePermissionPolicies(context, records)
        if (!current()) throw new Error('renderer-permission-handoff-unavailable')
        return value
      },
    })
  }

  async reserve(
    origin: ManagerOriginFence,
    context: ManagerRendererChannelContext,
    requestId: string,
    expected: readonly CordisXPersistedPermissionPolicyRecord[],
    updates: readonly CordisXPersistedPermissionPolicyRecord[],
    consumers: ServiceRendererPermissionConsumerFence,
    adapterTarget?: ManagerPolicyTarget,
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
        target: (context, pluginId) => this.target(context, pluginId),
      },
      origin,
      context,
      requestId,
      expected,
      updates,
      consumers,
      adapterTarget,
    )
  }
}
