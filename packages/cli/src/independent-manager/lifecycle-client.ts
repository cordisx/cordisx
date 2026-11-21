import type { CordisXPluginModule } from '../contracts.js'
import type { CordisXRuntimeHandle, RendererPluginMutation } from '../renderer/runtime-shared.js'

type Method = 'synchronize' | 'prepare' | 'stage' | 'publish' | 'complete' | 'finalize' | 'rollback'
type Scope = Readonly<{ profileId: string; generation: string; rendererId: string }>

export interface ManagerRendererLifecycleCommand {
  readonly id: string
  readonly sequence: number
  readonly method: Method
  readonly payload: unknown
}

export type ManagerRendererLifecycleReceipt =
  | { readonly id: string; readonly sequence: number; readonly ok: true; readonly value: unknown }
  | { readonly id: string; readonly sequence: number; readonly ok: false }

/** Owner-controlled, renderer-scoped resources; never execute source strings. */
export interface ManagerRendererLoadedStage {
  readonly mutation: RendererPluginMutation
  readonly module?: CordisXPluginModule
  readonly modules?: Readonly<Record<string, CordisXPluginModule>>
  /** Activate staged styles/resources before the runtime publishes its registry. */
  publish(): void | Promise<void>
  /** Transfer published resources into the loader's session lifetime. */
  commit(): void | Promise<void>
  /** Remove staged resources after rollback or a failed/disconnected session. */
  retire(): void | Promise<void>
}

/**
 * The Host supplies this loader only after the owner has granted and
 * authenticated the renderer's immutable plugin graph and capabilities.
 * Its implementation must validate the projected artifact and never eval
 * browser-provided source. An absent loader deliberately rejects staging.
 */
export interface ManagerRendererStageLoader {
  load(
    projection: Readonly<Record<string, unknown>>,
    context: Scope & { readonly signal: AbortSignal },
  ): Promise<ManagerRendererLoadedStage | undefined>
  dispose(): void | Promise<void>
}

type Runtime = Pick<
  CordisXRuntimeHandle,
  | 'activePluginGeneration'
  | 'pluginRegistryEpoch'
  | 'settleRegistryProjection'
  | 'adoptRecoveredActivation'
  | 'stagePluginMutation'
  | 'publishPluginMutation'
  | 'completePluginMutation'
  | 'finalizePluginMutation'
  | 'rollbackPluginMutation'
  | 'dispose'
>

interface Transaction {
  readonly id: string
  readonly epoch: string
  readonly registryEpoch: number
  phase: 'reserved' | 'staged' | 'published' | 'completed'
  loaded?: ManagerRendererLoadedStage
}

const methods = new Set<Method>([
  'synchronize',
  'prepare',
  'stage',
  'publish',
  'complete',
  'finalize',
  'rollback',
])
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const epochPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('renderer-lifecycle-invalid')
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('renderer-lifecycle-invalid')
  }
}

/** Compare JSON values without depending on object key order or accepting cycles. */
function equalJson(first: unknown, second: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (first === second) return first !== undefined && (typeof first !== 'number' || Number.isFinite(first))
  if (first === null || second === null || typeof first !== 'object' || typeof second !== 'object') return false
  if (Array.isArray(first) || Array.isArray(second)) {
    return Array.isArray(first) && Array.isArray(second) && first.length === second.length
      && first.every((item, index) => equalJson(item, second[index], depth + 1))
  }
  const left = first as Record<string, unknown>
  const right = second as Record<string, unknown>
  const keys = Object.keys(left).sort()
  const other = Object.keys(right).sort()
  return keys.length === other.length
    && keys.every((key, index) => key === other[index] && equalJson(left[key], right[key], depth + 1))
}

/** Runtime dependency order may differ from the owner's impact order. */
function sameUniqueIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false
  const ids = new Set(actual)
  return ids.size === actual.length && expected.every(id => ids.has(id))
}

function activation(value: unknown, scope: Scope, kind: 'active' | 'candidate'): Record<string, unknown> {
  const item = record(value)
  if (
    item.recordKind !== kind || item.profileId !== scope.profileId || item.runtimeGeneration !== scope.generation
    || !Number.isSafeInteger(item.revision) || (item.revision as number) < 0
    || !Number.isSafeInteger(item.lastGoodRevision) || (item.lastGoodRevision as number) < 0
    || !Array.isArray(item.plugins) || item.plugins.length > 4096
  ) throw new Error('renderer-lifecycle-scope-stale')
  return item
}

