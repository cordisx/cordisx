import { randomUUID } from 'node:crypto'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { normalizePluginActivation, pluginAffectedClosure } from './plugin-activation.js'
import {
  type AttachedRendererPeer,
  attachmentEqual,
  attachmentRecord,
  parseAttachmentScope,
  type RendererAttachmentIdentity,
  RendererAttachmentRejected,
  type RendererAttachmentScope,
} from './renderer-lifecycle-peer.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  PluginRuntimePreflight,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle-model.js'

type Participant = { readonly peer: AttachedRendererPeer; readonly unsubscribe: () => void }
type Transaction = {
  readonly id: string
  readonly fence: RuntimeGenerationFence
  readonly participants: readonly Participant[]
  dispatching: boolean
  operating: boolean
  phase:
    | 'reserved'
    | 'preparing'
    | 'staging'
    | 'staged'
    | 'publishing'
    | 'published'
    | 'completing'
    | 'completed'
    | 'finalizing'
    | 'rolling-back'
  mutation?: PluginRuntimeMutation
}

function readinessMatches(value: unknown, expected: RuntimeReadinessObservation, affected: readonly string[]): boolean {
  try {
    const { affectedPluginIds, ...receipt } = attachmentRecord(value)
    return attachmentEqual(affectedPluginIds, affected) && attachmentEqual(receipt, expected)
  } catch {
    return false
  }
}

function publicationMatches(
  value: unknown,
  expected: RuntimePublicationObservation,
  previous: CordisXPluginActivationRecordV1,
): boolean {
  try {
    const { retiring, notificationErrors, ...receipt } = attachmentRecord(value)
    return (retiring === undefined || attachmentEqual(retiring, previous))
      && (notificationErrors === undefined || Array.isArray(notificationErrors) && notificationErrors.length === 0)
      && attachmentEqual(receipt, expected)
  } catch {
    return false
  }
}

/** Owner-side lifecycle barrier. The caller must provide a per-renderer, capability-scoped projection. */
export class RendererLifecycleFederation implements PluginLifecycleRuntime {
  private readonly participants = new Map<string, Participant>()
  private joining = 0
  private preflighting = false
  private preflightReservation: string | undefined
  private preflightInvalid = false
  private transaction: Transaction | undefined
  private pendingAdoption: {
    readonly participants: readonly Participant[]
    readonly previous: CordisXPluginActivationRecordV1
    readonly candidateRevision: number
  } | undefined
  private uncertain = false
  private adopting = false
  private readonly scope: RendererAttachmentScope
  private readonly projectMutation: (
    mutation: PluginRuntimeMutation,
    identity: RendererAttachmentIdentity,
  ) => unknown | Promise<unknown>
  private readonly finalizeLast: (identity: RendererAttachmentIdentity) => boolean

  constructor(options: {
    readonly scope: RendererAttachmentScope
    readonly active: CordisXPluginActivationRecordV1
    readonly registryEpoch: number
    /** Never forward the raw mutation, graph leases, upstream credentials, or another renderer's capability tokens. */
    readonly projectMutation: (
      mutation: PluginRuntimeMutation,
      identity: RendererAttachmentIdentity,
    ) => unknown | Promise<unknown>
    /** Owner-selected resource authority whose cleanup must follow other seats. */
    readonly finalizeLast?: (identity: RendererAttachmentIdentity) => boolean
  }) {
    this.scope = Object.freeze({ ...parseAttachmentScope(options.scope) })
    this.projectMutation = options.projectMutation
    this.finalizeLast = options.finalizeLast ?? (() => false)
    if (
      options.active.profileId !== this.scope.profileId || options.active.recordKind !== 'active'
      || options.active.runtimeGeneration !== this.scope.generation
      || !Number.isSafeInteger(options.registryEpoch) || options.registryEpoch < 0
    ) {
      throw new Error('invalid renderer lifecycle owner snapshot')
    }
    this.active = normalizePluginActivation(options.active)
    this.registryEpoch = options.registryEpoch
  }

  private active: CordisXPluginActivationRecordV1
  private registryEpoch: number

  get requiresReconciliation(): boolean {
    return this.uncertain || this.pendingAdoption !== undefined
  }

