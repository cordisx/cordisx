import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { normalizePluginActivation } from './plugin-activation.js'
import type { PluginLifecycleRuntime, PluginRuntimeMutation, PluginRuntimePreflight } from './plugin-lifecycle-model.js'
import {
  type AttachedRendererPeer,
  attachmentEqual,
  parseAttachmentScope,
  type RendererAttachmentScope,
} from './renderer-lifecycle-peer.js'
import { RendererLifecycleFederation } from './renderer-lifecycle-federation.js'
import { assertServiceMutationAllowed, createServicePluginRuntime } from './service-plugin-runtime.js'
import {
  type PluginGenerationArtifactServer,
  type PluginGenerationGraphLease,
  startPluginGenerationArtifactServer,
} from './plugin-generation-artifact-server.js'

type Mode = 'headless' | 'renderers'
type ActiveTransaction = {
  readonly id: string
  readonly mode: Mode
  readonly runtime: PluginLifecycleRuntime
  candidate?: CordisXPluginActivationRecordV1
  epoch?: number
  affected?: readonly string[]
  leases?: readonly PluginGenerationGraphLease[]
}

/**
 * One service owner, one package coordinator and one managed backend fleet.
 * Renderer transport and the scoped projection are intentionally absent by
 * default. Only trusted owner code may opt in and attach attested peers.
 */
export class ServiceRendererLifecycle implements PluginLifecycleRuntime {
  private readonly headless
  private readonly scope: RendererAttachmentScope
  private readonly projectMutation:
    | ConstructorParameters<typeof RendererLifecycleFederation>[0]['projectMutation']
    | undefined
  private readonly members = new Map<string, { peer: AttachedRendererPeer; unsubscribe: () => void }>()
  private readonly joiningPeers = new Set<AttachedRendererPeer>()
  private readonly activeLeases = new Map<string, PluginGenerationGraphLease>()
  private readonly activationListeners = new Set<(active: CordisXPluginActivationRecordV1) => void>()
  private readonly createArtifactServer: () => Promise<PluginGenerationArtifactServer>
  private artifactServerPromise: Promise<PluginGenerationArtifactServer> | undefined
  private federation: RendererLifecycleFederation | undefined
  private active: CordisXPluginActivationRecordV1 | undefined
  private initialized = false
  private registryEpoch = 0
  private joining = 0
  private reservation: { id: string; mode: Mode; invalid: boolean; ready: boolean } | undefined
  private transaction: ActiveTransaction | undefined
  private pendingAdoption: { mode: Mode; epoch: number } | undefined
  private terminalFailure = false
  private closed = false

  constructor(input: {
    readonly scope: RendererAttachmentScope
    /** Must be supplied by the owner; never accept raw mutations or capabilities from a renderer. */
    readonly projectMutation?: ConstructorParameters<typeof RendererLifecycleFederation>[0]['projectMutation']
    /** Host-private factory; production creates a loopback server lazily. */
    readonly createArtifactServer?: () => Promise<PluginGenerationArtifactServer>
  }) {
    this.scope = Object.freeze({ ...parseAttachmentScope(input.scope) })
    this.headless = createServicePluginRuntime(this.scope.generation)
    this.projectMutation = input.projectMutation
    this.createArtifactServer = input.createArtifactServer ?? startPluginGenerationArtifactServer
  }

  /** Call after package recovery and before admitting any renderer or request. */
  initialize(active: CordisXPluginActivationRecordV1): void {
    if (this.initialized || this.closed || this.transaction || this.pendingAdoption) {
      throw new Error('service renderer lifecycle already initialized or unavailable')
    }
    const snapshot = this.validateActive(active)
    if (this.active !== undefined && !attachmentEqual(this.active, snapshot)) {
      throw new Error('service renderer recovered activation disagrees')
    }
    this.active = snapshot
    this.initialized = true
  }

  get requiresReconciliation(): boolean {
    return this.terminalFailure || this.pendingAdoption !== undefined
      || this.federation?.requiresReconciliation === true
  }

