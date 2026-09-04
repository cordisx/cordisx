import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentRuntimeCapability } from '@cordisx/protocol/agents/v1'
import {
  CORDISX_PLATFORM_CAPABILITIES,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
  type CordisXCapabilityDeclaration,
  type CordisXCapabilityScope,
  type CordisXLocalizedText,
  type CordisXModelDescriptor,
  type CordisXModelPage,
  type CordisXModelsListInput,
  type CordisXPermissionAuthorizationPlanV1,
  type CordisXPermissionAuthorizationDecisionV1,
  type CordisXPermissionDecision,
  type CordisXPermissionPolicy,
  type CordisXPermissionPolicyRecordV1,
  type CordisXPlatform,
  type CordisXPlatformAdapterStatus,
  type CordisXPlatformCapability,
  type CordisXPlatformDiagnostic,
  type CordisXPlatformModelRef,
  type CordisXPlatformSessionRef,
  type CordisXPlatformResult,
  type CordisXPluginIdentity,
  type CordisXPluginManifestV1,
  type CordisXTaskControlInput,
  type CordisXTaskControlOutcome,
  type CordisXTaskCreateInput,
  type CordisXTaskReadInput,
  type CordisXTasksListInput,
  type CordisXSessionCreateOutcome,
  type CordisXSessionPage,
  type CordisXSessionProjection,
  type CordisXSessionSummary,
  type CordisXTurnControlInput,
  type CordisXTurnControlOutcome,
  type CordisXTurnStart,
  type CordisXTurnSubmitInput,
} from '../contracts.js'
import {
  createPermissionPolicyRecord,
  normalizePermissionScope,
  permissionIdentityKey,
  permissionRecordKey,
  permissionScopeFingerprint,
} from '../permissions.js'
import {
  generationVisibilityFromContext,
  type GenerationVisibilityCoordinator,
  type PluginGenerationEffectIdentity,
  type PluginGenerationView,
} from './generation-visibility.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import type {
  PluginConsoleAspect,
  PluginConsoleInvocation,
  PluginConsolePermissionObserver,
  PluginPrincipalToken,
} from './plugin-console.js'
import { HostThemeProjection } from './host-theme.js'
import {
  type PermissionAuthorizationProjectionInput,
  PermissionAuthorizationViewModel,
} from '../permission-authorization-view-model.js'
import { BrowserPermissionAuthorizationDialog } from './permission-authorization-dialog.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4,
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V3,
  CORDISX_PERMISSION_POLICY_SCHEMA_V4,
  type CordisXCertifiedPermissionProjectionV1,
  type CordisXCapabilityDeclarationV3,
  type CordisXCapabilityDeclarationV4,
  type CordisXCapabilityDeclarationV2,
  type CordisXPermissionAuthorizationBindingV2,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationDecisionV4,
  type CordisXPermissionAuthorizationKeyV2,
  type CordisXPermissionAuthorizationKeyV3,
  type CordisXPermissionAuthorizationKeyV4,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPermissionAuthorizationPlanV4,
  type CordisXPermissionCapabilityV2,
  type CordisXPermissionCapabilityV3,
  type CordisXPermissionCapabilityV4,
  type CordisXPermissionDecisionV2,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyRecordV3,
  type CordisXPermissionPolicyRecordV4,
  type CordisXPermissionPolicyV2,
  type CordisXPermissionScopeV2,
  type CordisXPermissionScopeV3,
  type CordisXPermissionScopeV4,
  type CordisXPluginManifestV4,
  type CordisXPluginManifestV5,
  type CordisXPluginManifestV6,
  type CordisXPluginManifestV7,
  type CordisXPluginManifestV8,
} from '../permission-contracts.js'
import {
  CapabilityRiskCatalog,
  buildDomPermissionAuthorizationPlanV3,
  buildHostDomPermissionAuthorizationPlanV4,
  buildPermissionAuthorizationPlanV4,
  buildPermissionAuthorizationPlanResultV2,
} from '../capability-risk-catalog.js'
import {
  PermissionOnceGrantLedger,
  assertPermissionAuthorizationDecisionV2,
  migratePermissionPolicyV1,
  normalizePluginManifestV4,
  normalizePermissionAuthorizationBindingV2,
  normalizePermissionPolicyRecordV2,
  normalizePermissionScopeV2,
  permissionRecordKeyV2,
  permissionSecurityFingerprint,
  sha256Hex,
} from '../permission-model-v2.js'
import {
  domPermissionAuthorizationKeyV3,
  normalizePermissionPolicyRecordV3,
  permissionRecordKeyV3,
} from '../permission-model-v3.js'
import {
  assertPermissionAuthorizationDecisionV4,
  hostDomPermissionAuthorizationKeyV4,
  isHostDomPermissionCapability,
  normalizeCertifiedPermissionProjectionV1,
  normalizePermissionPolicyRecordV4,
  normalizePluginManifestV5,
  normalizePluginManifestV6,
  normalizePluginManifestV7,
  normalizePluginManifestV8,
  permissionRecordKeyV4,
} from '../permission-model-v4.js'
import {
  isPermissionPolicyRecordV2,
  isPermissionPolicyRecordV3,
  isPermissionPolicyRecordV4,
  normalizePersistedPermissionPolicyRecord,
  persistedPermissionMigrationKey,
  persistedPermissionRecordKey,
  type CordisXPersistedPermissionPolicyRecord,
} from '../permission-persistence.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
const LEGACY_POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v1'
const POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v2'

function failure(code: CordisXPlatformDiagnostic['code'], message: string, retryable = false): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message, ...(retryable ? { retryable: true } : {}) } }
}

function copy<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

function safeAdapterFailure(): CordisXPlatformResult<never> {
  return failure('adapter-failure', 'Platform adapter operation failed')
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function normalizedReason(value: unknown, label: string): CordisXLocalizedText {
  const reason = object(value, label)
  const unknown = Object.keys(reason).filter(key => !['namespace', 'key', 'params', 'fallback'].includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
  if (typeof reason.key !== 'string' || !ID_PATTERN.test(reason.key)) throw new Error(`${label}.key is invalid`)
  if (reason.namespace !== undefined && (typeof reason.namespace !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}(?::[a-z0-9][a-z0-9._-]{0,95})?$/.test(reason.namespace))) {
    throw new Error(`${label}.namespace is invalid`)
  }
  if (reason.fallback !== undefined && (typeof reason.fallback !== 'string' || reason.fallback.trim() === '')) {
    throw new Error(`${label}.fallback is invalid`)
  }
  const params = reason.params === undefined ? undefined : object(reason.params, `${label}.params`)
  if (params !== undefined && (Object.keys(params).length > 32 || Object.entries(params).some(([key, item]) => {
    return !/^[a-z][a-zA-Z0-9]*$/.test(key) || !(item === null || ['string', 'number', 'boolean'].includes(typeof item))
  }))) throw new Error(`${label}.params is invalid`)
  return Object.freeze({
    ...(typeof reason.namespace === 'string' ? { namespace: reason.namespace } : {}),
    key: reason.key,
    ...(params === undefined ? {} : {
      params: Object.fromEntries(Object.entries(params).sort(([left], [right]) => left.localeCompare(right))) as NonNullable<CordisXLocalizedText['params']>,
    }),
    ...(typeof reason.fallback === 'string' ? { fallback: reason.fallback } : {}),
  })
}

/** Validate and freeze one module manifest against its launcher-owned id. */
export function normalizePluginManifest(
  value: unknown,
  expectedId: string,
): CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8 {
  if (!ID_PATTERN.test(expectedId)) throw new Error(`launcher plugin id ${expectedId} is invalid`)
  if (value === undefined) {
    return Object.freeze({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id: expectedId,
      capabilities: Object.freeze([]),
    })
  }
  const manifest = object(value, `plugin ${expectedId} manifest`)
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V8 || manifest.schemaVersion === 8) {
    return normalizePluginManifestV8(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V7 || manifest.schemaVersion === 7) {
    return normalizePluginManifestV7(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V6 || manifest.schemaVersion === 6) {
    return normalizePluginManifestV6(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 || manifest.schemaVersion === 5) {
    return normalizePluginManifestV5(manifest, expectedId, new CapabilityRiskCatalog())
  }
  if (manifest.$schema === CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 || manifest.schemaVersion === 4) {
    return normalizePluginManifestV4(manifest, expectedId, new CapabilityRiskCatalog())
  }
  const unknown = Object.keys(manifest).filter(key => !['$schema', 'schemaVersion', 'id', 'name', 'capabilities'].includes(key))
  if (unknown.length > 0) throw new Error(`plugin ${expectedId} manifest contains unknown field ${unknown[0]}`)
  if (manifest.$schema !== CORDISX_PLUGIN_MANIFEST_SCHEMA_V1) throw new Error(`plugin ${expectedId} manifest schema is unsupported`)
  if (manifest.schemaVersion !== 1) throw new Error(`plugin ${expectedId} manifest version is unsupported`)
  if (manifest.id !== expectedId) throw new Error(`plugin manifest id ${String(manifest.id)} does not match launcher id ${expectedId}`)
  if (manifest.name !== undefined && (typeof manifest.name !== 'string' || manifest.name.trim() === '')) {
    throw new Error(`plugin ${expectedId} manifest name is invalid`)
  }
  if (!Array.isArray(manifest.capabilities)) throw new Error(`plugin ${expectedId} manifest capabilities must be an array`)
  const seen = new Set<string>()
  const capabilities = manifest.capabilities.map((item, index): CordisXCapabilityDeclaration => {
    const declaration = object(item, `plugin ${expectedId} capability[${index}]`)
    const unknownFields = Object.keys(declaration).filter(key => !['name', 'required', 'reason', 'scope'].includes(key))
    if (unknownFields.length > 0) throw new Error(`plugin ${expectedId} capability[${index}] contains unknown field ${unknownFields[0]}`)
    if (typeof declaration.name !== 'string' || !(CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(declaration.name)) {
      throw new Error(`plugin ${expectedId} capability[${index}] name is unsupported`)
    }
    if (seen.has(declaration.name)) throw new Error(`plugin ${expectedId} declares ${declaration.name} more than once`)
    seen.add(declaration.name)
    if (typeof declaration.required !== 'boolean') throw new Error(`plugin ${expectedId} capability[${index}].required must be boolean`)
    const name = declaration.name as CordisXPlatformCapability
    const scope = normalizePermissionScope(declaration.scope, `plugin ${expectedId} capability[${index}].scope`)
    if (name.startsWith('agent.') && scope.sessions !== undefined) {
      throw new Error(`plugin ${expectedId} capability[${index}] cannot use Platform sessions scope for ${name}`)
    }
    if (!name.startsWith('agent.') && scope.sessionIds !== undefined) {
      throw new Error(`plugin ${expectedId} capability[${index}] cannot use Agent sessionIds scope for ${name}`)
    }
    return Object.freeze({
      name,
      required: declaration.required,
      reason: normalizedReason(declaration.reason, `plugin ${expectedId} capability[${index}].reason`),
      scope,
    })
  })
  return Object.freeze({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id: expectedId,
    ...(typeof manifest.name === 'string' ? { name: manifest.name.trim() } : {}),
    capabilities: Object.freeze(capabilities),
  })
}

export function platformIdentityKey(identity: CordisXPluginIdentity): string {
  return permissionIdentityKey(identity)
}

function certifiedArtifactKey(
  identity: Readonly<{ source: string; pluginId: string }>,
  artifact: Readonly<{ version: string; integrity: string }>,
): string {
  return [identity.source, identity.pluginId, artifact.version, artifact.integrity].join('\u0000')
}

function declarationFingerprint(declaration: CordisXCapabilityDeclaration): string {
  return permissionScopeFingerprint(declaration.name, declaration.scope)
}

export interface LegacyStoredPolicy {
  readonly identityKey: string
  readonly capability: CordisXPlatformCapability
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
}

export interface PermissionPolicyStore {
  read(): readonly CordisXPermissionPolicyRecordV1[]
  write(records: readonly CordisXPermissionPolicyRecordV1[]): void | Promise<void>
  readV2?(): readonly CordisXPermissionPolicyRecordV2[]
  writeV2?(records: readonly CordisXPermissionPolicyRecordV2[]): void | Promise<void>
  readV3?(): readonly CordisXPermissionPolicyRecordV3[]
  writeV3?(records: readonly CordisXPermissionPolicyRecordV3[]): void | Promise<void>
  readV4?(): readonly CordisXPermissionPolicyRecordV4[]
  writeV4?(records: readonly CordisXPermissionPolicyRecordV4[]): void | Promise<void>
  /** One atomic write for mixed-version records in the single profile ledger. */
  writeAll?(records: readonly CordisXPersistedPermissionPolicyRecord[]): void | Promise<void>
  legacy?(): readonly LegacyStoredPolicy[]
  retireLegacy?(record: LegacyStoredPolicy): void | Promise<void>
}

export class MemoryPermissionPolicyStore implements PermissionPolicyStore {
  records: readonly CordisXPersistedPermissionPolicyRecord[]

  constructor(
    records: readonly CordisXPermissionPolicyRecordV1[] = [],
    recordsV2: readonly CordisXPermissionPolicyRecordV2[] = [],
    recordsV3: readonly CordisXPermissionPolicyRecordV3[] = [],
    recordsV4: readonly CordisXPermissionPolicyRecordV4[] = [],
  ) {
    this.records = copy([...records, ...recordsV2, ...recordsV3, ...recordsV4])
  }

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return copy(this.records.filter(record => !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record) && !isPermissionPolicyRecordV4(record))) as readonly CordisXPermissionPolicyRecordV1[]
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return copy(this.records.filter(isPermissionPolicyRecordV2))
  }

  readV3(): readonly CordisXPermissionPolicyRecordV3[] {
    return copy(this.records.filter(isPermissionPolicyRecordV3))
  }

  readV4(): readonly CordisXPermissionPolicyRecordV4[] {
    return copy(this.records.filter(isPermissionPolicyRecordV4))
  }

  write(records: readonly CordisXPermissionPolicyRecordV1[]): void {
    this.writeRecords(records)
  }

  writeV2(records: readonly CordisXPermissionPolicyRecordV2[]): void {
    this.writeRecords(records)
  }

  writeV3(records: readonly CordisXPermissionPolicyRecordV3[]): void {
    this.writeRecords(records)
  }

  writeV4(records: readonly CordisXPermissionPolicyRecordV4[]): void {
    this.writeRecords(records)
  }

  writeAll(records: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    this.writeRecords(records)
  }

  private writeRecords(records: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    const normalized = records.map(item => normalizePersistedPermissionPolicyRecord(item))
    const keys = new Set(normalized.map(persistedPermissionRecordKey))
    const migrations = new Set(normalized.filter(isPermissionPolicyRecordV2).map(persistedPermissionMigrationKey))
    this.records = copy([
      ...this.records.filter(item => !keys.has(persistedPermissionRecordKey(item))
        && !(migrations.has(persistedPermissionMigrationKey(item)) && !isPermissionPolicyRecordV2(item))),
      ...normalized,
    ])
  }
}

export class BrowserPermissionPolicyStore implements PermissionPolicyStore {
  constructor(private readonly profileId = 'default') {}

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV1 => (
      !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record) && !isPermissionPolicyRecordV4(record) && record.key.profileId === this.profileId
    ))
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV2 => (
      isPermissionPolicyRecordV2(record) && record.key.profileId === this.profileId
    ))
  }

  readV3(): readonly CordisXPermissionPolicyRecordV3[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV3 => (
      isPermissionPolicyRecordV3(record) && record.key.profileId === this.profileId
    ))
  }

  readV4(): readonly CordisXPermissionPolicyRecordV4[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV4 => (
      isPermissionPolicyRecordV4(record) && record.key.profileId === this.profileId
    ))
  }

  write(nextRecords: readonly CordisXPermissionPolicyRecordV1[]): void {
    this.writeRecords(nextRecords)
  }

  writeV2(nextRecords: readonly CordisXPermissionPolicyRecordV2[]): void {
    this.writeRecords(nextRecords)
  }

  writeV3(nextRecords: readonly CordisXPermissionPolicyRecordV3[]): void {
    this.writeRecords(nextRecords)
  }

  writeV4(nextRecords: readonly CordisXPermissionPolicyRecordV4[]): void {
    this.writeRecords(nextRecords)
  }

  writeAll(nextRecords: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    this.writeRecords(nextRecords)
  }

  private readAll(): readonly CordisXPersistedPermissionPolicyRecord[] {
    try {
      const value = localStorage.getItem(POLICY_STORAGE_KEY)
      const parsed = value === null ? [] : JSON.parse(value) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed.flatMap((item) => {
        try { return [normalizePersistedPermissionPolicyRecord(item)] } catch { return [] }
      })
    } catch {
      return []
    }
  }

  private writeRecords(nextRecords: readonly CordisXPersistedPermissionPolicyRecord[]): void {
    const normalized = nextRecords.map(item => normalizePersistedPermissionPolicyRecord(item))
    const records = this.readAll()
    const keys = new Set(normalized.map(persistedPermissionRecordKey))
    const migrations = new Set(normalized.filter(isPermissionPolicyRecordV2).map(persistedPermissionMigrationKey))
    localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify([
      ...records.filter(item => !keys.has(persistedPermissionRecordKey(item))
        && !(migrations.has(persistedPermissionMigrationKey(item)) && !isPermissionPolicyRecordV2(item))),
      ...normalized,
    ]))
  }

  legacy(): readonly LegacyStoredPolicy[] {
    try {
      const value = localStorage.getItem(LEGACY_POLICY_STORAGE_KEY)
      if (value === null) return []
      const records = JSON.parse(value) as unknown
      if (!Array.isArray(records)) return []
      return records.filter((item): item is LegacyStoredPolicy => {
        if (item === null || typeof item !== 'object') return false
        const record = item as Partial<LegacyStoredPolicy>
        return typeof record.identityKey === 'string'
          && typeof record.capability === 'string'
          && (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(record.capability)
          && typeof record.fingerprint === 'string'
          && (record.policy === 'ask' || record.policy === 'deny' || record.policy === 'allow')
      })
    } catch {
      return []
    }
  }

  retireLegacy(record: LegacyStoredPolicy): void {
    try {
      const records = this.legacy()
      const retained = records.filter(item => JSON.stringify(item) !== JSON.stringify(record))
      if (retained.length === 0) localStorage.removeItem(LEGACY_POLICY_STORAGE_KEY)
      else localStorage.setItem(LEGACY_POLICY_STORAGE_KEY, JSON.stringify(retained))
    } catch {
      // A stale legacy record is safe: exact migration is idempotent.
    }
  }
}

export interface RequestedScope {
  readonly providerId?: string
  readonly providerIds?: readonly string[]
  readonly cwd?: string
  readonly model?: CordisXPlatformModelRef
  readonly session?: CordisXPlatformSessionRef
  readonly adapterGeneration?: string
  readonly agentSessionId?: string
  readonly allAgentSessions?: true
}

export interface PermissionPromptRequest {
  readonly identity: CordisXPluginIdentity
  readonly declaration: CordisXCapabilityDeclaration
  readonly requested: RequestedScope
  readonly signal?: AbortSignal
}

