import { randomBytes, randomUUID } from 'node:crypto'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  PluginRuntimePreflight,
  RuntimeGenerationFence,
} from './plugin-lifecycle-model.js'
import { CdpPluginLifecycleRuntime, type CdpSharedAdmission } from './cdp-plugin-lifecycle-runtime.js'
import { sameUniquePluginIds } from './cdp-shared-admission.js'
import { RendererLifecycleFederation } from './renderer-lifecycle-federation.js'
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
 * package coordinator nor a managed-service fleet. Production wiring, CDP
 * recovery, zero-CDP-seat operation and additional capabilities are separate.
 */
export class DesktopRendererLifecycle implements PluginLifecycleRuntime {
  private readonly federation: RendererLifecycleFederation
  private readonly desktopId = `cdp-group-${randomUUID()}`
  private reservation: Reservation | undefined
  private failed = false
  private managerRevision = 0

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

  snapshot(): Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }> {
    if (this.reservation || this.failed) throw new Error('Desktop shared snapshot is unavailable')
    return this.federation.snapshot()
  }

  async attach(peer: AttachedRendererPeer): Promise<void> {
    if (this.failed || this.reservation || peer.identity.rendererId === this.desktopId) {
      peer.close()
      throw new Error('Desktop renderer attachment is unavailable')
    }
    await this.federation.attach(peer)
    this.managerRevision += 1
    peer.onDisconnect(() => this.managerRevision += 1)
  }

  async preflight(input: PluginRuntimePreflight): Promise<void> {
    if (this.failed || this.reservation || this.federation.requiresReconciliation) {
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
      reservation.admission.release()
      reservation.group.close()
      this.reservation = undefined
    } catch (error) {
      this.terminal(error)
      throw error
    }
  }
  async rollback(id: string) {
    const reservation = this.current(id)
    const result = await this.federation.rollback(id)
    reservation.pendingAdoption = true
    return result
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
    this.federation.terminal()
    this.input.cdp.terminal(error)
  }
  async commit(): Promise<void> {
    throw new Error('Desktop shared lifecycle requires the package authority')
  }
  async reload(): Promise<void> {
    throw new Error('Desktop shared reload is unavailable')
  }
}
