import { randomBytes, randomUUID } from 'node:crypto'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  PluginRuntimePreflight,
  RuntimeGenerationFence,
} from './plugin-lifecycle-model.js'
import { CdpPluginLifecycleRuntime, type CdpSharedAdmission } from './cdp-plugin-lifecycle-runtime.js'
import {
  createDesktopConfigurationReservation,
  type DesktopConfigurationReservation,
} from './desktop-configuration-reservation.js'
import { sameUniquePluginIds } from './cdp-shared-admission.js'
import { RendererLifecycleFederation } from './renderer-lifecycle-federation.js'
import type { RendererConfigOperation, RendererConfigResult } from './renderer-config-management.js'
import {
  type AttachedRendererPeer,
  attachmentEqual,
  attachmentRecord,
  type RendererAttachmentIdentity,
  type RendererAttachmentMethod,
  type RendererAttachmentScope,
} from './renderer-lifecycle-peer.js'

/**
 * CDP is an owner-internal aggregate, not an externally authenticated peer.
 * Raw lifecycle mutations stay in this process and never enter manager IPC.
 */
class CdpRendererGroup implements AttachedRendererPeer {
  readonly identity: RendererAttachmentIdentity
  readonly sessionId = randomBytes(32).toString('hex')
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private ended = false
  private fence: RuntimeGenerationFence | undefined
  private awaitingAdoption = false

  constructor(
    readonly scope: RendererAttachmentScope,
    private readonly admission: CdpSharedAdmission,
    rendererId: string,
    private readonly transactionId: string,
  ) {
    this.identity = {
      appId: scope.ownerAppId,
      adapterId: 'owner-cdp-group',
      rendererId,
      pid: process.pid,
      processStartedAt: 'owner-process',
    }
    this.unsubscribe = admission.onInvalidated(() => this.close())
  }

  get closed(): boolean {
    return this.ended || this.admission.closed
  }
  setFence(fence: RuntimeGenerationFence): void {
    this.fence = Object.freeze({ ...fence })
  }

  async request(method: RendererAttachmentMethod, payload: unknown): Promise<unknown> {
    if (this.closed) throw new Error('CDP renderer group is unavailable')
    const frame = attachmentRecord(payload)
    if (method === 'synchronize') {
      if (this.awaitingAdoption) {
        await this.admission.adoptRecoveredActivation(
          frame.active as CordisXPluginActivationRecordV1,
          frame.registryEpoch as number,
        )
        this.awaitingAdoption = false
      }
      return await this.admission.readSnapshot()
    }
    if (method === 'prepare') {
      if (!this.fence || !attachmentEqual(frame, { transactionId: this.transactionId, ...this.fence })) {
        throw new Error('CDP renderer group fence is stale')
      }
      return frame
    }
    if (method === 'stage') {
      const mutation = payload as PluginRuntimeMutation
      if (mutation.transactionId !== this.transactionId) throw new Error('CDP renderer group transaction is stale')
      const ready = await this.admission.stage(mutation)
      if (!ready) throw new Error('CDP renderer group did not confirm stage')
      const affected = (ready as typeof ready & { affectedPluginIds?: unknown }).affectedPluginIds
      if (!sameUniquePluginIds(affected, mutation.affectedPluginIds)) {
        throw new Error('CDP renderer group readiness impact disagrees')
      }
      // Normalize to the authority order only after validating the exact closure.
      return { ...ready, affectedPluginIds: [...mutation.affectedPluginIds] }
    }
    if (frame.transactionId !== this.transactionId) throw new Error('CDP renderer group transaction is invalid')
    if (method === 'publish') return await this.admission.publish(frame.transactionId)
    if (method === 'complete') return await this.admission.complete(frame.transactionId)
    if (method === 'finalize') {
      await this.admission.finalize(frame.transactionId)
      return { transactionId: frame.transactionId }
    }
    const restored = await this.admission.rollback(frame.transactionId)
    this.awaitingAdoption = true
    return restored
  }