export interface PermissionPrompt {
  request(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>>
}

export interface PermissionAuthorizationPromptV2 {
  request(
    plan: CordisXPermissionAuthorizationPlanV2,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined>
  requestV3?(
    plan: CordisXPermissionAuthorizationPlanV3,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV3 | undefined>
  cancelV3?(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void
  requestV4?(
    plan: CordisXPermissionAuthorizationPlanV4,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined>
  cancelV4?(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void
  dispose?(): void
}

export class BrowserPermissionPrompt implements PermissionPrompt {
  private queue = Promise.resolve()
  private readonly theme: HostThemeProjection

  constructor(private readonly document: Document | undefined = globalThis.document) {
    this.theme = new HostThemeProjection(document ?? globalThis.document)
  }

  request(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>> {
    const next = this.queue.then(async () => input.signal?.aborted === true ? 'deny' : await this.show(input))
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async show(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>> {
    const document = this.document
    if (document?.body === undefined || input.signal?.aborted === true) return 'deny'
    const reason = input.declaration.reason.fallback ?? `${input.declaration.reason.namespace ?? input.identity.id}:${input.declaration.reason.key}`
    return await new Promise((resolve) => {
      const overlay = document.createElement('div')
      const detachTheme = this.theme.attach(overlay)
      overlay.dataset.permissionPrompt = input.declaration.name
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-labelledby', 'cordisx-permission-prompt-title')
      overlay.setAttribute('aria-describedby', 'cordisx-permission-prompt-description')
      overlay.innerHTML = `<style>
        [data-permission-prompt] { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: var(--cx-backdrop); }
        [data-permission-prompt] .cxp-dialog { width: min(460px, 100%); border: 1px solid var(--cx-border); border-radius: 14px; padding: 20px; background: var(--cx-surface-raised); color: var(--cx-text); box-shadow: 0 20px 64px var(--cx-shadow); }
        [data-permission-prompt] h2 { margin: 0; font-size: 18px; }
        [data-permission-prompt] p { margin: 10px 0 0; line-height: 1.5; }
        [data-permission-prompt] .cxp-reason { color: var(--cx-muted); }
        [data-permission-prompt] .cxp-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
        [data-permission-prompt] button { border: 1px solid var(--cx-border); border-radius: 9px; padding: 8px 12px; background: var(--cx-hover); color: var(--cx-text); cursor: pointer; }
        [data-permission-prompt] button[data-primary="true"] { border-color: var(--cx-primary); background: var(--cx-primary); color: var(--cx-primary-text); font-weight: 600; }
        [data-permission-prompt] button[data-tone="danger"] { color: var(--cx-danger); }
        [data-permission-prompt] button:focus-visible { outline: 2px solid var(--cx-focus); outline-offset: 2px; }
      </style>`
      const dialog = document.createElement('div')
      dialog.className = 'cxp-dialog'
      const title = document.createElement('h2')
      title.id = 'cordisx-permission-prompt-title'
      title.textContent = '权限请求'
      const description = document.createElement('p')
      description.id = 'cordisx-permission-prompt-description'
      description.textContent = `${input.identity.id} 请求 ${input.declaration.name}`
      const reasonNode = document.createElement('p')
      reasonNode.className = 'cxp-reason'
      reasonNode.textContent = reason
      const actions = document.createElement('div')
      actions.className = 'cxp-actions'
      let settled = false
      const finish = (decision: Exclude<CordisXPermissionDecision, 'ask'>): void => {
        if (settled) return
        settled = true
        input.signal?.removeEventListener('abort', abort)
        detachTheme()
        overlay.remove()
        resolve(decision)
      }
      const abort = (): void => finish('deny')
      input.signal?.addEventListener('abort', abort, { once: true })
      const deny = document.createElement('button')
      deny.type = 'button'
      deny.dataset.permissionDecision = 'deny'
      deny.dataset.tone = 'danger'
      deny.textContent = '拒绝'
      deny.addEventListener('click', () => finish('deny'), { once: true })
      const once = document.createElement('button')
      once.type = 'button'
      once.dataset.permissionDecision = 'allow-once'
      once.textContent = '仅此次允许'
      once.addEventListener('click', () => finish('allow-once'), { once: true })
      const allow = document.createElement('button')
      allow.type = 'button'
      allow.dataset.permissionDecision = 'allow'
      allow.dataset.primary = 'true'
      allow.textContent = '始终允许'
      allow.addEventListener('click', () => finish('allow'), { once: true })
      overlay.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        finish('deny')
      })
      actions.append(deny, once, allow)
      dialog.append(title, description, reasonNode, actions)
      overlay.append(dialog)
      document.body.append(overlay)
      allow.focus()
    })
  }
}

export type PermissionAuthorizationProjectionFactoryV2 = (
  plan: CordisXPermissionAuthorizationPlanV2,
  identity: CordisXPluginIdentity,
) => PermissionAuthorizationProjectionInput

/** Host-owned v2 modal; plugin text is already validated and only reaches text nodes. */
export class BrowserPermissionAuthorizationPromptV2 implements PermissionAuthorizationPromptV2 {
  private readonly dialog: BrowserPermissionAuthorizationDialog

  constructor(
    document: Document = globalThis.document,
    private readonly project: PermissionAuthorizationProjectionFactoryV2 = (_plan, identity) => ({
      plugin: { name: identity.id, source: identity.source, trust: 'configured' },
      availability: {},
      resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
      scope: scope => Object.keys(scope).length === 0 ? 'Host default scope' : JSON.stringify(scope),
      requestSource: identity.source,
    }),
  ) {
    this.dialog = new BrowserPermissionAuthorizationDialog(document)
  }

  async request(
    plan: CordisXPermissionAuthorizationPlanV2,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined> {
    const result = await this.dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => this.project(plan, identity),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
  }

  async requestV3(
    plan: CordisXPermissionAuthorizationPlanV3,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV3 | undefined> {
    const result = await this.dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => this.project(plan as unknown as CordisXPermissionAuthorizationPlanV2, identity),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
  }

  async requestV4(
    plan: CordisXPermissionAuthorizationPlanV4,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV4 | undefined> {
    const result = await this.dialog.show(new PermissionAuthorizationViewModel(plan), {
      project: () => this.project(plan as unknown as CordisXPermissionAuthorizationPlanV2, identity),
    })
    return result.status === 'confirmed' && result.decision.schemaVersion === 4 ? result.decision : undefined
  }

  cancelV3(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    this.dialog.cancel(planId, binding)
  }

  cancelV4(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    this.dialog.cancel(planId, binding)
  }

  dispose(): void {
    this.dialog.dispose()
  }
}

interface AuditRecord {
  lastUsedAt?: string
  lastDeniedAt?: string
  lastRequested?: RequestedScope
  denialCount: number
  authorizationOrigin?: 'explicit-user' | 'certified-implicit'
  authorizationReason?: string
  certification?: CordisXCertifiedPermissionProjectionV1
}

export interface PlatformPermissionSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPermissionCapabilityV4
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly scope: CordisXPermissionScopeV4
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
  readonly lastRequested?: RequestedScope
  readonly lastUsedAt?: string
  readonly lastDeniedAt?: string
  readonly denialCount: number
  readonly blockedReason?: string
  readonly authorizationOrigin?: 'explicit-user' | 'certified-implicit'
  readonly authorizationReason?: string
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

export interface PermissionArtifactBindingV3 {
  readonly version: string
  readonly integrity: `sha256:${string}`
}

interface RegistrationArtifactBinding extends PermissionArtifactBindingV3 {
  readonly certification?: CordisXCertifiedPermissionProjectionV1
}

export interface DomPermissionAccessDecision {
  readonly authorized: boolean
  readonly state: 'allowed' | 'denied' | 'pending'
  readonly reason: string
  readonly policy: 'inherit' | 'allow' | 'deny'
  readonly authorizationOrigin?: 'explicit-user' | 'certified-implicit'
}

export interface DomPermissionPolicyEntry {
  readonly identity: CordisXPluginIdentity
  readonly pointId: string
  readonly policy: 'inherit' | 'allow' | 'deny'
}

interface Registration {
  readonly token: object
  readonly identity: CordisXPluginIdentity
  readonly manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8
  readonly declarations: ReadonlyMap<CordisXPlatformCapability, CordisXCapabilityDeclaration>
  readonly declarationsV2: ReadonlyMap<CordisXPermissionCapabilityV2, CordisXCapabilityDeclarationV2>
  readonly declarationsV4: ReadonlyMap<'ui.host-dom.read' | 'ui.host-dom.modify', CordisXCapabilityDeclarationV4>
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
  readonly artifact?: RegistrationArtifactBinding
}

interface DomPermissionLease {
  readonly key: CordisXPermissionAuthorizationKeyV3
  readonly runtimeGeneration: string
  readonly moduleGeneration?: string
  readonly authorizationOrigin: 'explicit-user' | 'certified-implicit'
  readonly certificationFingerprint?: `sha256:${string}`
  readonly certificationRevision?: string
}

export interface HostDomPermissionLease {
  readonly leaseId: string
  readonly key: CordisXPermissionAuthorizationKeyV4
  readonly runtimeGeneration: string
  readonly moduleGeneration?: string
  readonly authorizationOrigin: 'explicit-user' | 'certified-implicit'
  readonly certificationFingerprint?: `sha256:${string}`
  readonly certificationRevision?: string
}

export interface HostDomPermissionAccessDecision extends DomPermissionAccessDecision {
  readonly lease?: HostDomPermissionLease
}

function manifestDeclarationsV2(
  manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8,
): readonly CordisXCapabilityDeclarationV2[] {
  if (manifest.schemaVersion === 4) return manifest.capabilities
  if (manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7 || manifest.schemaVersion === 8) return manifest.capabilities.filter(item => (
    !isHostDomPermissionCapability(item.name) && !isAgentRuntimePermission(item.name)
  )) as readonly CordisXCapabilityDeclarationV2[]
  return Object.freeze(manifest.capabilities.map(declaration => Object.freeze({
    name: declaration.name as CordisXPermissionCapabilityV2,
    required: declaration.required,
    scope: declaration.scope as CordisXPermissionScopeV2,
  })))
}

function manifestHostDomDeclarationsV4(
  manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8,
): readonly CordisXCapabilityDeclarationV4[] {
  return manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7 || manifest.schemaVersion === 8
    ? manifest.capabilities.filter(item => isHostDomPermissionCapability(item.name)) as readonly CordisXCapabilityDeclarationV4[]
    : Object.freeze([])
}

function isAgentRuntimePermission(value: string): boolean {
  return value.startsWith('agents.') || value.startsWith('sessions.') || value.startsWith('approvals.')
}

/** The legacy v4 review UI has no Agent/Session vocabulary; those declarations
 * are evaluated by the Host-private exact Session lease authority instead. */
function permissionPlanDeclarations(
  manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8,
): readonly CordisXCapabilityDeclarationV4[] {
  return (manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7 || manifest.schemaVersion === 8
    ? manifest.capabilities.filter(item => !isAgentRuntimePermission(item.name))
    : manifest.capabilities) as readonly CordisXCapabilityDeclarationV4[]
}

interface AuthorizationGrant {
  readonly declaration: CordisXCapabilityDeclaration
}

function normalizedPath(value: string): string {
  const slashed = value.replaceAll('\\', '/')
  const prefix = /^[a-zA-Z]:\//.test(slashed) ? slashed.slice(0, 2).toLowerCase() : ''
  const body = prefix === '' ? slashed : slashed.slice(2)
  const parts = body.split('/').filter(part => part !== '' && part !== '.')
  const result: string[] = []
  for (const part of parts) part === '..' ? result.pop() : result.push(part)
  return `${prefix}${body.startsWith('/') ? '/' : ''}${result.join('/')}`.replace(/\/$/, '') || '/'
}

function pathInside(value: string, root: string): boolean {
  const target = normalizedPath(value)
  const base = normalizedPath(root)
  const insensitive = /^[a-z]:\//.test(target) || /^[a-z]:\//.test(base)
  const left = insensitive ? target.toLowerCase() : target
  const right = insensitive ? base.toLowerCase() : base
  return left === right || left.startsWith(right === '/' ? '/' : `${right}/`)
}

function scopeAllows(scope: CordisXCapabilityScope, requested: RequestedScope): boolean {
  if (requested.providerId !== undefined && scope.providers !== undefined && !scope.providers.includes(requested.providerId)) return false
  if (requested.providerIds !== undefined && scope.providers !== undefined && requested.providerIds.some(id => !scope.providers?.includes(id))) return false
  if (requested.model !== undefined && scope.providers !== undefined && !scope.providers.includes(requested.model.providerId)) return false
  if (requested.session !== undefined && scope.sessions !== undefined && !scope.sessions.some(ref => {
    return ref.providerId === requested.session?.providerId && ref.remoteSessionId === requested.session.remoteSessionId
  })) return false
  if (requested.cwd !== undefined && scope.cwdRoots !== undefined && !scope.cwdRoots.some(root => pathInside(requested.cwd as string, root))) return false
  if (requested.agentSessionId !== undefined && scope.sessionIds !== undefined && !scope.sessionIds.includes(requested.agentSessionId)) return false
  if (requested.allAgentSessions === true && scope.sessionIds !== undefined) return false
  return true
}

function requestedSnapshot(requested: RequestedScope): RequestedScope {
  return Object.freeze({
    ...(requested.providerId === undefined ? {} : { providerId: requested.providerId }),
    ...(requested.providerIds === undefined ? {} : { providerIds: Object.freeze([...requested.providerIds]) }),
    ...(requested.cwd === undefined ? {} : { cwd: requested.cwd }),
    ...(requested.model === undefined ? {} : { model: Object.freeze({ ...requested.model }) }),
    ...(requested.session === undefined ? {} : { session: Object.freeze({ ...requested.session }) }),
    ...(requested.adapterGeneration === undefined ? {} : { adapterGeneration: requested.adapterGeneration }),
    ...(requested.agentSessionId === undefined ? {} : { agentSessionId: requested.agentSessionId }),
    ...(requested.allAgentSessions === true ? { allAgentSessions: true as const } : {}),
  })
}

function isoNow(now: () => Date): string {
  return now().toISOString()
}

/** Host-only Agent/Session authorization inputs. They are never projected to plugins. */
export type AgentRuntimeConnection = Readonly<{ connectionId: string; generation: number }>
export type AgentRuntimeRouteScope = Readonly<{
  kind: 'host-route'; active: true; owner: { source: string; pluginId: string }; routeId: string
  routeInstanceId: string; path: string; params: Readonly<{ sessionId: string }>
}>
export type AgentRuntimeScopeSource =
  | Readonly<{ kind: 'host-route'; routeInstanceId: string; routeId: string; path: string; params: Readonly<{ sessionId: string }> }>
  | Readonly<{ kind: 'host-create'; reservedSessionId: string }>
  | Readonly<{ kind: 'host-exact'; exactSessionId: string }>
export type AgentRuntimePermissionFence = Readonly<{
  identity: CordisXPluginIdentity; sessionId: string
  code: 'route-replaced' | 'plugin-generation-replaced' | 'permission-revoked' | 'connection-replaced'
}>
export type AgentRuntimeLease = Readonly<{ leaseId: string; sessionId: string }>
export type DevelopmentAgentRuntimePolicySeedAuthority = object
export type DevelopmentAgentRuntimeAuthorizationAuthority = object
export type PlaygroundScenarioAgentRuntimeRouteAuthority = object

export type AgentRuntimeAuthorization = Readonly<{
  authorized: boolean
  lease?: AgentRuntimeLease
}>

interface AgentRuntimeLeaseRecord {
  readonly lease: AgentRuntimeLease
  readonly identity: CordisXPluginIdentity
  readonly capability: AgentRuntimeCapability
  readonly connection: AgentRuntimeConnection
  readonly routeInstanceId?: string
  readonly moduleGeneration?: string
}

function validAgentRuntimeOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}
function validAgentRuntimeSessionId(value: unknown): value is string {
  return validAgentRuntimeOpaqueId(value) && !value.includes('*')
}
function validAgentRuntimeConnection(value: AgentRuntimeConnection): boolean {
  return validAgentRuntimeOpaqueId(value.connectionId) && Number.isSafeInteger(value.generation) && value.generation >= 0
}
function validAgentRuntimeRoute(value: AgentRuntimeRouteScope): boolean {
  return value.kind === 'host-route' && value.active === true
    && validAgentRuntimeOpaqueId(value.owner.source) && validAgentRuntimeOpaqueId(value.owner.pluginId)
    && validAgentRuntimeOpaqueId(value.routeId) && validAgentRuntimeOpaqueId(value.routeInstanceId)
    && validAgentRuntimeOpaqueId(value.path) && validAgentRuntimeSessionId(value.params.sessionId)
}
function agentRuntimeIdentityKey(value: Readonly<{ source: string; pluginId: string }>): string {
  return `${value.source}\u0000${value.pluginId}`
}
function sameAgentRuntimeConnection(left: AgentRuntimeConnection | undefined, right: AgentRuntimeConnection | undefined): boolean {
  return left?.connectionId === right?.connectionId && left?.generation === right?.generation
}
function sameAgentRuntimeRoute(left: AgentRuntimeRouteScope, right: AgentRuntimeRouteScope): boolean {
  return left.owner.source === right.owner.source && left.owner.pluginId === right.owner.pluginId
    && left.routeId === right.routeId && left.routeInstanceId === right.routeInstanceId
    && left.path === right.path && left.params.sessionId === right.params.sessionId
}
function isHostRouteSessionScopeBinding(value: unknown): value is Readonly<{ kind: 'host-route-param'; routeId: string; param: 'sessionId' }> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => key === 'kind' || key === 'routeId' || key === 'param')
    && (value as { kind?: unknown }).kind === 'host-route-param'
    && typeof (value as { routeId?: unknown }).routeId === 'string'
    && (value as { param?: unknown }).param === 'sessionId'
}

export class PermissionBroker {
  private readonly registrations = new Map<string, Registration>()
  /** Launcher-fed, renderer-ephemeral exact projections; never a feed/root/store authority. */
  private readonly certifiedProjections = new Map<string, CordisXCertifiedPermissionProjectionV1>()
  private certifiedProjectionRevision = -1
  private certifiedProjectionDigest = ''
  private certifiedProjectionAvailable = false
  /** One profile ledger index for both the retiring v1 records and authoritative v2 records. */
  private readonly policyRecords = new Map<string, CordisXPersistedPermissionPolicyRecord>()
  private readonly audit = new Map<string, AuditRecord>()
  private readonly onceV2 = new PermissionOnceGrantLedger()
  private readonly domLeases = new Map<string, DomPermissionLease>()
  private readonly domRequests = new Map<string, Promise<DomPermissionAccessDecision>>()
  private readonly domPromptPlans = new Map<string, CordisXPermissionAuthorizationPlanV3>()
  private readonly domPoints = new Map<string, Readonly<{ identity: CordisXPluginIdentity; pointId: string; moduleGeneration?: string }>>()
  private readonly domCertificationTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly hostDomLeases = new Map<string, HostDomPermissionLease>()
  private readonly hostDomPromptPlans = new Map<string, Readonly<{
    plan: CordisXPermissionAuthorizationPlanV4
    cancel: () => void
  }>>()
  private readonly hostDomPolicyRevisions = new Map<string, number>()
  private hostDomOperationSequence = 0
  private readonly pendingDomReviews = new Map<string, Readonly<{
    identity: CordisXPluginIdentity
    pointId: string
    moduleGeneration?: string
    view?: PluginGenerationView
  }>>()
  private readonly catalog = new CapabilityRiskCatalog()
  private readonly listeners = new Set<() => void>()
  private readonly agentRuntimeRoutes = new Map<string, AgentRuntimeRouteScope>()
  private readonly playgroundScenarioAgentRuntimeRoutes = new Map<string, Readonly<{
    route: AgentRuntimeRouteScope
    baseRouteInstanceId: string
  }>>()
  private readonly agentRuntimeLeases = new Map<string, AgentRuntimeLeaseRecord>()
  private readonly pendingAgentRuntimePrompts = new Set<Readonly<{
    identity: CordisXPluginIdentity
    registrationToken: object
    abort: AbortController
  }>>()
  private readonly agentRuntimeFenceListeners = new Set<(fence: AgentRuntimePermissionFence) => void>()
  private readonly developmentAgentRuntimeSeeds = new WeakSet<object>()
  private readonly developmentAgentRuntimeAuthorizations = new WeakSet<object>()
  private readonly playgroundScenarioAgentRuntimeRouteAuthorities = new WeakSet<object>()
  private agentRuntimeConnection: AgentRuntimeConnection | undefined
  private readonly migrationTasks: Promise<void>[] = []
  private domPolicyCommitTail: Promise<void> = Promise.resolve()
  private changeBatchDepth = 0
  private changePending = false

  constructor(
    private readonly store: PermissionPolicyStore,
    private readonly prompt: PermissionPrompt,
    private readonly now: () => Date = () => new Date(),
    private readonly promptTimeoutMs = 30_000,
    private readonly profileId = 'default',
    private readonly generation = 'runtime',
    private readonly visibility?: GenerationVisibilityCoordinator,
    private readonly consoleObserver?: PluginConsolePermissionObserver,
    private readonly promptV2?: PermissionAuthorizationPromptV2,
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
    manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4 | CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8,
    generation: PluginGenerationEffectIdentity = Object.freeze({ pluginId: identity.id }),
    candidateView?: PluginGenerationView,
    artifact?: PermissionArtifactBindingV3,
  ): () => void {
    const key = `${platformIdentityKey(identity)}\u0000${generation.moduleGeneration ?? 'host'}`
    const declarations = new Map<CordisXPlatformCapability, CordisXCapabilityDeclaration>(
      manifest.schemaVersion === 4 || manifest.schemaVersion === 5 || manifest.schemaVersion === 6 || manifest.schemaVersion === 7 || manifest.schemaVersion === 8
        ? manifest.capabilities.flatMap(item => (
            (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(item.name)
              ? [[item.name as CordisXPlatformCapability, {
                  name: item.name as CordisXPlatformCapability,
                  required: item.required,
                  reason: ('rationale' in item ? item.rationale?.description : undefined) ?? {
                    namespace: 'permission',
                    key: `permission.${item.name}.legacy-reason`,
                    fallback: this.catalog.get(item.name as CordisXPermissionCapabilityV4).presentation.description.fallback,
                  },
                  scope: item.scope as CordisXCapabilityScope,
                } as CordisXCapabilityDeclaration] as const]
              : []
          ))
        : manifest.capabilities.map(item => [item.name, item] as const),
    )
    const declarationsV2 = new Map(manifestDeclarationsV2(manifest).map(item => [item.name, item]))
    const declarationsV4 = new Map(manifestHostDomDeclarationsV4(manifest).map(item => [
      item.name as 'ui.host-dom.read' | 'ui.host-dom.modify', item,
    ]))
    if (artifact !== undefined && (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(artifact.version)
      || !/^sha256:[a-f0-9]{64}$/u.test(artifact.integrity))) throw new Error(`plugin ${identity.id} permission artifact identity is invalid`)
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
    const normalizedArtifact: RegistrationArtifactBinding | undefined = artifact === undefined ? undefined : Object.freeze({
      version: artifact.version,
      integrity: artifact.integrity,
      ...(certification === undefined ? {} : { certification }),
    })
    const registration: Registration = {
      token: Object.freeze({}),
      identity: Object.freeze({ ...identity }), manifest, declarations, declarationsV2, declarationsV4, generation,
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
        for (const auditKey of [...this.audit.keys()]) if (auditKey.startsWith(`${identityKey}\u0000`)) this.audit.delete(auditKey)
      }
      if (this.visibility?.visible(generation) !== false) this.changed()
    }
  }

  /** Installs the current opaque transport generation. Replacing it fences every lease. */
  replaceAgentRuntimeConnection(connection: AgentRuntimeConnection): void {
    if (!validAgentRuntimeConnection(connection)) throw new Error('Agent Session runtime connection is invalid')
    if (sameAgentRuntimeConnection(this.agentRuntimeConnection, connection)) return
    this.agentRuntimeConnection = Object.freeze({ ...connection })
    this.fenceAgentRuntime(undefined, 'connection-replaced')
    this.playgroundScenarioAgentRuntimeRoutes.clear()
  }

  clearAgentRuntimeConnection(): void {
    if (this.agentRuntimeConnection === undefined) return
    this.agentRuntimeConnection = undefined
    this.fenceAgentRuntime(undefined, 'connection-replaced')
    this.playgroundScenarioAgentRuntimeRoutes.clear()
  }

  /** Host Router only: records the active same-plugin route projection. */
  replaceAgentRuntimeRouteScope(scope: AgentRuntimeRouteScope): void {
    if (!validAgentRuntimeRoute(scope)) throw new Error('Agent Session runtime route scope is invalid')
    const key = agentRuntimeIdentityKey(scope.owner)
    const previous = this.agentRuntimeRoutes.get(key)
    const next = Object.freeze({
      ...scope,
      owner: Object.freeze({ ...scope.owner }),
      params: Object.freeze({ ...scope.params }),
    })
    if (previous !== undefined && !sameAgentRuntimeRoute(previous, next)) {
      this.agentRuntimeRoutes.set(key, next)
      this.clearPlaygroundScenarioAgentRuntimeRoutes(previous.routeInstanceId)
      this.fenceAgentRuntime({ source: previous.owner.source, id: previous.owner.pluginId }, 'route-replaced')
      return
    }
    this.agentRuntimeRoutes.set(key, next)
  }

  revokeAgentRuntimeRoute(routeInstanceId: string): void {
    if (!validAgentRuntimeOpaqueId(routeInstanceId)) return
    for (const [key, route] of this.agentRuntimeRoutes) {
      if (route.routeInstanceId !== routeInstanceId) continue
      this.agentRuntimeRoutes.delete(key)
      this.clearPlaygroundScenarioAgentRuntimeRoutes(route.routeInstanceId)
      this.fenceAgentRuntime({ source: route.owner.source, id: route.owner.pluginId }, 'route-replaced')
    }
  }

  /** Returns an exact revocable lease only after a registered v5/v6 declaration and exact policy match. */
  async authorizeAgentRuntime(input: Readonly<{
    identity: CordisXPluginIdentity
    capability: AgentRuntimeCapability
    sessionId: string
    scopeSource: AgentRuntimeScopeSource
    connection: AgentRuntimeConnection
    view?: PluginGenerationView
  }>): Promise<AgentRuntimeAuthorization> {
    return await this.authorizeAgentRuntimeInternal(input, false)
  }

  /** Host development composition only: applies a normal exact policy without opening interactive UI. */
  async authorizeDevelopmentAgentRuntime(
    authority: DevelopmentAgentRuntimeAuthorizationAuthority,
    input: Readonly<{
      identity: CordisXPluginIdentity
      capability: AgentRuntimeCapability
      sessionId: string
      scopeSource: AgentRuntimeScopeSource
      connection: AgentRuntimeConnection
      view?: PluginGenerationView
    }>,
  ): Promise<AgentRuntimeAuthorization> {
    if (!this.developmentAgentRuntimeAuthorizations.has(authority)) {
      throw new Error('Agent Session development authorization authority is invalid')
    }
    return await this.authorizeAgentRuntimeInternal(input, true)
  }

  private async authorizeAgentRuntimeInternal(input: Readonly<{
    identity: CordisXPluginIdentity
    capability: AgentRuntimeCapability
    sessionId: string
    scopeSource: AgentRuntimeScopeSource
    connection: AgentRuntimeConnection
    view?: PluginGenerationView
  }>, developmentAutoApprove: boolean): Promise<AgentRuntimeAuthorization> {
    const registration = this.registration(input.identity, input.view)
    if (registration === undefined || !validAgentRuntimeSessionId(input.sessionId)
      || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
      || (registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6)) return Object.freeze({ authorized: false })
    const declaration = registration.manifest.capabilities.find(item => item.name === input.capability)
    if (declaration === undefined) return Object.freeze({ authorized: false })
    if (!this.validAgentRuntimeScopeSource(registration, input, declaration.scope.sessionIds)) return Object.freeze({ authorized: false })
    const policyKey = this.agentRuntimePolicyKey(registration, input.capability, input.sessionId)
    const policy = this.policyRecords.get(policyKey)
    if (!developmentAutoApprove && isPermissionPolicyRecordV4(policy) && policy.policy === 'deny-persistent') {
      return Object.freeze({ authorized: false })
    }
    if (developmentAutoApprove && (!isPermissionPolicyRecordV4(policy) || policy.policy !== 'allow-persistent')) {
      const record = this.agentRuntimePolicyRecord(registration, input.capability, input.sessionId, 'allow-persistent')
      try { await this.persistV4([record]) } catch { return Object.freeze({ authorized: false }) }
      if (!this.isRegistered(registration) || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
        || !this.validAgentRuntimeScopeSource(registration, input, declaration.scope.sessionIds)) {
        return Object.freeze({ authorized: false })
      }
      this.policyRecords.set(permissionRecordKeyV4(record), record)
      this.changed()
    } else if (!isPermissionPolicyRecordV4(policy) || policy.policy !== 'allow-persistent') {
      const promptDeclaration: CordisXCapabilityDeclaration = Object.freeze({
        name: input.capability as CordisXPlatformCapability,
        required: declaration.required,
        reason: declaration.rationale?.description ?? Object.freeze({
          namespace: 'permission', key: `agent-runtime.${input.capability}`,
          fallback: `${input.capability} for one exact Agent Session`,
        }),
        scope: Object.freeze({ sessionIds: Object.freeze([input.sessionId]) }),
      })
      let decision: Exclude<CordisXPermissionDecision, 'ask'> | 'timeout' | 'cancelled'
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = new AbortController()
      const pending = Object.freeze({ identity: registration.identity, registrationToken: registration.token, abort })
      this.pendingAgentRuntimePrompts.add(pending)
      try {
        decision = await Promise.race([
          this.prompt.request({
            identity: input.identity,
            declaration: promptDeclaration,
            requested: Object.freeze({ agentSessionId: input.sessionId }),
            signal: abort.signal,
          }),
          new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.promptTimeoutMs) }),
          new Promise<'cancelled'>(resolve => abort.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })),
        ])
      } catch { decision = 'deny' }
      finally {
        if (timer !== undefined) clearTimeout(timer)
        this.pendingAgentRuntimePrompts.delete(pending)
        abort.abort()
      }
      if (decision !== 'allow' && decision !== 'allow-once') return Object.freeze({ authorized: false })
      if (!this.isRegistered(registration) || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
        || !this.validAgentRuntimeScopeSource(registration, input, declaration.scope.sessionIds)) {
        return Object.freeze({ authorized: false })
      }
      if (decision === 'allow') {
        const record = this.agentRuntimePolicyRecord(registration, input.capability, input.sessionId, 'allow-persistent')
        try { await this.persistV4([record]) } catch { return Object.freeze({ authorized: false }) }
        if (!this.isRegistered(registration) || !sameAgentRuntimeConnection(this.agentRuntimeConnection, input.connection)
          || !this.validAgentRuntimeScopeSource(registration, input, declaration.scope.sessionIds)) {
          return Object.freeze({ authorized: false })
        }
        this.policyRecords.set(permissionRecordKeyV4(record), record)
        this.changed()
      }
    }
    const existing = [...this.agentRuntimeLeases.values()].find(item => (
      item.identity.source === input.identity.source && item.identity.id === input.identity.id
      && item.capability === input.capability && item.lease.sessionId === input.sessionId
      && sameAgentRuntimeConnection(item.connection, input.connection)
      && item.routeInstanceId === (input.scopeSource.kind === 'host-route' ? input.scopeSource.routeInstanceId : undefined)
      && item.moduleGeneration === registration.generation.moduleGeneration
    ))
    if (existing !== undefined) return Object.freeze({ authorized: true, lease: existing.lease })
    const lease = Object.freeze({ leaseId: crypto.randomUUID(), sessionId: input.sessionId })
    this.agentRuntimeLeases.set(lease.leaseId, Object.freeze({
      lease, identity: Object.freeze({ ...input.identity }), capability: input.capability,
      connection: Object.freeze({ ...input.connection }),
      ...(input.scopeSource.kind === 'host-route' ? { routeInstanceId: input.scopeSource.routeInstanceId } : {}),
      ...(registration.generation.moduleGeneration === undefined ? {} : { moduleGeneration: registration.generation.moduleGeneration }),
    }))
    return Object.freeze({ authorized: true, lease })
  }

  isAgentRuntimeLeaseActive(identity: CordisXPluginIdentity, leaseId: string, view?: PluginGenerationView): boolean {
    const lease = this.agentRuntimeLeases.get(leaseId)
    const registration = this.registration(identity, view)
    return lease !== undefined && registration !== undefined
      && lease.identity.source === identity.source && lease.identity.id === identity.id
      && lease.moduleGeneration === registration.generation.moduleGeneration
      && sameAgentRuntimeConnection(lease.connection, this.agentRuntimeConnection)
      && (lease.routeInstanceId === undefined || this.agentRuntimeRouteValues().some(route => (
        route.routeInstanceId === lease.routeInstanceId && route.params.sessionId === lease.lease.sessionId
        && route.owner.source === identity.source && route.owner.pluginId === identity.id
      )))
  }

  subscribeAgentRuntimePermissionFences(listener: (fence: AgentRuntimePermissionFence) => void): () => void {
    this.agentRuntimeFenceListeners.add(listener)
    return () => this.agentRuntimeFenceListeners.delete(listener)
  }

  /** Development composition receives this opaque authority; production does not create one. */
  createDevelopmentAgentRuntimePolicySeedAuthority(): DevelopmentAgentRuntimePolicySeedAuthority {
    const authority = Object.freeze({})
    this.developmentAgentRuntimeSeeds.add(authority)
    return authority
  }

  /** Created only by a Host development composition and never projected into plugin context. */
  createDevelopmentAgentRuntimeAuthorizationAuthority(): DevelopmentAgentRuntimeAuthorizationAuthority {
    const authority = Object.freeze({})
    this.developmentAgentRuntimeAuthorizations.add(authority)
    return authority
  }

  /** Host Playground only: mint authority for an exact scenario route beside the visible Room route. */
  createPlaygroundScenarioAgentRuntimeRouteAuthority(): PlaygroundScenarioAgentRuntimeRouteAuthority {
    const authority = Object.freeze({})
    this.playgroundScenarioAgentRuntimeRouteAuthorities.add(authority)
    return authority
  }

  /**
   * Add one temporary exact route to this broker without replacing the visible
   * Room route. Cleanup is idempotent and fences only leases from this route.
   */
  activatePlaygroundScenarioAgentRuntimeRoute(
    authority: PlaygroundScenarioAgentRuntimeRouteAuthority,
    baseRouteInstanceId: string,
    scope: AgentRuntimeRouteScope,
  ): () => void {
    if (!this.playgroundScenarioAgentRuntimeRouteAuthorities.has(authority)) {
      throw new Error('Playground scenario Agent Session route authority is invalid')
    }
    if (!validAgentRuntimeOpaqueId(baseRouteInstanceId) || !validAgentRuntimeRoute(scope)) {
      throw new Error('Playground scenario Agent Session route scope is invalid')
    }
    const primary = this.agentRuntimeRoutes.get(agentRuntimeIdentityKey(scope.owner))
    if (primary === undefined || primary.routeInstanceId !== baseRouteInstanceId
      || primary.owner.source !== scope.owner.source || primary.owner.pluginId !== scope.owner.pluginId
      || primary.routeId !== scope.routeId || primary.path !== scope.path
      || scope.routeInstanceId === baseRouteInstanceId) {
      throw new Error('Playground scenario Agent Session route does not match the active Room route')
    }
    if (this.playgroundScenarioAgentRuntimeRoutes.has(scope.routeInstanceId)) {
      throw new Error('Playground scenario Agent Session route instance is already active')
    }
    const record = Object.freeze({
      route: Object.freeze({ ...scope, owner: Object.freeze({ ...scope.owner }), params: Object.freeze({ ...scope.params }) }),
      baseRouteInstanceId,
    })
    this.playgroundScenarioAgentRuntimeRoutes.set(scope.routeInstanceId, record)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.playgroundScenarioAgentRuntimeRoutes.get(scope.routeInstanceId) !== record) return
      this.playgroundScenarioAgentRuntimeRoutes.delete(scope.routeInstanceId)
      this.fenceAgentRuntimeRouteInstance(scope.routeInstanceId, 'route-replaced')
    }
  }