  private validateActive(active: CordisXPluginActivationRecordV1): CordisXPluginActivationRecordV1 {
    const value = normalizePluginActivation(active)
    if (
      value.recordKind !== 'active' || value.profileId !== this.scope.profileId
      || value.runtimeGeneration !== this.scope.generation
    ) throw new Error('service renderer owner snapshot is invalid')
    return value
  }

  private assertIdle(): void {
    if (
      !this.initialized || !this.active || this.closed || this.requiresReconciliation || this.joining > 0
      || this.reservation
      || this.transaction
    ) throw new Error('service renderer lifecycle is unavailable')
  }

  /** Trusted owner bootstrap can bind a renderer to this exact idle snapshot. */
  snapshot(): Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }> {
    this.assertIdle()
    return { active: structuredClone(this.active!), registryEpoch: this.registryEpoch }
  }

  /** Trusted owner cleanup hook, called only after every renderer has finalized. */
  onActivationFinalized(listener: (active: CordisXPluginActivationRecordV1) => void): () => void {
    if (this.closed) throw new Error('service renderer lifecycle is unavailable')
    this.activationListeners.add(listener)
    return () => this.activationListeners.delete(listener)
  }

  private releaseUnusedFederation(): void {
    if (
      this.members.size === 0 && this.joining === 0 && !this.reservation && !this.transaction
      && !this.pendingAdoption && !this.federation?.requiresReconciliation
    ) {
      this.federation = undefined
      try {
        for (const lease of this.activeLeases.values()) lease.retire()
        this.activeLeases.clear()
      } catch {
        this.terminalFailure = true
      }
    }
  }

  /** Transport must authenticate and attest this exact peer before calling attach. */
  async attach(peer: AttachedRendererPeer): Promise<void> {
    if (this.projectMutation === undefined) {
      peer.close()
      throw new Error('service renderer attachment is disabled')
    }
    if (
      !this.initialized || !this.active || this.closed || this.requiresReconciliation || this.reservation
      || this.transaction
      || this.members.has(peer.identity.rendererId) || peer.closed
    ) {
      peer.close()
      throw new Error('service renderer attachment is unavailable')
    }
    const federation = this.federation ??= new RendererLifecycleFederation({
      scope: this.scope,
      active: this.active,
      registryEpoch: this.registryEpoch,
      projectMutation: this.projectMutation,
    })
    this.joining += 1
    this.joiningPeers.add(peer)
    try {
      await federation.attach(peer)
      const unsubscribe = peer.onDisconnect(() => {
        if (this.members.get(peer.identity.rendererId)?.peer === peer) this.members.delete(peer.identity.rendererId)
        if (this.reservation?.mode === 'renderers') this.reservation.invalid = true
        this.releaseUnusedFederation()
      })
      if (this.closed || peer.closed || this.members.has(peer.identity.rendererId)) {
        unsubscribe()
        throw new Error('service renderer attachment became stale')
      }
      this.members.set(peer.identity.rendererId, { peer, unsubscribe })
    } catch (error) {
      peer.close()
      throw error
    } finally {
      this.joining -= 1
      this.joiningPeers.delete(peer)
      this.releaseUnusedFederation()
    }
  }

  async preflight(input: PluginRuntimePreflight): Promise<void> {
    this.assertIdle()
    if (!attachmentEqual(normalizePluginActivation(input.previous), this.active)) {
      throw new Error('service renderer owner activation is stale')
    }
    assertServiceMutationAllowed(input)
    const mode: Mode = this.members.size > 0 ? 'renderers' : 'headless'
    const reservation = { id: input.transactionId, mode, invalid: false, ready: false }
    this.reservation = reservation
    try {
      if (mode === 'renderers') await this.federation!.preflight(input)
      if (this.reservation !== reservation || reservation.invalid || this.closed || this.requiresReconciliation) {
        throw new Error('service renderer admission became stale')
      }
      reservation.ready = true
    } catch (error) {
      this.federation?.cancelPreflight(input.transactionId)
      this.reservation = undefined
      this.releaseUnusedFederation()
      throw error
    }
  }

  prepare(transactionId: string) {
    // A concurrent caller cannot consume or cancel a preflight which is still
    // resolving the participant projections.
    if (this.reservation?.id === transactionId && !this.reservation.ready) {
      throw new Error('service renderer admission is still in progress')
    }
    if (this.reservation === undefined && this.members.size > 0) {
      throw new Error('service renderer admission is required')
    }
    if (
      !this.initialized || !this.active || this.closed || this.requiresReconciliation || this.joining > 0
      || this.transaction
      || (this.reservation && (this.reservation.id !== transactionId || this.reservation.invalid))
    ) {
      this.federation?.cancelPreflight(transactionId)
      if (this.reservation?.id === transactionId) this.reservation = undefined
      this.releaseUnusedFederation()
      throw new Error('service renderer transaction is unavailable')
    }
    const mode: Mode = this.reservation?.mode ?? (this.members.size > 0 ? 'renderers' : 'headless')
    const runtime = mode === 'renderers' ? this.federation : this.headless
    if (!runtime?.prepare) throw new Error('service renderer transaction runtime is unavailable')
    try {
      const fence = runtime.prepare(transactionId)
      if (fence.expectedRegistryEpoch !== this.registryEpoch) {
        this.terminalFailure = true
        throw new Error('service renderer registry epoch disagrees')
      }
      this.transaction = { id: transactionId, mode, runtime }
      return fence
    } finally {
      this.federation?.cancelPreflight(transactionId)
      this.reservation = undefined
      this.releaseUnusedFederation()
    }
  }

  private current(id: string): ActiveTransaction {
    if (this.closed || this.terminalFailure || this.transaction?.id !== id) {
      throw new Error('service renderer transaction requires reconciliation')
    }
    return this.transaction
  }

  requiresBrowserArtifacts(transactionId: string): boolean {
    const tx = this.current(transactionId)
    if (tx.mode === 'renderers' && this.federation?.requiresReconciliation) {
      throw new Error('service renderer transaction requires reconciliation')
    }
    return tx.mode === 'renderers'
  }

  /** Reused by trusted owner bootstrap and candidate projection; never returned to a browser. */
  async artifactServer(): Promise<PluginGenerationArtifactServer> {
    if (this.closed || this.projectMutation === undefined) throw new Error('renderer artifact authority is unavailable')
    const pending = this.artifactServerPromise ??= this.createArtifactServer()
    let server: PluginGenerationArtifactServer
    try {
      server = await pending
    } catch (error) {
      if (this.artifactServerPromise === pending) this.artifactServerPromise = undefined
      throw error
    }
    if (this.closed) {
      await server.close()
      throw new Error('renderer artifact authority is unavailable')
    }
    return server
  }

  async browserArtifactServer(transactionId: string): Promise<PluginGenerationArtifactServer> {
    if (!this.requiresBrowserArtifacts(transactionId)) throw new Error('renderer artifact authority is unavailable')
    const server = await this.artifactServer()
    if (!this.requiresBrowserArtifacts(transactionId)) throw new Error('renderer artifact authority is unavailable')
    return server
  }

  async stage(mutation: PluginRuntimeMutation) {
    const tx = this.current(mutation.transactionId)
    const leases = [
      ...(mutation.runtimeArtifactLease === undefined ? [] : [mutation.runtimeArtifactLease]),
      ...(mutation.runtimeArtifactLeases ?? []),
    ]
    tx.leases = [...new Map(leases.map(lease => [lease.leaseId, lease])).values()]
    tx.affected = [...mutation.affectedPluginIds]
    assertServiceMutationAllowed(mutation)
    if (
      tx.leases.some(lease => {
        const plugin = mutation.candidate.plugins.find(item => item.id === lease.pluginId)
        return plugin?.enabled !== true || plugin.moduleGeneration !== lease.moduleGeneration
          || !mutation.affectedPluginIds.includes(lease.pluginId)
      }) || new Set(tx.leases.map(lease => lease.pluginId)).size !== tx.leases.length
    ) {
      throw new Error('renderer artifact leases do not match the frozen candidate')
    }
    tx.candidate = mutation.candidate
    return await tx.runtime.stage(mutation)
  }

  async publish(id: string) {
    const tx = this.current(id)
    const result = await tx.runtime.publish!(id)
    tx.epoch = result.registryEpoch
    return result
  }

  async complete(id: string) {
    return await this.current(id).runtime.complete!(id)
  }

  async finalize(id: string): Promise<void> {
    const tx = this.current(id)
    if (!tx.candidate || tx.epoch === undefined) throw new Error('service renderer transaction is incomplete')
    await tx.runtime.finalize!(id)
    if (tx.mode === 'renderers') this.headless.adoptRegistryEpoch(tx.epoch)
    const nextLeases = new Map((tx.leases ?? []).map(lease => [lease.pluginId, lease]))
    for (const pluginId of tx.affected ?? []) {
      const previous = this.activeLeases.get(pluginId)
      const next = nextLeases.get(pluginId)
      const previousPlugin = this.active?.plugins.find(plugin => plugin.id === pluginId)
      const candidatePlugin = tx.candidate.plugins.find(plugin => plugin.id === pluginId)
      if (
        previous && (next !== undefined || candidatePlugin?.enabled !== true
          || previousPlugin?.moduleGeneration !== candidatePlugin.moduleGeneration)
      ) {
        previous.retire()
        this.activeLeases.delete(pluginId)
      }
      if (next !== undefined) this.activeLeases.set(pluginId, next)
    }
    const { transactionId: _transactionId, ...candidate } = tx.candidate
    void _transactionId
    this.active = this.validateActive({ ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision })
    this.registryEpoch = tx.epoch
    this.transaction = undefined
    try {
      for (const listener of this.activationListeners) listener(this.active)
    } catch (error) {
      this.terminalFailure = true
      throw error
    }
    this.releaseUnusedFederation()
  }

  async rollback(id: string) {
    const tx = this.current(id)
    let result
    try {
      result = await tx.runtime.rollback!(id)
    } catch (error) {
      this.terminalFailure = true
      for (const member of this.members.values()) member.peer.close()
      throw error
    } finally {
      for (const lease of tx.leases ?? []) lease.retire()
    }
    if (tx.mode === 'renderers') this.headless.adoptRegistryEpoch(result.registryEpoch)
    this.registryEpoch = result.registryEpoch
    this.active = this.validateActive(result.active)
    this.pendingAdoption = { mode: tx.mode, epoch: result.registryEpoch }
    this.transaction = undefined
    return result
  }

  async recoverRollback(plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) {
    if (this.closed || this.transaction || this.members.size > 0) {
      throw new Error('service renderer recovery is unavailable')
    }
    const result = await this.headless.recoverRollback!(plan)
    this.registryEpoch = result.registryEpoch
    this.pendingAdoption = { mode: 'headless', epoch: result.registryEpoch }
    return result
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const pending = this.pendingAdoption
    if (!pending || pending.epoch !== registryEpoch || this.closed) {
      throw new Error('service renderer recovery adoption is unavailable')
    }
    const confirmed = this.validateActive(active)
    if (pending.mode === 'renderers') await this.federation!.adoptRecoveredActivation(confirmed, registryEpoch)
    this.active = confirmed
    this.pendingAdoption = undefined
    this.releaseUnusedFederation()
  }

  async abort(id: string): Promise<void> {
    const tx = this.current(id)
    await tx.runtime.abort(id)
    this.transaction = undefined
    this.releaseUnusedFederation()
  }

  async commit(): Promise<void> {
    throw new Error('Service runtime requires a package authority transaction')
  }

  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    return await this.headless.reload(input)
  }

  terminal(error: unknown): void {
    this.terminalFailure = true
    this.federation?.terminal()
    for (const peer of this.joiningPeers) peer.close()
    for (const member of this.members.values()) member.peer.close()
    this.headless.terminal?.(error)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const peer of this.joiningPeers) peer.close()
    this.joiningPeers.clear()
    for (const member of this.members.values()) {
      member.unsubscribe()
      member.peer.close()
    }
    this.members.clear()
    for (const lease of this.activeLeases.values()) lease.retire()
    this.activeLeases.clear()
    for (const lease of this.transaction?.leases ?? []) lease.retire()
    this.activationListeners.clear()
    const server = await this.artifactServerPromise?.catch(() => undefined)
    await server?.close()
  }
}