  snapshot(): Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }> {
    if (
      this.requiresReconciliation || this.transaction || this.joining || this.preflighting || this.preflightReservation
    ) throw new Error('renderer lifecycle snapshot is unavailable')
    return { active: structuredClone(this.active), registryEpoch: this.registryEpoch }
  }

  /** A renderer is admitted only after it confirms the owner's exact activation and registry epoch. */
  async attach(peer: AttachedRendererPeer): Promise<void> {
    if (
      this.uncertain || this.transaction || this.pendingAdoption || this.preflighting || this.preflightReservation
      || !attachmentEqual(peer.scope, this.scope)
      || this.participants.has(peer.identity.rendererId) || peer.closed
    ) {
      peer.close()
      throw new Error('renderer lifecycle attach is unavailable or stale')
    }
    this.joining += 1
    try {
      const snapshot = { active: this.active, registryEpoch: this.registryEpoch }
      const result = await peer.request('synchronize', snapshot)
      if (peer.closed || this.uncertain || this.transaction || !attachmentEqual(result, snapshot)) {
        throw new Error('renderer lifecycle synchronization was not confirmed')
      }
      const participant: Participant = {
        peer,
        unsubscribe: peer.onDisconnect(() => {
          if (this.participants.get(peer.identity.rendererId)?.peer === peer) {
            this.participants.delete(peer.identity.rendererId)
          }
          if (this.transaction?.participants.some(item => item.peer === peer)) this.uncertain = true
          if (this.pendingAdoption?.participants.some(item => item.peer === peer)) this.uncertain = true
          if (this.preflightReservation !== undefined) this.preflightInvalid = true
        }),
      }
      if (peer.closed || this.participants.has(peer.identity.rendererId)) {
        participant.unsubscribe()
        throw new Error('renderer lifecycle attachment changed during synchronization')
      }
      this.participants.set(peer.identity.rendererId, participant)
    } catch (error) {
      peer.close()
      throw error
    } finally {
      this.joining -= 1
    }
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    if (this.preflightReservation === transactionId && this.preflightInvalid) {
      this.cancelPreflight(transactionId)
      throw new Error('renderer lifecycle admission became stale')
    }
    if (
      this.uncertain || this.transaction || this.pendingAdoption || this.joining || this.preflighting
      || (this.preflightReservation !== undefined && this.preflightReservation !== transactionId)
      || this.participants.size === 0
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(transactionId)
    ) {
      throw new Error('renderer lifecycle transaction is unavailable')
    }
    const fence = { transactionEpoch: `${transactionId}:${randomUUID()}`, expectedRegistryEpoch: this.registryEpoch }
    this.preflightReservation = undefined
    this.transaction = {
      id: transactionId,
      fence,
      participants: [...this.participants.values()],
      phase: 'reserved',
      dispatching: false,
      operating: false,
    }
    return fence
  }

  /** Reject unsupported capabilities and artifacts before the owner reserves a lifecycle transaction. */
  async preflight(input: PluginRuntimePreflight): Promise<void> {
    if (
      this.uncertain || this.transaction || this.pendingAdoption || this.joining || this.preflighting
      || this.preflightReservation !== undefined
      || this.participants.size === 0
    ) throw new Error('renderer lifecycle admission is unavailable')
    this.preflighting = true
    const participants = [...this.participants.values()]
    try {
      // Candidate generations identify the complete owner-computed impact,
      // including dependents and removed plugins, before any graph is issued.
      const impacted = pluginAffectedClosure(input.previous.plugins, input.candidate.plugins)
      if (
        !impacted.includes(input.targetId)
        || attachmentEqual(
          input.previous.plugins.find(plugin => plugin.id === input.targetId),
          input.candidate.plugins.find(plugin => plugin.id === input.targetId),
        )
      ) throw new Error('renderer lifecycle candidate has no target change')
      const projection: PluginRuntimeMutation = {
        ...input,
        transactionEpoch: `${input.transactionId}:preflight`,
        expectedRegistryEpoch: this.registryEpoch,
        afterRegistryEpoch: this.registryEpoch + 1,
        affectedPluginIds: impacted,
      }
      const results = await Promise.allSettled(
        participants.map(async participant => await this.projectMutation(projection, participant.peer.identity)),
      )
      if (results.some(result => result.status === 'rejected')) {
        throw new Error('renderer lifecycle admission was rejected')
      }
      if (
        participants.length !== this.participants.size
        || participants.some(item => item.peer.closed || this.participants.get(item.peer.identity.rendererId) !== item)
      ) {
        throw new Error('renderer lifecycle admission became stale')
      }
      this.preflightReservation = input.transactionId
      this.preflightInvalid = false
    } finally {
      this.preflighting = false
    }
  }

  /** Release a reservation when the owner cannot start its package transaction. */
  cancelPreflight(transactionId: string): void {
    if (!this.preflighting && this.preflightReservation === transactionId) {
      this.preflightReservation = undefined
      this.preflightInvalid = false
    }
  }

  private current(transactionId: string): Transaction {
    if (!this.transaction || this.transaction.id !== transactionId || this.uncertain) {
      throw new Error('renderer lifecycle transaction requires reconciliation')
    }
    return this.transaction
  }

  private async broadcast(
    transaction: Transaction,
    method: 'prepare' | 'stage' | 'publish' | 'complete' | 'finalize' | 'rollback',
    payload: (participant: Participant) => unknown | Promise<unknown>,
    participants: readonly Participant[] = transaction.participants,
  ): Promise<unknown[]> {
    if (transaction.dispatching) throw new Error('renderer lifecycle operation is already in progress')
    transaction.dispatching = true
    try {
      // Construct every scoped projection before dispatching any operation.
      // A local projection error is not an unknown renderer execution result.
      const projections = await Promise.allSettled(
        participants.map(async participant => await payload(participant)),
      )
      if (projections.some(result => result.status === 'rejected') || this.uncertain) {
        throw new Error('renderer lifecycle projection is unavailable')
      }
      const replies = await Promise.allSettled(
        participants.map(async (participant, index) =>
          await participant.peer.request(method, (projections[index] as PromiseFulfilledResult<unknown>).value)
        ),
      )
      if (replies.some(reply => reply.status === 'rejected') || this.uncertain) {
        if (
          participants.some(participant => participant.peer.closed)
          || replies.some(reply => reply.status === 'rejected' && !(reply.reason instanceof RendererAttachmentRejected))
        ) this.uncertain = true
        throw new Error('renderer lifecycle participants did not all confirm the operation')
      }
      return replies.map(reply => (reply as PromiseFulfilledResult<unknown>).value)
    } finally {
      transaction.dispatching = false
    }
  }

  async stage(mutation: PluginRuntimeMutation): Promise<RuntimeReadinessObservation> {
    const tx = this.current(mutation.transactionId)
    const previous = normalizePluginActivation(mutation.previous)
    const candidate = normalizePluginActivation(mutation.candidate)
    if (
      tx.phase !== 'reserved' || mutation.transactionEpoch !== tx.fence.transactionEpoch
      || mutation.expectedRegistryEpoch !== tx.fence.expectedRegistryEpoch
      || mutation.afterRegistryEpoch !== tx.fence.expectedRegistryEpoch + 1
      || !attachmentEqual(previous, this.active)
      || candidate.recordKind !== 'candidate' || candidate.transactionId !== tx.id
      || candidate.revision !== previous.revision + 1
      || candidate.lastGoodRevision !== previous.revision
      || candidate.profileId !== this.scope.profileId
      || candidate.runtimeGeneration !== this.scope.generation
    ) {
      throw new Error('renderer lifecycle mutation does not match the owner fence')
    }
    const captured = { ...mutation, previous, candidate, affectedPluginIds: [...mutation.affectedPluginIds] }
    tx.operating = true
    try {
      tx.mutation = captured
      tx.phase = 'preparing'
      const prepare = { transactionId: tx.id, ...tx.fence }
      const prepared = await this.broadcast(tx, 'prepare', () => prepare)
      if (prepared.some(reply => !attachmentEqual(reply, prepare))) throw new Error('renderer preparation disagrees')
      tx.phase = 'staging'
      const expected: RuntimeReadinessObservation = {
        transactionId: tx.id,
        ...tx.fence,
        afterRegistryEpoch: tx.fence.expectedRegistryEpoch + 1,
        observation: candidate,
      }
      const staged = await this.broadcast(
        tx,
        'stage',
        participant => this.projectMutation(captured, participant.peer.identity),
      )
      if (staged.some(reply => !readinessMatches(reply, expected, captured.affectedPluginIds))) {
        throw new Error('renderer readiness disagrees')
      }
      tx.phase = 'staged'
      return expected
    } finally {
      tx.operating = false
    }
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const tx = this.current(transactionId)
    if (tx.phase !== 'staged' || !tx.mutation) throw new Error('renderer transaction is not staged')
    tx.phase = 'publishing'
    tx.operating = true
    const expected: RuntimePublicationObservation = {
      transactionId,
      transactionEpoch: tx.fence.transactionEpoch,
      registryEpoch: tx.fence.expectedRegistryEpoch + 1,
      active: tx.mutation.candidate,
    }
    try {
      const replies = await this.broadcast(tx, 'publish', () => ({ transactionId }))
      if (replies.some(reply => !publicationMatches(reply, expected, tx.mutation!.previous))) {
        throw new Error('renderer publication disagrees')
      }
      tx.phase = 'published'
      return expected
    } finally {
      tx.operating = false
    }
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    const tx = this.current(transactionId)
    if (tx.phase !== 'published' || !tx.mutation) throw new Error('renderer transaction is not published')
    tx.phase = 'completing'
    tx.operating = true
    const expected: RuntimeCleanupObservation = {
      transactionId,
      transactionEpoch: tx.fence.transactionEpoch,
      registryEpoch: tx.fence.expectedRegistryEpoch + 1,
      active: tx.mutation.candidate,
      disposedAfter: tx.mutation.previous,
    }
    try {
      const replies = await this.broadcast(tx, 'complete', () => ({ transactionId }))
      if (replies.some(reply => !attachmentEqual(reply, expected))) throw new Error('renderer cleanup disagrees')
      tx.phase = 'completed'
      return expected
    } finally {
      tx.operating = false
    }
  }

  async finalize(transactionId: string): Promise<void> {
    const tx = this.current(transactionId)
    if (tx.phase !== 'completed' || !tx.mutation) throw new Error('renderer transaction is not complete')
    tx.phase = 'finalizing'
    tx.operating = true
    try {
      const first = tx.participants.filter(item => !this.finalizeLast(item.peer.identity))
      const last = tx.participants.filter(item => this.finalizeLast(item.peer.identity))
      const confirmed = (replies: readonly unknown[]) =>
        replies.every(reply => attachmentEqual(reply, { transactionId }))
      if (!confirmed(await this.broadcast(tx, 'finalize', () => ({ transactionId }), first))) {
        throw new Error('renderer finalization disagrees')
      }
      if (!confirmed(await this.broadcast(tx, 'finalize', () => ({ transactionId }), last))) {
        throw new Error('renderer finalization disagrees')
      }
      const { transactionId: _candidateId, ...candidate } = tx.mutation.candidate
      void _candidateId
      this.active = normalizePluginActivation({
        ...candidate,
        recordKind: 'active',
        lastGoodRevision: candidate.revision,
      })
      this.registryEpoch = tx.fence.expectedRegistryEpoch + 1
      this.transaction = undefined
    } catch (error) {
      this.uncertain = true
      throw error
    } finally {
      tx.operating = false
    }
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    const tx = this.current(transactionId)
    if (!tx.mutation) throw new Error('renderer transaction has not staged a mutation')
    if (tx.phase === 'rolling-back') throw new Error('renderer rollback is already in progress')
    if (tx.operating || tx.dispatching) throw new Error('renderer lifecycle operation is already in progress')
    tx.phase = 'rolling-back'
    tx.operating = true
    const expected: RuntimeCleanupObservation = {
      transactionId,
      transactionEpoch: tx.fence.transactionEpoch,
      registryEpoch: tx.fence.expectedRegistryEpoch + 2,
      active: tx.mutation.previous,
      disposedAfter: tx.mutation.candidate,
    }
    try {
      const replies = await this.broadcast(tx, 'rollback', () => ({ transactionId, expected }))
      if (replies.some(reply => !attachmentEqual(reply, expected))) throw new Error('renderer rollback disagrees')
      this.active = structuredClone(tx.mutation.previous)
      this.registryEpoch = expected.registryEpoch
      this.pendingAdoption = {
        participants: tx.participants,
        previous: tx.mutation.previous,
        candidateRevision: tx.mutation.candidate.revision,
      }
      this.transaction = undefined
      return expected
    } catch (error) {
      this.uncertain = true
      throw error
    } finally {
      tx.operating = false
    }
  }

  async abort(transactionId: string): Promise<void> {
    this.cancelReserved(transactionId)
  }

  /** Synchronous cancellation is safe only before any renderer dispatch. */
  cancelReserved(transactionId: string): void {
    const tx = this.current(transactionId)
    if (tx.phase !== 'reserved') throw new Error('a dispatched renderer transaction needs confirmed rollback')
    this.transaction = undefined
  }

  /** The package authority may assign a new durable revision after a confirmed rollback. */
  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const pending = this.pendingAdoption
    if (
      !pending || this.uncertain || this.transaction || this.adopting || registryEpoch !== this.registryEpoch
      || active.recordKind !== 'active' || active.profileId !== this.scope.profileId
      || active.runtimeGeneration !== this.scope.generation
      || (active.revision !== pending.previous.revision && active.revision !== pending.candidateRevision + 1)
      || (active.revision === pending.previous.revision && !attachmentEqual(active, pending.previous))
      || (active.revision !== pending.previous.revision && active.lastGoodRevision !== pending.previous.revision)
      || !attachmentEqual(active.plugins, pending.previous.plugins)
    ) {
      throw new Error('renderer rollback adoption is stale or unavailable')
    }
    const snapshot = { active, registryEpoch }
    this.adopting = true
    try {
      const replies = await Promise.all(
        pending.participants.map(async item => await item.peer.request('synchronize', snapshot)),
      )
      if (this.uncertain || replies.some(reply => !attachmentEqual(reply, snapshot))) {
        throw new Error('renderer rollback adoption was not confirmed')
      }
      this.active = normalizePluginActivation(active)
      this.pendingAdoption = undefined
    } catch (error) {
      this.uncertain = true
      throw error
    } finally {
      this.adopting = false
    }
  }

  async commit(_transactionId: string): Promise<void> {
    throw new Error('renderer federation requires the package lifecycle authority')
  }

  async reload(): Promise<void> {
    throw new Error('renderer federation reload is not implemented')
  }

  terminal(): void {
    this.uncertain = true
  }
}
