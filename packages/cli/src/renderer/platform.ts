import { Context, Service } from '@deepseek-ai/cordis'
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
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  type CordisXCapabilityDeclarationV2,
  type CordisXPermissionAuthorizationBindingV2,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationKeyV2,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionCapabilityV2,
  type CordisXPermissionDecisionV2,
  type CordisXPermissionPolicyRecordV2,
  type CordisXPermissionPolicyV2,
  type CordisXPermissionScopeV2,
  type CordisXPluginManifestV4,
} from '../permission-contracts.js'
import {
  CapabilityRiskCatalog,
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
} from '../permission-model-v2.js'
import {
  isPermissionPolicyRecordV2,
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
): CordisXPluginManifestV1 | CordisXPluginManifestV4 {
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
  legacy?(): readonly LegacyStoredPolicy[]
  retireLegacy?(record: LegacyStoredPolicy): void | Promise<void>
}

export class MemoryPermissionPolicyStore implements PermissionPolicyStore {
  records: readonly CordisXPersistedPermissionPolicyRecord[]

  constructor(
    records: readonly CordisXPermissionPolicyRecordV1[] = [],
    recordsV2: readonly CordisXPermissionPolicyRecordV2[] = [],
  ) {
    this.records = copy([...records, ...recordsV2])
  }

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return copy(this.records.filter(record => !isPermissionPolicyRecordV2(record))) as readonly CordisXPermissionPolicyRecordV1[]
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return copy(this.records.filter(isPermissionPolicyRecordV2))
  }

  write(records: readonly CordisXPermissionPolicyRecordV1[]): void {
    this.writeRecords(records)
  }

  writeV2(records: readonly CordisXPermissionPolicyRecordV2[]): void {
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
      !isPermissionPolicyRecordV2(record) && record.key.profileId === this.profileId
    ))
  }

  readV2(): readonly CordisXPermissionPolicyRecordV2[] {
    return this.readAll().filter((record): record is CordisXPermissionPolicyRecordV2 => (
      isPermissionPolicyRecordV2(record) && record.key.profileId === this.profileId
    ))
  }

  write(nextRecords: readonly CordisXPermissionPolicyRecordV1[]): void {
    this.writeRecords(nextRecords)
  }

  writeV2(nextRecords: readonly CordisXPermissionPolicyRecordV2[]): void {
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
}

export interface PermissionPrompt {
  request(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>>
}

export interface PermissionAuthorizationPromptV2 {
  request(
    plan: CordisXPermissionAuthorizationPlanV2,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV2 | undefined>
  dispose?(): void
}

export class BrowserPermissionPrompt implements PermissionPrompt {
  private queue = Promise.resolve()
  private readonly theme: HostThemeProjection

  constructor(private readonly document: Document | undefined = globalThis.document) {
    this.theme = new HostThemeProjection(document ?? globalThis.document)
  }