  onDisconnect(listener: () => void): () => void {
    if (this.closed) listener()
    else this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  close(): void {
    if (this.ended) return
    this.ended = true
    this.unsubscribe()
    for (const listener of this.listeners) {
      try {
        listener()
      } catch { /* isolate listeners */ }
    }
    this.listeners.clear()
  }
}

type Reservation = {
  readonly id: string
  readonly previous: CordisXPluginActivationRecordV1
  readonly managerRevision: number
  readonly admission: CdpSharedAdmission
  readonly group: CdpRendererGroup
  ready: boolean
  prepared: boolean
  preparingGraph: boolean
  pendingAdoption: boolean
}

/**
 * Experimental shared Desktop/Manager barrier. The existing owner must supply
 * its CDP runtime and its per-manager mutation projector. It creates neither a
 * package coordinator nor a managed-service fleet. Callers must separately
 * gate configuration, capabilities, recovery and zero-CDP-seat operation.
 */
export class DesktopRendererLifecycle implements PluginLifecycleRuntime {
  private readonly federation: RendererLifecycleFederation
  private readonly desktopId = `cdp-group-${randomUUID()}`
  private reservation: Reservation | undefined
  private externalConfig: { fence?: () => void } | undefined
  private rollbackInProgress = false
  private failed = false
  private closed = false
  private managerRevision = 0
  private readonly managers = new Set<AttachedRendererPeer>()
  private readonly joiningPeers = new Set<AttachedRendererPeer>()
  private readonly activationListeners = new Set<(active: CordisXPluginActivationRecordV1) => void>()
  private joiningManagers = 0
  private joinTail: Promise<void> = Promise.resolve()
  private joinSnapshot:
    | { admission: CdpSharedAdmission; value: ReturnType<RendererLifecycleFederation['snapshot']> }
    | undefined

  constructor(
    private readonly input: {
      readonly scope: RendererAttachmentScope
      readonly cdp: CdpPluginLifecycleRuntime
      readonly active: CordisXPluginActivationRecordV1
      readonly registryEpoch: number
      readonly projectManagerMutation: (
        mutation: PluginRuntimeMutation,
        identity: RendererAttachmentIdentity,
      ) => unknown | Promise<unknown>
    },
  ) {
    if (input.cdp.currentRegistryEpoch() !== input.registryEpoch) throw new Error('CDP owner epoch is stale')
    this.federation = new RendererLifecycleFederation({
      scope: input.scope,
      active: input.active,
      registryEpoch: input.registryEpoch,
      // The CDP group is local trusted code. Every other peer requires an
      // independently authorized projection with no cross-process lease.
      projectMutation: async (mutation, identity) =>
        identity.rendererId === this.desktopId
          ? mutation.transactionEpoch?.endsWith(':preflight') ? undefined : mutation
          : await input.projectManagerMutation(mutation, identity),
      finalizeLast: identity => identity.rendererId === this.desktopId,
    })
  }

  get requiresReconciliation(): boolean {
    return this.failed || this.federation.requiresReconciliation
  }

  get hasManagerParticipants(): boolean {
    return this.managers.size > 0 || this.joiningManagers > 0
  }

  snapshot(): Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }> {
    if (this.reservation || this.failed) throw new Error('Desktop shared snapshot is unavailable')
    if (this.joinSnapshot && !this.joinSnapshot.admission.closed) return structuredClone(this.joinSnapshot.value)
    // A temporary owner lock ensures at least one CDP seat is ready and no
    // join, reload, configuration or generation transaction is in flight.
    const admission = this.input.cdp.beginSharedAdmission(`snapshot-${randomUUID()}`)
    try {
      const snapshot = this.federation.snapshot()
      if (admission.registryEpoch !== snapshot.registryEpoch) throw new Error('Desktop shared snapshot is stale')
      return snapshot
    } finally {
      admission.release()
    }
  }

  onActivationFinalized(listener: (active: CordisXPluginActivationRecordV1) => void): () => void {
    if (this.failed) throw new Error('Desktop shared lifecycle is unavailable')
    this.activationListeners.add(listener)
    return () => this.activationListeners.delete(listener)
  }