  /** Host Playground Shell only: mount an exact route from a captured Room binding. */
  activateCapturedPlaygroundScenarioAgentRuntimeRoute(
    authority: PlaygroundScenarioAgentRuntimeRouteAuthority,
    scope: AgentRuntimeRouteScope,
  ): () => void {
    if (!this.playgroundScenarioAgentRuntimeRouteAuthorities.has(authority)) {
      throw new Error('Playground scenario Agent Session route authority is invalid')
    }
    if (!validAgentRuntimeRoute(scope) || this.playgroundScenarioAgentRuntimeRoutes.has(scope.routeInstanceId)) {
      throw new Error('Playground scenario captured Agent Session route scope is invalid')
    }
    const record = Object.freeze({
      route: Object.freeze({ ...scope, owner: Object.freeze({ ...scope.owner }), params: Object.freeze({ ...scope.params }) }),
      baseRouteInstanceId: scope.routeInstanceId,
    })
    this.playgroundScenarioAgentRuntimeRoutes.set(scope.routeInstanceId, record)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.playgroundScenarioAgentRuntimeRoutes.get(scope.routeInstanceId) !== record) return
      this.playgroundScenarioAgentRuntimeRoutes.delete(scope.routeInstanceId)
      this.fenceAgentRuntimeRouteInstance(scope.routeInstanceId, 'route-replaced')
    }
  }

  async seedAgentRuntimePolicies(
    authority: DevelopmentAgentRuntimePolicySeedAuthority,
    identity: CordisXPluginIdentity,
    entries: readonly Readonly<{ capability: AgentRuntimeCapability; sessionIds: readonly [string, ...string[]]; policy: CordisXPermissionPolicyV2 }>[],
  ): Promise<void> {
    if (!this.developmentAgentRuntimeSeeds.has(authority)) throw new Error('Agent Session policy seed authority is invalid')
    const records = entries.map(entry => {
      if (entry.sessionIds.length !== 1 || !validAgentRuntimeSessionId(entry.sessionIds[0])) throw new Error('Agent Session seed requires one exact SessionId')
      if (!isAgentRuntimePermission(entry.capability)) throw new Error('Agent Session seed capability is unsupported')
      return this.agentRuntimePolicyRecordForIdentity(identity, entry.capability, entry.sessionIds[0]!, entry.policy)
    })
    for (const record of records) this.policyRecords.set(permissionRecordKeyV4(record), record)
    this.fenceAgentRuntime(identity, 'permission-revoked')
    this.changed()
    await this.persistV4(records)
  }

  private registration(identity: CordisXPluginIdentity, view?: PluginGenerationView): Registration | undefined {
    return [...this.registrations.values()].find(item => platformIdentityKey(item.identity) === platformIdentityKey(identity)
      && (this.visibility?.visible(item.generation, view) ?? true))
  }

  private validAgentRuntimeScopeSource(
    registration: Registration,
    input: Readonly<{ sessionId: string; capability: AgentRuntimeCapability; scopeSource: AgentRuntimeScopeSource }>,
    declaredScope: unknown,
  ): boolean {
    if (input.scopeSource.kind === 'host-create') {
      return input.capability === 'agents.create'
        && input.scopeSource.reservedSessionId === input.sessionId
        && declaredScope === undefined
    }
    if (input.scopeSource.kind === 'host-exact') {
      return input.scopeSource.exactSessionId === input.sessionId
        && (declaredScope === undefined || (Array.isArray(declaredScope) && declaredScope.includes(input.sessionId)))
    }
    if (Array.isArray(declaredScope)) return declaredScope.length === 1 && declaredScope[0] === input.sessionId
    const source = input.scopeSource
    const route = this.agentRuntimeRouteValues().find(candidate => (
      candidate.owner.source === registration.identity.source
      && candidate.owner.pluginId === registration.identity.id
      && candidate.routeInstanceId === source.routeInstanceId
    ))
    return route !== undefined
      && route.routeInstanceId === source.routeInstanceId
      && route.routeId === source.routeId
      && route.path === source.path
      && route.params.sessionId === source.params.sessionId
      && route.params.sessionId === input.sessionId
      && isHostRouteSessionScopeBinding(declaredScope)
      && declaredScope.routeId === route.routeId
      && declaredScope.param === 'sessionId'
  }

  private agentRuntimePolicyRecord(
    registration: Registration,
    capability: AgentRuntimeCapability,
    sessionId: string,
    policy: CordisXPermissionPolicyV2,
  ): CordisXPermissionPolicyRecordV4 {
    return this.agentRuntimePolicyRecordForIdentity(registration.identity, capability, sessionId, policy)
  }

  private agentRuntimePolicyRecordForIdentity(
    identity: CordisXPluginIdentity,
    capability: AgentRuntimeCapability,
    sessionId: string,
    policy: CordisXPermissionPolicyV2,
  ): CordisXPermissionPolicyRecordV4 {
    return normalizePermissionPolicyRecordV4({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key: {
        profileId: this.profileId,
        identity: { source: identity.source, pluginId: identity.id },
        capability,
        scope: { sessionIds: [sessionId] },
        securityFingerprint: `sha256:${sha256Hex(JSON.stringify({ capability, sessionId }))}`,
      },
      policy,
    })
  }

  private agentRuntimePolicyKey(registration: Registration, capability: AgentRuntimeCapability, sessionId: string): string {
    return permissionRecordKeyV4(this.agentRuntimePolicyRecord(registration, capability, sessionId, 'ask'))
  }

  private fenceAgentRuntime(
    identity: CordisXPluginIdentity | undefined,
    code: AgentRuntimePermissionFence['code'],
    registrationToken?: object,
  ): void {
    if (code === 'plugin-generation-replaced' && identity !== undefined) {
      for (const [routeInstanceId, record] of this.playgroundScenarioAgentRuntimeRoutes) {
        if (record.route.owner.source === identity.source && record.route.owner.pluginId === identity.id) {
          this.playgroundScenarioAgentRuntimeRoutes.delete(routeInstanceId)
        }
      }
    }
    for (const pending of this.pendingAgentRuntimePrompts) {
      if (identity !== undefined && (pending.identity.source !== identity.source || pending.identity.id !== identity.id)) continue
      if (registrationToken !== undefined && pending.registrationToken !== registrationToken) continue
      pending.abort.abort()
      this.pendingAgentRuntimePrompts.delete(pending)
    }
    for (const [leaseId, lease] of this.agentRuntimeLeases) {
      if (identity !== undefined && (lease.identity.source !== identity.source || lease.identity.id !== identity.id)) continue
      this.agentRuntimeLeases.delete(leaseId)
      const fence = Object.freeze({ identity: lease.identity, sessionId: lease.lease.sessionId, code })
      for (const listener of this.agentRuntimeFenceListeners) {
        try { listener(fence) } catch { /* fences are authoritative; observers are isolated */ }
      }
    }
  }

  private agentRuntimeRouteValues(): readonly AgentRuntimeRouteScope[] {
    return [
      ...this.agentRuntimeRoutes.values(),
      ...[...this.playgroundScenarioAgentRuntimeRoutes.values()].map(record => record.route),
    ]
  }

  private fenceAgentRuntimeRouteInstance(routeInstanceId: string, code: AgentRuntimePermissionFence['code']): void {
    for (const [leaseId, lease] of this.agentRuntimeLeases) {
      if (lease.routeInstanceId !== routeInstanceId) continue
      this.agentRuntimeLeases.delete(leaseId)
      const fence = Object.freeze({ identity: lease.identity, sessionId: lease.lease.sessionId, code })
      for (const listener of this.agentRuntimeFenceListeners) {
        try { listener(fence) } catch { /* fences are authoritative; observers are isolated */ }
      }
    }
  }

  private clearPlaygroundScenarioAgentRuntimeRoutes(baseRouteInstanceId: string): void {
    for (const [routeInstanceId, record] of this.playgroundScenarioAgentRuntimeRoutes) {
      if (record.baseRouteInstanceId !== baseRouteInstanceId) continue
      this.playgroundScenarioAgentRuntimeRoutes.delete(routeInstanceId)
      this.fenceAgentRuntimeRouteInstance(routeInstanceId, 'route-replaced')
    }
  }

  private isRegistered(registration: Registration): boolean {
    return [...this.registrations.values()].some(candidate => candidate.token === registration.token)
  }

  /** Refreshes only the Host-owned trust projection for the already bound exact artifact. */
  private refreshRegistrationDomCertification(
    key: string,
    registration: Registration,
    certification?: CordisXCertifiedPermissionProjectionV1,
  ): void {
    const artifact = registration.artifact
    if (artifact === undefined || this.registrations.get(key)?.token !== registration.token) return
    const normalized = normalizeCertifiedPermissionProjectionV1(certification, {
      source: registration.identity.source,
      pluginId: registration.identity.id,
    }, artifact, this.now())
    const previous = artifact.certification
    if (previous?.fingerprint === normalized?.fingerprint && previous?.revision === normalized?.revision) {
      this.scheduleDomCertificationExpiry(key, registration)
      return
    }
    const next = Object.freeze({
      ...registration,
      artifact: Object.freeze({
        version: artifact.version,
        integrity: artifact.integrity,
        ...(normalized === undefined ? {} : { certification: normalized }),
      }),
    })
    this.registrations.set(key, next)
    this.scheduleDomCertificationExpiry(key, next)
    this.clearCertifiedDomLeases(registration)
    this.clearCertifiedHostDomLeases(registration)
    const auditPrefix = this.domAuditPrefix(
      platformIdentityKey(registration.identity),
      registration.generation.moduleGeneration,
    )
    for (const [key, audit] of this.audit) {
      if (!key.startsWith(auditPrefix)) continue
      if (audit.authorizationOrigin !== 'certified-implicit') continue
      delete audit.authorizationOrigin
      delete audit.authorizationReason
      delete audit.certification
    }
    this.changed()
  }

  /**
   * Atomically replace the Launcher-owned exact projection snapshot. This is
   * the single runtime trust input: it neither parses feeds nor accepts
   * Official, policies, scopes, grants, or plugin-supplied assertions.
   */
  replaceCertifiedPermissionSnapshot(
    snapshot: Readonly<{
      revision: number
      projections: readonly CordisXCertifiedPermissionProjectionV1[]
    }>,
  ): void {
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
      throw new Error('Certified permission snapshot revision is invalid')
    }
    const next = new Map<string, CordisXCertifiedPermissionProjectionV1>()
    for (const projection of snapshot.projections) {
      const normalized = normalizeCertifiedPermissionProjectionV1(
        projection,
        { source: projection.source, pluginId: projection.pluginId },
        { version: projection.version, integrity: projection.integrity },
        this.now(),
      )
      if (normalized === undefined) throw new Error('Certified permission snapshot contains an invalid projection')
      const key = certifiedArtifactKey(
        { source: normalized.source, pluginId: normalized.pluginId },
        normalized,
      )
      if (next.has(key)) throw new Error('Certified permission snapshot contains a duplicate exact artifact')
      next.set(key, normalized)
    }
    const digest = JSON.stringify([...next.values()])
    if (snapshot.revision < this.certifiedProjectionRevision) {
      throw new Error('Certified permission snapshot revision regressed')
    }
    if (snapshot.revision === this.certifiedProjectionRevision
      && this.certifiedProjectionDigest !== '' && digest !== this.certifiedProjectionDigest) {
      throw new Error('Certified permission snapshot equivocated at one revision')
    }
    if (snapshot.revision === this.certifiedProjectionRevision
      && digest === this.certifiedProjectionDigest && this.certifiedProjectionAvailable) return
    this.certifiedProjectionRevision = snapshot.revision
    this.certifiedProjectionDigest = digest
    this.certifiedProjectionAvailable = true
    this.applyCertifiedProjectionMap(next)
  }

  /** Channel loss clears grants without resetting the monotonic replay fence. */
  clearCertifiedPermissionSnapshot(): void {
    if (!this.certifiedProjectionAvailable && this.certifiedProjections.size === 0) return
    this.certifiedProjectionAvailable = false
    this.applyCertifiedProjectionMap(new Map())
  }

  private applyCertifiedProjectionMap(
    next: ReadonlyMap<string, CordisXCertifiedPermissionProjectionV1>,
  ): void {
    this.batchChanges(() => {
      this.certifiedProjections.clear()
      for (const [key, projection] of next) this.certifiedProjections.set(key, projection)
      for (const [registrationKey, registration] of [...this.registrations.entries()]) {
        const artifact = registration.artifact
        if (artifact === undefined) continue
        this.refreshRegistrationDomCertification(
          registrationKey,
          registration,
          this.certifiedProjections.get(certifiedArtifactKey(
            { source: registration.identity.source, pluginId: registration.identity.id },
            artifact,
          )),
        )
      }
    })
  }

  private clearDomCertificationTimer(key: string): void {
    const timer = this.domCertificationTimers.get(key)
    if (timer !== undefined) clearTimeout(timer)
    this.domCertificationTimers.delete(key)
  }

  private scheduleDomCertificationExpiry(key: string, registration: Registration): void {
    this.clearDomCertificationTimer(key)
    const certification = registration.artifact?.certification
    if (certification === undefined) return
    const remaining = Date.parse(certification.expiresAt) - this.now().getTime()
    if (!Number.isFinite(remaining) || remaining <= 0) {
      queueMicrotask(() => this.expireDomCertification(key, registration.token))
      return
    }
    const timer = setTimeout(
      () => this.expireDomCertification(key, registration.token),
      Math.min(remaining, 2_147_483_647),
    )
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
    this.domCertificationTimers.set(key, timer)
  }

  private expireDomCertification(key: string, token: object): void {
    this.domCertificationTimers.delete(key)
    const registration = this.registrations.get(key)
    const artifact = registration?.artifact
    const certification = artifact?.certification
    if (registration === undefined || registration.token !== token || artifact === undefined || certification === undefined) return
    if (this.now().getTime() < Date.parse(certification.expiresAt)) {
      this.scheduleDomCertificationExpiry(key, registration)
      return
    }
    const next = Object.freeze({
      ...registration,
      artifact: Object.freeze({ version: artifact.version, integrity: artifact.integrity }),
    })
    this.registrations.set(key, next)
    this.clearCertifiedDomLeases(registration)
    this.clearCertifiedHostDomLeases(registration)
    const auditPrefix = this.domAuditPrefix(
      platformIdentityKey(registration.identity),
      registration.generation.moduleGeneration,
    )
    for (const [auditKey, audit] of this.audit) {
      if (!auditKey.startsWith(auditPrefix)) continue
      if (audit.authorizationOrigin !== 'certified-implicit') continue
      delete audit.authorizationOrigin
      delete audit.authorizationReason
      delete audit.certification
    }
    this.changed()
  }

  private persistV2(records: readonly CordisXPermissionPolicyRecordV2[]): Promise<void> {
    if (this.store.writeV2 === undefined) return Promise.reject(new Error('permission v2 persistence is unavailable'))
    return Promise.resolve(this.store.writeV2(records))
  }

  private persistV3(records: readonly CordisXPermissionPolicyRecordV3[]): Promise<void> {
    if (this.store.writeV3 === undefined) return Promise.reject(new Error('permission v3 persistence is unavailable'))
    return Promise.resolve(this.store.writeV3(records))
  }

  private commitDomPolicyRecords(
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

  private persistV4(records: readonly CordisXPermissionPolicyRecordV4[]): Promise<void> {
    if (this.store.writeV4 === undefined) return Promise.reject(new Error('permission v4 persistence is unavailable'))
    return Promise.resolve(this.store.writeV4(records))
  }

  private persistMixed(records: readonly CordisXPersistedPermissionPolicyRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve()
    if (this.store.writeAll !== undefined) return Promise.resolve(this.store.writeAll(records))
    const v2 = records.filter(isPermissionPolicyRecordV2)
    const v4 = records.filter(isPermissionPolicyRecordV4)
    if (v2.length !== records.length && v4.length !== records.length) {
      return Promise.reject(new Error('atomic mixed-version permission persistence is unavailable'))
    }
    return v2.length > 0 ? this.persistV2(v2) : this.persistV4(v4)
  }

  private binding(
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

  private domPointKey(identity: CordisXPluginIdentity, pointId: string, moduleGeneration?: string): string {
    return `${this.domGenerationPrefix(identity, moduleGeneration)}${pointId}`
  }

  private domGenerationPrefix(identity: CordisXPluginIdentity, moduleGeneration?: string): string {
    return `${platformIdentityKey(identity)}\u0000${moduleGeneration ?? 'host'}\u0000`
  }

  private domPendingReviewKey(identity: CordisXPluginIdentity, moduleGeneration?: string): string {
    return `${platformIdentityKey(identity)}\u0000${moduleGeneration ?? 'host'}`
  }

  private activeCertification(registration: Registration): CordisXCertifiedPermissionProjectionV1 | undefined {
    const artifact = registration.artifact
    return artifact === undefined
      ? undefined
      : normalizeCertifiedPermissionProjectionV1(artifact.certification, {
          source: registration.identity.source,
          pluginId: registration.identity.id,
        }, artifact, this.now())
  }

  private domPlan(registration: Registration, pointId: string, operationId: string): CordisXPermissionAuthorizationPlanV3 {
    const certification = this.activeCertification(registration)
    return buildDomPermissionAuthorizationPlanV3({
      planId: operationId,
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      binding: this.binding(registration, operationId, operationId),
      declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [pointId] } },
      policies: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV3),
      ...(certification === undefined ? {} : { certification }),
    }, this.catalog)
  }

  private domLeaseKey(key: CordisXPermissionAuthorizationKeyV3): string {
    return permissionRecordKeyV3({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
      schemaVersion: 3,
      key,
      policy: 'ask',
    })
  }

  private validDomLease(registration: Registration, pointId: string): DomPermissionLease | undefined {
    const key = domPermissionAuthorizationKeyV3({
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      pointId,
      catalogVersion: this.catalog.version,
    })
    const leaseKey = this.domLeaseKey(key)
    const lease = this.domLeases.get(leaseKey)
    if (lease === undefined) return undefined
    const certification = this.activeCertification(registration)
    const valid = lease.runtimeGeneration === this.generation
      && lease.moduleGeneration === registration.generation.moduleGeneration
      && (lease.authorizationOrigin !== 'certified-implicit' || (
        certification !== undefined
        && lease.certificationFingerprint === certification.fingerprint
        && lease.certificationRevision === certification.revision
      ))
    if (valid) return lease
    this.domLeases.delete(leaseKey)
    return undefined
  }

  domPolicy(identity: CordisXPluginIdentity, pointId: string): 'inherit' | 'allow' | 'deny' {
    const key = domPermissionAuthorizationKeyV3({
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      pointId,
      catalogVersion: this.catalog.version,
    })
    const record = this.policyRecords.get(this.domLeaseKey(key))
    if (record === undefined || !isPermissionPolicyRecordV3(record)) return 'inherit'
    return record.policy === 'allow-persistent' ? 'allow' : record.policy === 'deny-persistent' ? 'deny' : 'inherit'
  }

  hasDomPolicy(identity: CordisXPluginIdentity, pointId: string): boolean {
    const key = domPermissionAuthorizationKeyV3({
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      pointId,
      catalogVersion: this.catalog.version,
    })
    return isPermissionPolicyRecordV3(this.policyRecords.get(this.domLeaseKey(key)))
  }

  domPolicies(): readonly DomPermissionPolicyEntry[] {
    return Object.freeze([...this.policyRecords.values()].flatMap(record => {
      if (!isPermissionPolicyRecordV3(record) || record.key.profileId !== this.profileId) return []
      const pointId = record.key.scope.extensionPoints?.[0]
      if (pointId === undefined || record.key.scope.extensionPoints?.length !== 1) return []
      return [Object.freeze({
        identity: Object.freeze({ source: record.key.identity.source, id: record.key.identity.pluginId }),
        pointId,
        policy: record.policy === 'allow-persistent' ? 'allow' as const : record.policy === 'deny-persistent' ? 'deny' as const : 'inherit' as const,
      })]
    }).sort((left, right) => `${left.identity.source}\u0000${left.identity.id}\u0000${left.pointId}`.localeCompare(
      `${right.identity.source}\u0000${right.identity.id}\u0000${right.pointId}`,
    )))
  }

  domAccess(identity: CordisXPluginIdentity, pointId: string, view?: PluginGenerationView): DomPermissionAccessDecision {
    const registration = this.registration(identity, view)
    const policy = this.domPolicy(identity, pointId)
    if (registration === undefined) return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.identity-unavailable', policy })
    const pointKey = this.domPointKey(identity, pointId, registration.generation.moduleGeneration)
    this.domPoints.set(pointKey, Object.freeze({ identity: registration.identity, pointId, ...(registration.generation.moduleGeneration === undefined ? {} : { moduleGeneration: registration.generation.moduleGeneration }) }))
    const lease = this.validDomLease(registration, pointId)
    if (lease !== undefined) return Object.freeze({
      authorized: true,
      state: 'allowed',
      reason: lease.authorizationOrigin === 'certified-implicit' ? 'permission.certified-implicit' : 'permission.explicit-user',
      policy,
      authorizationOrigin: lease.authorizationOrigin,
    })
    const request = this.domRequests.get(pointKey)
    if (request !== undefined) return Object.freeze({ authorized: false, state: 'pending', reason: 'permission.review-pending', policy })
    if (policy === 'deny') return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.denied-persistent', policy })
    if (policy === 'allow' || this.activeCertification(registration) !== undefined) {
      const operationId = `dom:auto:${sha256Hex([
        this.generation,
        registration.generation.moduleGeneration ?? 'host',
        identity.source,
        identity.id,
        pointId,
      ].join('\u0000')).slice(0, 48)}`
      const plan = this.domPlan(registration, pointId, operationId)
      const item = plan.declarations[0]!
      if (item.authorizationMode === 'certified-implicit') {
        return this.grantDomAccess(registration, pointId, plan, item, 'certified-implicit', true)
      }
      if (item.authorizationMode === 'persistent-policy' && item.policy === 'allow-persistent') {
        return this.grantDomAccess(registration, pointId, plan, item, 'explicit-user', true)
      }
    }
    this.pendingDomReviews.set(this.domPendingReviewKey(identity, registration.generation.moduleGeneration), Object.freeze({
      identity: registration.identity,
      pointId,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
      ...(view === undefined ? {} : { view }),
    }))
    return Object.freeze({ authorized: false, state: 'pending', reason: 'permission.review-pending', policy })
  }

  requestDomAccess(identity: CordisXPluginIdentity, pointId: string, view?: PluginGenerationView): Promise<DomPermissionAccessDecision> {
    const registration = this.registration(identity, view)
    if (registration === undefined) return Promise.resolve(Object.freeze({
      authorized: false,
      state: 'denied',
      reason: 'permission.identity-unavailable',
      policy: this.domPolicy(identity, pointId),
    }))
    const pointKey = this.domPointKey(identity, pointId, registration.generation.moduleGeneration)
    const pendingKey = this.domPendingReviewKey(identity, registration.generation.moduleGeneration)
    if (this.pendingDomReviews.get(pendingKey)?.pointId === pointId) this.pendingDomReviews.delete(pendingKey)
    this.domPoints.set(pointKey, Object.freeze({
      identity: registration.identity,
      pointId,
      ...(registration.generation.moduleGeneration === undefined ? {} : { moduleGeneration: registration.generation.moduleGeneration }),
    }))
    const existing = this.domRequests.get(pointKey)
    if (existing !== undefined) return existing
    const task = this.resolveDomAccess(registration, pointId).finally(() => {
      if (this.domRequests.get(pointKey) === task) this.domRequests.delete(pointKey)
      this.changed()
    })
    this.domRequests.set(pointKey, task)
    this.changed()
    return task
  }

  /** Starts or waits for only the exact plugin scope touched by an explicit Host interaction. */
  async reviewPendingDomAccess(
    identity: CordisXPluginIdentity,
    moduleGeneration?: string,
    view?: PluginGenerationView,
  ): Promise<readonly DomPermissionAccessDecision[]> {
    const registration = this.registration(identity, view)
    if (registration === undefined || registration.generation.moduleGeneration !== moduleGeneration) return Object.freeze([])
    const prefix = this.domGenerationPrefix(identity, moduleGeneration)
    const requests = [...this.domRequests.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, request]) => request)
    if (requests.length > 0) return Object.freeze(await Promise.all(requests))
    const key = this.domPendingReviewKey(identity, moduleGeneration)
    const pending = this.pendingDomReviews.get(key)
    if (pending === undefined) return Object.freeze([])
    this.pendingDomReviews.delete(key)
    return Object.freeze([await this.requestDomAccess(pending.identity, pending.pointId, pending.view)])
  }

  private async resolveDomAccess(registration: Registration, pointId: string): Promise<DomPermissionAccessDecision> {
    const identity = registration.identity
    const operationId = `dom:${this.generation}:${registration.generation.moduleGeneration ?? 'host'}:${identity.id}:${pointId}`
    const plan = this.domPlan(registration, pointId, operationId)
    const item = plan.declarations[0]!
    const key: CordisXPermissionAuthorizationKeyV3 = Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
    if (item.authorizationMode === 'persistent-policy' && item.policy === 'deny-persistent') {
      this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Persistent user denial')
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.denied-persistent', policy: 'deny' })
    }
    let origin: 'explicit-user' | 'certified-implicit'
    if (item.authorizationMode === 'certified-implicit') {
      origin = 'certified-implicit'
    } else if (item.authorizationMode === 'persistent-policy') {
      origin = 'explicit-user'
    } else {
      let decision: CordisXPermissionAuthorizationDecisionV3 | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const promptKey = this.domPointKey(identity, pointId, registration.generation.moduleGeneration)
      this.domPromptPlans.set(promptKey, plan)
      try {
        decision = await Promise.race([
          this.promptV2?.requestV3?.(plan, identity) ?? Promise.resolve(undefined),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs) }),
        ])
      } catch {
        decision = undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (this.domPromptPlans.get(promptKey) === plan) this.domPromptPlans.delete(promptKey)
        this.promptV2?.cancelV3?.(plan.planId, plan.binding)
      }
      if (!this.isRegistered(registration)) {
        return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.generation-invalidated', policy: 'inherit' })
      }
      if (decision === undefined) {
        this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Explicit review cancelled or timed out')
        return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.review-cancelled', policy: 'inherit' })
      }
      const selected = await this.commitDomDecision(plan, decision)
      if (!this.isRegistered(registration)) {
        return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.generation-invalidated', policy: 'inherit' })
      }
      if (selected === 'deny-once' || selected === 'deny-persistent') {
        this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Explicit user denial')
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.denied-explicit',
          policy: selected === 'deny-persistent' ? 'deny' : 'inherit',
        })
      }
      if (selected === 'allow-once') {
        this.onceV2.issue(key, plan.binding)
        if (!this.onceV2.consume(key, plan.binding)) {
          this.recordDomAudit(registration, pointId, false, 'explicit-user', 'Exact one-time grant could not be consumed')
          return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.once-invalid', policy: 'inherit' })
        }
      }
      origin = 'explicit-user'
    }
    const granted = this.grantDomAccess(registration, pointId, plan, item, origin)
    return this.isRegistered(registration)
      ? granted
      : Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.generation-invalidated',
          policy: 'inherit',
        })
  }

  private grantDomAccess(
    registration: Registration,
    pointId: string,
    plan: CordisXPermissionAuthorizationPlanV3,
    item: CordisXPermissionAuthorizationPlanV3['declarations'][number],
    origin: 'explicit-user' | 'certified-implicit',
    deferAuditNotification = false,
  ): DomPermissionAccessDecision {
    const key: CordisXPermissionAuthorizationKeyV3 = Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
    const certification = origin === 'certified-implicit' ? item.certification : undefined
    this.domLeases.set(this.domLeaseKey(key), Object.freeze({
      key,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : { moduleGeneration: registration.generation.moduleGeneration }),
      authorizationOrigin: origin,
      ...(certification === undefined ? {} : {
        certificationFingerprint: certification.fingerprint,
        certificationRevision: certification.revision,
      }),
    }))
    this.recordDomAudit(
      registration,
      pointId,
      true,
      origin,
      origin === 'certified-implicit' ? 'Exact Certified artifact auto-approved by the Host catalog' : 'Explicit user approval',
      certification,
      deferAuditNotification,
    )
    return Object.freeze({
      authorized: true,
      state: 'allowed',
      reason: origin === 'certified-implicit' ? 'permission.certified-implicit' : 'permission.explicit-user',
      policy: item.policy === 'allow-persistent' ? 'allow' : 'inherit',
      authorizationOrigin: origin,
    })
  }

  private async commitDomDecision(
    plan: CordisXPermissionAuthorizationPlanV3,
    decision: CordisXPermissionAuthorizationDecisionV3,
  ): Promise<CordisXPermissionDecisionV2> {
    if (decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3
      || decision.schemaVersion !== 3 || decision.origin !== 'explicit-user'
      || decision.planId !== plan.planId || decision.operation !== plan.operation
      || decision.profileId !== plan.profileId || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
      || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding)
      || decision.decisions.length !== 1) throw new Error('DOM permission decision does not match the Host plan')
    const item = plan.declarations[0]!
    const selected = decision.decisions[0]!
    if (selected.capability !== item.capability
      || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint
      || !item.allowedDecisions.includes(selected.decision)) throw new Error('DOM permission decision is invalid')
    if (selected.decision === 'allow-persistent' || selected.decision === 'deny-persistent') {
      const record = normalizePermissionPolicyRecordV3({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
        schemaVersion: 3,
        key: {
          profileId: plan.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        },
        policy: selected.decision,
      })
      const key = permissionRecordKeyV3(record)
      await this.commitDomPolicyRecords([record], () => {
        this.policyRecords.set(key, record)
      })
    }
    return selected.decision
  }

  private recordDomAudit(
    registration: Registration,
    pointId: string,
    allowed: boolean,
    authorizationOrigin: 'explicit-user' | 'certified-implicit',
    authorizationReason: string,
    certification?: CordisXCertifiedPermissionProjectionV1,
    deferNotification = false,
  ): void {
    const key = this.domAuditKey(
      platformIdentityKey(registration.identity),
      pointId,
      registration.generation.moduleGeneration,
    )
    const audit = this.audit.get(key) ?? { denialCount: 0 }
    if (allowed) audit.lastUsedAt = isoNow(this.now)
    else { audit.lastDeniedAt = isoNow(this.now); audit.denialCount += 1 }
    audit.authorizationOrigin = authorizationOrigin
    audit.authorizationReason = authorizationReason
    if (certification === undefined) delete audit.certification
    else audit.certification = certification
    this.audit.set(key, audit)
    const notify = (): void => {
      this.consoleObserver?.permission(
        registration.identity,
        'ui.extension-points.render',
        allowed ? 'allow' : 'deny',
        `${pointId}: ${authorizationReason}`,
      )
      this.changed()
    }
    if (deferNotification) queueMicrotask(notify)
    else notify()
  }

  private clearDomGeneration(moduleGeneration?: string, identity?: CordisXPluginIdentity): void {
    this.clearDomLeases(moduleGeneration, identity)
    const identityKey = identity === undefined ? undefined : platformIdentityKey(identity)
    for (const [key, plan] of this.domPromptPlans) {
      if ((moduleGeneration === undefined || plan.binding.moduleGeneration === moduleGeneration)
        && (identity === undefined || (
          plan.identity.source === identity.source && plan.identity.pluginId === identity.id
        ))) {
        this.domPromptPlans.delete(key)
        this.promptV2?.cancelV3?.(plan.planId, plan.binding)
      }
    }
    for (const [key, point] of this.domPoints) {
      if ((moduleGeneration === undefined || point.moduleGeneration === moduleGeneration)
        && (identityKey === undefined || platformIdentityKey(point.identity) === identityKey)) this.domPoints.delete(key)
    }
    for (const [key, pending] of this.pendingDomReviews) {
      if ((moduleGeneration === undefined || pending.moduleGeneration === moduleGeneration)
        && (identityKey === undefined || platformIdentityKey(pending.identity) === identityKey)) this.pendingDomReviews.delete(key)
    }
    const requestPrefix = identity === undefined ? undefined : this.domGenerationPrefix(identity, moduleGeneration)
    for (const key of [...this.domRequests.keys()]) {
      if (requestPrefix !== undefined ? key.startsWith(requestPrefix)
        : moduleGeneration === undefined || key.includes(`\u0000${moduleGeneration}\u0000`)) this.domRequests.delete(key)
    }
    if (identityKey !== undefined) {
      const auditPrefix = moduleGeneration === undefined
        ? `${identityKey}\u0000ui.extension-points.render\u0000`
        : this.domAuditPrefix(identityKey, moduleGeneration)
      for (const key of [...this.audit.keys()]) if (key.startsWith(auditPrefix)) this.audit.delete(key)
    }
  }

  private clearDomLeases(moduleGeneration?: string, identity?: CordisXPluginIdentity): void {
    for (const [key, lease] of this.domLeases) {
      if (lease.runtimeGeneration === this.generation
        && (moduleGeneration === undefined || lease.moduleGeneration === moduleGeneration)
        && (identity === undefined || (
          lease.key.identity.source === identity.source && lease.key.identity.pluginId === identity.id
        ))) this.domLeases.delete(key)
    }
  }

  private clearCertifiedDomLeases(registration: Registration): void {
    for (const [key, lease] of this.domLeases) {
      if (lease.runtimeGeneration !== this.generation
        || lease.moduleGeneration !== registration.generation.moduleGeneration
        || lease.authorizationOrigin !== 'certified-implicit'
        || lease.key.identity.source !== registration.identity.source
        || lease.key.identity.pluginId !== registration.identity.id) continue
      this.domLeases.delete(key)
    }
  }

  private clearExactDomLease(registration: Registration, pointId: string): void {
    for (const [key, lease] of this.domLeases) {
      if (lease.runtimeGeneration !== this.generation
        || lease.moduleGeneration !== registration.generation.moduleGeneration
        || lease.key.identity.source !== registration.identity.source
        || lease.key.identity.pluginId !== registration.identity.id
        || lease.key.scope.extensionPoints?.length !== 1
        || lease.key.scope.extensionPoints[0] !== pointId) continue
      this.domLeases.delete(key)
    }
  }

  private domAuditPrefix(identityKey: string, moduleGeneration?: string): string {
    return `${identityKey}\u0000ui.extension-points.render\u0000${moduleGeneration ?? 'host'}\u0000`
  }

  private domAuditKey(identityKey: string, pointId: string, moduleGeneration?: string): string {
    return `${this.domAuditPrefix(identityKey, moduleGeneration)}${pointId}`
  }

  private hostDomPlan(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    operationId: string,
  ): CordisXPermissionAuthorizationPlanV4 {
    const declaration = registration.declarationsV4.get(capability)
    if (declaration === undefined) throw new Error(`plugin ${registration.identity.id} does not declare ${capability}`)
    const certification = this.activeCertification(registration)
    return buildHostDomPermissionAuthorizationPlanV4({
      planId: operationId,
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      binding: this.binding(registration, operationId, operationId),
      declaration,
      policies: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV4),
      ...(certification === undefined ? {} : { certification }),
    }, this.catalog)
  }

  private hostDomLeaseKey(key: CordisXPermissionAuthorizationKeyV4): string {
    return permissionRecordKeyV4({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key,
      policy: 'ask',
    })
  }

  private hostDomKey(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): CordisXPermissionAuthorizationKeyV4 {
    const declaration = registration.declarationsV4.get(capability)
    if (declaration === undefined) throw new Error(`plugin ${registration.identity.id} does not declare ${capability}`)
    return hostDomPermissionAuthorizationKeyV4({
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      declaration,
      catalogVersion: this.catalog.versionV4,
    })
  }

  hostDomPolicy(
    identity: CordisXPluginIdentity,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    view?: PluginGenerationView,
  ): 'inherit' | 'allow' | 'deny' {
    const registration = this.registration(identity, view)
    if (registration?.declarationsV4.has(capability) !== true) return 'inherit'
    const record = this.policyRecords.get(this.hostDomLeaseKey(this.hostDomKey(registration, capability)))
    if (!isPermissionPolicyRecordV4(record)) return 'inherit'
    return record.policy === 'allow-persistent' ? 'allow' : record.policy === 'deny-persistent' ? 'deny' : 'inherit'
  }

  private hostDomPolicyRevision(registration: Registration, capability: 'ui.host-dom.read' | 'ui.host-dom.modify'): number {
    return this.hostDomPolicyRevisions.get(this.hostDomLeaseKey(this.hostDomKey(registration, capability))) ?? 0
  }

  private bumpHostDomPolicyRevision(registration: Registration, capability: 'ui.host-dom.read' | 'ui.host-dom.modify'): number {
    const key = this.hostDomLeaseKey(this.hostDomKey(registration, capability))
    const revision = (this.hostDomPolicyRevisions.get(key) ?? 0) + 1
    this.hostDomPolicyRevisions.set(key, revision)
    return revision
  }

  private cancelHostDomPrompts(registration: Registration, capability: 'ui.host-dom.read' | 'ui.host-dom.modify'): void {
    for (const [key, pending] of this.hostDomPromptPlans) {
      const plan = pending.plan
      if (plan.identity.source !== registration.identity.source || plan.identity.pluginId !== registration.identity.id
        || plan.binding.moduleGeneration !== registration.generation.moduleGeneration
        || plan.declarations[0]?.capability !== capability) continue
      this.hostDomPromptPlans.delete(key)
      pending.cancel()
      this.promptV2?.cancelV4?.(plan.planId, plan.binding)
    }
  }

  async setHostDomPolicy(
    identity: CordisXPluginIdentity,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    policy: CordisXPermissionPolicyV2,
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration?.declarationsV4.has(capability) !== true) {
      throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    }
    if (capability === 'ui.host-dom.modify' && policy === 'allow-persistent') {
      throw new Error('ui.host-dom.modify does not permit persistent allow')
    }
    const plan = this.hostDomPlan(registration, capability, `policy-v4:${identity.id}:${capability}`)
    const item = plan.declarations[0]!
    const record = normalizePermissionPolicyRecordV4({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
      schemaVersion: 4,
      key: {
        profileId: plan.profileId,
        identity: plan.identity,
        capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
      },
      policy,
    })
    const key = permissionRecordKeyV4(record)
    const previous = this.policyRecords.get(key)
    this.policyRecords.set(key, record)
    this.clearExactHostDomLease(registration, capability)
    this.bumpHostDomPolicyRevision(registration, capability)
    this.cancelHostDomPrompts(registration, capability)
    this.changed()
    try {
      await this.persistV4([record])
    } catch (error) {
      if (previous === undefined) this.policyRecords.delete(key)
      else this.policyRecords.set(key, previous)
      this.clearExactHostDomLease(registration, capability)
      this.bumpHostDomPolicyRevision(registration, capability)
      this.cancelHostDomPrompts(registration, capability)
      this.changed()
      throw error
    }
    this.onceV2.clearGeneration(this.generation, registration.generation.moduleGeneration)
  }

  async authorizeHostDom(
    identity: CordisXPluginIdentity,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    rootId: string,
    operations: readonly string[],
    view?: PluginGenerationView,
  ): Promise<HostDomPermissionAccessDecision> {
    const registration = this.registration(identity, view)
    if (registration === undefined) return Object.freeze({
      authorized: false, state: 'denied', reason: 'permission.identity-unavailable', policy: 'inherit',
    })
    const declaration = registration.declarationsV4.get(capability)
    if (declaration === undefined) return Object.freeze({
      authorized: false, state: 'denied', reason: 'permission.undeclared', policy: 'inherit',
    })
    const roots = declaration.scope.rootIds ?? []
    const declaredOperations = declaration.scope.operations ?? []
    if (!roots.includes(rootId) || operations.length < 1 || new Set(operations).size !== operations.length
      || operations.some(operation => !declaredOperations.includes(operation as never))) {
      this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Requested root or operation exceeds manifest scope')
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.scope-denied', policy: 'inherit' })
    }
    const policy = this.hostDomPolicy(identity, capability, view)
    if (policy === 'deny') {
      this.clearExactHostDomLease(registration, capability)
      this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Persistent user denial')
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.denied-persistent', policy: 'deny' })
    }
    const lease = this.validHostDomLease(registration, capability)
    if (lease !== undefined) return Object.freeze({
      authorized: true,
      state: 'allowed',
      reason: lease.authorizationOrigin === 'certified-implicit' ? 'permission.certified-implicit' : 'permission.explicit-user',
      policy,
      authorizationOrigin: lease.authorizationOrigin,
      lease,
    })
    const operationId = `host-dom:${sha256Hex([
      this.generation,
      registration.generation.moduleGeneration ?? 'host',
      identity.source,
      identity.id,
      capability,
      rootId,
      [...operations].sort().join(','),
      String(this.now().getTime()),
      String(++this.hostDomOperationSequence),
    ].join('\u0000')).slice(0, 48)}`
    const plan = this.hostDomPlan(registration, capability, operationId)
    const item = plan.declarations[0]!
    if (item.authorizationMode === 'persistent-policy' && item.policy === 'deny-persistent') {
      this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Persistent user denial')
      return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.denied-persistent', policy: 'deny' })
    }
    let origin: 'explicit-user' | 'certified-implicit'
    if (item.authorizationMode === 'certified-implicit') origin = 'certified-implicit'
    else if (item.authorizationMode === 'persistent-policy' && item.policy === 'allow-persistent') origin = 'explicit-user'
    else {
      let decision: CordisXPermissionAuthorizationDecisionV4 | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const policyRevision = this.hostDomPolicyRevision(registration, capability)
      let cancelPrompt!: () => void
      const cancelled = new Promise<undefined>(resolve => { cancelPrompt = () => resolve(undefined) })
      this.hostDomPromptPlans.set(plan.planId, { plan, cancel: cancelPrompt })
      try {
        decision = await Promise.race([
          this.promptV2?.requestV4?.(plan, identity) ?? Promise.resolve(undefined),
          cancelled,
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs) }),
        ])
      } catch {
        decision = undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        this.hostDomPromptPlans.delete(plan.planId)
        this.promptV2?.cancelV4?.(plan.planId, plan.binding)
      }
      if (!this.isRegistered(registration)) return Object.freeze({
        authorized: false, state: 'denied', reason: 'permission.generation-invalidated', policy: 'inherit',
      })
      const currentPolicy = this.hostDomPolicy(identity, capability, view)
      if (currentPolicy === 'deny') {
        this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Persistent user denial')
        return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.denied-persistent', policy: 'deny' })
      }
      if (this.hostDomPolicyRevision(registration, capability) !== policyRevision) return Object.freeze({
        authorized: false, state: 'denied', reason: 'permission.policy-invalidated', policy: currentPolicy,
      })
      if (decision === undefined) {
        this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Explicit review cancelled or timed out')
        return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.review-cancelled', policy: 'inherit' })
      }
      const committed = await this.commitHostDomDecision(registration, plan, decision)
      const selected = committed.decision
      if (!this.isRegistered(registration)) return Object.freeze({
        authorized: false, state: 'denied', reason: 'permission.generation-invalidated', policy: 'inherit',
      })
      const committedPolicy = this.hostDomPolicy(identity, capability, view)
      if (this.hostDomPolicyRevision(registration, capability) !== committed.policyRevision || committedPolicy === 'deny' && selected !== 'deny-persistent') {
        this.clearExactHostDomLease(registration, capability)
        return Object.freeze({ authorized: false, state: 'denied', reason: 'permission.policy-invalidated', policy: committedPolicy })
      }
      if (selected === 'deny-once' || selected === 'deny-persistent') {
        this.recordHostDomAudit(registration, capability, false, 'explicit-user', 'Explicit user denial')
        return Object.freeze({
          authorized: false,
          state: 'denied',
          reason: 'permission.denied-explicit',
          policy: selected === 'deny-persistent' ? 'deny' : 'inherit',
        })
      }
      const key: CordisXPermissionAuthorizationKeyV4 = Object.freeze({
        profileId: plan.profileId,
        identity: plan.identity,
        capability: item.capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
      })
      if (selected === 'allow-once') {
        this.onceV2.issue(key, plan.binding)
        if (!this.onceV2.consume(key, plan.binding)) return Object.freeze({
          authorized: false, state: 'denied', reason: 'permission.once-invalid', policy: 'inherit',
        })
      }
      origin = 'explicit-user'
    }
    const granted = this.grantHostDomAccess(registration, plan, item, origin)
    const activeLease = this.isRegistered(registration)
      ? this.validHostDomLease(registration, capability)
      : undefined
    return activeLease !== undefined && activeLease.leaseId === granted.lease?.leaseId
      ? granted
      : Object.freeze({
          authorized: false, state: 'denied', reason: 'permission.grant-invalidated', policy: 'inherit',
        })
  }

  isHostDomLeaseActive(
    identity: CordisXPluginIdentity,
    leaseId: string,
    view?: PluginGenerationView,
  ): boolean {
    const registration = this.registration(identity, view)
    if (registration === undefined) return false
    const lease = [...this.hostDomLeases.values()].find(candidate => candidate.leaseId === leaseId)
    return lease !== undefined && this.validHostDomLease(registration, lease.key.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')?.leaseId === leaseId
  }

  private validHostDomLease(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): HostDomPermissionLease | undefined {
    if (!registration.declarationsV4.has(capability)) return undefined
    const key = this.hostDomKey(registration, capability)
    const leaseKey = this.hostDomLeaseKey(key)
    const lease = this.hostDomLeases.get(leaseKey)
    if (lease === undefined) return undefined
    const policy = this.policyRecords.get(leaseKey)
    if (isPermissionPolicyRecordV4(policy) && policy.policy === 'deny-persistent') {
      this.hostDomLeases.delete(leaseKey)
      return undefined
    }
    const certification = this.activeCertification(registration)
    const valid = lease.runtimeGeneration === this.generation
      && lease.moduleGeneration === registration.generation.moduleGeneration
      && lease.key.securityFingerprint === key.securityFingerprint
      && (lease.authorizationOrigin !== 'certified-implicit' || (
        certification !== undefined
        && lease.certificationFingerprint === certification.fingerprint
        && lease.certificationRevision === certification.revision
      ))
    if (valid) return lease
    this.hostDomLeases.delete(leaseKey)
    return undefined
  }

  private grantHostDomAccess(
    registration: Registration,
    plan: CordisXPermissionAuthorizationPlanV4,
    item: CordisXPermissionAuthorizationPlanV4['declarations'][number],
    origin: 'explicit-user' | 'certified-implicit',
  ): HostDomPermissionAccessDecision {
    const key: CordisXPermissionAuthorizationKeyV4 = Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
    const certification = origin === 'certified-implicit' ? item.certification : undefined
    const lease: HostDomPermissionLease = Object.freeze({
      leaseId: `hdl_${sha256Hex([plan.planId, item.capability, item.securityFingerprint, this.now().toISOString()].join('\u0000')).slice(0, 48)}`,
      key,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : { moduleGeneration: registration.generation.moduleGeneration }),
      authorizationOrigin: origin,
      ...(certification === undefined ? {} : {
        certificationFingerprint: certification.fingerprint,
        certificationRevision: certification.revision,
      }),
    })
    this.hostDomLeases.set(this.hostDomLeaseKey(key), lease)
    this.recordHostDomAudit(
      registration,
      item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify',
      true,
      origin,
      origin === 'certified-implicit' ? 'Exact Certified artifact auto-approved by the Host catalog' : 'Explicit user approval',
      certification,
    )
    return Object.freeze({
      authorized: true,
      state: 'allowed',
      reason: origin === 'certified-implicit' ? 'permission.certified-implicit' : 'permission.explicit-user',
      policy: item.policy === 'allow-persistent' ? 'allow' : 'inherit',
      authorizationOrigin: origin,
      lease,
    })
  }

  private async commitHostDomDecision(
    registration: Registration,
    plan: CordisXPermissionAuthorizationPlanV4,
    decision: CordisXPermissionAuthorizationDecisionV4,
  ): Promise<Readonly<{ decision: CordisXPermissionDecisionV2; policyRevision: number }>> {
    const item = plan.declarations[0]!
    const selected = decision.decisions[0]
    if (decision.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V4
      || decision.schemaVersion !== 4 || decision.origin !== 'explicit-user'
      || decision.planId !== plan.planId || decision.operation !== plan.operation
      || decision.profileId !== plan.profileId || JSON.stringify(decision.identity) !== JSON.stringify(plan.identity)
      || JSON.stringify(decision.binding) !== JSON.stringify(plan.binding)
      || decision.decisions.length !== 1 || selected === undefined
      || selected.capability !== item.capability || JSON.stringify(selected.scope) !== JSON.stringify(item.scope)
      || selected.securityFingerprint !== item.securityFingerprint || !item.allowedDecisions.includes(selected.decision)) {
      throw new Error('Host DOM permission decision does not match the exact Host plan')
    }
    let policyRevision = this.hostDomPolicyRevision(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
    if (selected.decision === 'allow-persistent' || selected.decision === 'deny-persistent') {
      const record = normalizePermissionPolicyRecordV4({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
        schemaVersion: 4,
        key: {
          profileId: plan.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        },
        policy: selected.decision,
      })
      const key = permissionRecordKeyV4(record)
      const previous = this.policyRecords.get(key)
      this.policyRecords.set(key, record)
      this.clearExactHostDomLease(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
      policyRevision = this.bumpHostDomPolicyRevision(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
      this.cancelHostDomPrompts(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
      this.changed()
      try {
        await this.persistV4([record])
      } catch (error) {
        if (previous === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, previous)
        this.clearExactHostDomLease(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
        this.bumpHostDomPolicyRevision(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
        this.cancelHostDomPrompts(registration, item.capability as 'ui.host-dom.read' | 'ui.host-dom.modify')
        this.changed()
        throw error
      }
    }
    return Object.freeze({ decision: selected.decision, policyRevision })
  }

  private hostDomAuditKey(registration: Registration, capability: 'ui.host-dom.read' | 'ui.host-dom.modify'): string {
    return `${platformIdentityKey(registration.identity)}\u0000${capability}\u0000${registration.generation.moduleGeneration ?? 'host'}`
  }

  private recordHostDomAudit(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
    allowed: boolean,
    authorizationOrigin: 'explicit-user' | 'certified-implicit',
    authorizationReason: string,
    certification?: CordisXCertifiedPermissionProjectionV1,
  ): void {
    const key = this.hostDomAuditKey(registration, capability)
    const audit = this.audit.get(key) ?? { denialCount: 0 }
    if (allowed) audit.lastUsedAt = isoNow(this.now)
    else { audit.lastDeniedAt = isoNow(this.now); audit.denialCount += 1 }
    audit.authorizationOrigin = authorizationOrigin
    audit.authorizationReason = authorizationReason
    if (certification === undefined) delete audit.certification
    else audit.certification = certification
    this.audit.set(key, audit)
    this.consoleObserver?.permission(registration.identity, capability, allowed ? 'allow' : 'deny', authorizationReason)
    this.changed()
  }

  private clearExactHostDomLease(
    registration: Registration,
    capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  ): void {
    if (!registration.declarationsV4.has(capability)) return
    this.hostDomLeases.delete(this.hostDomLeaseKey(this.hostDomKey(registration, capability)))
  }

  private clearCertifiedHostDomLeases(registration: Registration): void {
    for (const [key, lease] of this.hostDomLeases) {
      if (lease.runtimeGeneration === this.generation
        && lease.moduleGeneration === registration.generation.moduleGeneration
        && lease.authorizationOrigin === 'certified-implicit'
        && lease.key.identity.source === registration.identity.source
        && lease.key.identity.pluginId === registration.identity.id) this.hostDomLeases.delete(key)
    }
    for (const capability of registration.declarationsV4.keys()) {
      const audit = this.audit.get(this.hostDomAuditKey(registration, capability))
      if (audit?.authorizationOrigin !== 'certified-implicit') continue
      delete audit.authorizationOrigin
      delete audit.authorizationReason
      delete audit.certification
    }
  }

  private clearHostDomGeneration(moduleGeneration?: string, identity?: CordisXPluginIdentity): void {
    for (const [key, lease] of this.hostDomLeases) {
      if (lease.runtimeGeneration === this.generation
        && (moduleGeneration === undefined || lease.moduleGeneration === moduleGeneration)
        && (identity === undefined || (
          lease.key.identity.source === identity.source && lease.key.identity.pluginId === identity.id
        ))) this.hostDomLeases.delete(key)
    }
    for (const [key, pending] of this.hostDomPromptPlans) {
      const plan = pending.plan
      if ((moduleGeneration === undefined || plan.binding.moduleGeneration === moduleGeneration)
        && (identity === undefined || (plan.identity.source === identity.source && plan.identity.pluginId === identity.id))) {
        this.hostDomPromptPlans.delete(key)
        pending.cancel()
        this.promptV2?.cancelV4?.(plan.planId, plan.binding)
      }
    }
    if (identity !== undefined) {
      const prefix = `${platformIdentityKey(identity)}\u0000ui.host-dom.`
      const generationSuffix = moduleGeneration === undefined ? undefined : `\u0000${moduleGeneration}`
      for (const key of [...this.audit.keys()]) {
        if (key.startsWith(prefix) && (generationSuffix === undefined || key.endsWith(generationSuffix))) this.audit.delete(key)
      }
    }
  }

  private legacyAuthorizationKey(
    registration: Registration,
    declaration: CordisXCapabilityDeclaration,
  ): CordisXPermissionAuthorizationKeyV2 {
    const declarationV2 = registration.declarationsV2.get(declaration.name as CordisXPermissionCapabilityV2)!
    return Object.freeze({
      profileId: this.profileId,
      identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
      capability: declarationV2.name,
      scope: declarationV2.scope,
      securityFingerprint: permissionSecurityFingerprint(this.catalog.version, declarationV2),
    })
  }

  private planV2(
    registration: Registration,
    operation: CordisXPermissionAuthorizationPlanV2['operation'],
    binding: CordisXPermissionAuthorizationPlanV2['binding'],
    declarations: readonly CordisXCapabilityDeclarationV2[] = [...registration.declarationsV2.values()],
  ): CordisXPermissionAuthorizationPlanV2 {
    const built = buildPermissionAuthorizationPlanResultV2({
      planId: binding.operationId,
      operation,
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      binding,
      declarations,
      policies: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV2),
      contextFor: declaration => {
        const family = this.catalog.get(declaration.name).providerFamily
        return {
          operation,
          providerKind: family === 'platform' ? 'current-connection' : 'host-local',
          providerTrust: 'configured',
          availability: 'supported',
        }
      },
    }, this.catalog)
    if (built.policyMigrations.length > 0) {
      const previous = built.policyMigrations.map(record => this.policyRecords.get(permissionRecordKeyV2(record)))
      for (const record of built.policyMigrations) this.policyRecords.set(permissionRecordKeyV2(record), record)
      const task = this.persistV2(built.policyMigrations).catch((error) => {
        built.policyMigrations.forEach((record, index) => {
          const key = permissionRecordKeyV2(record)
          const prior = previous[index]
          if (prior === undefined) this.policyRecords.delete(key)
          else this.policyRecords.set(key, prior)
        })
        this.changed()
        throw error
      })
      this.migrationTasks.push(task)
    }
    return built.plan
  }

  policyV2(
    identity: CordisXPluginIdentity,
    capability: CordisXPermissionCapabilityV2,
    view?: PluginGenerationView,
  ): CordisXPermissionPolicyV2 {
    const registration = this.registration(identity, view)
    const declaration = registration?.declarationsV2.get(capability)
    if (registration === undefined || declaration === undefined) return 'ask'
    const operationId = `policy:${identity.id}:${capability}`
    return this.planV2(registration, 'runtime', {
      operationId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
    }, [declaration]).declarations[0]!.policy
  }

  async setPolicyV2(
    identity: CordisXPluginIdentity,
    capability: CordisXPermissionCapabilityV2,
    policy: CordisXPermissionPolicyV2,
  ): Promise<void> {
    const registration = this.registration(identity)
    const declaration = registration?.declarationsV2.get(capability)
    if (registration === undefined || declaration === undefined) {
      throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    }
    const plan = this.planV2(registration, 'runtime', {
      operationId: `policy:${identity.id}:${capability}`,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
    }, [declaration])
    const item = plan.declarations[0]!
    if (policy === 'allow-persistent' && !item.persistentAllow) {
      throw new Error(`${capability} does not permit persistent allow`)
    }
    if (policy === 'deny-persistent' && !item.persistentDeny) {
      throw new Error(`${capability} does not permit persistent deny`)
    }
    const record = normalizePermissionPolicyRecordV2({
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
      schemaVersion: 2,
      key: {
        profileId: this.profileId,
        identity: plan.identity,
        capability,
        scope: item.scope,
        securityFingerprint: item.securityFingerprint,
      },
      policy,
    })
    const key = permissionRecordKeyV2(record)
    const previous = this.policyRecords.get(key)
    this.policyRecords.set(key, record)
    this.changed()
    try {
      await this.persistV2([record])
    } catch (error) {
      if (previous === undefined) this.policyRecords.delete(key)
      else this.policyRecords.set(key, previous)
      this.changed()
      throw error
    }
    this.onceV2.clearGeneration(this.generation, registration.generation.moduleGeneration)
  }

  authorizationPlanV2(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
    operationId = `${this.generation}:${identity.id}`,
  ): CordisXPermissionAuthorizationPlanV2 {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    return this.planV2(registration, operation, {
      operationId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
    })
  }

  async authorizeActivationV2(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV2,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    const plan = this.planV2(registration, operation, authorization.binding)
    this.assertDecisionV2(plan, authorization)
    await this.commitDecisionV2(
      plan,
      authorization,
      this.binding(registration, `${this.generation}:${identity.id}`),
    )
  }

  authorizationPlanV4(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
    binding?: CordisXPermissionAuthorizationBindingV2,
  ): CordisXPermissionAuthorizationPlanV4 | undefined {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6) return undefined
    const operationBinding = binding ?? this.binding(registration, `${this.generation}:${identity.id}`)
    const certification = this.activeCertification(registration)
    return buildPermissionAuthorizationPlanV4({
      planId: `${this.generation}:${identity.id}`,
      operation,
      profileId: this.profileId,
      identity: { source: identity.source, pluginId: identity.id },
      binding: operationBinding,
      declarations: permissionPlanDeclarations(registration.manifest),
      policiesV2: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV2),
      policiesV4: [...this.policyRecords.values()].filter(isPermissionPolicyRecordV4),
      ...(certification === undefined ? {} : { certification }),
    }, this.catalog)
  }

  async authorizeActivationV4(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV4,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration === undefined || (registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6)) {
      throw new Error(`plugin ${identity.id} does not use permission v4`)
    }
    const plan = this.authorizationPlanV4(identity, operation, view, authorization.binding)!
    assertPermissionAuthorizationDecisionV4(plan, authorization)
    if (plan.declarations.some(item => item.required
      && item.authorizationMode === 'persistent-policy'
      && item.policy === 'deny-persistent')
      || authorization.decisions.some(selected => plan.declarations.some(item => (
        item.capability === selected.capability && item.required && selected.decision.startsWith('deny')
      )))) {
      throw new Error(`plugin ${identity.id} denies a required permission v4 capability`)
    }
    const oneShotBinding = this.binding(registration, `${this.generation}:${identity.id}`)
    const persistent: CordisXPersistedPermissionPolicyRecord[] = []
    for (const selected of authorization.decisions) {
      if (selected.decision !== 'allow-persistent' && selected.decision !== 'deny-persistent') continue
      if (isHostDomPermissionCapability(selected.capability)) {
        persistent.push(normalizePermissionPolicyRecordV4({
          $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V4,
          schemaVersion: 4,
          key: {
            profileId: plan.profileId,
            identity: plan.identity,
            capability: selected.capability,
            scope: selected.scope,
            securityFingerprint: selected.securityFingerprint,
          },
          policy: selected.decision,
        }))
        continue
      }
      persistent.push(normalizePermissionPolicyRecordV2({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
        schemaVersion: 2,
        key: {
          profileId: plan.profileId,
          identity: plan.identity,
          capability: selected.capability,
          scope: selected.scope,
          securityFingerprint: selected.securityFingerprint,
        },
        policy: selected.decision,
      }))
    }
    const previous = persistent.map(record => this.policyRecords.get(persistedPermissionRecordKey(record)))
    for (const record of persistent) this.policyRecords.set(persistedPermissionRecordKey(record), record)
    try {
      await this.persistMixed(persistent)
    } catch (error) {
      persistent.forEach((record, index) => {
        const key = persistedPermissionRecordKey(record)
        const prior = previous[index]
        if (prior === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, prior)
      })
      this.changed()
      throw error
    }
    this.onceV2.clearOperation(plan.binding.operationId)
    for (const selected of authorization.decisions) {
      if (selected.decision !== 'allow-once') continue
      this.onceV2.issue({
        profileId: plan.profileId,
        identity: plan.identity,
        capability: selected.capability,
        scope: selected.scope,
        securityFingerprint: selected.securityFingerprint,
      }, oneShotBinding)
    }
    for (const item of plan.declarations) {
      if (!isHostDomPermissionCapability(item.capability)) continue
      const selected = authorization.decisions.find(candidate => candidate.capability === item.capability)?.decision
      const allowed = item.authorizationMode === 'certified-implicit'
        || (item.authorizationMode === 'persistent-policy' && item.policy === 'allow-persistent')
        || selected === 'allow-persistent'
        || (selected === 'allow-once' && this.onceV2.consume({
          profileId: plan.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        }, oneShotBinding))
      if (!allowed) {
        this.clearExactHostDomLease(registration, item.capability)
        continue
      }
      this.grantHostDomAccess(
        registration,
        plan,
        item,
        item.authorizationMode === 'certified-implicit' ? 'certified-implicit' : 'explicit-user',
      )
    }
    this.changed()
  }

  private assertDecisionV2(
    plan: CordisXPermissionAuthorizationPlanV2,
    decision: CordisXPermissionAuthorizationDecisionV2,
  ): void {
    assertPermissionAuthorizationDecisionV2(plan, decision)
  }

  private authorizationKey(
    plan: CordisXPermissionAuthorizationPlanV2,
    capability: CordisXPermissionCapabilityV2,
  ): CordisXPermissionAuthorizationKeyV2 {
    const item = plan.declarations.find(candidate => candidate.capability === capability)
    if (item === undefined) throw new Error(`permission plan does not declare ${capability}`)
    return Object.freeze({
      profileId: plan.profileId,
      identity: plan.identity,
      capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
    })
  }

  private async commitDecisionV2(
    plan: CordisXPermissionAuthorizationPlanV2,
    decision: CordisXPermissionAuthorizationDecisionV2,
    oneShotBinding: CordisXPermissionAuthorizationBindingV2 = plan.binding,
  ): Promise<void> {
    const persistent = decision.decisions.flatMap((item): CordisXPermissionPolicyRecordV2[] => {
      if (item.decision !== 'allow-persistent' && item.decision !== 'deny-persistent') return []
      return [normalizePermissionPolicyRecordV2({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
        schemaVersion: 2,
        key: this.authorizationKey(plan, item.capability),
        policy: item.decision,
      })]
    })
    const previous = persistent.map(record => this.policyRecords.get(permissionRecordKeyV2(record)))
    for (const record of persistent) this.policyRecords.set(permissionRecordKeyV2(record), record)
    try {
      if (persistent.length > 0) await this.persistV2(persistent)
    } catch (error) {
      persistent.forEach((record, index) => {
        const key = permissionRecordKeyV2(record)
        const prior = previous[index]
        if (prior === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, prior)
      })
      this.changed()
      throw error
    }
    this.onceV2.clearOperation(plan.binding.operationId)
    for (const item of decision.decisions) {
      if (item.decision === 'allow-once') {
        this.onceV2.issue(this.authorizationKey(plan, item.capability), oneShotBinding)
      }
    }
    this.changed()
  }

  private migratePolicyRecordsV1(registration: Registration): void {
    if (registration.manifest.schemaVersion !== 4 && registration.manifest.schemaVersion !== 5 && registration.manifest.schemaVersion !== 6) return
    const legacy = [...this.policyRecords.values()].filter((record): record is CordisXPermissionPolicyRecordV1 => (
      !isPermissionPolicyRecordV2(record)
      && !isPermissionPolicyRecordV3(record)
      && record.key.profileId === this.profileId
      && record.key.identity.source === registration.identity.source
      && record.key.identity.pluginId === registration.identity.id
    ))
    for (const record of legacy) {
      const declaration = registration.declarationsV2.get(record.key.capability as CordisXPermissionCapabilityV2)
      if (declaration === undefined
        || JSON.stringify(normalizePermissionScopeV2(record.key.scope)) !== JSON.stringify(declaration.scope)) continue
      const plan = this.planV2(registration, 'runtime', {
        operationId: `migration:${registration.identity.id}:${record.key.capability}`,
        runtimeGeneration: this.generation,
        ...(registration.generation.moduleGeneration === undefined ? {} : {
          moduleGeneration: registration.generation.moduleGeneration,
        }),
      }, [declaration])
      const item = plan.declarations[0]!
      const migrated = migratePermissionPolicyV1(record.policy, {
        key: this.authorizationKey(plan, item.capability),
        persistentAllow: item.persistentAllow,
        persistentDeny: item.persistentDeny,
      })
      const migratedKey = permissionRecordKeyV2(migrated)
      if (this.policyRecords.has(migratedKey)) continue
      this.policyRecords.set(migratedKey, migrated)
      const legacyKey = permissionRecordKey(record)
      const task = this.persistV2([migrated]).then(() => {
        this.policyRecords.delete(legacyKey)
      }).catch((error) => {
        if (this.policyRecords.get(migratedKey) === migrated) this.policyRecords.delete(migratedKey)
        this.changed()
        throw error
      })
      this.migrationTasks.push(task)
    }
  }

  policy(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, view?: PluginGenerationView): CordisXPermissionPolicy {
    const registration = this.registration(identity, view)
    const declaration = registration?.declarations.get(capability)
    if (registration === undefined || declaration === undefined) return 'ask'
    if (registration.manifest.schemaVersion === 1) {
      const record = this.policyRecords.get(permissionRecordKey(createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability,
        scope: declaration.scope,
        policy: 'ask',
      })))
      return record !== undefined && !isPermissionPolicyRecordV2(record) && !isPermissionPolicyRecordV3(record) && !isPermissionPolicyRecordV4(record)
        ? record.policy
        : 'ask'
    }
    const policy = this.policyV2(identity, capability as CordisXPermissionCapabilityV2, view)
    return policy === 'allow-persistent' ? 'allow' : policy === 'deny-persistent' ? 'deny' : 'ask'
  }

  async setPolicy(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    policy: CordisXPermissionPolicy,
  ): Promise<void> {
    const registration = this.registration(identity)
    const declaration = registration?.declarations.get(capability)
    if (registration === undefined || declaration === undefined) throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    if (registration.manifest.schemaVersion === 1) {
      const record = createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability,
        scope: declaration.scope,
        policy,
      })
      const key = permissionRecordKey(record)
      const previous = this.policyRecords.get(key)
      this.policyRecords.set(key, record)
      this.changed()
      try {
        await this.store.write([record])
      } catch (error) {
        if (previous === undefined) this.policyRecords.delete(key)
        else this.policyRecords.set(key, previous)
        this.changed()
        throw error
      }
      this.onceV2.clearGeneration(this.generation, registration.generation.moduleGeneration)
      return
    }
    await this.setPolicyV2(
      identity,
      capability as CordisXPermissionCapabilityV2,
      policy === 'allow' ? 'allow-persistent' : policy === 'deny' ? 'deny-persistent' : 'ask',
    )
  }

  authorizationPlan(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): CordisXPermissionAuthorizationPlanV1 {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (registration.manifest.schemaVersion === 1) {
      return Object.freeze({
        $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
        schemaVersion: 1,
        planId: `${this.generation}:${identity.id}`,
        operation,
        profileId: this.profileId,
        identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
        defaultDecision: 'allow',
        declarations: Object.freeze([...registration.declarations.values()].map(declaration => {
          const record = createPermissionPolicyRecord({
            profileId: this.profileId,
            identity,
            capability: declaration.name,
            scope: declaration.scope,
            policy: 'ask',
          })
          return Object.freeze({
            capability: declaration.name,
            required: declaration.required,
            reason: declaration.reason,
            scope: declaration.scope,
            policy: this.policy(identity, declaration.name, view),
            decisionRequired: !this.policyRecords.has(permissionRecordKey(record)),
          })
        })),
      })
    }
    const v2 = this.authorizationPlanV2(identity, operation, view)
    return Object.freeze({
      $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
      schemaVersion: 1,
      planId: `${this.generation}:${identity.id}`,
      operation,
      profileId: this.profileId,
      identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
      defaultDecision: 'allow',
      declarations: Object.freeze([...registration.declarations.values()].map(declaration => {
        const item = v2.declarations.find(candidate => candidate.capability === declaration.name)!
        return Object.freeze({
        capability: declaration.name,
        required: declaration.required,
        reason: declaration.reason,
        scope: declaration.scope,
        policy: item.policy === 'allow-persistent' ? 'allow' : item.policy === 'deny-persistent' ? 'deny' : 'ask',
        decisionRequired: item.decisionRequired,
      }) })),
    })
  }

  async authorizeActivation(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV1,
    operation: 'install' | 'update' | 'enable' = 'enable',
    view?: PluginGenerationView,
  ): Promise<void> {
    const registration = this.registration(identity, view)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    if (registration.manifest.schemaVersion === 1) {
      await this.authorizeActivationLegacy(registration, authorization, operation)
      return
    }
    const plan = this.authorizationPlanV2(identity, operation, view)
    if (authorization === null || typeof authorization !== 'object'
      || authorization.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1
      || authorization.schemaVersion !== 1
      || authorization.planId !== `${this.generation}:${identity.id}`
      || authorization.operation !== operation
      || authorization.profileId !== this.profileId
      || authorization.identity?.source !== identity.source
      || authorization.identity.pluginId !== identity.id
      || !Array.isArray(authorization.decisions)) {
      throw new Error('authorization decision does not match the current plan')
    }
    const expected = new Set(plan.declarations.map(item => item.capability))
    const seen = new Set<CordisXPlatformCapability>()
    for (const item of authorization.decisions) {
      if (item === null || typeof item !== 'object'
        || (item.decision !== 'ask' && item.decision !== 'allow' && item.decision !== 'allow-once' && item.decision !== 'deny')
        || !expected.has(item.capability) || seen.has(item.capability)
        || JSON.stringify(normalizePermissionScopeV2(item.scope))
          !== JSON.stringify(plan.declarations.find(candidate => candidate.capability === item.capability)?.scope)) {
        throw new Error('authorization decision does not match the current manifest')
      }
      seen.add(item.capability)
    }
    if (seen.size !== expected.size) throw new Error('authorization decision is incomplete')
    const decisionV2: CordisXPermissionAuthorizationDecisionV2 = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
      schemaVersion: 2,
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: authorization.decisions.map((item) => {
        const declaration = plan.declarations.find(candidate => candidate.capability === item.capability)!
        let decision: CordisXPermissionDecisionV2 = item.decision === 'allow-once'
          ? 'allow-once'
          : item.decision === 'allow'
            ? 'allow-persistent'
            : item.decision === 'deny'
              ? 'deny-persistent'
              : 'deny-once'
        if (!declaration.allowedDecisions.includes(decision)) {
          decision = item.decision === 'allow' ? 'allow-once' : 'deny-once'
        }
        return {
          capability: declaration.capability,
          scope: declaration.scope,
          securityFingerprint: declaration.securityFingerprint,
          decision,
        }
      }),
    }
    this.assertDecisionV2(plan, decisionV2)
    await this.commitDecisionV2(plan, decisionV2)
  }

  private async authorizeActivationLegacy(
    registration: Registration,
    authorization: CordisXPermissionAuthorizationDecisionV1,
    operation: 'install' | 'update' | 'enable',
  ): Promise<void> {
    const identity = registration.identity
    if (authorization === null || typeof authorization !== 'object'
      || authorization.$schema !== CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1
      || authorization.schemaVersion !== 1
      || authorization.planId !== `${this.generation}:${identity.id}`
      || authorization.operation !== operation
      || authorization.profileId !== this.profileId
      || authorization.identity?.source !== identity.source
      || authorization.identity.pluginId !== identity.id
      || !Array.isArray(authorization.decisions)) {
      throw new Error('authorization decision does not match the current plan')
    }
    const expected = new Set(registration.declarations.keys())
    const seen = new Set<CordisXPlatformCapability>()
    for (const item of authorization.decisions) {
      if (item === null || typeof item !== 'object'
        || (item.decision !== 'ask' && item.decision !== 'allow' && item.decision !== 'allow-once' && item.decision !== 'deny')
        || !expected.has(item.capability) || seen.has(item.capability)
        || permissionScopeFingerprint(item.capability, normalizePermissionScope(item.scope))
          !== declarationFingerprint(registration.declarations.get(item.capability)!)) {
        throw new Error('authorization decision does not match the current manifest')
      }
      seen.add(item.capability)
    }
    if (seen.size !== expected.size) throw new Error('authorization decision is incomplete')
    const records = authorization.decisions.flatMap((item): CordisXPermissionPolicyRecordV1[] => (
      item.decision === 'allow-once' ? [] : [createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability: item.capability,
        scope: registration.declarations.get(item.capability)!.scope,
        policy: item.decision,
      })]
    ))
    if (records.length > 0) {
      await this.store.write(records)
      for (const record of records) this.policyRecords.set(permissionRecordKey(record), record)
    }
    const binding = this.binding(registration, `${this.generation}:${identity.id}`)
    this.onceV2.clearOperation(binding.operationId)
    for (const item of authorization.decisions) {
      if (item.decision !== 'allow-once') continue
      const declaration = registration.declarations.get(item.capability)!
      this.onceV2.issue(this.legacyAuthorizationKey(registration, declaration), binding)
    }
    this.changed()
  }

  clearOnce(identity: CordisXPluginIdentity): void {
    const registration = this.registration(identity)
    this.onceV2.clearOperation(`${this.generation}:${identity.id}`)
    this.onceV2.clearGeneration(this.generation, registration?.generation.moduleGeneration)
    this.clearDomGeneration(registration?.generation.moduleGeneration, identity)
    this.clearHostDomGeneration(registration?.generation.moduleGeneration, identity)
    this.changed()
  }

  async setDomPolicy(identity: CordisXPluginIdentity, pointId: string, policy: CordisXPermissionPolicyV2): Promise<void> {
    await this.setDomPolicies(identity, [{ pointId, policy }])
  }

  /** Persist one plugin's point-policy replacement as one profile-ledger write. */
  async setDomPolicies(
    identity: CordisXPluginIdentity,
    policies: readonly { readonly pointId: string; readonly policy: CordisXPermissionPolicyV2 }[],
  ): Promise<void> {
    const registration = this.registration(identity)
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    const pointIds = new Set<string>()
    const replacements = policies.map(({ pointId, policy }) => {
      if (pointIds.has(pointId)) throw new Error(`duplicate extension point policy: ${pointId}`)
      pointIds.add(pointId)
      const key = domPermissionAuthorizationKeyV3({
        profileId: this.profileId,
        identity: { source: identity.source, pluginId: identity.id },
        pointId,
        catalogVersion: this.catalog.version,
      })
      const record = normalizePermissionPolicyRecordV3({
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
        schemaVersion: 3,
        key,
        policy,
      })
      const recordKey = permissionRecordKeyV3(record)
      return { pointId, record, recordKey }
    })
    await this.commitDomPolicyRecords(replacements.map(replacement => replacement.record), () => {
      for (const replacement of replacements) {
        this.policyRecords.set(replacement.recordKey, replacement.record)
        this.clearExactDomLease(registration, replacement.pointId)
      }
    })
  }

  async settled(): Promise<void> {
    await Promise.all(this.migrationTasks)
  }

  authorize(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
    view?: PluginGenerationView,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const currentRegistration = this.registration(identity, view)
    const declarationV2 = currentRegistration?.declarationsV2.get(capability as CordisXPermissionCapabilityV2)
    if (currentRegistration === undefined || declarationV2 === undefined) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is not declared`)
      this.denied(platformIdentityKey(identity), capability, requested)
      return Promise.resolve(failure('permission-undeclared', `Plugin ${identity.id} does not declare ${capability}`))
    }
    if (currentRegistration.manifest.schemaVersion === 1) {
      return this.authorizeCallLegacy(currentRegistration, capability, requested, view)
    }
    return this.authorizeCallV2(currentRegistration, declarationV2, capability, requested)
  }

  private async authorizeCallLegacy(
    registration: Registration,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
    view?: PluginGenerationView,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = registration.identity
    const identityKey = platformIdentityKey(identity)
    const declaration = registration.declarations.get(capability)!
    if (!scopeAllows(declaration.scope, requested)) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is outside the declared scope`)
      this.denied(identityKey, capability, requested)
      return failure('permission-scope-denied', `Requested parameters are outside the declared ${capability} scope`)
    }
    const activationBinding = this.binding(registration, `${this.generation}:${identity.id}`)
    const key = this.legacyAuthorizationKey(registration, declaration)
    const activationTicket = this.onceV2.consume(key, activationBinding)
    const policy = this.policy(identity, capability, view)
    if (policy === 'deny' && !activationTicket) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is denied by policy`)
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} is denied for plugin ${identity.id}`)
    }
    if (policy === 'ask' && !activationTicket) {
      this.consoleObserver?.permission(identity, capability, 'ask', `${capability} requires a decision`)
      let decision: Exclude<CordisXPermissionDecision, 'ask'> | 'timeout'
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        decision = await Promise.race([
          this.prompt.request({ identity, declaration, requested }),
          new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), this.promptTimeoutMs) }),
        ])
      } catch {
        decision = 'deny'
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (decision === 'timeout') {
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} permission request timed out`)
        this.denied(identityKey, capability, requested)
        return failure('timeout', `${capability} permission request timed out`)
      }
      if (decision === 'deny') {
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} was denied for this call`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was denied for this call`)
      }
      if (decision === 'allow') {
        try {
          await this.setPolicy(identity, capability, 'allow')
        } catch {
          this.consoleObserver?.permission(identity, capability, 'deny', `${capability} allow decision could not be persisted`)
          this.denied(identityKey, capability, requested)
          return failure('adapter-failure', `${capability} permission policy could not be persisted`)
        }
      } else {
        const requestId = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const binding = this.binding(registration, requestId, requestId)
        this.onceV2.issue(key, binding)
        if (!this.onceV2.consume(key, binding)) {
          this.denied(identityKey, capability, requested)
          return failure('permission-denied', `${capability} one-time authorization was not bound to this request`)
        }
      }
    }
    const auditKey = this.auditKey(identityKey, capability)
    const audit = this.audit.get(auditKey) ?? { denialCount: 0 }
    audit.lastUsedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    this.audit.set(auditKey, audit)
    this.consoleObserver?.permission(identity, capability, 'allow', `${capability} allowed`)
    this.changed()
    return { ok: true, value: { declaration } }
  }

  private async authorizeCallV2(
    registration: Registration,
    declaration: CordisXCapabilityDeclarationV2,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = registration.identity
    const identityKey = platformIdentityKey(identity)
    const legacyDeclaration = registration.declarations.get(capability)
    if (legacyDeclaration === undefined) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is not declared`)
      this.denied(identityKey, capability, requested)
      return failure('permission-undeclared', `Plugin ${identity.id} does not declare ${capability}`)
    }
    if (!scopeAllows(declaration.scope as CordisXCapabilityScope, requested)) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is outside the declared scope`)
      this.denied(identityKey, capability, requested)
      return failure('permission-scope-denied', `Requested parameters are outside the declared ${capability} scope`)
    }
    const requestId = typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const binding = {
      operationId: requestId,
      runtimeGeneration: this.generation,
      ...(registration.generation.moduleGeneration === undefined ? {} : {
        moduleGeneration: registration.generation.moduleGeneration,
      }),
      requestId,
    }
    const plan = this.planV2(registration, 'runtime', binding, [declaration])
    const item = plan.declarations[0]!
    const activationBinding = this.binding(registration, `${this.generation}:${identity.id}`)
    const activationTicket = this.onceV2.consume(this.authorizationKey(plan, item.capability), activationBinding)
    if (item.policy === 'deny-persistent' && !activationTicket) {
      this.consoleObserver?.permission(identity, capability, 'deny', `${capability} is denied by persistent policy`)
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} is denied for plugin ${identity.id}`)
    }
    let allowed = activationTicket || (item.policy === 'allow-persistent' && item.sensitivity !== 'high-risk')
    if (!allowed) {
      this.consoleObserver?.permission(identity, capability, 'ask', `${capability} requires a decision`)
      let decision: CordisXPermissionAuthorizationDecisionV2 | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        decision = await Promise.race([
          this.promptV2?.request(plan, identity) ?? Promise.resolve(undefined),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs) }),
        ])
      } catch {
        decision = undefined
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
      if (decision === undefined) {
        this.onceV2.clearOperation(binding.operationId)
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} permission request was cancelled or timed out`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was not authorized for this call`)
      }
      try {
        this.assertDecisionV2(plan, decision)
        await this.commitDecisionV2(plan, decision)
      } catch {
        this.onceV2.clearOperation(binding.operationId)
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} decision was invalid`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} authorization was invalid`)
      }
      const selected = decision.decisions[0]!.decision
      if (selected === 'deny-once' || selected === 'deny-persistent') {
        this.onceV2.clearOperation(binding.operationId)
        this.consoleObserver?.permission(identity, capability, 'deny', `${capability} was denied`)
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was denied for this call`)
      }
      if (selected === 'allow-once') {
        const key = {
          profileId: this.profileId,
          identity: plan.identity,
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
        }
        allowed = this.onceV2.consume(key, binding)
      } else {
        allowed = true
      }
    }
    this.onceV2.clearOperation(binding.operationId)
    if (!allowed) {
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} one-time authorization was not bound to this request`)
    }
    const auditKey = this.auditKey(identityKey, capability)
    const audit = this.audit.get(auditKey) ?? { denialCount: 0 }
    audit.lastUsedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    this.audit.set(auditKey, audit)
    this.consoleObserver?.permission(identity, capability, 'allow', `${capability} allowed`)
    this.changed()
    return { ok: true, value: { declaration: legacyDeclaration } }
  }

  requiredDenied(identity: CordisXPluginIdentity, view?: PluginGenerationView): readonly CordisXPermissionCapabilityV4[] {
    const registration = this.registration(identity, view)
    if (registration === undefined) return []
    if (registration.manifest.schemaVersion === 1) {
      const binding = this.binding(registration, `${this.generation}:${identity.id}`)
      return [...registration.declarations.values()]
        .filter(item => item.required && this.policy(identity, item.name, view) === 'deny'
          && !this.onceV2.has(this.legacyAuthorizationKey(registration, item), binding))
        .map(item => item.name)
    }
    const plan = this.authorizationPlanV2(identity, 'enable', view)
    const denied: CordisXPermissionCapabilityV4[] = plan.declarations.filter(item => item.required
      && item.policy !== 'allow-persistent'
      && !this.onceV2.has(this.authorizationKey(plan, item.capability), plan.binding))
      .map(item => item.capability)
    if (registration.manifest.schemaVersion === 5 || registration.manifest.schemaVersion === 6) {
      for (const declaration of registration.declarationsV4.values()) {
        if (!declaration.required) continue
        const capability = declaration.name as 'ui.host-dom.read' | 'ui.host-dom.modify'
        const policy = this.hostDomPolicy(identity, capability, view)
        if (policy === 'deny' || (policy !== 'allow'
          && this.validHostDomLease(registration, capability) === undefined
          && this.activeCertification(registration) === undefined)) denied.push(capability)
      }
    }
    return Object.freeze(denied)
  }

  recordScopeDenial(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, requested: RequestedScope): void {
    this.denied(platformIdentityKey(identity), capability, requested)
  }

  snapshots(): readonly PlatformPermissionSnapshot[] {
    const platform = [...this.registrations.values()]
      .filter(registration => this.visibility?.visible(registration.generation) ?? true)
      .flatMap<PlatformPermissionSnapshot>(registration => {
        const identityKey = platformIdentityKey(registration.identity)
        if (registration.manifest.schemaVersion === 1) {
          return [...registration.declarations.values()].map(declaration => {
            const audit = this.audit.get(this.auditKey(identityKey, declaration.name)) ?? { denialCount: 0 }
            return {
              identity: registration.identity,
              capability: declaration.name,
              required: declaration.required,
              reason: declaration.reason,
              scope: declaration.scope,
              fingerprint: declarationFingerprint(declaration),
              policy: this.policy(registration.identity, declaration.name),
              ...(audit.lastRequested === undefined ? {} : { lastRequested: audit.lastRequested }),
              ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
              ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
              denialCount: audit.denialCount,
              ...(this.requiredDenied(registration.identity).includes(declaration.name)
                ? { blockedReason: `Required capability ${declaration.name} is denied` }
                : {}),
            }
          })
        }
        const operationId = `snapshot:${this.generation}:${registration.generation.moduleGeneration ?? 'host'}:${registration.identity.id}`
        const plan = this.planV2(registration, 'enable', this.binding(registration, operationId))
        const denied = new Set(this.requiredDenied(registration.identity))
        return plan.declarations.map(item => {
          const declaration = registration.declarationsV2.get(item.capability)!
          const audit = this.audit.get(this.auditKey(identityKey, item.capability as CordisXPlatformCapability)) ?? { denialCount: 0 }
          return {
            identity: registration.identity,
            capability: item.capability,
            required: item.required,
            reason: declaration.rationale?.description ?? item.presentation.description,
            scope: item.scope,
            fingerprint: item.securityFingerprint,
            policy: item.policy === 'allow-persistent' ? 'allow' as const : item.policy === 'deny-persistent' ? 'deny' as const : 'ask' as const,
            ...(audit.lastRequested === undefined ? {} : { lastRequested: audit.lastRequested }),
            ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
            ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
            denialCount: audit.denialCount,
            ...(denied.has(item.capability) ? { blockedReason: `Required capability ${item.capability} is not authorized` } : {}),
          }
        })
      })
    const dom = [...this.domPoints.values()].flatMap(point => {
      const registration = [...this.registrations.values()].find(item => (
        platformIdentityKey(item.identity) === platformIdentityKey(point.identity)
        && item.generation.moduleGeneration === point.moduleGeneration
        && (this.visibility?.visible(item.generation) ?? true)
      ))
      if (registration === undefined) return []
      const key = domPermissionAuthorizationKeyV3({
        profileId: this.profileId,
        identity: { source: point.identity.source, pluginId: point.identity.id },
        pointId: point.pointId,
        catalogVersion: this.catalog.version,
      })
      const record = this.policyRecords.get(this.domLeaseKey(key))
      const policy = record !== undefined && isPermissionPolicyRecordV3(record)
        ? record.policy === 'allow-persistent' ? 'allow' as const : record.policy === 'deny-persistent' ? 'deny' as const : 'ask' as const
        : 'ask' as const
      const audit = this.audit.get(this.domAuditKey(
        platformIdentityKey(point.identity),
        point.pointId,
        point.moduleGeneration,
      )) ?? { denialCount: 0 }
      return [Object.freeze({
        identity: point.identity,
        capability: 'ui.extension-points.render' as const,
        required: false,
        reason: Object.freeze({
          namespace: 'permission',
          ...this.catalog.get('ui.extension-points.render').presentation.description,
        }),
        scope: key.scope,
        fingerprint: key.securityFingerprint,
        policy,
        ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
        ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
        denialCount: audit.denialCount,
        ...(audit.authorizationOrigin === undefined ? {} : { authorizationOrigin: audit.authorizationOrigin }),
        ...(audit.authorizationReason === undefined ? {} : { authorizationReason: audit.authorizationReason }),
        ...(audit.certification === undefined ? {} : { certification: audit.certification }),
      })]
    })
    const hostDom = [...this.registrations.values()].flatMap(registration => {
      if (this.visibility?.visible(registration.generation) === false) return []
      return [...registration.declarationsV4.values()].map(declaration => {
        const capability = declaration.name as 'ui.host-dom.read' | 'ui.host-dom.modify'
        const key = this.hostDomKey(registration, capability)
        const record = this.policyRecords.get(this.hostDomLeaseKey(key))
        const policy = isPermissionPolicyRecordV4(record)
          ? record.policy === 'allow-persistent' ? 'allow' as const : record.policy === 'deny-persistent' ? 'deny' as const : 'ask' as const
          : 'ask' as const
        const audit = this.audit.get(this.hostDomAuditKey(registration, capability)) ?? { denialCount: 0 }
        return Object.freeze({
          identity: registration.identity,
          capability,
          required: declaration.required,
          reason: declaration.rationale?.description ?? Object.freeze({
            namespace: 'permission',
            ...this.catalog.get(capability).presentation.description,
          }),
          scope: key.scope as CordisXPermissionScopeV4,
          fingerprint: key.securityFingerprint,
          policy,
          ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
          ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
          denialCount: audit.denialCount,
          ...(audit.authorizationOrigin === undefined ? {} : { authorizationOrigin: audit.authorizationOrigin }),
          ...(audit.authorizationReason === undefined ? {} : { authorizationReason: audit.authorizationReason }),
          ...(audit.certification === undefined ? {} : { certification: audit.certification }),
          ...(declaration.required && policy === 'deny'
            ? { blockedReason: `Required capability ${capability} is denied` }
            : {}),
        })
      })
    })
    return Object.freeze([...platform, ...dom, ...hostDom])
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.clearAgentRuntimeConnection()
    this.registrations.clear()
    this.certifiedProjections.clear()
    this.certifiedProjectionRevision = -1
    this.certifiedProjectionDigest = ''
    this.certifiedProjectionAvailable = false
    this.audit.clear()
    this.onceV2.dispose()
    this.domLeases.clear()
    this.domRequests.clear()
    this.domPromptPlans.clear()
    this.domPoints.clear()
    this.hostDomLeases.clear()
    for (const pending of this.hostDomPromptPlans.values()) {
      pending.cancel()
      this.promptV2?.cancelV4?.(pending.plan.planId, pending.plan.binding)
    }
    this.hostDomPromptPlans.clear()
    this.hostDomPolicyRevisions.clear()
    this.agentRuntimeRoutes.clear()
    this.playgroundScenarioAgentRuntimeRoutes.clear()
    this.agentRuntimeLeases.clear()
    this.agentRuntimeFenceListeners.clear()
    this.pendingDomReviews.clear()
    for (const timer of this.domCertificationTimers.values()) clearTimeout(timer)
    this.domCertificationTimers.clear()
    this.promptV2?.dispose?.()
    this.listeners.clear()
  }

  private denied(identityKey: string, capability: CordisXPlatformCapability, requested: RequestedScope): void {
    const key = this.auditKey(identityKey, capability)
    const audit = this.audit.get(key) ?? { denialCount: 0 }
    audit.lastDeniedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    audit.denialCount += 1
    this.audit.set(key, audit)
    this.changed()
  }

  private auditKey(identityKey: string, capability: CordisXPlatformCapability): string {
    return `${identityKey}\u0000${capability}`
  }

  private changed(): void {
    if (this.changeBatchDepth > 0) {
      this.changePending = true
      return
    }
    this.emitChanged()
  }

  private batchChanges(operation: () => void): void {
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

  private emitChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // Permission state is authoritative; observer failures are isolated.
      }
    }
  }

  private migrateLegacy(registration: Registration): void {
    for (const legacy of this.store.legacy?.() ?? []) {
      if (legacy.identityKey !== platformIdentityKey(registration.identity)) continue
      const declaration = registration.declarations.get(legacy.capability)
      if (declaration === undefined) continue
      let parsed: unknown
      try { parsed = JSON.parse(legacy.fingerprint) as unknown } catch { continue }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const fingerprint = parsed as { name?: unknown; scope?: unknown }
      if (fingerprint.name !== declaration.name) continue
      let legacyFingerprint: string
      try {
        legacyFingerprint = permissionScopeFingerprint(declaration.name, normalizePermissionScope(fingerprint.scope))
      } catch {
        continue
      }
      if (legacyFingerprint !== declarationFingerprint(declaration)) continue
      if (registration.manifest.schemaVersion === 1) {
        const record = createPermissionPolicyRecord({
          profileId: this.profileId,
          identity: registration.identity,
          capability: declaration.name,
          scope: declaration.scope,
          policy: legacy.policy,
        })
        const key = permissionRecordKey(record)
        if (this.policyRecords.has(key)) continue
        this.policyRecords.set(key, record)
        const task = Promise.resolve(this.store.write([record])).then(async () => {
          await this.store.retireLegacy?.(legacy)
        }).catch(() => {
          if (this.policyRecords.get(key) === record) this.policyRecords.delete(key)
          this.changed()
        })
        this.migrationTasks.push(task)
        continue
      }
      const declarationV2 = registration.declarationsV2.get(declaration.name as CordisXPermissionCapabilityV2)
      if (declarationV2 === undefined) continue
      const plan = this.planV2(registration, 'runtime', {
        operationId: `legacy-migration:${registration.identity.id}:${declaration.name}`,
        runtimeGeneration: this.generation,
        ...(registration.generation.moduleGeneration === undefined ? {} : {
          moduleGeneration: registration.generation.moduleGeneration,
        }),
      }, [declarationV2])
      const item = plan.declarations[0]!
      const record = migratePermissionPolicyV1(legacy.policy, {
        key: this.authorizationKey(plan, item.capability),
        persistentAllow: item.persistentAllow,
        persistentDeny: item.persistentDeny,
      })
      const key = permissionRecordKeyV2(record)
      if (this.policyRecords.has(key)) continue
      this.policyRecords.set(key, record)
      const task = this.persistV2([record]).then(async () => {
        await this.store.retireLegacy?.(legacy)
      }).catch(() => {
        if (this.policyRecords.get(key) === record) this.policyRecords.delete(key)
        this.changed()
      })
      this.migrationTasks.push(task)
    }
  }
}

