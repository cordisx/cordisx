import { CORDISX_PLATFORM_CAPABILITIES } from '../../contracts.js'
import type {
  CordisXCapabilityDeclaration,
  CordisXCapabilityScope,
  CordisXPlatformCapability,
  CordisXPluginIdentity,
  CordisXPluginManifestV1,
} from '../../contracts.js'
import type {
  GenerationVisibilityCoordinator,
  PluginGenerationEffectIdentity,
  PluginGenerationView,
} from '../generation-visibility.js'
import type { PluginConsolePermissionObserver } from '../plugin-console.js'
import type {
  CordisXCertifiedPermissionProjectionV1,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV3,
  CordisXPermissionAuthorizationPlanV4,
  CordisXPermissionCapabilityV4,
  CordisXPermissionPolicyRecordV2,
  CordisXPermissionPolicyRecordV3,
  CordisXPermissionPolicyRecordV4,
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
} from '../../permission-contracts.js'
import { CapabilityRiskCatalog } from '../../capability-risk-catalog.js'
import { PermissionOnceGrantLedger } from '../../permission-model-v2.js'
import { normalizeCertifiedPermissionProjectionV1 } from '../../permission-model-v4.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV4,
  persistedPermissionRecordKey,
} from '../../permission-persistence.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../../permission-persistence.js'

import { certifiedArtifactKey, object, platformIdentityKey } from './platform-manifest.js'
import {
  PermissionAuthorizationPromptV2,
  PermissionPolicyStore,
  PermissionPrompt,
  RequestedScope,
} from './platform-permission-store.js'
import {
  AgentRuntimeConnection,
  AgentRuntimeLeaseRecord,
  AgentRuntimePermissionFence,
  AgentRuntimeRouteScope,
  AuditRecord,
  DomPermissionAccessDecision,
  DomPermissionLease,
  HostDomPermissionLease,
  isoNow,
  manifestDeclarationsV2,
  manifestHostDomDeclarationsV4,
  PermissionArtifactBindingV3,
  Registration,
  RegistrationArtifactBinding,
  requestedSnapshot,
} from './platform-permission-types.js'

export abstract class PlatformPermissionBrokerBase {
  protected readonly registrations = new Map<string, Registration>()

  /** Launcher-fed, renderer-ephemeral exact projections; never a feed/root/store authority. */
  protected readonly certifiedProjections = new Map<string, CordisXCertifiedPermissionProjectionV1>()

  protected certifiedProjectionRevision = -1

  protected certifiedProjectionDigest = ''

  protected certifiedProjectionAvailable = false

  /** One profile ledger index for both the retiring v1 records and authoritative v2 records. */
  protected readonly policyRecords = new Map<string, CordisXPersistedPermissionPolicyRecord>()

  protected readonly audit = new Map<string, AuditRecord>()

  protected readonly onceV2 = new PermissionOnceGrantLedger()

  protected readonly domLeases = new Map<string, DomPermissionLease>()

  protected readonly domRequests = new Map<string, Promise<DomPermissionAccessDecision>>()

  protected readonly domPromptPlans = new Map<string, CordisXPermissionAuthorizationPlanV3>()

  protected readonly domPoints = new Map<
    string,
    Readonly<{ identity: CordisXPluginIdentity; pointId: string; moduleGeneration?: string }>
  >()

  protected readonly domCertificationTimers = new Map<string, ReturnType<typeof setTimeout>>()

  protected readonly hostDomLeases = new Map<string, HostDomPermissionLease>()

  protected readonly hostDomPromptPlans = new Map<
    string,
    Readonly<{
      plan: CordisXPermissionAuthorizationPlanV4
      cancel: () => void
    }>
  >()

  protected readonly hostDomPolicyRevisions = new Map<string, number>()

  protected hostDomOperationSequence = 0

  protected readonly pendingDomReviews = new Map<
    string,
    Readonly<{
      identity: CordisXPluginIdentity
      pointId: string
      moduleGeneration?: string
      view?: PluginGenerationView
    }>
  >()

  protected readonly catalog = new CapabilityRiskCatalog()

  protected readonly listeners = new Set<() => void>()

  protected readonly agentRuntimeRoutes = new Map<string, AgentRuntimeRouteScope>()

  protected readonly playgroundScenarioAgentRuntimeRoutes = new Map<
    string,
    Readonly<{
      route: AgentRuntimeRouteScope
      baseRouteInstanceId: string
    }>
  >()

  protected readonly agentRuntimeLeases = new Map<string, AgentRuntimeLeaseRecord>()

  protected readonly pendingAgentRuntimePrompts = new Set<
    Readonly<{
      identity: CordisXPluginIdentity
      registrationToken: object
      abort: AbortController
    }>
  >()

  protected readonly agentRuntimeFenceListeners = new Set<(fence: AgentRuntimePermissionFence) => void>()

  protected readonly developmentAgentRuntimeSeeds = new WeakSet<object>()

  protected readonly developmentAgentRuntimeAuthorizations = new WeakSet<object>()