  async attach(peer: AttachedRendererPeer): Promise<void> {
    if (this.failed || this.reservation || this.externalConfig || peer.identity.rendererId === this.desktopId) {
      peer.close()
      throw new Error('Desktop renderer attachment is unavailable')
    }
    this.joiningManagers += 1
    this.joiningPeers.add(peer)
    const joining = this.joinTail.then(async () => {
      let admission: CdpSharedAdmission | undefined
      try {
        if (this.failed || this.reservation || this.externalConfig || peer.closed) {
          throw new Error('Desktop renderer attachment is unavailable')
        }
        admission = this.input.cdp.beginSharedAdmission(`join-${randomUUID()}`)
        const snapshot = this.federation.snapshot()
        this.joinSnapshot = { admission, value: snapshot }
        const observed = await admission.readSnapshot()
        if (!attachmentEqual(snapshot, observed)) throw new Error('Desktop shared snapshot is stale')
        if (this.failed || peer.closed) throw new Error('Desktop renderer attachment is unavailable')
        await this.federation.attach(peer)
        if (this.failed || admission.closed || peer.closed) throw new Error('Desktop shared attachment became stale')
        this.managers.add(peer)
        this.managerRevision += 1
        peer.onDisconnect(() => {
          this.managers.delete(peer)
          this.managerRevision += 1
        })
      } catch (error) {
        peer.close()
        throw error
      } finally {
        if (this.joinSnapshot?.admission === admission) this.joinSnapshot = undefined
        admission?.release()
      }
    })
    this.joinTail = joining.then(() => undefined, () => undefined)
    try {
      await joining
    } finally {
      this.joiningManagers -= 1
      this.joiningPeers.delete(peer)
    }
  }

  async preflight(input: PluginRuntimePreflight): Promise<void> {
    if (
      this.failed || this.reservation || this.externalConfig || this.joiningManagers > 0
      || this.federation.requiresReconciliation
    ) {
      throw new Error('Desktop shared preflight is unavailable')
    }
    const admission = this.input.cdp.beginSharedAdmission(input.transactionId)
    const group = new CdpRendererGroup(this.input.scope, admission, this.desktopId, input.transactionId)
    const reservation: Reservation = {
      id: input.transactionId,
      previous: structuredClone(input.previous),
      managerRevision: this.managerRevision,
      admission,
      group,
      ready: false,
      prepared: false,
      preparingGraph: false,
      pendingAdoption: false,
    }
    this.reservation = reservation
    try {
      await this.federation.attach(group)
      if (!attachmentEqual(this.federation.snapshot().active, input.previous)) {
        throw new Error('Desktop shared activation is stale')
      }
      await this.federation.preflight(input)
      if (
        group.closed || this.reservation !== reservation || reservation.managerRevision !== this.managerRevision
      ) throw new Error('Desktop shared preflight is stale')
      reservation.ready = true
    } catch (error) {
      this.federation.cancelPreflight(input.transactionId)
      group.close()
      admission.release()
      this.reservation = undefined
      throw error
    }
  }

  private current(transactionId: string): Reservation {
    const reservation = this.reservation
    if (
      this.failed || !reservation || reservation.id !== transactionId || !reservation.ready || reservation.group.closed
    ) {
      throw new Error('Desktop shared transaction is unavailable')
    }
    return reservation
  }

  private releaseUnprepared(reservation: Reservation): void {
    this.federation.cancelPreflight(reservation.id)
    reservation.group.close()
    reservation.admission.release()
    if (this.reservation === reservation) this.reservation = undefined
  }

  private reserve(transactionId: string): { reservation: Reservation; fence: RuntimeGenerationFence } {
    const reservation = this.reservation
    if (reservation?.preparingGraph) throw new Error('Desktop shared graph admission is already in progress')
    if (
      reservation?.id === transactionId && !reservation.prepared
      && (reservation.group.closed || reservation.managerRevision !== this.managerRevision)
    ) {
      this.releaseUnprepared(reservation)
      throw new Error('Desktop shared participant reservation is stale')
    }
    const current = this.current(transactionId)
    if (current.prepared) throw new Error('Desktop shared transaction is already prepared')
    try {
      return { reservation: current, fence: this.federation.prepare(transactionId) }
    } catch (error) {
      if (!this.federation.requiresReconciliation) this.releaseUnprepared(current)
      else this.terminal(error)
      throw error
    }
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    const { reservation, fence } = this.reserve(transactionId)
    try {
      reservation.admission.prepare(fence)
      reservation.group.setFence(fence)
      reservation.prepared = true
      return fence
    } catch (error) {
      this.federation.cancelReserved(transactionId)
      reservation.group.close()
      reservation.admission.release()
      this.reservation = undefined
      throw error
    }
  }

