import type { CordisXPluginBundleManagerSnapshotV1 } from '../plugin-bundle-contracts.js'
import type { CordisXLocalDevelopmentSnapshot } from '../local-development-contracts.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../plugin-lifecycle-contracts.js'
import type { EntityDirectoryAuthority } from './entity-directory.js'
import type { PluginGenerationGraphLease } from './plugin-generation-loader.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimeGenerationFence,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from './plugin-lifecycle.js'
import type { RollbackPlan } from './packages/authority.js'
import type { PackageActivationTuple } from './packages/types.js'
import {
  entityInstallationId,
  type OwnerDocumentLeaseRegistry,
  type OwnerDocumentPrincipalBinding,
} from './owner-document-rpc.js'
import type { PluginPermissionIdentityRegistry } from './permission-rpc.js'
import {
  type ProductionGraphOperations,
  promoteProductionGraph,
  refreshProductionGraphBootstraps,
} from './production-graph-admission.js'
import { CdpSession, evaluateRuntimeOperation } from './cdp-session.js'

function activationRecord(tuple: PackageActivationTuple): CordisXPluginActivationRecordV1 {
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

function mutationArtifactLeases(mutation: PluginRuntimeMutation): readonly PluginGenerationGraphLease[] {
  return mutation.runtimeArtifactLeases
    ?? (mutation.runtimeArtifactLease === undefined ? [] : [mutation.runtimeArtifactLease])
}

type GenerationOwner =
  | { readonly kind: 'join'; readonly token: symbol; readonly session: CdpSession }
  | {
    readonly kind: 'browser-graph-admission'
    readonly token: symbol
    readonly transactionId: string
    readonly expectedRegistryEpoch: number
  }
  | { readonly kind: 'transaction'; readonly transactionId: string; readonly fence: RuntimeGenerationFence }

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

/** Broadcast one reversible generation transaction to every injected Codex renderer. */
export class CdpPluginLifecycleRuntime implements PluginLifecycleRuntime {
  private readonly sessions = new Set<CdpSession>()
  private readonly joining = new Set<CdpSession>()
  private readonly staged = new Map<string, readonly CdpSession[]>()
  private readonly stagedMutations = new Map<string, PluginRuntimeMutation>()
  private readonly fences = new Map<string, RuntimeGenerationFence>()
  private registryEpoch = 0
  private permissionIdentities: PluginPermissionIdentityRegistry | undefined
  private ownerDocumentAuthority: {
    readonly leases: OwnerDocumentLeaseRegistry
    readonly issue: (
      identity: { readonly source: string; readonly pluginId: string },
      moduleGeneration: string,
    ) => OwnerDocumentPrincipalBinding
  } | undefined
  private entityAuthority: { readonly profileId: string; readonly authority: EntityDirectoryAuthority } | undefined
  private recoveredActivation: CordisXPluginActivationRecordV1 | undefined
  private readonly recoveredSessions = new WeakSet<CdpSession>()
  private readonly developmentStates = new Map<string, CordisXLocalDevelopmentSnapshot>()
  private readonly activeArtifactLeases = new Map<string, PluginGenerationGraphLease>()
  private readonly retiredTransactionArtifactLeases = new Map<string, Set<string>>()
  private developmentVersion = 0
  private generationOwner: GenerationOwner | undefined
  private browserGraphAdmission: BrowserGraphAdmission | undefined
  private browserGraphBootstrapRefresh: BrowserGraphBootstrapRefresh | undefined
  private browserGraphTerminalError: ((error: unknown) => void) | undefined
  private browserGraphTransportReady = false

  constructor(permissionIdentities?: PluginPermissionIdentityRegistry) {
    this.permissionIdentities = permissionIdentities
  }

  setPermissionIdentities(permissionIdentities: PluginPermissionIdentityRegistry): void {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot replace permission identities during a generation transaction')
    }
    this.permissionIdentities = permissionIdentities
  }

  setOwnerDocumentAuthority(authority: NonNullable<CdpPluginLifecycleRuntime['ownerDocumentAuthority']>): void {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot replace owner document authority during a generation transaction')
    }
    this.ownerDocumentAuthority = authority
  }

  setEntityAuthority(profileId: string, authority: EntityDirectoryAuthority): void {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot replace entity authority during a generation transaction')
    }
    this.entityAuthority = { profileId, authority }
  }

  /** Register a graph already selected by the durable activation used for cold boot. */
  registerActivePluginGenerationLease(lease: PluginGenerationGraphLease): void {
    if (this.generationOwner !== undefined || this.staged.size !== 0) {
      throw new Error('cannot register an active browser graph during a generation transaction')
    }
    const current = this.activeArtifactLeases.get(lease.pluginId)
    if (current !== undefined && current.leaseId !== lease.leaseId) {
      throw new Error(`plugin ${lease.pluginId} already has an active browser graph lease`)
    }
    this.activeArtifactLeases.set(lease.pluginId, lease)
  }

  activeBrowserGraph(
    pluginId: string,
    moduleGeneration: string,
  ):
    | Readonly<{ moduleGeneration: string; loadSource: string; publishSource: string; retireSource: string }>
    | undefined
  {
    const transaction = this.generationOwner?.kind === 'transaction'
      ? this.stagedMutations.get(this.generationOwner.transactionId)
      : undefined
    const pendingLease =
      transaction?.candidate.plugins.some(plugin =>
          plugin.id === pluginId && plugin.enabled && plugin.moduleGeneration === moduleGeneration
        )
        ? mutationArtifactLeases(transaction).find(lease => lease.pluginId === pluginId)
        : undefined
    const lease = pendingLease ?? this.activeArtifactLeases.get(pluginId)
    if (lease === undefined) return undefined
    if (lease.moduleGeneration !== moduleGeneration) {
      throw new Error(`active browser graph generation is stale for plugin ${pluginId}`)
    }
    return {
      moduleGeneration: lease.moduleGeneration,
      loadSource: lease.importSource,
      publishSource: lease.publishSource,
      retireSource: lease.retireSource,
    }
  }

  currentRegistryEpoch(): number {
    return this.registryEpoch
  }

  setBrowserGraphAdmission(admission: BrowserGraphAdmission | undefined): void {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot replace browser graph admission during a generation transaction')
    }
    this.browserGraphAdmission = admission
  }

  setBrowserGraphBootstrapRefresh(refresh: BrowserGraphBootstrapRefresh | undefined): void {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot replace browser graph bootstrap refresh during a generation transaction')
    }
    this.browserGraphBootstrapRefresh = refresh
  }

  setBrowserGraphTerminalError(handler: ((error: unknown) => void) | undefined): void {
    this.browserGraphTerminalError = handler
  }

  terminal(error: unknown): void {
    if (this.browserGraphTransportReady) this.browserGraphTerminalError?.(error)
  }

  async refreshBrowserGraphBootstrap(active: CordisXPluginActivationRecordV1): Promise<void> {
    if (!this.browserGraphTransportReady) return
    if (this.browserGraphBootstrapRefresh === undefined) {
      throw new Error('browser graph transport has no future-document bootstrap refresh')
    }
    await this.browserGraphBootstrapRefresh(active, this.registryEpoch)
  }

  private async projectPluginBundles(
    session: CdpSession,
    snapshot: CordisXPluginBundleManagerSnapshotV1,
  ): Promise<Readonly<{ revision: number; pluginRevision: number }>> {
    return await evaluateRuntimeOperation(
      session,
      `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      return { ok: true, result: runtime.adoptPluginBundleSnapshot(${JSON.stringify(snapshot)}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
    )
  }

  async synchronizePluginBundles(snapshot: CordisXPluginBundleManagerSnapshotV1): Promise<void> {
    const acknowledgements = await Promise.all(
      [...this.sessions].map(async session => await this.projectPluginBundles(session, snapshot)),
    )
    if (
      acknowledgements.some(ack => (
        ack.revision !== snapshot.revision || ack.pluginRevision !== snapshot.pluginRevision
      ))
    ) throw new Error('CordisX renderer plugin bundle projections disagree')
  }

  async synchronizePluginBundlesFor(
    session: CdpSession,
    snapshot: CordisXPluginBundleManagerSnapshotV1,
  ): Promise<void> {
    const acknowledgement = await this.projectPluginBundles(session, snapshot)
    if (
      acknowledgement.revision !== snapshot.revision
      || acknowledgement.pluginRevision !== snapshot.pluginRevision
    ) throw new Error('CordisX renderer plugin bundle projection is stale')
  }

  requiresBrowserGraphTransport(): boolean {
    return this.browserGraphTransportReady
  }

  markBrowserGraphTransportReady(): void {
    if (this.generationOwner !== undefined) {
      throw new Error('cannot mark browser graph transport during a generation transaction')
    }
    this.browserGraphTransportReady = true
  }

  cancelPreparation(transactionId: string): void {
    if (this.staged.has(transactionId) || this.stagedMutations.has(transactionId)) {
      throw new Error('cannot cancel a staged plugin generation')
    }
    this.releaseTransaction(transactionId, 'abort')
  }

  prepare(transactionId: string): RuntimeGenerationFence {
    if (this.fences.has(transactionId)) throw new Error('plugin generation fence already exists')
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('another plugin generation transaction is unresolved')
    }
    if (this.sessions.size === 0) throw new Error('no ready CordisX renderer is available')
    const fence = Object.freeze({
      transactionEpoch: `${transactionId}:${crypto.randomUUID()}`,
      expectedRegistryEpoch: this.registryEpoch,
    })
    this.fences.set(transactionId, fence)
    this.generationOwner = { kind: 'transaction', transactionId, fence }
    return fence
  }

  async prepareBrowserGraph(
    transactionId: string,
    active: CordisXPluginActivationRecordV1,
  ): Promise<RuntimeGenerationFence> {
    if (this.browserGraphTransportReady) return this.prepare(transactionId)
    if (this.browserGraphAdmission === undefined) {
      throw new Error('browser graph admission requires a launcher-owned native Host')
    }
    if (this.fences.has(transactionId)) throw new Error('plugin generation fence already exists')
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('another plugin generation transaction is unresolved')
    }
    const sessions = [...this.sessions]
    if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
    const token = Symbol(transactionId)
    const expectedRegistryEpoch = this.registryEpoch
    this.generationOwner = {
      kind: 'browser-graph-admission',
      token,
      transactionId,
      expectedRegistryEpoch,
    }
    try {
      const admission = await this.browserGraphAdmission({ transactionId, active, expectedRegistryEpoch, sessions })
      const owner = this.generationOwner
      if (
        owner?.kind !== 'browser-graph-admission' || owner.token !== token
        || this.registryEpoch !== expectedRegistryEpoch
        || sessions.length !== this.sessions.size
        || sessions.some(session => !this.sessions.has(session))
      ) {
        await admission.rollback()
        throw new Error('browser graph admission reservation became stale')
      }
      const fence = Object.freeze({
        transactionEpoch: `${transactionId}:${crypto.randomUUID()}`,
        expectedRegistryEpoch,
      })
      this.fences.set(transactionId, fence)
      this.browserGraphTransportReady = true
      this.generationOwner = { kind: 'transaction', transactionId, fence }
      admission.commit()
      return fence
    } catch (error) {
      const owner = this.generationOwner
      if (owner?.kind === 'browser-graph-admission' && owner.token === token) this.generationOwner = undefined
      throw error
    }
  }

  register(session: CdpSession): () => void {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot register a CordisX renderer during a plugin generation transaction')
    }
    this.sessions.add(session)
    return () => {
      this.sessions.delete(session)
      for (const [transactionId, sessions] of this.staged) {
        const remaining = sessions.filter(item => item !== session)
        if (remaining.length !== sessions.length) this.staged.set(transactionId, remaining)
      }
    }
  }

  /** Reserve one boot-ready renderer for cold recovery before normal admission. */
  beginJoin(session: CdpSession): {
    readonly commit: (developmentVersion: number) => (() => void) | undefined
    readonly abort: () => void
  } {
    if (this.generationOwner !== undefined || this.staged.size !== 0 || this.stagedMutations.size !== 0) {
      throw new Error('cannot join a CordisX renderer during a plugin generation transaction')
    }
    const token = Symbol('renderer-join')
    this.generationOwner = { kind: 'join', token, session }
    this.joining.add(session)
    let settled = false
    return {
      commit: developmentVersion => {
        if (settled || !this.joining.has(session)) throw new Error('CordisX renderer join reservation is stale')
        // Synchronous compare-and-move is the join barrier. A status update
        // cannot interleave between this version check and sessions.add().
        if (developmentVersion !== this.developmentVersion) return undefined
        this.joining.delete(session)
        if (this.generationOwner?.kind !== 'join' || this.generationOwner.token !== token) {
          throw new Error('CordisX renderer join reservation is stale')
        }
        this.generationOwner = undefined
        settled = true
        this.sessions.add(session)
        return () => {
          this.sessions.delete(session)
          for (const [transactionId, sessions] of this.staged) {
            const remaining = sessions.filter(item => item !== session)
            if (remaining.length !== sessions.length) this.staged.set(transactionId, remaining)
          }
        }
      },
      abort: () => {
        if (settled) return
        settled = true
        this.joining.delete(session)
        if (this.generationOwner?.kind === 'join' && this.generationOwner.token === token) {
          this.generationOwner = undefined
        }
      },
    }
  }

  private releaseTransaction(transactionId: string, permission: 'commit' | 'abort'): void {
    this.staged.delete(transactionId)
    this.stagedMutations.delete(transactionId)
    this.fences.delete(transactionId)
    this.retiredTransactionArtifactLeases.delete(transactionId)
    if (this.generationOwner?.kind === 'transaction' && this.generationOwner.transactionId === transactionId) {
      this.generationOwner = undefined
    }
    this.permissionIdentities?.[permission](transactionId)
    this.ownerDocumentAuthority?.leases[permission](transactionId)
  }

  private async evaluateArtifactLease(
    sessions: readonly CdpSession[],
    source: string,
  ): Promise<void> {
    await Promise.all(sessions.map(async session => {
      const result = await session.send('Runtime.evaluate', {
        expression: source,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      })
      const value = (result.result as { value?: unknown } | undefined)?.value
      if (result.exceptionDetails !== undefined || value !== true) {
        throw new Error('plugin generation resource operation failed')
      }
    }))
  }

  private async retireArtifactLease(
    sessions: readonly CdpSession[],
    lease: PluginGenerationGraphLease,
  ): Promise<void> {
    await this.evaluateArtifactLease(sessions, lease.retireSource)
    lease.retire()
  }

  private async retireTransactionArtifactLeases(
    transactionId: string,
    sessions: readonly CdpSession[],
    mutation: PluginRuntimeMutation,
  ): Promise<void> {
    const retired = this.retiredTransactionArtifactLeases.get(transactionId) ?? new Set<string>()
    this.retiredTransactionArtifactLeases.set(transactionId, retired)
    for (const lease of [...mutationArtifactLeases(mutation)].reverse()) {
      if (retired.has(lease.leaseId)) continue
      if (sessions.length === 0) lease.retire()
      else await this.retireArtifactLease(sessions, lease)
      retired.add(lease.leaseId)
    }
  }

  private async projectDevelopmentState(
    session: CdpSession,
    state: CordisXLocalDevelopmentSnapshot,
  ): Promise<void> {
    await evaluateRuntimeOperation(
      session,
      `(async () => { try {
      await globalThis.__cordisxBoot
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      return { ok: true, result: runtime.updateLocalDevelopmentStatus(${JSON.stringify(state)}) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
    )
  }

  async updateDevelopmentStatus(state: CordisXLocalDevelopmentSnapshot): Promise<void> {
    this.developmentStates.set(state.sourcePath, structuredClone(state))
    this.developmentVersion += 1
    await Promise.all([...this.sessions].map(async session => await this.projectDevelopmentState(session, state)))
  }

  async synchronizeDevelopmentStatus(session: CdpSession): Promise<number> {
    while (true) {
      const version = this.developmentVersion
      const states = [...this.developmentStates.values()].map(state => structuredClone(state))
      for (const state of states) await this.projectDevelopmentState(session, state)
      if (version === this.developmentVersion) return version
    }
  }

  async stage(mutation: PluginRuntimeMutation): Promise<RuntimeReadinessObservation> {
    const sessions = [...this.sessions]
    if (sessions.length === 0) throw new Error('no ready CordisX renderer is available')
    const fence = this.fences.get(mutation.transactionId)
    if (
      fence === undefined
      || mutation.transactionEpoch !== fence.transactionEpoch
      || mutation.expectedRegistryEpoch !== fence.expectedRegistryEpoch
      || mutation.afterRegistryEpoch !== fence.expectedRegistryEpoch + 1
    ) {
      throw new Error('plugin generation mutation does not match its Host registry fence')
    }
    this.stagedMutations.set(mutation.transactionId, mutation)
    // Publish the participant snapshot before any awaited renderer work so a
    // concurrent target close can prune it, including the final participant.
    this.staged.set(mutation.transactionId, sessions)
    const { runtimeArtifactSource, runtimeArtifactLease, runtimeArtifactLeases, ...projectedMutation } = mutation
    void runtimeArtifactLease
    void runtimeArtifactLeases
    const browserArtifactLeases = mutationArtifactLeases(mutation)
    const leasedPluginIds = new Set(browserArtifactLeases.map(lease => lease.pluginId))
    if (
      leasedPluginIds.size !== browserArtifactLeases.length
      || browserArtifactLeases.some(lease => {
        const candidate = mutation.candidate.plugins.find(plugin => plugin.id === lease.pluginId)
        return candidate?.enabled !== true || candidate.moduleGeneration !== lease.moduleGeneration
          || !mutation.affectedPluginIds.includes(lease.pluginId)
      })
      || mutation.affectedPluginIds.some(pluginId => {
        const activeLease = this.activeArtifactLeases.get(pluginId)
        const candidate = mutation.candidate.plugins.find(plugin => plugin.id === pluginId)
        return activeLease !== undefined && candidate?.enabled === true
          && candidate.moduleGeneration !== activeLease.moduleGeneration
          && pluginId !== mutation.targetId && !leasedPluginIds.has(pluginId)
      })
    ) {
      throw new Error('candidate browser graph leases do not match the affected dependency closure')
    }
    const runtimePackage = mutation.package
    if (
      runtimePackage !== undefined
      && mutation.candidate.plugins.find(item => item.id === mutation.targetId)?.enabled === true
      && this.entityAuthority !== undefined
    ) {
      const binding = {
        profileId: this.entityAuthority.profileId,
        installationId: entityInstallationId(this.entityAuthority.profileId, mutation.targetId),
        pluginId: mutation.targetId,
        pluginGeneration: 1,
      }
      this.entityAuthority.authority.register(
        binding,
        runtimePackage.entityTemplates.map(template => template.declaration),
      )
      const materialized = await this.entityAuthority.authority.materialize(
        binding,
        runtimePackage.manifest.version,
        runtimePackage.digest,
        runtimePackage.entityTemplates,
      )
      const rejected = materialized.find(result => result.status === 'rejected')
      if (rejected !== undefined) throw new Error(`entity template ${rejected.agentId} was rejected: ${rejected.code}`)
    }
    const runtimeManifest = runtimePackage?.manifest?.runtimeManifest ?? mutation.developmentPackage?.manifest
    const isolatedArtifactSource = runtimeManifest !== undefined
        && (runtimeManifest.schemaVersion === 7
          || ((runtimeManifest.schemaVersion === 5 || runtimeManifest.schemaVersion === 6)
            && runtimeManifest.capabilities.some(capability => (
              capability.name === 'ui.host-dom.read' || capability.name === 'ui.host-dom.modify'
            ))))
      ? runtimePackage?.artifactSource ?? runtimeArtifactSource
      : undefined
    const candidateLeases = mutation.candidate.plugins.flatMap(item => {
      if (!item.enabled) return []
      const source = item.id === mutation.targetId && mutation.package?.identitySource !== undefined
        ? mutation.package.identitySource
        : this.ownerDocumentAuthority?.leases.source(item.id)
      return source === undefined ? [] : [{ source, pluginId: item.id, moduleGeneration: item.moduleGeneration }]
    })
    const rendererMutation = {
      ...projectedMutation,
      ...(isolatedArtifactSource === undefined ? {} : { isolatedArtifactSource }),
      ...(mutation.package === undefined ? {} : {
        package: {
          manifest: mutation.package.manifest,
          digest: mutation.package.digest,
          identitySource: mutation.package.identitySource,
          ...(mutation.package.readme === undefined ? {} : { readme: mutation.package.readme }),
        },
      }),
      ...(this.ownerDocumentAuthority === undefined ? {} : {
        ownerDocumentBindings: candidateLeases
          .filter(lease => mutation.affectedPluginIds.includes(lease.pluginId))
          .map(lease => this.ownerDocumentAuthority!.issue(lease, lease.moduleGeneration)),
      }),
    }
    const receipts: RuntimeReadinessObservation[] = []
    try {
      this.permissionIdentities?.stage(
        mutation.transactionId,
        mutation.operation,
        mutation.targetId,
        mutation.affectedPluginIds,
        mutation.package?.identitySource,
      )
      this.ownerDocumentAuthority?.leases.stage(mutation.transactionId, candidateLeases)
      const results = await Promise.allSettled(sessions.map(async session => {
        let artifactFailure: unknown
        if (mutation.package !== undefined || runtimeArtifactSource !== undefined) {
          try {
            await session.send('Runtime.evaluate', {
              expression:
                'delete globalThis.__cordisxPendingPluginModuleV1; delete globalThis.__cordisxPendingPluginModuleFactoryV1; delete globalThis.__cordisxPendingPluginModulesV1',
              allowUnsafeEvalBlockedByCSP: true,
            })
            if (browserArtifactLeases.length > 0) {
              const imports = browserArtifactLeases.map(lease => (
                `${JSON.stringify(lease.pluginId)}: await (${lease.importSource})`
              )).join(',\n')
              const artifact = await session.send('Runtime.evaluate', {
                expression: `(async () => {
                  globalThis.__cordisxPendingPluginModulesV1 = { ${imports} }
                  return true
                })()`,
                awaitPromise: true,
                allowUnsafeEvalBlockedByCSP: true,
              })
              if (artifact.exceptionDetails !== undefined) {
                artifactFailure = new Error('plugin artifact evaluation failed')
              }
            }
            if (
              !browserArtifactLeases.some(lease => lease.pluginId === mutation.targetId)
              && isolatedArtifactSource === undefined
            ) {
              const artifact = await session.send('Runtime.evaluate', {
                expression: runtimeArtifactSource ?? mutation.package!.artifactSource,
                allowUnsafeEvalBlockedByCSP: true,
              })
              if (artifact.exceptionDetails !== undefined) {
                artifactFailure = new Error('plugin artifact evaluation failed')
              }
            }
          } catch (error) {
            artifactFailure = error
          }
        }
        const serialized = JSON.stringify(rendererMutation)
        const receipt = await evaluateRuntimeOperation<Omit<RuntimeReadinessObservation, 'observation'>>(
          session,
          `(async () => { try {
          const module = globalThis.__cordisxPendingPluginModuleV1
          const moduleFactory = globalThis.__cordisxPendingPluginModuleFactoryV1
          const modules = globalThis.__cordisxPendingPluginModulesV1
          delete globalThis.__cordisxPendingPluginModuleV1
          delete globalThis.__cordisxPendingPluginModuleFactoryV1
          delete globalThis.__cordisxPendingPluginModulesV1
          const runtime = globalThis.__cordisxRuntime
          if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
          const result = await runtime.stagePluginMutation(${serialized}, module, moduleFactory, modules)
          return { ok: true, result }
        } catch (error) {
          delete globalThis.__cordisxPendingPluginModuleV1
          delete globalThis.__cordisxPendingPluginModuleFactoryV1
          delete globalThis.__cordisxPendingPluginModulesV1
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        } })()`,
        )
        if (artifactFailure !== undefined) throw artifactFailure
        return { ...receipt, observation: mutation.candidate }
      }))
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      for (const result of results) if (result.status === 'fulfilled') receipts.push(result.value)
      if (failed !== undefined) throw failed.reason
      const first = receipts[0]!
      if (
        receipts.some(item =>
          item.transactionEpoch !== first.transactionEpoch
          || item.expectedRegistryEpoch !== first.expectedRegistryEpoch
          || item.afterRegistryEpoch !== first.afterRegistryEpoch
        )
      ) {
        throw new Error('CordisX renderer readiness receipts disagree')
      }
      return first
    } catch (error) {
      throw error
    }
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const mutation = this.stagedMutations.get(transactionId)
    const resourcePublication = mutation === undefined
      ? ''
      : mutationArtifactLeases(mutation).map(lease =>
        `if ((${lease.publishSource}) !== true) throw new Error('plugin generation resource publication failed')`
      ).join('\n')
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimePublicationObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      ${resourcePublication}
      const result = await runtime.publishPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || results.some(item =>
        item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
      )
    ) throw new Error('CordisX renderer publications disagree')
    this.registryEpoch = first.registryEpoch
    return first
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimeCleanupObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.completePluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || results.some(item =>
        item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
      )
    ) throw new Error('CordisX renderer cleanup observations disagree')
    return first
  }

  async finalize(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    const mutation = this.stagedMutations.get(transactionId)
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.finalizePluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
    if (mutation !== undefined && this.browserGraphTransportReady) {
      if (this.browserGraphBootstrapRefresh === undefined) {
        throw new Error('browser graph transport has no future-document bootstrap refresh')
      }
      await this.refreshBrowserGraphBootstrap(mutation.candidate)
    }
    if (mutation !== undefined) {
      const candidateLeases = new Map(mutationArtifactLeases(mutation).map(lease => [lease.pluginId, lease]))
      for (const pluginId of mutation.affectedPluginIds) {
        const candidate = mutation.candidate.plugins.find(plugin => plugin.id === pluginId)
        const previousLease = this.activeArtifactLeases.get(pluginId)
        const candidateLease = candidateLeases.get(pluginId)
        if (candidate?.enabled === true && candidateLease !== undefined) {
          if (previousLease !== undefined && previousLease.leaseId !== candidateLease.leaseId) {
            await this.retireArtifactLease(sessions, previousLease)
          }
          this.activeArtifactLeases.set(pluginId, candidateLease)
        } else if (candidate?.enabled !== true || (pluginId === mutation.targetId && mutation.package !== undefined)) {
          if (previousLease !== undefined) await this.retireArtifactLease(sessions, previousLease)
          this.activeArtifactLeases.delete(pluginId)
        }
      }
    }
    this.releaseTransaction(transactionId, 'commit')
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    const sessions = this.staged.get(transactionId) ?? []
    if (sessions.length === 0) {
      const mutation = this.stagedMutations.get(transactionId)
      const fence = this.fences.get(transactionId)
      if (mutation === undefined || fence === undefined) throw new Error('unknown plugin generation transaction')
      // No renderer can still observe the candidate. Advance the Host to the
      // monotonic rollback epoch required by the shared lifecycle authority.
      const rollbackRegistryEpoch = mutation.afterRegistryEpoch! + 1
      const restored = {
        transactionId,
        transactionEpoch: fence.transactionEpoch,
        registryEpoch: rollbackRegistryEpoch,
        active: mutation.previous,
        disposedAfter: mutation.candidate,
      }
      await this.retireTransactionArtifactLeases(transactionId, sessions, mutation)
      this.registryEpoch = rollbackRegistryEpoch
      this.releaseTransaction(transactionId, 'abort')
      return restored
    }
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimeCleanupObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      const result = await runtime.rollbackPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || first.transactionId !== transactionId
      || results.some(item =>
        item.transactionId !== first.transactionId
        || item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
        || JSON.stringify(item.active) !== JSON.stringify(first.active)
        || JSON.stringify(item.disposedAfter) !== JSON.stringify(first.disposedAfter)
      )
    ) {
      throw new Error('CordisX renderer rollback observations disagree')
    }
    const mutation = this.stagedMutations.get(transactionId)
    if (mutation !== undefined) {
      await this.retireTransactionArtifactLeases(transactionId, sessions, mutation)
    }
    this.registryEpoch = first.registryEpoch
    this.releaseTransaction(transactionId, 'abort')
    return first
  }

  async recoverRollback(plan: RollbackPlan): Promise<RuntimeCleanupObservation> {
    const sessions = [...this.sessions, ...this.joining]
    const recovery = {
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      registryEpoch: plan.rollbackRegistryEpoch,
      active: activationRecord(plan.rollbackTarget),
      disposedAfter: activationRecord(plan.expectedPublished),
    }
    const results = await Promise.all(
      sessions.map(async session =>
        await evaluateRuntimeOperation<RuntimeCleanupObservation>(
          session,
          `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      let result
      try {
        result = await runtime.rollbackPluginMutation(${JSON.stringify(plan.transactionId)})
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'unknown plugin generation transaction') throw error
        result = await runtime.recoverPluginMutation(${JSON.stringify(recovery)})
      }
      return { ok: true, result }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
        )
      ),
    )
    const first = results[0]
    if (
      first === undefined || first.transactionId !== plan.transactionId
      || first.transactionEpoch !== plan.transactionEpoch
      || first.registryEpoch !== plan.rollbackRegistryEpoch
      || results.some(item =>
        item.transactionId !== first.transactionId
        || item.transactionEpoch !== first.transactionEpoch
        || item.registryEpoch !== first.registryEpoch
        || JSON.stringify(item.active) !== JSON.stringify(first.active)
        || JSON.stringify(item.disposedAfter) !== JSON.stringify(first.disposedAfter)
      )
    ) {
      throw new Error('CordisX renderer recovery observations disagree')
    }
    this.registryEpoch = first.registryEpoch
    this.releaseTransaction(plan.transactionId, 'abort')
    return first
  }

  async adoptRecoveredActivation(active: CordisXPluginActivationRecordV1, registryEpoch: number): Promise<void> {
    const sessions = [...this.sessions, ...this.joining]
    await Promise.all(
      sessions.map(async session => await this.adoptRecoveredActivationFor(session, active, registryEpoch)),
    )
    this.registryEpoch = registryEpoch
    this.recoveredActivation = active
  }

  async synchronizeRecoveredActivation(session: CdpSession): Promise<void> {
    if (this.recoveredActivation === undefined || this.recoveredSessions.has(session)) return
    await this.adoptRecoveredActivationFor(session, this.recoveredActivation, this.registryEpoch)
  }

  private async adoptRecoveredActivationFor(
    session: CdpSession,
    active: CordisXPluginActivationRecordV1,
    registryEpoch: number,
  ): Promise<void> {
    await evaluateRuntimeOperation(
      session,
      `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.adoptRecoveredActivation(${JSON.stringify(active)}, ${JSON.stringify(registryEpoch)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
    )
    this.recoveredSessions.add(session)
  }

  async commit(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.commitPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
    this.releaseTransaction(transactionId, 'commit')
  }

  async abort(transactionId: string): Promise<void> {
    const sessions = this.staged.get(transactionId) ?? []
    const mutation = this.stagedMutations.get(transactionId)
    await Promise.all(sessions.map(async session =>
      await evaluateRuntimeOperation(
        session,
        `(async () => { try {
      const runtime = globalThis.__cordisxRuntime
      if (runtime === undefined) throw new Error('CordisX renderer runtime is unavailable')
      await runtime.abortPluginMutation(${JSON.stringify(transactionId)})
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })()`,
      )
    ))
    if (mutation !== undefined) {
      await this.retireTransactionArtifactLeases(transactionId, sessions, mutation)
    }
    this.releaseTransaction(transactionId, 'abort')
  }

  async reload(
    input: { readonly pluginId: string; readonly moduleGeneration: string; readonly runtimeGeneration: string },
  ): Promise<void> {
    const sessions = [...this.sessions]
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
}