  protected readonly playgroundScenarioAgentRuntimeRouteAuthorities = new WeakSet<object>()

  protected agentRuntimeConnection: AgentRuntimeConnection | undefined

  protected readonly migrationTasks: Promise<void>[] = []

  protected domPolicyCommitTail: Promise<void> = Promise.resolve()

  protected changeBatchDepth = 0

  protected changePending = false

  constructor(
    protected readonly store: PermissionPolicyStore,
    protected readonly prompt: PermissionPrompt,
    protected readonly now: () => Date = () => new Date(),
    protected readonly promptTimeoutMs = 30_000,
    protected readonly profileId = 'default',
    protected readonly generation = 'runtime',
    protected readonly visibility?: GenerationVisibilityCoordinator,
    protected readonly consoleObserver?: PluginConsolePermissionObserver,
    protected readonly promptV2?: PermissionAuthorizationPromptV2,
  ) {
    for (const record of store.read()) {
      if (record.key.profileId === profileId) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    }
    for (const record of store.readV2?.() ?? []) {
      if (record.key.profileId === profileId) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    }
    for (const record of store.readV3?.() ?? []) {
      if (record.key.profileId === profileId) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    }
    for (const record of store.readV4?.() ?? []) {
      if (record.key.profileId === profileId) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    }
    visibility?.connect({ notify: () => this.changed() })
  }