  async prepareBrowserGraph(
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): Promise<RuntimeGenerationFence> {
    if (!this.reservation || this.reservation.id !== transactionId || !this.reservation.ready) {
      throw new Error('Desktop shared graph admission is unavailable')
    }
    if (this.reservation.preparingGraph) throw new Error('Desktop shared graph admission is already in progress')
    if (!attachmentEqual(active, this.reservation.previous)) {
      if (!this.reservation.prepared) this.releaseUnprepared(this.reservation)
      throw new Error('Desktop shared graph activation is stale')
    }
    const { reservation, fence } = this.reserve(transactionId)
    reservation.preparingGraph = true
    try {
      await reservation.admission.prepareBrowserGraph(active, fence)
      if (reservation.group.closed || this.federation.requiresReconciliation) {
        throw new Error('Desktop shared graph admission is stale')
      }
      reservation.group.setFence(fence)
      reservation.prepared = true
      return fence
    } catch (error) {
      // A graph admission may have committed before its response was lost.
      // Do not reopen either transaction domain without reconciliation.
      this.terminal(error)
      throw error
    } finally {
      reservation.preparingGraph = false
    }
  }

  async stage(mutation: PluginRuntimeMutation) {
    const reservation = this.current(mutation.transactionId)
    if (!reservation.prepared) throw new Error('Desktop shared fence is unavailable')
    return await this.federation.stage(mutation)
  }
  async publish(id: string) {
    this.current(id)
    return await this.federation.publish(id)
  }
  async complete(id: string) {
    this.current(id)
    return await this.federation.complete(id)
  }
  async finalize(id: string): Promise<void> {
    const reservation = this.current(id)
    try {
      await this.federation.finalize(id)
      const active = this.federation.snapshot().active
      for (const listener of this.activationListeners) listener(active)
      reservation.admission.release()
      reservation.group.close()
      this.reservation = undefined
    } catch (error) {
      this.terminal(error)
      throw error
    }
  }
  async rollback(id: string) {
    // The federation can confirm rollback just before this wrapper records
    // pending adoption. Do not let a concurrent duplicate fence that window.
    if (this.rollbackInProgress) throw new Error('Desktop shared rollback is already in progress')
    this.rollbackInProgress = true
    try {
      const reservation = this.current(id)
      const result = await this.federation.rollback(id)
      reservation.pendingAdoption = true
      return result
    } catch (error) {
      // A stale caller or the normal adoption window does not terminate a
      // healthy rollback. An uncertain rollback for this transaction does.
      if (
        this.reservation?.id === id && !this.reservation.pendingAdoption
        && this.federation.requiresReconciliation
      ) this.terminal(error)
      throw error
    } finally {
      this.rollbackInProgress = false
    }
  }
  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const reservation = this.reservation
    if (!reservation?.pendingAdoption || this.failed) throw new Error('Desktop shared rollback is unavailable')
    try {
      await this.federation.adoptRecoveredActivation(active, registryEpoch)
      reservation.admission.release()
      reservation.group.close()
      this.reservation = undefined
    } catch (error) {
      this.terminal(error)
      throw error
    }
  }
  async abort(id: string): Promise<void> {
    const reservation = this.current(id)
    if (reservation.preparingGraph) throw new Error('Desktop shared graph admission is already in progress')
    try {
      await this.federation.abort(id)
      reservation.admission.cancelPreparation(id)
      reservation.admission.release()
      reservation.group.close()
      this.reservation = undefined
    } catch (error) {
      this.terminal(error)
      throw error
    }
  }
  terminal(error: unknown): void {
    this.failed = true
    this.externalConfig?.fence?.()
    this.federation.terminal()
    // No renderer may keep serving a session after the owner has fenced an
    // uncertain generation. Confirmed rollback uses a separate nonterminal path.
    for (const peer of this.joiningPeers) peer.close()
    for (const peer of this.managers) peer.close()
    this.input.cdp.terminal(error)
  }
  async commit(): Promise<void> {
    throw new Error('Desktop shared lifecycle requires the package authority')
  }
  async reload(input: Parameters<PluginLifecycleRuntime['reload']>[0]): Promise<void> {
    if (this.failed || this.reservation || this.externalConfig || this.managers.size > 0) {
      throw new Error('Desktop shared reload is unavailable')
    }
    await this.input.cdp.reload(input)
  }

  async pluginConfiguration(operation: RendererConfigOperation): Promise<RendererConfigResult> {
    if (this.failed || this.reservation || this.externalConfig || this.joiningManagers > 0 || this.managers.size > 0) {
      return { status: 'unavailable', reason: 'renderer-busy' }
    }
    return await this.input.cdp.pluginConfiguration(operation)
  }

  /** A joining Manager cannot query a native seat once another Manager is admitted. */
  async managerConfigProof(pluginId: string) {
    if (this.failed || this.reservation || this.externalConfig || this.joiningManagers > 0 || this.managers.size > 0) {
      return undefined
    }
    return await this.input.cdp.managerConfigProof(pluginId)
  }

  /** Reserve every admitted Manager and one native seat for a coordinated config write. */
  async reserveExternalMutation(peers: readonly AttachedRendererPeer[]): Promise<DesktopConfigurationReservation> {
    const cohort = [...peers]
    const matchesManagers = () =>
      cohort.length > 0 && new Set(cohort).size === cohort.length && this.managers.size === cohort.length
      && cohort.every(peer => this.managers.has(peer) && !peer.closed)
    if (
      this.failed || this.closed || this.reservation || this.externalConfig || this.joiningManagers > 0
      || this.federation.requiresReconciliation || !matchesManagers()
    ) throw new Error('Desktop configuration reservation is unavailable')
    const admission = this.input.cdp.beginSharedAdmission(`config-${randomUUID()}`)
    const marker: { fence?: () => void } = {}
    this.externalConfig = marker
    try {
      if (admission.sessionCount !== 1) throw new Error('Desktop configuration reservation is unavailable')
      const snapshot = this.federation.snapshot()
      const revision = this.managerRevision
      this.joinSnapshot = { admission, value: snapshot }
      const observed = await admission.readSnapshot()
      if (
        this.failed || this.closed || this.externalConfig !== marker || admission.closed
        || this.managerRevision !== revision || !matchesManagers() || !attachmentEqual(observed, snapshot)
      ) throw new Error('Desktop configuration reservation is unavailable')
      const reservation = createDesktopConfigurationReservation({
        admission,
        ownerCurrent: () =>
          !this.failed && !this.closed && this.externalConfig === marker && this.managerRevision === revision
          && matchesManagers()
          && attachmentEqual(this.federation.snapshot(), snapshot),
        onEnd: () => {
          if (this.joinSnapshot?.admission === admission) this.joinSnapshot = undefined
          if (this.externalConfig === marker) this.externalConfig = undefined
        },
        onUncertain: () => this.terminal(new Error('Desktop configuration result is uncertain')),
      })
      marker.fence = reservation.fence
      return reservation
    } catch (error) {
      if (this.joinSnapshot?.admission === admission) this.joinSnapshot = undefined
      if (this.externalConfig === marker) this.externalConfig = undefined
      admission.release()
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failed = true
    this.externalConfig?.fence?.()
    for (const peer of this.joiningPeers) peer.close()
    this.joiningPeers.clear()
    for (const peer of this.managers) peer.close()
    this.managers.clear()
    this.activationListeners.clear()
    const reservation = this.reservation
    if (reservation && !reservation.prepared && !reservation.preparingGraph) {
      this.releaseUnprepared(reservation)
    } else if (reservation) {
      reservation.group.close()
      this.federation.terminal()
    }
  }
}