  request(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>> {
    const next = this.queue.then(async () => await this.show(input))
    this.queue = next.then(() => undefined, () => undefined)
    return next
  }

  private async show(input: PermissionPromptRequest): Promise<Exclude<CordisXPermissionDecision, 'ask'>> {
    const document = this.document
    if (document?.body === undefined) return 'deny'
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
      const finish = (decision: Exclude<CordisXPermissionDecision, 'ask'>): void => {
        detachTheme()
        overlay.remove()
        resolve(decision)
      }
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
    return result.status === 'confirmed' ? result.decision : undefined
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
}

export interface PlatformPermissionSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly capability: CordisXPlatformCapability
  readonly required: boolean
  readonly reason: CordisXLocalizedText
  readonly scope: CordisXCapabilityScope
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
  readonly lastRequested?: RequestedScope
  readonly lastUsedAt?: string
  readonly lastDeniedAt?: string
  readonly denialCount: number
  readonly blockedReason?: string
}

interface Registration {
  readonly identity: CordisXPluginIdentity
  readonly manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4
  readonly declarations: ReadonlyMap<CordisXPlatformCapability, CordisXCapabilityDeclaration>
  readonly declarationsV2: ReadonlyMap<CordisXPermissionCapabilityV2, CordisXCapabilityDeclarationV2>
  readonly generation: PluginGenerationEffectIdentity
  readonly candidateView?: PluginGenerationView
}

function manifestDeclarationsV2(
  manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4,
): readonly CordisXCapabilityDeclarationV2[] {
  if (manifest.schemaVersion === 4) return manifest.capabilities
  return Object.freeze(manifest.capabilities.map(declaration => Object.freeze({
    name: declaration.name as CordisXPermissionCapabilityV2,
    required: declaration.required,
    scope: declaration.scope as CordisXPermissionScopeV2,
  })))
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

export class PermissionBroker {
  private readonly registrations = new Map<string, Registration>()
  /** One profile ledger index for both the retiring v1 records and authoritative v2 records. */
  private readonly policyRecords = new Map<string, CordisXPersistedPermissionPolicyRecord>()
  private readonly audit = new Map<string, AuditRecord>()
  private readonly onceV2 = new PermissionOnceGrantLedger()
  private readonly catalog = new CapabilityRiskCatalog()
  private readonly listeners = new Set<() => void>()
  private readonly migrationTasks: Promise<void>[] = []

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
    visibility?.connect({ notify: () => this.changed() })
  }

  register(
    identity: CordisXPluginIdentity,
    manifest: CordisXPluginManifestV1 | CordisXPluginManifestV4,
    generation: PluginGenerationEffectIdentity = Object.freeze({ pluginId: identity.id }),
    candidateView?: PluginGenerationView,
  ): () => void {
    const key = `${platformIdentityKey(identity)}\u0000${generation.moduleGeneration ?? 'host'}`
    const declarations = new Map<CordisXPlatformCapability, CordisXCapabilityDeclaration>(
      manifest.schemaVersion === 4
        ? manifest.capabilities.flatMap(item => (
            (CORDISX_PLATFORM_CAPABILITIES as readonly string[]).includes(item.name)
              ? [[item.name as CordisXPlatformCapability, {
                  name: item.name as CordisXPlatformCapability,
                  required: item.required,
                  reason: item.rationale?.description ?? {
                    namespace: 'permission',
                    key: `permission.${item.name}.legacy-reason`,
                    fallback: this.catalog.get(item.name).presentation.description.fallback,
                  },
                  scope: item.scope as CordisXCapabilityScope,
                } as CordisXCapabilityDeclaration] as const]
              : []
          ))
        : manifest.capabilities.map(item => [item.name, item] as const),
    )
    const declarationsV2 = new Map(manifestDeclarationsV2(manifest).map(item => [item.name, item]))
    const registration = {
      identity: Object.freeze({ ...identity }), manifest, declarations, declarationsV2, generation,
      ...(candidateView === undefined ? {} : { candidateView }),
    }
    if (this.registrations.has(key) && this.visibility !== undefined) {
      throw new Error(`plugin ${identity.id} permission generation is already registered`)
    }
    this.registrations.set(key, registration)
    this.migrateLegacy(registration)
    this.migratePolicyRecordsV1(registration)
    if (this.visibility?.visible(generation) !== false) this.changed()
    return () => {
      if (this.registrations.get(key) !== registration) return
      this.registrations.delete(key)
      const identityKey = platformIdentityKey(identity)
      this.onceV2.clearGeneration(this.generation, generation.moduleGeneration)
      for (const auditKey of [...this.audit.keys()]) if (auditKey.startsWith(`${identityKey}\u0000`)) this.audit.delete(auditKey)
      if (this.visibility?.visible(generation) !== false) this.changed()
    }
  }

  private registration(identity: CordisXPluginIdentity, view?: PluginGenerationView): Registration | undefined {
    return [...this.registrations.values()].find(item => platformIdentityKey(item.identity) === platformIdentityKey(identity)
      && (this.visibility?.visible(item.generation, view) ?? true))
  }

  private persistV2(records: readonly CordisXPermissionPolicyRecordV2[]): Promise<void> {
    if (this.store.writeV2 === undefined) return Promise.reject(new Error('permission v2 persistence is unavailable'))
    return Promise.resolve(this.store.writeV2(records))
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
    if (registration.manifest.schemaVersion !== 4) return
    const legacy = [...this.policyRecords.values()].filter((record): record is CordisXPermissionPolicyRecordV1 => (
      !isPermissionPolicyRecordV2(record)
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
      return record !== undefined && !isPermissionPolicyRecordV2(record) ? record.policy : 'ask'
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
    this.changed()
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

  requiredDenied(identity: CordisXPluginIdentity, view?: PluginGenerationView): readonly CordisXPermissionCapabilityV2[] {
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
    return plan.declarations.filter(item => item.required
      && item.policy !== 'allow-persistent'
      && !this.onceV2.has(this.authorizationKey(plan, item.capability), plan.binding))
      .map(item => item.capability)
  }

  recordScopeDenial(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, requested: RequestedScope): void {
    this.denied(platformIdentityKey(identity), capability, requested)
  }

  snapshots(): readonly PlatformPermissionSnapshot[] {
    return [...this.registrations.values()]
      .filter(registration => this.visibility?.visible(registration.generation) ?? true)
      .flatMap(registration => [...registration.declarations.values()].map(declaration => {
      const identityKey = platformIdentityKey(registration.identity)
      const audit = this.audit.get(this.auditKey(identityKey, declaration.name)) ?? { denialCount: 0 }
      const policy = this.policy(registration.identity, declaration.name)
      const item = registration.declarationsV2.get(declaration.name as CordisXPermissionCapabilityV2)
      return {
        identity: registration.identity,
        capability: declaration.name,
        required: declaration.required,
        reason: declaration.reason,
        scope: declaration.scope,
        fingerprint: registration.manifest.schemaVersion === 1 || item === undefined
          ? declarationFingerprint(declaration)
          : this.authorizationPlanV2(registration.identity, 'enable').declarations
              .find(candidate => candidate.capability === item.name)!.securityFingerprint,
        policy,
        ...(audit.lastRequested === undefined ? {} : { lastRequested: audit.lastRequested }),
        ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
        ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
        denialCount: audit.denialCount,
        ...(this.requiredDenied(registration.identity).includes(declaration.name)
          ? { blockedReason: registration.manifest.schemaVersion === 1
              ? `Required capability ${declaration.name} is denied`
              : `Required capability ${declaration.name} is not authorized` }
          : {}),
      }
    }))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.registrations.clear()
    this.audit.clear()
    this.onceV2.dispose()
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
