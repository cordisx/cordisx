import type { Context } from '@deepseek-ai/cordis'
import type { CordisXPluginActivationItemV1, CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { generationFromContext, ownerFromContext } from './ownership.js'

/** Host-private metadata inherited by candidate effects. */
export const CORDISX_PLUGIN_GENERATION_TRANSACTION = Symbol('cordisx.pluginGenerationTransaction')
/** Stable Host runtime authority inherited by every service and plugin Context. */
export const CORDISX_GENERATION_VISIBILITY_COORDINATOR = Symbol('cordisx.generationVisibilityCoordinator')

export function generationVisibilityFromContext(ctx: Context): GenerationVisibilityCoordinator | undefined {
  return (ctx as Context & {
    [CORDISX_GENERATION_VISIBILITY_COORDINATOR]?: GenerationVisibilityCoordinator
  })[CORDISX_GENERATION_VISIBILITY_COORDINATOR]
}

export interface PluginGenerationEffectIdentity {
  readonly pluginId: string
  readonly moduleGeneration?: string
  readonly transactionId?: string
  readonly transactionEpoch?: string
}

export interface PluginGenerationView extends PluginGenerationEffectIdentity {
  readonly activation: CordisXPluginActivationRecordV1
  readonly visibilityVersion: number
}

export interface PluginGenerationTransitionHandle {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly affectedPluginIds: readonly string[]
}

export interface PluginGenerationReadinessReceipt {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly expectedRegistryEpoch: number
  readonly afterRegistryEpoch: number
  readonly affectedPluginIds: readonly string[]
}

export interface PluginGenerationPublishBarrier {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly expectedRegistryEpoch: number
  readonly afterRegistryEpoch: number
}

export interface PluginGenerationPublication {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly registryEpoch: number
  readonly active: CordisXPluginActivationRecordV1
  readonly retiring: CordisXPluginActivationRecordV1
  readonly notificationErrors: readonly unknown[]
}

export interface PluginGenerationParticipant {
  readonly prepare?: (transition: PluginGenerationParticipantTransition) => void
  readonly notify: (visibilityVersion: number) => void
}

export interface PluginGenerationParticipantTransition {
  readonly transactionId: string
  readonly transactionEpoch: string
  readonly affectedPluginIds: readonly string[]
  readonly expected: CordisXPluginActivationRecordV1
  readonly after: CordisXPluginActivationRecordV1
}

interface TransactionSeat {
  readonly handle: PluginGenerationTransitionHandle
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly target: 'after' | 'expected'
}

interface TransitionState {
  readonly handle: PluginGenerationTransitionHandle
  readonly expected: CordisXPluginActivationRecordV1
  readonly after: CordisXPluginActivationRecordV1
  phase: 'staged' | 'prepared' | 'published' | 'rolled-back'
  readiness?: PluginGenerationReadinessReceipt
  barrier?: PluginGenerationPublishBarrier
  publication?: PluginGenerationPublication
}

function pluginEqual(
  left: CordisXPluginActivationItemV1 | undefined,
  right: CordisXPluginActivationItemV1 | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  if (
    left.id !== right.id
    || left.version !== right.version
    || left.digest !== right.digest
    || left.moduleGeneration !== right.moduleGeneration
    || left.enabled !== right.enabled
    || left.canonicalSource !== right.canonicalSource
    || left.dependencies.length !== right.dependencies.length
  ) return false
  return left.dependencies.every((dependency, index) => {
    const candidate = right.dependencies[index]
    return candidate?.id === dependency.id && candidate.version === dependency.version
  })
}

function activationEqual(left: CordisXPluginActivationRecordV1, right: CordisXPluginActivationRecordV1): boolean {
  if (
    left.profileId !== right.profileId
    || left.revision !== right.revision
    || left.lastGoodRevision !== right.lastGoodRevision
    || left.runtimeGeneration !== right.runtimeGeneration
    || left.plugins.length !== right.plugins.length
  ) return false
  const rightById = new Map(right.plugins.map(plugin => [plugin.id, plugin]))
  return left.plugins.every(plugin => pluginEqual(plugin, rightById.get(plugin.id)))
}

function dependentClosure(plugins: readonly CordisXPluginActivationItemV1[], roots: ReadonlySet<string>): Set<string> {
  const closure = new Set(roots)
  let changed = true
  while (changed) {
    changed = false
    for (const plugin of plugins) {
      if (closure.has(plugin.id) || !plugin.dependencies.some(dependency => closure.has(dependency.id))) continue
      closure.add(plugin.id)
      changed = true
    }
  }
  return closure
}

function dependencyOrder(plugins: readonly CordisXPluginActivationItemV1[]): readonly string[] {
  const byId = new Map(plugins.map(plugin => [plugin.id, plugin]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`plugin dependency cycle contains ${id}`)
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (byId.has(dependency.id)) visit(dependency.id)
    }
    visiting.delete(id)
    visited.add(id)
    ordered.push(id)
  }
  for (const id of [...byId.keys()].sort()) visit(id)
  return ordered
}

