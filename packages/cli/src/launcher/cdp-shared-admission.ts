import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import type { PackageActivationTuple } from './packages/types.js'
import type {
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle-model.js'
import type { PluginGenerationGraphLease } from './plugin-generation-loader.js'
import { type CdpSession, evaluateRuntimeOperation } from './cdp-session.js'
import { attachmentEqual } from './renderer-lifecycle-peer.js'

export type GenerationOwner =
  | { readonly kind: 'join'; readonly token: symbol; readonly session: CdpSession }
  | { readonly kind: 'configuration'; readonly token: symbol }
  | {
    readonly kind: 'browser-graph-admission'
    readonly token: symbol
    readonly transactionId: string
    readonly expectedRegistryEpoch: number
  }
  | { readonly kind: 'transaction'; readonly transactionId: string; readonly fence: RuntimeGenerationFence }
  | { readonly kind: 'shared-admission'; readonly token: symbol; readonly transactionId: string }

export type SharedAdmissionState = {
  readonly token: symbol
  readonly transactionId: string
  readonly sessions: readonly CdpSession[]
  readonly listeners: Set<() => void>
  invalid: boolean
  released: boolean
}

export type BrowserGraphAdmission = (
  input: Readonly<{
    transactionId: string
    active: CordisXPluginActivationRecordV1
    expectedRegistryEpoch: number
    sessions: readonly CdpSession[]
  }>,
) => Promise<Readonly<{ commit(): void; rollback(): Promise<void> }>>

export type BrowserGraphBootstrapRefresh = (
  active: CordisXPluginActivationRecordV1,
  registryEpoch: number,
) => Promise<void>

export interface CdpSharedAdmission {
  readonly registryEpoch: number
  readonly closed: boolean
  readonly sessionCount: number
  onInvalidated(listener: () => void): () => void
  readSnapshot(): Promise<Readonly<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>>
  prepare(fence: RuntimeGenerationFence): void
  prepareBrowserGraph(active: CordisXPluginActivationRecordV1, fence: RuntimeGenerationFence): Promise<void>
  stage(mutation: PluginRuntimeMutation): Promise<void | RuntimeReadinessObservation>
  publish(transactionId: string): Promise<RuntimePublicationObservation>
  complete(transactionId: string): Promise<RuntimeCleanupObservation>
  finalize(transactionId: string): Promise<void>
  rollback(transactionId: string): Promise<RuntimeCleanupObservation>
  cancelPreparation(transactionId: string): void
  adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void>
  /** Only release after a confirmed abort, finalization, or durable rollback adoption. */
  release(): void
}

type SharedAdmissionHost = {
  readonly sessions: Set<CdpSession>
  readonly fences: Map<string, RuntimeGenerationFence>
  generationOwner: GenerationOwner | undefined
  sharedAdmission: SharedAdmissionState | undefined
  readonly registryEpoch: number
  readonly browserGraphAdmission: BrowserGraphAdmission | undefined
  browserGraphTransportReady: boolean
  stage(mutation: PluginRuntimeMutation, token: symbol): Promise<void | RuntimeReadinessObservation>
  publish(id: string, token: symbol): Promise<RuntimePublicationObservation>
  complete(id: string, token: symbol): Promise<RuntimeCleanupObservation>
  finalize(id: string, token: symbol): Promise<void>
  rollback(id: string, token: symbol): Promise<RuntimeCleanupObservation>
  cancelPreparation(id: string, token: symbol): void
  adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, epoch: number, token: symbol): Promise<void>
}