export interface CordisXPlatformAdapter {
  status(): CordisXPlatformAdapterStatus
  listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>>
  listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>>
  readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>>
  createTask(input: Omit<CordisXTaskCreateInput, 'initialMessage'>): Promise<CordisXPlatformResult<CordisXSessionSummary>>
  controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>>
  submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>>
  controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>>
}

const CURRENT_CONNECTION_UNAVAILABLE: CordisXPlatformDiagnostic = Object.freeze({
  code: 'current-connection-client-unavailable',
  message: 'The Desktop current-connection request client is not safely available to CordisX',
})

export class UnavailablePlatformAdapter implements CordisXPlatformAdapter {
  status(): CordisXPlatformAdapterStatus {
    return {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [CURRENT_CONNECTION_UNAVAILABLE],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  async listModels(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
  async listTasks(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
  async readTask(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
  async createTask(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
  async controlTask(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
  async submitTurn(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
  async controlTurn(): Promise<CordisXPlatformResult<never>> { return { ok: false, error: CURRENT_CONNECTION_UNAVAILABLE } }
}

export interface CordisXPlatformProjection {
  readonly hostId: string
  readonly hostName: string
  readonly snapshotId?: string
  readonly models?: readonly CordisXModelDescriptor[]
  readonly sessions?: readonly CordisXSessionSummary[]
  readonly sessionContents?: readonly CordisXSessionProjection[]
}

export interface CordisXPlatformProjectionSource {
  getSnapshot(): CordisXPlatformProjection
}

export class ProjectionPlatformAdapter implements CordisXPlatformAdapter {
  constructor(private readonly source: CordisXPlatformProjectionSource) {}

  status(): CordisXPlatformAdapterStatus {
    const snapshot = this.source.getSnapshot()
    const supported: CordisXPlatformCapability[] = []
    if (snapshot.models !== undefined) supported.push('models.read')
    if (snapshot.sessions !== undefined) supported.push('tasks.catalog.read')
    if (snapshot.sessionContents !== undefined) supported.push('tasks.content.read')
    return {
      hostId: snapshot.hostId,
      hostName: snapshot.hostName,
      mode: 'read-only',
      supportedCapabilities: supported,
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>> {
    const models = this.source.getSnapshot().models
    if (models === undefined) return failure('adapter-unavailable', 'The current model projection is unavailable')
    const providerIds = input.providerIds ?? []
    return {
      ok: true,
      value: {
        contract: 'cordisx.platform-model-page/v1',
        schemaVersion: 1,
        providerIds: copy(providerIds),
        models: copy(models.filter(item => providerIds.length === 0 || providerIds.includes(item.ref.providerId))),
      },
    }
  }

  async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    const snapshot = this.source.getSnapshot()
    const sessions = snapshot.sessions
    if (sessions === undefined) return failure('adapter-unavailable', 'The complete session catalog projection is unavailable')
    if (input.cursor !== undefined) return failure('invalid-request', 'The projection adapter does not support continuation cursors')
    const providerIds = input.providerIds ?? []
    const limit = input.limit ?? 100
    const filtered = sessions.filter(item => {
      return (providerIds.length === 0 || providerIds.includes(item.ref.providerId))
        && (input.cwd === undefined || normalizedPath(item.cwd) === normalizedPath(input.cwd))
        && (input.searchTerm === undefined || `${item.title ?? ''}\n${item.cwd}`.toLocaleLowerCase().includes(input.searchTerm.toLocaleLowerCase()))
    }).slice(0, limit)
    return {
      ok: true,
      value: {
        contract: 'cordisx.platform-session-page/v1',
        schemaVersion: 1,
        query: {
          ...(input.providerIds === undefined ? {} : { providerIds: copy(input.providerIds) }),
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(input.searchTerm === undefined ? {} : { searchTerm: input.searchTerm }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        },
        snapshotId: snapshot.snapshotId ?? `projection:${snapshot.hostId}`,
        sessions: copy(filtered),
      },
    }
  }

  async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    const contents = this.source.getSnapshot().sessionContents
    if (contents === undefined) return failure('adapter-unavailable', 'The complete session content projection is unavailable')
    const session = contents.find(item => {
      return item.ref.providerId === input.session.providerId
        && item.ref.remoteSessionId === input.session.remoteSessionId
    })
    return session === undefined
      ? failure('task-not-found', `Session ${input.session.remoteSessionId} was not found for provider ${input.session.providerId}`)
      : { ok: true, value: copy(session) }
  }

  async createTask(): Promise<CordisXPlatformResult<never>> { return failure('adapter-read-only', 'The current Platform adapter is read-only') }
  async controlTask(): Promise<CordisXPlatformResult<never>> { return failure('adapter-read-only', 'The current Platform adapter is read-only') }
  async submitTurn(): Promise<CordisXPlatformResult<never>> { return failure('adapter-read-only', 'The current Platform adapter is read-only') }
  async controlTurn(): Promise<CordisXPlatformResult<never>> { return failure('adapter-read-only', 'The current Platform adapter is read-only') }
}

export interface CordisXPlatformServiceOptions {
  readonly adapter: CordisXPlatformAdapter
  readonly broker: PermissionBroker
  readonly console?: PluginConsoleAspect
}

const platformServiceOptions = new WeakMap<object, CordisXPlatformServiceOptions>()
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function optionsFor(service: object): CordisXPlatformServiceOptions {
  const original = (service as { [CORDIS_ORIGINAL]?: unknown })[CORDIS_ORIGINAL]
  if (typeof original === 'object' && original !== null) {
    const options = platformServiceOptions.get(original)
    if (options !== undefined) return options
  }
  let candidate: object | null = service
  while (candidate !== null) {
    const options = platformServiceOptions.get(candidate)
    if (options !== undefined) return options
    candidate = Object.getPrototypeOf(candidate) as object | null
  }
  throw new Error('CordisX Platform service is detached from its host binding')
}

function pluginIdentity(ctx: Context): CordisXPluginIdentity | undefined {
  const identity = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  return identity[CORDISX_PLUGIN_ID] === undefined || identity[CORDISX_PLUGIN_SOURCE] === undefined
    ? undefined
    : { id: identity[CORDISX_PLUGIN_ID], source: identity[CORDISX_PLUGIN_SOURCE] }
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function validProviderIds(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length <= 32
    && value.every(validText)
    && new Set(value).size === value.length
}

function validModelRef(value: unknown): value is CordisXPlatformModelRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<CordisXPlatformModelRef>
  return Object.keys(value).every(key => key === 'providerId' || key === 'modelId')
    && validText(ref.providerId)
    && validText(ref.modelId)
}

function validSessionRef(value: unknown): value is CordisXPlatformSessionRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const ref = value as Partial<CordisXPlatformSessionRef>
  return Object.keys(value).every(key => key === 'providerId' || key === 'remoteSessionId')
    && validText(ref.providerId)
    && validText(ref.remoteSessionId)
}

function sameSession(left: CordisXPlatformSessionRef, right: CordisXPlatformSessionRef): boolean {
  return left.providerId === right.providerId && left.remoteSessionId === right.remoteSessionId
}

function absolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/** Permission-brokered Platform service. The adapter and broker never cross this API. */
export class CordisXPlatformService extends Service implements CordisXPlatform {
  constructor(ctx: Context, options: CordisXPlatformServiceOptions) {
    super(ctx, 'platform')
    platformServiceOptions.set(this, options)
  }

  get models(): CordisXPlatform['models'] {
    const options = optionsFor(this)
    const token = options.console?.tokenFromContext(this.ctx)
    return Object.freeze({
      list: async (input = {}) => token === undefined || options.console === undefined
        ? await this.listModels(input)
        : await options.console.run(token, 'platform.models.list', input, invocation => this.listModels(input, token, invocation)),
    })
  }

  get tasks(): CordisXPlatform['tasks'] {
    const options = optionsFor(this)
    const token = options.console?.tokenFromContext(this.ctx)
    const instrument = <Value>(source: string, input: unknown, operation: (invocation?: PluginConsoleInvocation) => Promise<Value>): Promise<Value> => (
      token === undefined || options.console === undefined
        ? operation()
        : options.console.run(token, source, input, operation)
    )
    return Object.freeze({
      list: async (input = {}) => await instrument('platform.tasks.list', input, invocation => this.listTasks(input, token, invocation)),
      read: async input => await instrument('platform.tasks.read', input, invocation => this.readTask(input, token, invocation)),
      create: async input => await instrument('platform.tasks.create', input, invocation => this.createTask(input, token, invocation)),
      control: async input => await instrument('platform.tasks.control', input, invocation => this.controlTask(input, token, invocation)),
    })
  }

  get turns(): CordisXPlatform['turns'] {
    const options = optionsFor(this)
    const token = options.console?.tokenFromContext(this.ctx)
    const instrument = <Value>(source: string, input: unknown, operation: (invocation?: PluginConsoleInvocation) => Promise<Value>): Promise<Value> => (
      token === undefined || options.console === undefined ? operation() : options.console.run(token, source, input, operation)
    )
    return Object.freeze({
      submit: async input => await instrument('platform.turns.submit', input, invocation => this.submitTurn(input, token, invocation)),
      control: async input => await instrument('platform.turns.control', input, invocation => this.controlTurn(input, token, invocation)),
    })
  }

  status(): CordisXPlatformAdapterStatus {
    return copy(optionsFor(this).adapter.status())
  }

  private async authorize(
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
    token?: PluginPrincipalToken,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = token === undefined ? pluginIdentity(this.ctx) : optionsFor(this).console?.owner(token)
    if (identity === undefined) return failure('permission-undeclared', 'Platform calls require a runtime-bound plugin identity')
    return await optionsFor(this).broker.authorize(
      identity,
      capability,
      requested,
      generationVisibilityFromContext(this.ctx)?.view(this.ctx),
    )
  }

  private async guarded<Value>(operation: () => Promise<CordisXPlatformResult<Value>>): Promise<CordisXPlatformResult<Value>> {
    try {
      return await operation()
    } catch {
      return safeAdapterFailure()
    }
  }

  private async ensureSessionScope(
    grant: AuthorizationGrant,
    session: CordisXPlatformSessionRef,
  ): Promise<CordisXPlatformResult<true>> {
    const scope = grant.declaration.scope
    if (scope.cwdRoots === undefined) return { ok: true, value: true }
    const projection = await this.guarded(async () => await optionsFor(this).adapter.readTask({ session }))
    if (!projection.ok) return projection
    const requested = { session, providerId: session.providerId, cwd: projection.value.cwd }
    if (scopeAllows(scope, requested)) return { ok: true, value: true }
    const identity = pluginIdentity(this.ctx)
    if (identity !== undefined) optionsFor(this).broker.recordScopeDenial(identity, grant.declaration.name, requested)
    return failure('permission-scope-denied', `Session ${session.remoteSessionId} is outside the declared ${grant.declaration.name} scope`)
  }

  private async listModels(input: CordisXModelsListInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXModelPage>> {
    if (input.providerIds !== undefined && !validProviderIds(input.providerIds)) return failure('invalid-request', 'providerIds must be a unique string array')
    const grant = await this.authorize('models.read', {
      ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const result = await this.guarded(async () => await optionsFor(this).adapter.listModels(input))
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        ...result.value,
        models: result.value.models.filter(item => scopeAllows(grant.value.declaration.scope, { model: item.ref })),
      },
    }
  }

  private async listTasks(input: CordisXTasksListInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXSessionPage>> {
    if (input.providerIds !== undefined && !validProviderIds(input.providerIds)) return failure('invalid-request', 'providerIds must be a unique string array')
    if (input.cwd !== undefined && (!validText(input.cwd) || !absolutePath(input.cwd))) return failure('invalid-request', 'cwd must be an absolute path')
    if (input.searchTerm !== undefined && !validText(input.searchTerm)) return failure('invalid-request', 'searchTerm must be a non-empty string')
    if (input.cursor !== undefined && !validText(input.cursor)) return failure('invalid-request', 'cursor must be a non-empty string')
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) {
      return failure('invalid-request', 'limit must be an integer between 1 and 500')
    }
    const grant = await this.authorize('tasks.catalog.read', {
      ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const result = await this.guarded(async () => await optionsFor(this).adapter.listTasks(input))
    if (!result.ok) return result
    return {
      ok: true,
      value: {
        ...result.value,
        sessions: result.value.sessions.filter(item => scopeAllows(grant.value.declaration.scope, {
          providerId: item.ref.providerId,
          cwd: item.cwd,
          session: item.ref,
        })),
      },
    }
  }

  private async readTask(input: CordisXTaskReadInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    if (!validSessionRef(input.session)) return failure('invalid-request', 'session must be a complete Platform session reference')
    const requested = { providerId: input.session.providerId, session: input.session }
    const grant = await this.authorize('tasks.content.read', requested, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const result = await this.guarded(async () => await optionsFor(this).adapter.readTask(input))
    if (!result.ok) return result
    if (!sameSession(result.value.ref, input.session) || result.value.model.providerId !== input.session.providerId) return safeAdapterFailure()
    if (scopeAllows(grant.value.declaration.scope, { ...requested, cwd: result.value.cwd })) return result
    const identity = pluginIdentity(this.ctx)
    if (identity !== undefined) optionsFor(this).broker.recordScopeDenial(identity, grant.value.declaration.name, { ...requested, cwd: result.value.cwd })
    return failure('permission-scope-denied', 'Session content is outside the declared scope')
  }

  private async createTask(input: CordisXTaskCreateInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXSessionCreateOutcome>> {
    if (!validModelRef(input.model)) return failure('invalid-request', 'model must be a complete Platform model reference')
    if (!validText(input.cwd) || !absolutePath(input.cwd)) return failure('invalid-request', 'cwd must be an absolute path')
    if (input.initialMessage !== undefined && !validText(input.initialMessage)) return failure('invalid-request', 'initialMessage must be a non-empty string')
    const grant = await this.authorize('tasks.create', { providerId: input.model.providerId, model: input.model, cwd: input.cwd }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const models = await this.guarded(async () => await optionsFor(this).adapter.listModels({ providerIds: [input.model.providerId] }))
    if (!models.ok) return models
    const providerModels = models.value.models.filter(model => model.ref.providerId === input.model.providerId)
    if (providerModels.length === 0) return failure('invalid-provider', `Provider ${input.model.providerId} is not currently available`)
    if (!providerModels.some(model => model.ref.modelId === input.model.modelId)) {
      return failure('invalid-model', `Model ${input.model.modelId} is not currently available from provider ${input.model.providerId}`)
    }
    const created = await this.guarded(async () => await optionsFor(this).adapter.createTask({
      model: input.model,
      cwd: input.cwd,
    }))
    if (!created.ok) return created
    if (created.value.ref.providerId !== input.model.providerId || created.value.model.providerId !== input.model.providerId) return safeAdapterFailure()
    if (input.initialMessage === undefined) return { ok: true, value: { status: 'created', session: created.value } }
    const turn = await this.guarded(async () => await optionsFor(this).adapter.submitTurn({ session: created.value.ref, message: input.initialMessage as string }))
    if (turn.ok) return { ok: true, value: { status: 'created', session: created.value, initialTurn: turn.value } }
    return {
      ok: true,
      value: {
        status: 'created-initial-turn-failed',
        session: created.value,
        error: {
          code: 'initial-turn-failed',
          message: `Session ${created.value.ref.remoteSessionId} was created, but its initial turn did not start: ${turn.error.message}`,
          ...(turn.error.retryable === undefined ? {} : { retryable: turn.error.retryable }),
        },
      },
    }
  }

  private async controlTask(input: CordisXTaskControlInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    if (!validSessionRef(input.session) || !['continue', 'fork', 'archive', 'restore', 'delete'].includes(input.action)) {
      return failure('invalid-request', 'task control input is invalid')
    }
    const grant = await this.authorize('tasks.control', { providerId: input.session.providerId, session: input.session }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTask(input))
  }

  private async submitTurn(input: CordisXTurnSubmitInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    if (!validSessionRef(input.session) || !validText(input.message)) return failure('invalid-request', 'session and message must be valid')
    const grant = await this.authorize('turns.submit', { providerId: input.session.providerId, session: input.session }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.submitTurn(input))
  }

  private async controlTurn(input: CordisXTurnControlInput, token?: PluginPrincipalToken, invocation?: PluginConsoleInvocation): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    if (!validSessionRef(input.session) || !['steer', 'interrupt'].includes(input.action)) return failure('invalid-request', 'turn control input is invalid')
    if (input.action === 'steer' && !validText(input.message)) return failure('invalid-request', 'steer message must be a non-empty string')
    const grant = await this.authorize('turns.control', { providerId: input.session.providerId, session: input.session }, token)
    if (!grant.ok) return grant
    invocation?.dispatch()
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTurn(input))
  }
}