/**
 * Coordinates generation visibility only. Contribution records remain owned
 * by the existing registries.
 */
export class GenerationVisibilityCoordinator {
  private active: CordisXPluginActivationRecordV1
  private transition: TransitionState | undefined
  private nextEpoch = 1
  private visibilityVersion: number
  private readonly stableGenerations = new Map<string, string>()
  private readonly handles = new WeakSet<object>()
  private readonly receipts = new WeakSet<object>()
  private readonly barriers = new WeakSet<object>()
  private readonly publications = new WeakSet<object>()
  private readonly views = new WeakMap<object, TransactionSeat>()
  private readonly participants = new Set<PluginGenerationParticipant>()

  constructor(active: CordisXPluginActivationRecordV1, initialRegistryEpoch = 0) {
    if (!Number.isSafeInteger(initialRegistryEpoch) || initialRegistryEpoch < 0) {
      throw new Error('invalid initial registry epoch')
    }
    this.active = active
    this.visibilityVersion = initialRegistryEpoch
  }

  /** Canonicalize the durable active record after a startup rollback receipt commits. */
  adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): void {
    if (
      this.transition !== undefined || registryEpoch !== this.visibilityVersion
      || active.profileId !== this.active.profileId
      || active.runtimeGeneration !== this.active.runtimeGeneration
      || active.plugins.length !== this.active.plugins.length
    ) {
      throw new Error('recovered activation scope is stale')
    }
    const current = new Map(this.active.plugins.map(plugin => [plugin.id, plugin]))
    if (!active.plugins.every(plugin => pluginEqual(plugin, current.get(plugin.id)))) {
      throw new Error('recovered activation tuple changed the live closure')
    }
    this.active = active
  }

  snapshot(): CordisXPluginActivationRecordV1 {
    return this.active
  }

  registryEpoch(): number {
    return this.visibilityVersion
  }

  /** Active projection used by Host-owned generation-aware observers such as Plugin Console. */
  activeModuleGeneration(pluginId: string): string | undefined {
    return this.active.plugins.find(plugin => plugin.id === pluginId)?.moduleGeneration
      ?? this.stableGenerations.get(pluginId)
  }

  /** Candidate callbacks are callable only while their authenticated transaction remains viable. */
  callableGeneration(pluginId: string, moduleGeneration: string): boolean {
    if (this.activeModuleGeneration(pluginId) === moduleGeneration) return true
    const transition = this.transition
    if (transition === undefined || transition.phase === 'rolled-back') return false
    const candidate = transition.after.plugins.find(plugin => plugin.id === pluginId)
    if (candidate?.moduleGeneration === moduleGeneration) return true
    const retiring = transition.expected.plugins.find(plugin => plugin.id === pluginId)
    return transition.phase === 'published' && retiring?.moduleGeneration === moduleGeneration
  }

  /** Bind a launcher-composed plugin that is outside the dynamic package graph. */
  bindStable(pluginId: string, moduleGeneration: string): void {
    if (this.transition !== undefined) throw new Error('cannot bind a stable plugin during a generation transaction')
    const existing = this.stableGenerations.get(pluginId)
    if (existing !== undefined && existing !== moduleGeneration) {
      throw new Error('stable plugin generation is already bound')
    }
    this.stableGenerations.set(pluginId, moduleGeneration)
  }

  connect(participant: PluginGenerationParticipant): () => void {
    this.participants.add(participant)
    return () => this.participants.delete(participant)
  }

  begin(
    transactionId: string,
    expected: CordisXPluginActivationRecordV1,
    after: CordisXPluginActivationRecordV1,
    transactionEpoch = `${transactionId}:${this.nextEpoch++}`,
  ): PluginGenerationTransitionHandle {
    if (this.transition !== undefined) throw new Error('plugin generation transaction is already active')
    if (!activationEqual(this.active, expected)) throw new Error('stale plugin activation tuple')
    if (expected.profileId !== after.profileId || expected.runtimeGeneration !== after.runtimeGeneration) {
      throw new Error('plugin generation scope is stale')
    }
    if (after.revision !== expected.revision + 1 || after.lastGoodRevision !== expected.revision) {
      throw new Error('invalid plugin activation revision transition')
    }
    const expectedById = new Map(expected.plugins.map(plugin => [plugin.id, plugin]))
    const afterById = new Map(after.plugins.map(plugin => [plugin.id, plugin]))
    const changed = new Set<string>()
    for (const id of new Set([...expectedById.keys(), ...afterById.keys()])) {
      if (!pluginEqual(expectedById.get(id), afterById.get(id))) changed.add(id)
    }
    const affected = dependentClosure(expected.plugins, changed)
    for (const id of dependentClosure(after.plugins, changed)) affected.add(id)
    const order = [
      ...dependencyOrder(after.plugins),
      ...dependencyOrder(expected.plugins),
    ]
    const affectedPluginIds = Object.freeze([...new Set(order)].filter(id => affected.has(id)))
    if (affectedPluginIds.length === 0) throw new Error('plugin generation transaction has no activation change')
    const handle = Object.freeze({
      transactionId,
      transactionEpoch,
      affectedPluginIds,
    })
    this.handles.add(handle)
    this.transition = { handle, expected, after, phase: 'staged' }
    return handle
  }

  context(handle: PluginGenerationTransitionHandle, pluginId: string): Record<PropertyKey, unknown> {
    const transition = this.assertHandle(handle)
    if (transition.phase !== 'staged' || !handle.affectedPluginIds.includes(pluginId)) {
      throw new Error('plugin generation transaction does not stage this plugin')
    }
    const plugin = transition.after.plugins.find(item => item.id === pluginId)
    if (plugin === undefined) throw new Error(`candidate activation is missing plugin ${pluginId}`)
    const seat: TransactionSeat = Object.freeze({
      handle,
      pluginId,
      moduleGeneration: plugin.moduleGeneration,
      target: 'after',
    })
    return { [CORDISX_PLUGIN_GENERATION_TRANSACTION]: seat }
  }

  /** Private rollback view used to rebuild retiring records before the active-map flip. */
  retiringContext(publication: PluginGenerationPublication, pluginId: string): Record<PropertyKey, unknown> {
    const transition = this.assertPublication(publication)
    if (transition.phase !== 'published') throw new Error('retiring generation is not available for rollback staging')
    const plugin = transition.expected.plugins.find(item => item.id === pluginId)
    if (plugin === undefined) throw new Error(`retiring activation is missing plugin ${pluginId}`)
    const seat: TransactionSeat = Object.freeze({
      handle: transition.handle,
      pluginId,
      moduleGeneration: plugin.moduleGeneration,
      target: 'expected',
    })
    return { [CORDISX_PLUGIN_GENERATION_TRANSACTION]: seat }
  }

  view(ctx: Context): PluginGenerationView {
    const pluginId = ownerFromContext(ctx)
    const moduleGeneration = generationFromContext(ctx)
    const seat = (ctx as Context & { [CORDISX_PLUGIN_GENERATION_TRANSACTION]?: TransactionSeat })[
      CORDISX_PLUGIN_GENERATION_TRANSACTION
    ]
    if (seat !== undefined) {
      const transition = this.transition
      if (
        !this.handles.has(seat.handle as object)
        || seat.pluginId !== pluginId
        || seat.moduleGeneration !== moduleGeneration
      ) {
        throw new Error('stale or forged plugin generation transaction effect')
      }
      if (transition?.handle === seat.handle) {
        const activation = seat.target === 'expected' ? transition.expected : transition.after
        const candidate = activation.plugins.find(plugin => plugin.id === pluginId)
        const validPhase = seat.target === 'expected'
          ? transition.phase === 'published'
          : transition.phase !== 'rolled-back'
        if (candidate?.moduleGeneration !== moduleGeneration || !validPhase) {
          throw new Error('stale or forged plugin generation transaction effect')
        }
        const view = Object.freeze({
          pluginId,
          moduleGeneration,
          transactionId: seat.handle.transactionId,
          transactionEpoch: seat.handle.transactionEpoch,
          activation,
          visibilityVersion: this.visibilityVersion,
        })
        this.views.set(view, seat)
        return view
      }
    }
    if (moduleGeneration !== undefined) {
      const active = this.active.plugins.find(plugin => plugin.id === pluginId)
      if ((active?.moduleGeneration ?? this.stableGenerations.get(pluginId)) !== moduleGeneration) {
        throw new Error('stale plugin generation effect')
      }
    }
    return Object.freeze({
      pluginId,
      ...(moduleGeneration === undefined ? {} : { moduleGeneration }),
      activation: this.active,
      visibilityVersion: this.visibilityVersion,
    })
  }

  effect(ctx: Context): PluginGenerationEffectIdentity {
    const view = this.view(ctx)
    return Object.freeze({
      pluginId: view.pluginId,
      ...(view.moduleGeneration === undefined ? {} : { moduleGeneration: view.moduleGeneration }),
      ...(view.transactionId === undefined ? {} : {
        transactionId: view.transactionId,
        transactionEpoch: view.transactionEpoch,
      }),
    })
  }

  visible(effect: PluginGenerationEffectIdentity, view?: PluginGenerationView): boolean {
    if (effect.moduleGeneration === undefined) return true
    const seat = view === undefined ? undefined : this.views.get(view as object)
    const transition = this.transition
    const viableView = seat !== undefined && transition?.handle === seat.handle
      && (seat.target === 'expected' ? transition.phase === 'published' : transition.phase !== 'rolled-back')
    const activation = viableView ? view!.activation : this.active
    const active = activation.plugins.find(plugin => plugin.id === effect.pluginId)
    if (active !== undefined) return active.enabled && active.moduleGeneration === effect.moduleGeneration
    return this.stableGenerations.get(effect.pluginId) === effect.moduleGeneration
  }

  /** Active generation projection, including an installed generation that is disabled. */
  projected(effect: PluginGenerationEffectIdentity, view?: PluginGenerationView): boolean {
    if (effect.moduleGeneration === undefined) return true
    const seat = view === undefined ? undefined : this.views.get(view as object)
    const transition = this.transition
    const viableView = seat !== undefined && transition?.handle === seat.handle
      && (seat.target === 'expected' ? transition.phase === 'published' : transition.phase !== 'rolled-back')
    const activation = viableView ? view!.activation : this.active
    const projected = activation.plugins.find(plugin => plugin.id === effect.pluginId)
    if (projected !== undefined) return projected.moduleGeneration === effect.moduleGeneration
    return this.stableGenerations.get(effect.pluginId) === effect.moduleGeneration
  }

  assertCallable(effect: PluginGenerationEffectIdentity, view?: PluginGenerationView): void {
    let effectiveView = view
    if (view?.transactionId !== undefined) {
      const transition = this.transition
      if (
        transition?.handle.transactionId === view.transactionId
        && transition.handle.transactionEpoch === view.transactionEpoch
      ) {
        if (transition.phase === 'rolled-back') {
          if (this.visible(effect)) return
          throw new Error('stale plugin generation handle')
        }
      } else {
        const active = this.active.plugins.find(plugin => plugin.id === effect.pluginId)
        if ((active?.moduleGeneration ?? this.stableGenerations.get(effect.pluginId)) !== effect.moduleGeneration) {
          throw new Error('stale plugin generation handle')
        }
        effectiveView = undefined
      }
    }
    if (!this.visible(effect, effectiveView)) throw new Error('stale plugin generation handle')
  }

  confirmReadiness(handle: PluginGenerationTransitionHandle): PluginGenerationReadinessReceipt {
    const transition = this.assertHandle(handle)
    if (transition.phase !== 'staged') throw new Error('plugin generation is not staging')
    const receipt = Object.freeze({
      transactionId: handle.transactionId,
      transactionEpoch: handle.transactionEpoch,
      expectedRegistryEpoch: this.visibilityVersion,
      afterRegistryEpoch: this.visibilityVersion + 1,
      affectedPluginIds: handle.affectedPluginIds,
    })
    this.receipts.add(receipt)
    transition.readiness = receipt
    return receipt
  }

  preparePublish(
    handle: PluginGenerationTransitionHandle,
    receipt: PluginGenerationReadinessReceipt,
  ): PluginGenerationPublishBarrier {
    const transition = this.assertHandle(handle)
    if (
      transition.phase !== 'staged'
      || transition.readiness !== receipt
      || !this.receipts.has(receipt as object)
      || !activationEqual(this.active, transition.expected)
    ) {
      throw new Error('stale plugin generation readiness receipt')
    }
    const participantTransition: PluginGenerationParticipantTransition = {
      transactionId: handle.transactionId,
      transactionEpoch: handle.transactionEpoch,
      affectedPluginIds: handle.affectedPluginIds,
      expected: transition.expected,
      after: transition.after,
    }
    for (const participant of this.participants) participant.prepare?.(participantTransition)
    const barrier = Object.freeze({
      transactionId: handle.transactionId,
      transactionEpoch: handle.transactionEpoch,
      expectedRegistryEpoch: this.visibilityVersion,
      afterRegistryEpoch: this.visibilityVersion + 1,
    })
    this.barriers.add(barrier)
    transition.barrier = barrier
    transition.phase = 'prepared'
    return barrier
  }

  publish(barrier: PluginGenerationPublishBarrier): PluginGenerationPublication {
    const transition = this.transition
    if (
      transition?.phase !== 'prepared'
      || transition.barrier !== barrier
      || !this.barriers.has(barrier as object)
      || !activationEqual(this.active, transition.expected)
      || barrier.expectedRegistryEpoch !== this.visibilityVersion
      || barrier.afterRegistryEpoch !== this.visibilityVersion + 1
    ) {
      throw new Error('stale or forged plugin generation publish barrier')
    }
    this.active = transition.after
    this.visibilityVersion = barrier.afterRegistryEpoch
    transition.phase = 'published'
    const notificationErrors: unknown[] = []
    for (const participant of this.participants) {
      try {
        participant.notify(this.visibilityVersion)
      } catch (error) {
        notificationErrors.push(error)
      }
    }
    const publication = Object.freeze({
      transactionId: transition.handle.transactionId,
      transactionEpoch: transition.handle.transactionEpoch,
      registryEpoch: this.visibilityVersion,
      active: transition.after,
      retiring: transition.expected,
      notificationErrors: Object.freeze(notificationErrors),
    })
    this.publications.add(publication)
    transition.publication = publication
    return publication
  }

  rollback(publication: PluginGenerationPublication): CordisXPluginActivationRecordV1 {
    const transition = this.assertPublication(publication)
    if (transition.phase === 'rolled-back') return this.active
    if (transition.phase !== 'published' || !activationEqual(this.active, transition.after)) {
      throw new Error('stale plugin generation rollback')
    }
    this.active = transition.expected
    this.visibilityVersion += 1
    transition.phase = 'rolled-back'
    for (const participant of this.participants) {
      try {
        participant.notify(this.visibilityVersion)
      } catch {
        // The complete map is already restored. Listener failures are isolated.
      }
    }
    return this.active
  }

  abort(handle: PluginGenerationTransitionHandle): void {
    const transition = this.assertHandle(handle)
    if (transition.phase === 'published') throw new Error('published plugin generation requires rollback')
    if (transition.phase === 'rolled-back') throw new Error('rolled-back plugin generation requires cleanup completion')
    this.transition = undefined
  }

  /** Fence every Host-authorized rollback before publication at the canonical +2 epoch. */
  rollbackUnpublished(handle: PluginGenerationTransitionHandle): number {
    const transition = this.assertHandle(handle)
    if (transition.phase !== 'staged') throw new Error('unpublished plugin generation rollback is stale')
    this.visibilityVersion += 2
    this.transition = undefined
    return this.visibilityVersion
  }

  completeLastGood(publication: PluginGenerationPublication): void {
    const transition = this.assertPublication(publication)
    if (transition.phase !== 'published') throw new Error('plugin generation is not the published last-good candidate')
    const { transactionId: _transactionId, ...after } = transition.after
    this.active = {
      ...after,
      recordKind: 'active',
      lastGoodRevision: transition.after.revision,
    }
    this.transition = undefined
  }

  /** Restore a just-finalized candidate when another renderer failed finalize. */
  rollbackLastGood(publication: PluginGenerationPublication): CordisXPluginActivationRecordV1 {
    if (!this.publications.has(publication as object) || this.transition !== undefined) {
      throw new Error('stale plugin generation finalized rollback')
    }
    const { transactionId: _transactionId, ...candidate } = publication.active
    const committed = {
      ...candidate,
      recordKind: 'active' as const,
      lastGoodRevision: publication.active.revision,
    }
    if (!activationEqual(this.active, committed) || this.visibilityVersion !== publication.registryEpoch) {
      throw new Error('stale plugin generation finalized rollback')
    }
    this.active = publication.retiring
    this.visibilityVersion += 1
    for (const participant of this.participants) {
      try {
        participant.notify(this.visibilityVersion)
      } catch {
        // The complete map is already restored. Listener failures are isolated.
      }
    }
    return this.active
  }

  completeRollback(publication: PluginGenerationPublication): void {
    const transition = this.assertPublication(publication)
    if (transition.phase !== 'rolled-back') throw new Error('plugin generation rollback is not complete')
    this.transition = undefined
  }

  private assertHandle(handle: PluginGenerationTransitionHandle): TransitionState {
    const transition = this.transition
    if (
      !this.handles.has(handle as object)
      || transition?.handle !== handle
      || transition.handle.transactionId !== handle.transactionId
      || transition.handle.transactionEpoch !== handle.transactionEpoch
    ) {
      throw new Error('stale or forged plugin generation transaction')
    }
    return transition
  }

  private assertPublication(publication: PluginGenerationPublication): TransitionState {
    const transition = this.transition
    if (!this.publications.has(publication as object) || transition?.publication !== publication) {
      throw new Error('stale or forged plugin generation publication')
    }
    return transition
  }
}