  register(
    identity: CordisXPluginIdentity,
    manifest:
      | CordisXPluginManifestV1
      | CordisXPluginManifestV4
      | CordisXPluginManifestV5
      | CordisXPluginManifestV6
      | CordisXPluginManifestV7
      | CordisXPluginManifestV8,
    generation: PluginGenerationEffectIdentity = Object.freeze({ pluginId: identity.id }),
    candidateView?: PluginGenerationView,
    artifact?: PermissionArtifactBindingV3,
  ): () => void {
    const key = `${platformIdentityKey(identity)}\u0000${generation.moduleGeneration ?? 'host'}`
    const declarations = new Map<CordisXPlatformCapability, CordisXCapabilityDeclaration>(
      manifest.schemaVersion === 4 || manifest.schemaVersion === 5 || manifest.schemaVersion === 6
        || manifest.schemaVersion === 7 || manifest.schemaVersion === 8
        ? manifest.capabilities.flatMap(item => (
          (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(item.name)
            ? [
              [item.name as CordisXPlatformCapability, {
                name: item.name as CordisXPlatformCapability,
                required: item.required,
                reason: ('rationale' in item ? item.rationale?.description : undefined) ?? {
                  namespace: 'permission',
                  key: `permission.${item.name}.legacy-reason`,
                  fallback:
                    this.catalog.get(item.name as CordisXPermissionCapabilityV4).presentation.description.fallback,
                },
                scope: item.scope as CordisXCapabilityScope,
              } as CordisXCapabilityDeclaration] as const,
            ]
            : []
        ))
        : manifest.capabilities.map(item => [item.name, item] as const),
    )
    const declarationsV2 = new Map(manifestDeclarationsV2(manifest).map(item => [item.name, item]))
    const declarationsV4 = new Map(
      manifestHostDomDeclarationsV4(manifest).map(item => [
        item.name as 'ui.host-dom.read' | 'ui.host-dom.modify',
        item,
      ]),
    )
    if (
      artifact !== undefined
      && (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(
        artifact.version,
      )
        || !/^sha256:[a-f0-9]{64}$/u.test(artifact.integrity))
    ) throw new Error(`plugin ${identity.id} permission artifact identity is invalid`)
    const projectedCertification = artifact === undefined
      ? undefined
      : this.certifiedProjections.get(certifiedArtifactKey(
        { source: identity.source, pluginId: identity.id },
        artifact,
      ))
    const certification = artifact === undefined
      ? undefined
      : normalizeCertifiedPermissionProjectionV1(
        projectedCertification,
        { source: identity.source, pluginId: identity.id },
        artifact,
        this.now(),
      )
    const normalizedArtifact: RegistrationArtifactBinding | undefined = artifact === undefined
      ? undefined
      : Object.freeze({
        version: artifact.version,
        integrity: artifact.integrity,
        ...(certification === undefined ? {} : { certification }),
      })
    const registration: Registration = {
      token: Object.freeze({}),
      identity: Object.freeze({ ...identity }),
      manifest,
      declarations,
      declarationsV2,
      declarationsV4,
      generation,
      ...(candidateView === undefined ? {} : { candidateView }),
      ...(normalizedArtifact === undefined ? {} : { artifact: normalizedArtifact }),
    }
    if (this.registrations.has(key) && this.visibility !== undefined) {
      throw new Error(`plugin ${identity.id} permission generation is already registered`)
    }
    this.registrations.set(key, registration)
    this.scheduleDomCertificationExpiry(key, registration)
    this.migrateLegacy(registration)
    this.migratePolicyRecordsV1(registration)
    if (this.visibility?.visible(generation) !== false) this.changed()
    return () => {
      if (this.registrations.get(key)?.token !== registration.token) return
      this.fenceAgentRuntime(identity, 'plugin-generation-replaced', registration.token)
      this.registrations.delete(key)
      this.clearDomCertificationTimer(key)
      const identityKey = platformIdentityKey(identity)
      this.onceV2.clearGeneration(this.generation, generation.moduleGeneration)
      this.clearDomGeneration(generation.moduleGeneration, identity)
      this.clearHostDomGeneration(generation.moduleGeneration, identity)
      if (![...this.registrations.values()].some(item => platformIdentityKey(item.identity) === identityKey)) {
        for (const auditKey of [...this.audit.keys()]) {
          if (auditKey.startsWith(`${identityKey}\u0000`)) this.audit.delete(auditKey)
        }
      }
      if (this.visibility?.visible(generation) !== false) this.changed()
    }
  }

  protected registration(identity: CordisXPluginIdentity, view?: PluginGenerationView): Registration | undefined {
    return [...this.registrations.values()].find(item =>
      platformIdentityKey(item.identity) === platformIdentityKey(identity)
      && (this.visibility?.visible(item.generation, view) ?? true)
    )
  }

  protected isRegistered(registration: Registration): boolean {
    return [...this.registrations.values()].some(candidate => candidate.token === registration.token)
  }

  protected persistV2(records: readonly CordisXPermissionPolicyRecordV2[]): Promise<void> {
    if (this.store.writeV2 === undefined) return Promise.reject(new Error('permission v2 persistence is unavailable'))
    return Promise.resolve(this.store.writeV2(records))
  }

  protected persistV3(records: readonly CordisXPermissionPolicyRecordV3[]): Promise<void> {
    if (this.store.writeV3 === undefined) return Promise.reject(new Error('permission v3 persistence is unavailable'))
    return Promise.resolve(this.store.writeV3(records))
  }

  protected commitDomPolicyRecords(
    records: readonly CordisXPermissionPolicyRecordV3[],
    publish: () => void,
  ): Promise<void> {
    const task = this.domPolicyCommitTail.then(async () => {
      await this.persistV3(records)
      publish()
      this.changed()
    })
    this.domPolicyCommitTail = task.catch(() => undefined)
    return task
  }

  protected persistV4(records: readonly CordisXPermissionPolicyRecordV4[]): Promise<void> {
    if (this.store.writeV4 === undefined) return Promise.reject(new Error('permission v4 persistence is unavailable'))
    return Promise.resolve(this.store.writeV4(records))
  }

  protected persistMixed(records: readonly CordisXPersistedPermissionPolicyRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve()
    if (this.store.writeAll !== undefined) return Promise.resolve(this.store.writeAll(records))
    const v2 = records.filter(isPermissionPolicyRecordV2)
    const v4 = records.filter(isPermissionPolicyRecordV4)
    if (v2.length !== records.length && v4.length !== records.length) {
      return Promise.reject(new Error('atomic mixed-version permission persistence is unavailable'))
    }
    return v2.length > 0 ? this.persistV2(v2) : this.persistV4(v4)
  }

  protected binding(
    registration: Registration,
    operationId: string,
    requestId?: string,
  ): CordisXPermissionAuthorizationPlanV2['binding'] {
    return Object.freeze({
      operationId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
      ...(requestId === undefined ? {} : { requestId }),
    })
  }

  protected denied(identityKey: string, capability: CordisXPlatformCapability, requested: RequestedScope): void {
    const key = this.auditKey(identityKey, capability)
    const audit = this.audit.get(key) ?? { denialCount: 0 }
    audit.lastDeniedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    audit.denialCount += 1
    this.audit.set(key, audit)
    this.changed()
  }

  protected auditKey(identityKey: string, capability: CordisXPlatformCapability): string {
    return `${identityKey}\u0000${capability}`
  }

  protected changed(): void {
    if (this.changeBatchDepth > 0) {
      this.changePending = true
      return
    }
    this.emitChanged()
  }

  protected batchChanges(operation: () => void): void {
    this.changeBatchDepth += 1
    try {
      operation()
    } finally {
      this.changeBatchDepth -= 1
      if (this.changeBatchDepth === 0 && this.changePending) {
        this.changePending = false
        this.emitChanged()
      }
    }
  }

  protected emitChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Permission state is authoritative; observer failures are isolated.
      }
    }
  }

  protected abstract scheduleDomCertificationExpiry(key: string, registration: Registration): void
  protected abstract clearDomCertificationTimer(key: string): void
  protected abstract migratePolicyRecordsV1(registration: Registration): void
  protected abstract clearDomGeneration(moduleGeneration?: string, identity?: CordisXPluginIdentity): void
  protected abstract clearHostDomGeneration(moduleGeneration?: string, identity?: CordisXPluginIdentity): void
  protected abstract fenceAgentRuntime(
    identity: CordisXPluginIdentity | undefined,
    code: AgentRuntimePermissionFence['code'],
    registrationToken?: object,
  ): void
  protected abstract migrateLegacy(registration: Registration): void
}