function transactionPayload(value: unknown, withExpected = false): Record<string, unknown> {
  const item = record(value)
  exact(item, withExpected ? ['transactionId', 'expected'] : ['transactionId'])
  if (typeof item.transactionId !== 'string' || !idPattern.test(item.transactionId)) {
    throw new Error('renderer-lifecycle-invalid')
  }
  return item
}

/**
 * Lifecycle participant for an authenticated independent Manager renderer.
 * This module has no transport and does not open a production renderer.
 * The caller must destroy it on session/owner loss and must not retry a
 * command after a missing or negative acknowledgement.
 */
export function createManagerRendererLifecycleClient(input: {
  readonly runtime: Runtime
  readonly scope: Scope
  readonly loader?: ManagerRendererStageLoader
  readonly signal?: AbortSignal
  readonly onDisconnected?: () => void | Promise<void>
}): {
  readonly closed: boolean
  handle(command: unknown): Promise<ManagerRendererLifecycleReceipt>
  close(): Promise<void>
} {
  const { runtime, loader } = input
  const scope = Object.freeze({ ...input.scope })
  if (
    !idPattern.test(scope.profileId) || !idPattern.test(scope.generation)
    || !/^[a-f0-9]{64}$/u.test(scope.rendererId)
  ) throw new Error('renderer-lifecycle-scope-invalid')
  const lifetime = new AbortController()
  let closed = false
  let busy = false
  let sequence = 0
  let synchronized = false
  let transaction: Transaction | undefined
  let awaitingAdoption: { previous: Record<string, unknown>; candidateRevision: number } | undefined
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing
    closed = true
    lifetime.abort()
    input.signal?.removeEventListener('abort', onAbort)
    const staged = transaction?.loaded
    closing = (async () => {
      // Retiring this renderer does not prove whether the owner committed.
      await Promise.allSettled([
        Promise.resolve().then(() => runtime.dispose()),
        Promise.resolve().then(() => input.onDisconnected?.()),
      ])
      await Promise.resolve().then(() => staged?.retire()).catch(() => undefined)
      await Promise.resolve().then(() => loader?.dispose()).catch(() => undefined)
    })()
    return closing
  }
  const onAbort = () => {
    void close()
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  if (input.signal?.aborted) onAbort()
  const assertLive = () => {
    if (closed || lifetime.signal.aborted) throw new Error('renderer-lifecycle-closed')
  }
  const snapshot = async () => {
    await runtime.settleRegistryProjection()
    assertLive()
    return { active: runtime.activePluginGeneration(), registryEpoch: runtime.pluginRegistryEpoch() }
  }
  const ensureTransaction = (value: unknown, withExpected = false) => {
    const item = transactionPayload(value, withExpected)
    if (transaction === undefined || item.transactionId !== transaction.id) {
      throw new Error('renderer-lifecycle-transaction-stale')
    }
    return { item, current: transaction }
  }
  const execute = async (method: Method, payload: unknown): Promise<unknown> => {
    assertLive()
    if (method === 'synchronize') {
      const item = record(payload)
      exact(item, ['active', 'registryEpoch'])
      const target = activation(item.active, scope, 'active')
      if (!Number.isSafeInteger(item.registryEpoch) || (item.registryEpoch as number) < 0 || transaction) {
        throw new Error('renderer-lifecycle-snapshot-invalid')
      }
      let observed = await snapshot()
      if (awaitingAdoption !== undefined && !equalJson(observed.active, target)) {
        const previous = awaitingAdoption.previous
        const revision = target.revision as number
        if (
          observed.registryEpoch !== item.registryEpoch || !equalJson(observed.active, previous)
          || !equalJson(target.plugins, previous.plugins)
          || (revision !== previous.revision && revision !== awaitingAdoption.candidateRevision + 1)
          || (revision === previous.revision && !equalJson(target, previous))
          || (revision !== previous.revision && target.lastGoodRevision !== previous.revision)
        ) throw new Error('renderer-lifecycle-adoption-stale')
        await runtime.adoptRecoveredActivation(
          target as unknown as ReturnType<Runtime['activePluginGeneration']>,
          item.registryEpoch as number,
        )
        observed = await snapshot()
      }
      if (!equalJson(observed.active, target) || observed.registryEpoch !== item.registryEpoch) {
        throw new Error('renderer-lifecycle-snapshot-disagrees')
      }
      awaitingAdoption = undefined
      synchronized = true
      return observed
    }
    if (!synchronized || awaitingAdoption !== undefined) throw new Error('renderer-lifecycle-not-synchronized')
    if (method === 'prepare') {
      const item = record(payload)
      exact(item, ['transactionId', 'transactionEpoch', 'expectedRegistryEpoch'])
      if (
        transaction !== undefined || typeof item.transactionId !== 'string' || !idPattern.test(item.transactionId)
        || typeof item.transactionEpoch !== 'string' || !epochPattern.test(item.transactionEpoch)
        || !Number.isSafeInteger(item.expectedRegistryEpoch) || (item.expectedRegistryEpoch as number) < 0
      ) throw new Error('renderer-lifecycle-prepare-invalid')
      const observed = await snapshot()
      activation(observed.active, scope, 'active')
      if (observed.registryEpoch !== item.expectedRegistryEpoch) throw new Error('renderer-lifecycle-epoch-stale')
      transaction = {
        id: item.transactionId,
        epoch: item.transactionEpoch,
        registryEpoch: item.expectedRegistryEpoch as number,
        phase: 'reserved',
      }
      return {
        transactionId: transaction.id,
        transactionEpoch: transaction.epoch,
        expectedRegistryEpoch: transaction.registryEpoch,
      }
    }
    if (method === 'stage') {
      if (transaction?.phase !== 'reserved' || loader === undefined) {
        throw new Error('renderer-lifecycle-stage-unavailable')
      }
      const current = transaction
      const projection = record(payload)
      if (
        projection.rendererId !== scope.rendererId || projection.transactionId !== current.id
        || projection.transactionEpoch !== current.epoch
        || projection.expectedRegistryEpoch !== current.registryEpoch
        || projection.afterRegistryEpoch !== current.registryEpoch + 1
      ) throw new Error('renderer-lifecycle-projection-stale')
      const previous = activation(projection.previous, scope, 'active')
      const candidate = activation(projection.candidate, scope, 'candidate')
      if (
        candidate.transactionId !== current.id || candidate.revision !== (previous.revision as number) + 1
        || candidate.lastGoodRevision !== previous.revision
        || !Array.isArray(projection.affectedPluginIds) || projection.affectedPluginIds.length < 1
        || projection.affectedPluginIds.length > 4096
        || projection.affectedPluginIds.some(id => typeof id !== 'string' || !idPattern.test(id))
        || new Set(projection.affectedPluginIds).size !== projection.affectedPluginIds.length
        || typeof projection.targetId !== 'string' || !projection.affectedPluginIds.includes(projection.targetId)
        || !['install', 'update', 'enable', 'disable', 'uninstall'].includes(String(projection.operation))
      ) throw new Error('renderer-lifecycle-projection-invalid')
      const before = await snapshot()
      if (before.registryEpoch !== current.registryEpoch || !equalJson(before.active, previous)) {
        throw new Error('renderer-lifecycle-snapshot-disagrees')
      }
      const loaded = await loader.load(projection, { ...scope, signal: lifetime.signal })
      if (loaded === undefined) throw new Error('renderer-lifecycle-stage-unavailable')
      if (closed) {
        await Promise.resolve().then(() => loaded.retire()).catch(() => undefined)
        throw new Error('renderer-lifecycle-closed')
      }
      current.loaded = loaded
      const mutation = loaded.mutation
      if (
        mutation.transactionId !== current.id || mutation.transactionEpoch !== current.epoch
        || mutation.expectedRegistryEpoch !== current.registryEpoch
        || mutation.afterRegistryEpoch !== current.registryEpoch + 1
        || mutation.operation !== projection.operation || mutation.targetId !== projection.targetId
        || !equalJson(mutation.affectedPluginIds, projection.affectedPluginIds)
        || !equalJson(mutation.previous, previous) || !equalJson(mutation.candidate, candidate)
        || mutation.isolatedArtifactSource !== undefined
      ) throw new Error('renderer-lifecycle-loader-disagrees')
      const receipt = await runtime.stagePluginMutation(mutation, loaded.module, undefined, loaded.modules)
      assertLive()
      if (
        receipt.transactionId !== current.id || receipt.transactionEpoch !== current.epoch
        || receipt.expectedRegistryEpoch !== current.registryEpoch
        || receipt.afterRegistryEpoch !== current.registryEpoch + 1
        || !Array.isArray(receipt.affectedPluginIds)
        || !sameUniqueIds(receipt.affectedPluginIds, mutation.affectedPluginIds)
      ) throw new Error('renderer-lifecycle-readiness-disagrees')
      current.phase = 'staged'
      // Forward the owner-authoritative order after proving identical membership.
      return { ...receipt, affectedPluginIds: [...mutation.affectedPluginIds], observation: mutation.candidate }
    }
    if (method === 'rollback') {
      const { item, current } = ensureTransaction(payload, true)
      if (current.phase === 'reserved' || current.loaded === undefined) throw new Error('renderer-lifecycle-not-staged')
      const mutation = current.loaded.mutation
      const expected = {
        transactionId: current.id,
        transactionEpoch: current.epoch,
        registryEpoch: current.registryEpoch + 2,
        active: mutation.previous,
        disposedAfter: mutation.candidate,
      }
      if (!equalJson(item.expected, expected)) throw new Error('renderer-lifecycle-rollback-invalid')
      const observed = await runtime.rollbackPluginMutation(current.id)
      assertLive()
      if (!equalJson(observed, expected)) throw new Error('renderer-lifecycle-rollback-disagrees')
      await current.loaded.retire()
      assertLive()
      const actual = await snapshot()
      if (!equalJson(actual.active, mutation.previous) || actual.registryEpoch !== expected.registryEpoch) {
        throw new Error('renderer-lifecycle-rollback-disagrees')
      }
      awaitingAdoption = {
        previous: mutation.previous as unknown as Record<string, unknown>,
        candidateRevision: mutation.candidate.revision,
      }
      transaction = undefined
      return observed
    }
    const { current } = ensureTransaction(payload)
    if (current.loaded === undefined) throw new Error('renderer-lifecycle-not-staged')
    const mutation = current.loaded.mutation
    if (method === 'publish') {
      if (current.phase !== 'staged') throw new Error('renderer-lifecycle-phase-invalid')
      await current.loaded.publish()
      assertLive()
      const observed = await runtime.publishPluginMutation(current.id)
      assertLive()
      if (
        observed.transactionId !== current.id || observed.transactionEpoch !== current.epoch
        || observed.registryEpoch !== current.registryEpoch + 1 || !equalJson(observed.active, mutation.candidate)
        || !equalJson(observed.retiring, mutation.previous) || observed.notificationErrors.length !== 0
      ) throw new Error('renderer-lifecycle-publication-disagrees')
      const actual = await snapshot()
      if (!equalJson(actual.active, mutation.candidate) || actual.registryEpoch !== observed.registryEpoch) {
        throw new Error('renderer-lifecycle-publication-disagrees')
      }
      current.phase = 'published'
      return observed
    }
    if (method === 'complete') {
      if (current.phase !== 'published') throw new Error('renderer-lifecycle-phase-invalid')
      const observed = await runtime.completePluginMutation(current.id)
      assertLive()
      const expected = {
        transactionId: current.id,
        transactionEpoch: current.epoch,
        registryEpoch: current.registryEpoch + 1,
        active: mutation.candidate,
        disposedAfter: mutation.previous,
      }
      if (!equalJson(observed, expected)) throw new Error('renderer-lifecycle-cleanup-disagrees')
      current.phase = 'completed'
      return observed
    }
    if (method === 'finalize') {
      if (current.phase !== 'completed') throw new Error('renderer-lifecycle-phase-invalid')
      await runtime.finalizePluginMutation(current.id)
      assertLive()
      await current.loaded.commit()
      assertLive()
      const { transactionId: _transactionId, ...candidate } = mutation.candidate
      const expected = { ...candidate, recordKind: 'active', lastGoodRevision: candidate.revision }
      const actual = await snapshot()
      if (!equalJson(actual.active, expected) || actual.registryEpoch !== current.registryEpoch + 1) {
        throw new Error('renderer-lifecycle-finalize-disagrees')
      }
      transaction = undefined
      return { transactionId: current.id }
    }
    throw new Error('renderer-lifecycle-method-invalid')
  }
  return {
    get closed() {
      return closed
    },
    async handle(value) {
      let item: Record<string, unknown>
      try {
        item = record(value)
        exact(item, ['id', 'sequence', 'method', 'payload'])
      } catch {
        void close()
        throw new Error('renderer-lifecycle-command-invalid')
      }
      if (
        typeof item.id !== 'string' || !/^[a-f0-9]{64}$/u.test(item.id)
        || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1
      ) {
        void close()
        throw new Error('renderer-lifecycle-command-invalid')
      }
      const receipt = { id: item.id, sequence: item.sequence as number }
      if (closed || busy || item.sequence !== sequence + 1 || !methods.has(item.method as Method)) {
        void close()
        return { ...receipt, ok: false }
      }
      sequence = item.sequence as number
      busy = true
      try {
        const result = await execute(item.method as Method, item.payload)
        assertLive()
        return { ...receipt, ok: true, value: result }
      } catch {
        void close()
        return { ...receipt, ok: false }
      } finally {
        busy = false
      }
    },
    close,
  }
}