export function createCdpSharedAdmission(host: SharedAdmissionHost, state: SharedAdmissionState): CdpSharedAdmission {
  const transactionId = state.transactionId
  const assertCurrent = (): void => {
    if (
      state.released || state.invalid || host.sharedAdmission !== state
      || state.sessions.length !== host.sessions.size
      || state.sessions.some(session => !host.sessions.has(session))
    ) throw new Error('CDP shared admission is stale')
  }
  const prepare = (fence: RuntimeGenerationFence): void => {
    assertCurrent()
    if (
      host.generationOwner?.kind !== 'shared-admission' || host.generationOwner.token !== state.token
      || host.fences.has(transactionId) || typeof fence.transactionEpoch !== 'string'
      || !fence.transactionEpoch.startsWith(`${transactionId}:`) || fence.transactionEpoch.length > 256
      || fence.expectedRegistryEpoch !== host.registryEpoch
    ) throw new Error('CDP shared fence is invalid or stale')
    const frozen = Object.freeze({ ...fence })
    host.fences.set(transactionId, frozen)
    host.generationOwner = { kind: 'transaction', transactionId, fence: frozen }
  }
  const readSnapshot = async () => {
    assertCurrent()
    const snapshots = await Promise.all(
      state.sessions.map(async session =>
        await evaluateRuntimeOperation<{ active: CordisXPluginActivationRecordV1; registryEpoch: number }>(
          session,
          `(async () => { try {
            const runtime = globalThis.__cordisxRuntime
            if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
            return { ok: true, result: { active: runtime.activePluginGeneration(), registryEpoch: runtime.pluginRegistryEpoch() } }
          } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    assertCurrent()
    const first = snapshots[0]
    if (
      !first || first.registryEpoch !== host.registryEpoch || snapshots.some(value => !attachmentEqual(value, first))
    ) {
      throw new Error('CDP shared renderer snapshots disagree')
    }
    return first
  }
  const self = host
  return {
    get registryEpoch() {
      return self.registryEpoch
    },
    get closed() {
      return state.released || state.invalid || self.sharedAdmission !== state
    },
    get sessionCount() {
      return state.sessions.length
    },
    onInvalidated(listener) {
      if (state.invalid || state.released) listener()
      else state.listeners.add(listener)
      return () => state.listeners.delete(listener)
    },
    readSnapshot,
    prepare,
    async stage(mutation) {
      assertCurrent()
      return await host.stage(mutation, state.token)
    },
    async publish(id) {
      assertCurrent()
      return await host.publish(id, state.token)
    },
    async complete(id) {
      assertCurrent()
      return await host.complete(id, state.token)
    },
    async finalize(id) {
      assertCurrent()
      await host.finalize(id, state.token)
    },
    async rollback(id) {
      assertCurrent()
      return await host.rollback(id, state.token)
    },
    cancelPreparation(id) {
      assertCurrent()
      host.cancelPreparation(id, state.token)
    },
    async prepareBrowserGraph(active, fence) {
      assertCurrent()
      if (self.browserGraphTransportReady) return prepare(fence)
      if (
        self.browserGraphAdmission === undefined || self.generationOwner?.kind !== 'shared-admission'
        || self.generationOwner.token !== state.token || fence.expectedRegistryEpoch !== self.registryEpoch
        || typeof fence.transactionEpoch !== 'string' || !fence.transactionEpoch.startsWith(`${transactionId}:`)
        || fence.transactionEpoch.length > 256
      ) throw new Error('CDP shared browser graph admission is unavailable')
      self.generationOwner = {
        kind: 'browser-graph-admission',
        token: state.token,
        transactionId,
        expectedRegistryEpoch: self.registryEpoch,
      }
      try {
        const admission = await self.browserGraphAdmission({
          transactionId,
          active,
          expectedRegistryEpoch: self.registryEpoch,
          sessions: state.sessions,
        })
        const owner = self.generationOwner
        if (
          state.invalid || state.released || self.sharedAdmission !== state
          || owner?.kind !== 'browser-graph-admission' || owner.token !== state.token
          || self.registryEpoch !== fence.expectedRegistryEpoch
          || state.sessions.length !== self.sessions.size || state.sessions.some(session => !self.sessions.has(session))
        ) {
          await admission.rollback()
          throw new Error('CDP shared browser graph admission is stale')
        }
        const frozen = Object.freeze({ ...fence })
        self.fences.set(transactionId, frozen)
        self.browserGraphTransportReady = true
        self.generationOwner = { kind: 'transaction', transactionId, fence: frozen }
        admission.commit()
      } catch (error) {
        if (self.generationOwner?.kind === 'browser-graph-admission' && self.generationOwner.token === state.token) {
          self.generationOwner = { kind: 'shared-admission', token: state.token, transactionId }
        }
        throw error
      }
    },
    async adoptRecoveredActivation(active, registryEpoch) {
      assertCurrent()
      await self.adoptRecoveredActivation(active, registryEpoch, state.token)
      const readback = await readSnapshot()
      if (readback.registryEpoch !== registryEpoch || !attachmentEqual(readback.active, active)) {
        throw new Error('CDP shared rollback adoption was not confirmed')
      }
    },
    release() {
      if (state.released) return
      if (self.generationOwner?.kind !== 'shared-admission' || self.generationOwner.token !== state.token) {
        throw new Error('cannot release an active CDP shared transaction')
      }
      state.released = true
      state.listeners.clear()
      self.sharedAdmission = undefined
      self.generationOwner = undefined
    },
  }
}

/** No legacy caller may bypass an active owner-shared generation reservation. */
export function assertSharedCdpOperation(state: SharedAdmissionState | undefined, token: symbol | undefined): void {
  if (state && (state.released || state.invalid || state.token !== token)) {
    throw new Error('CDP shared operation requires its owner capability')
  }
}

export function invalidateCdpSharedAdmission(state: SharedAdmissionState | undefined, session: CdpSession): void {
  if (!state || !state.sessions.includes(session)) return
  state.invalid = true
  for (const listener of state.listeners) {
    try {
      listener()
    } catch { /* isolate listeners */ }
  }
  state.listeners.clear()
}

export function removeCdpSession(
  sessions: Set<CdpSession>,
  staged: Map<string, readonly CdpSession[]>,
  admission: SharedAdmissionState | undefined,
  session: CdpSession,
): void {
  if (!sessions.delete(session)) return
  invalidateCdpSharedAdmission(admission, session)
  for (const [transactionId, members] of staged) {
    const remaining = members.filter(item => item !== session)
    if (remaining.length !== members.length) staged.set(transactionId, remaining)
  }
}

/** Signal only the transition from at least one admitted Desktop seat to zero. */
export function createCdpDepartureObserver(
  sessions: Set<CdpSession>,
  staged: Map<string, readonly CdpSession[]>,
  admission: () => SharedAdmissionState | undefined,
): {
  subscribe(listener: () => void): () => void
  subscribeChange(listener: () => void): () => void
  token(): symbol
  changed(): void
  remove(session: CdpSession): void
} {
  const listeners = new Set<() => void>()
  const changeListeners = new Set<() => void>()
  let seatToken = Symbol('desktop-seats')
  const changed = () => {
    seatToken = Symbol('desktop-seats')
    for (const listener of changeListeners) {
      try {
        listener()
      } catch { /* isolate lifecycle observers */ }
    }
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    subscribeChange(listener) {
      changeListeners.add(listener)
      return () => changeListeners.delete(listener)
    },
    token: () => seatToken,
    changed,
    remove(session) {
      const present = sessions.has(session)
      removeCdpSession(sessions, staged, admission(), session)
      if (present) changed()
      if (present && sessions.size === 0) {
        for (const listener of listeners) {
          try {
            listener()
          } catch { /* isolate lifecycle observers */ }
        }
      }
    },
  }
}

export async function reloadCdpSessions(
  sessions: readonly CdpSession[],
  input: { readonly pluginId: string; readonly moduleGeneration: string; readonly runtimeGeneration: string },
): Promise<void> {
  if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
  await Promise.all(sessions.map(async session =>
    await evaluateRuntimeOperation(
      session,
      `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.reloadPluginGeneration(${JSON.stringify(input.pluginId)}, ${
        JSON.stringify(input.moduleGeneration)
      }, ${JSON.stringify(input.runtimeGeneration)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
    )
  ))
}

export function mutationArtifactLeases(mutation: PluginRuntimeMutation): readonly PluginGenerationGraphLease[] {
  return mutation.runtimeArtifactLeases
    ?? (mutation.runtimeArtifactLease === undefined ? [] : [mutation.runtimeArtifactLease])
}

export function sameUniquePluginIds(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false
  const expectedIds = new Set(expected)
  return expectedIds.size === expected.length && new Set(actual).size === actual.length
    && actual.every(id => typeof id === 'string' && expectedIds.has(id))
}

/** Validate every real CDP document, not only the first returned receipt. */
export function assertSharedCdpReadiness(
  receipts: readonly RuntimeReadinessObservation[],
  mutation: PluginRuntimeMutation,
): void {
  if (
    !receipts.length || receipts.some(receipt => {
      const affected = (receipt as RuntimeReadinessObservation & { affectedPluginIds?: unknown }).affectedPluginIds
      return receipt.transactionId !== mutation.transactionId || receipt.transactionEpoch !== mutation.transactionEpoch
        || receipt.expectedRegistryEpoch !== mutation.expectedRegistryEpoch
        || receipt.afterRegistryEpoch !== mutation.afterRegistryEpoch
        || !sameUniquePluginIds(affected, mutation.affectedPluginIds)
    })
  ) throw new Error('CDP shared renderer readiness disagrees')
}

export function assertSharedCdpPublication(
  receipts: readonly RuntimePublicationObservation[],
  mutation: PluginRuntimeMutation | undefined,
): void {
  if (
    !mutation || !receipts.length || receipts.some(receipt => {
      const actual = receipt as RuntimePublicationObservation & { retiring?: unknown; notificationErrors?: unknown }
      return receipt.transactionId !== mutation.transactionId || receipt.transactionEpoch !== mutation.transactionEpoch
        || receipt.registryEpoch !== mutation.afterRegistryEpoch || !attachmentEqual(receipt.active, mutation.candidate)
        || !attachmentEqual(actual.retiring, mutation.previous)
        || !Array.isArray(actual.notificationErrors) || actual.notificationErrors.length !== 0
    })
  ) throw new Error('CDP shared renderer publication disagrees')
}

export function assertSharedCdpCleanup(
  receipts: readonly RuntimeCleanupObservation[],
  mutation: PluginRuntimeMutation | undefined,
): void {
  if (
    !mutation || !receipts.length
    || receipts.some(receipt =>
      receipt.transactionId !== mutation.transactionId || receipt.transactionEpoch !== mutation.transactionEpoch
      || receipt.registryEpoch !== mutation.afterRegistryEpoch || !attachmentEqual(receipt.active, mutation.candidate)
      || !attachmentEqual(receipt.disposedAfter, mutation.previous)
    )
  ) throw new Error('CDP shared renderer cleanup disagrees')
}

export function activationRecord(tuple: PackageActivationTuple): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: tuple.profileId,
    revision: tuple.revision,
    lastGoodRevision: tuple.lastGoodRevision,
    runtimeGeneration: tuple.runtimeGeneration,
    plugins: tuple.plugins,
  }
}
