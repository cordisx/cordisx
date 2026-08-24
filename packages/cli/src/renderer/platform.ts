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
  normalizePermissionPolicyRecord,
  normalizePermissionScope,
  permissionIdentityKey,
  permissionRecordKey,
  permissionScopeFingerprint,
} from '../permissions.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'

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
export function normalizePluginManifest(value: unknown, expectedId: string): CordisXPluginManifestV1 {
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
  legacy?(): readonly LegacyStoredPolicy[]
  retireLegacy?(record: LegacyStoredPolicy): void | Promise<void>
}

export class MemoryPermissionPolicyStore implements PermissionPolicyStore {
  records: readonly CordisXPermissionPolicyRecordV1[]

  constructor(records: readonly CordisXPermissionPolicyRecordV1[] = []) {
    this.records = copy(records)
  }

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    return copy(this.records)
  }

  write(records: readonly CordisXPermissionPolicyRecordV1[]): void {
    const keys = new Set(records.map(permissionRecordKey))
    this.records = copy([...this.records.filter(item => !keys.has(permissionRecordKey(item))), ...records])
  }
}

export class BrowserPermissionPolicyStore implements PermissionPolicyStore {
  constructor(private readonly profileId = 'default') {}

  read(): readonly CordisXPermissionPolicyRecordV1[] {
    try {
      const value = localStorage.getItem(POLICY_STORAGE_KEY)
      if (value === null) return []
      const records = JSON.parse(value) as unknown
      if (!Array.isArray(records)) return []
      return records.flatMap((item) => {
        try {
          const record = normalizePermissionPolicyRecord(item)
          return record.key.profileId === this.profileId ? [record] : []
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  write(nextRecords: readonly CordisXPermissionPolicyRecordV1[]): void {
    const value = localStorage.getItem(POLICY_STORAGE_KEY)
    const parsed = value === null ? [] : JSON.parse(value) as unknown
    const records = Array.isArray(parsed) ? parsed.flatMap((item) => {
      try { return [normalizePermissionPolicyRecord(item)] } catch { return [] }
    }) : []
    const keys = new Set(nextRecords.map(permissionRecordKey))
    localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify([
      ...records.filter(item => !keys.has(permissionRecordKey(item))),
      ...nextRecords,
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

export class BrowserPermissionPrompt implements PermissionPrompt {
  private queue = Promise.resolve()

  constructor(private readonly document: Document | undefined = globalThis.document) {}

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
      overlay.dataset.permissionPrompt = input.declaration.name
      overlay.setAttribute('role', 'dialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-labelledby', 'cordisx-permission-prompt-title')
      overlay.setAttribute('aria-describedby', 'cordisx-permission-prompt-description')
      overlay.innerHTML = `<style>
        [data-permission-prompt] { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 24px; background: color-mix(in srgb, CanvasText 42%, transparent); color-scheme: light dark; }
        [data-permission-prompt] .cxp-dialog { width: min(460px, 100%); border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 14px; padding: 20px; background: Canvas; color: CanvasText; box-shadow: 0 20px 64px color-mix(in srgb, CanvasText 28%, transparent); }
        [data-permission-prompt] h2 { margin: 0; font-size: 18px; }
        [data-permission-prompt] p { margin: 10px 0 0; line-height: 1.5; }
        [data-permission-prompt] .cxp-reason { color: color-mix(in srgb, CanvasText 72%, transparent); }
        [data-permission-prompt] .cxp-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 20px; }
        [data-permission-prompt] button { border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 9px; padding: 8px 12px; background: color-mix(in srgb, CanvasText 6%, Canvas); color: CanvasText; cursor: pointer; }
        [data-permission-prompt] button[data-primary="true"] { border-color: #8e959f; background: #c7ccd4; color: #17191c; font-weight: 600; }
        [data-permission-prompt] button[data-tone="danger"] { color: #d95c5c; }
        [data-permission-prompt] button:focus-visible { outline: 2px solid #9da5b0; outline-offset: 2px; }
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
  readonly manifest: CordisXPluginManifestV1
  readonly declarations: ReadonlyMap<CordisXPlatformCapability, CordisXCapabilityDeclaration>
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
  private readonly policies = new Map<string, CordisXPermissionPolicyRecordV1>()
  private readonly audit = new Map<string, AuditRecord>()
  private readonly onceTickets = new Map<string, Set<string>>()
  private readonly listeners = new Set<() => void>()
  private readonly migrationTasks: Promise<void>[] = []

  constructor(
    private readonly store: PermissionPolicyStore,
    private readonly prompt: PermissionPrompt,
    private readonly now: () => Date = () => new Date(),
    private readonly promptTimeoutMs = 30_000,
    private readonly profileId = 'default',
    private readonly generation = 'runtime',
  ) {
    for (const record of store.read()) {
      if (record.key.profileId === profileId) this.policies.set(permissionRecordKey(record), record)
    }
  }

  register(identity: CordisXPluginIdentity, manifest: CordisXPluginManifestV1): () => void {
    const key = platformIdentityKey(identity)
    const declarations = new Map(manifest.capabilities.map(item => [item.name, item]))
    const registration = { identity: Object.freeze({ ...identity }), manifest, declarations }
    this.registrations.set(key, registration)
    this.migrateLegacy(registration)
    this.changed()
    return () => {
      if (this.registrations.get(key) !== registration) return
      this.registrations.delete(key)
      this.onceTickets.delete(key)
      for (const auditKey of [...this.audit.keys()]) if (auditKey.startsWith(`${key}\u0000`)) this.audit.delete(auditKey)
      this.changed()
    }
  }

  policy(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability): CordisXPermissionPolicy {
    const registration = this.registrations.get(platformIdentityKey(identity))
    const declaration = registration?.declarations.get(capability)
    if (declaration === undefined) return 'ask'
    return this.policies.get(permissionRecordKey(createPermissionPolicyRecord({
      profileId: this.profileId,
      identity,
      capability,
      scope: declaration.scope,
      policy: 'ask',
    })))?.policy ?? 'ask'
  }

  async setPolicy(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    policy: CordisXPermissionPolicy,
  ): Promise<void> {
    const identityKey = platformIdentityKey(identity)
    const declaration = this.registrations.get(identityKey)?.declarations.get(capability)
    if (declaration === undefined) throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    const record = createPermissionPolicyRecord({
      profileId: this.profileId,
      identity,
      capability,
      scope: declaration.scope,
      policy,
    })
    const key = permissionRecordKey(record)
    const previous = this.policies.get(key)
    this.policies.set(key, record)
    this.changed()
    try {
      await this.store.write([record])
    } catch (error) {
      if (previous === undefined) this.policies.delete(key)
      else this.policies.set(key, previous)
      this.changed()
      throw error
    }
    const tickets = this.onceTickets.get(identityKey)
    tickets?.delete(this.onceKey(declaration))
    if (tickets?.size === 0) this.onceTickets.delete(identityKey)
  }

  authorizationPlan(
    identity: CordisXPluginIdentity,
    operation: 'install' | 'update' | 'enable' = 'enable',
  ): CordisXPermissionAuthorizationPlanV1 {
    const registration = this.registrations.get(platformIdentityKey(identity))
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
    return Object.freeze({
      $schema: CORDISX_PERMISSION_AUTHORIZATION_PLAN_SCHEMA_V1,
      schemaVersion: 1,
      planId: `${this.generation}:${identity.id}`,
      operation,
      profileId: this.profileId,
      identity: Object.freeze({ source: registration.identity.source, pluginId: registration.identity.id }),
      defaultDecision: 'allow',
      declarations: Object.freeze([...registration.declarations.values()].map(declaration => Object.freeze({
        capability: declaration.name,
        required: declaration.required,
        reason: declaration.reason,
        scope: declaration.scope,
        policy: this.policy(identity, declaration.name),
        decisionRequired: !this.policies.has(permissionRecordKey(createPermissionPolicyRecord({
          profileId: this.profileId,
          identity,
          capability: declaration.name,
          scope: declaration.scope,
          policy: 'ask',
        }))),
      }))),
    })
  }

  async authorizeActivation(
    identity: CordisXPluginIdentity,
    authorization: CordisXPermissionAuthorizationDecisionV1,
    operation: 'install' | 'update' | 'enable' = 'enable',
  ): Promise<void> {
    const registration = this.registrations.get(platformIdentityKey(identity))
    if (registration === undefined) throw new Error(`plugin ${identity.id} is not registered`)
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
    const records: CordisXPermissionPolicyRecordV1[] = []
    const ticketKeys: string[] = []
    const persistentTicketKeys: string[] = []
    for (const item of authorization.decisions) {
      const declaration = registration.declarations.get(item.capability)!
      if (item.decision === 'allow-once') {
        ticketKeys.push(this.onceKey(declaration))
        continue
      }
      records.push(createPermissionPolicyRecord({
        profileId: this.profileId,
        identity,
        capability: item.capability,
        scope: declaration.scope,
        policy: item.decision,
      }))
      persistentTicketKeys.push(this.onceKey(declaration))
    }
    if (records.length > 0) {
      await this.store.write(records)
      for (const record of records) this.policies.set(permissionRecordKey(record), record)
    }
    const tickets = ticketKeys.length > 0 ? this.ticketSet(identity) : this.onceTickets.get(platformIdentityKey(identity))
    for (const key of ticketKeys) tickets?.add(key)
    for (const key of persistentTicketKeys) tickets?.delete(key)
    if (tickets?.size === 0) this.onceTickets.delete(platformIdentityKey(identity))
    this.changed()
  }

  clearOnce(identity: CordisXPluginIdentity): void {
    if (this.onceTickets.delete(platformIdentityKey(identity))) this.changed()
  }

  async settled(): Promise<void> {
    await Promise.all(this.migrationTasks)
  }

  async authorize(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identityKey = platformIdentityKey(identity)
    const declaration = this.registrations.get(identityKey)?.declarations.get(capability)
    if (declaration === undefined) {
      this.denied(identityKey, capability, requested)
      return failure('permission-undeclared', `Plugin ${identity.id} does not declare ${capability}`)
    }
    if (!scopeAllows(declaration.scope, requested)) {
      this.denied(identityKey, capability, requested)
      return failure('permission-scope-denied', `Requested parameters are outside the declared ${capability} scope`)
    }
    const policy = this.policy(identity, capability)
    const ticket = this.consumeOnce(identity, declaration)
    if (policy === 'deny' && !ticket) {
      this.denied(identityKey, capability, requested)
      return failure('permission-denied', `${capability} is denied for plugin ${identity.id}`)
    }
    if (policy === 'ask' && !ticket) {
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
        this.denied(identityKey, capability, requested)
        return failure('timeout', `${capability} permission request timed out`)
      }
      if (decision === 'deny') {
        this.denied(identityKey, capability, requested)
        return failure('permission-denied', `${capability} was denied for this call`)
      }
      if (decision === 'allow') {
        try {
          await this.setPolicy(identity, capability, 'allow')
        } catch {
          this.denied(identityKey, capability, requested)
          return failure('adapter-failure', `${capability} permission policy could not be persisted`)
        }
      }
    }
    const auditKey = this.auditKey(identityKey, capability)
    const audit = this.audit.get(auditKey) ?? { denialCount: 0 }
    audit.lastUsedAt = isoNow(this.now)
    audit.lastRequested = requestedSnapshot(requested)
    this.audit.set(auditKey, audit)
    this.changed()
    return { ok: true, value: { declaration } }
  }

  requiredDenied(identity: CordisXPluginIdentity): readonly CordisXPlatformCapability[] {
    const registration = this.registrations.get(platformIdentityKey(identity))
    if (registration === undefined) return []
    return [...registration.declarations.values()]
      .filter(item => item.required && this.policy(identity, item.name) === 'deny' && !this.hasOnce(identity, item))
      .map(item => item.name)
  }

  recordScopeDenial(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, requested: RequestedScope): void {
    this.denied(platformIdentityKey(identity), capability, requested)
  }

  snapshots(): readonly PlatformPermissionSnapshot[] {
    return [...this.registrations.values()].flatMap(registration => [...registration.declarations.values()].map(declaration => {
      const identityKey = platformIdentityKey(registration.identity)
      const audit = this.audit.get(this.auditKey(identityKey, declaration.name)) ?? { denialCount: 0 }
      const policy = this.policy(registration.identity, declaration.name)
      return {
        identity: registration.identity,
        capability: declaration.name,
        required: declaration.required,
        reason: declaration.reason,
        scope: declaration.scope,
        fingerprint: declarationFingerprint(declaration),
        policy,
        ...(audit.lastRequested === undefined ? {} : { lastRequested: audit.lastRequested }),
        ...(audit.lastUsedAt === undefined ? {} : { lastUsedAt: audit.lastUsedAt }),
        ...(audit.lastDeniedAt === undefined ? {} : { lastDeniedAt: audit.lastDeniedAt }),
        denialCount: audit.denialCount,
        ...(declaration.required && policy === 'deny' ? { blockedReason: `Required capability ${declaration.name} is denied` } : {}),
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
    this.onceTickets.clear()
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
    for (const listener of this.listeners) listener()
  }

  private ticketSet(identity: CordisXPluginIdentity): Set<string> {
    const identityKey = platformIdentityKey(identity)
    const tickets = this.onceTickets.get(identityKey) ?? new Set<string>()
    this.onceTickets.set(identityKey, tickets)
    return tickets
  }

  private onceKey(declaration: CordisXCapabilityDeclaration): string {
    return `${this.generation}\u0000${declarationFingerprint(declaration)}`
  }

  private consumeOnce(identity: CordisXPluginIdentity, declaration: CordisXCapabilityDeclaration): boolean {
    const tickets = this.onceTickets.get(platformIdentityKey(identity))
    const key = this.onceKey(declaration)
    if (tickets?.has(key) !== true) return false
    tickets.delete(key)
    if (tickets.size === 0) this.onceTickets.delete(platformIdentityKey(identity))
    this.changed()
    return true
  }

  private hasOnce(identity: CordisXPluginIdentity, declaration: CordisXCapabilityDeclaration): boolean {
    return this.onceTickets.get(platformIdentityKey(identity))?.has(this.onceKey(declaration)) === true
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
      const record = createPermissionPolicyRecord({
        profileId: this.profileId,
        identity: registration.identity,
        capability: declaration.name,
        scope: declaration.scope,
        policy: legacy.policy,
      })
      const key = permissionRecordKey(record)
      if (this.policies.has(key)) continue
      this.policies.set(key, record)
      const task = Promise.resolve(this.store.write([record])).then(async () => {
        await this.store.retireLegacy?.(legacy)
      }).catch(() => {
        if (this.policies.get(key) === record) this.policies.delete(key)
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
    return Object.freeze({ list: async (input = {}) => await this.listModels(input) })
  }

  get tasks(): CordisXPlatform['tasks'] {
    return Object.freeze({
      list: async (input = {}) => await this.listTasks(input),
      read: async input => await this.readTask(input),
      create: async input => await this.createTask(input),
      control: async input => await this.controlTask(input),
    })
  }

  get turns(): CordisXPlatform['turns'] {
    return Object.freeze({
      submit: async input => await this.submitTurn(input),
      control: async input => await this.controlTurn(input),
    })
  }

  status(): CordisXPlatformAdapterStatus {
    return copy(optionsFor(this).adapter.status())
  }

  private async authorize(
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identity = pluginIdentity(this.ctx)
    if (identity === undefined) return failure('permission-undeclared', 'Platform calls require a runtime-bound plugin identity')
    return await optionsFor(this).broker.authorize(identity, capability, requested)
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

  private async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<CordisXModelPage>> {
    if (input.providerIds !== undefined && !validProviderIds(input.providerIds)) return failure('invalid-request', 'providerIds must be a unique string array')
    const grant = await this.authorize('models.read', {
      ...(input.providerIds === undefined ? {} : { providerIds: input.providerIds }),
    })
    if (!grant.ok) return grant
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

  private async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<CordisXSessionPage>> {
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
    })
    if (!grant.ok) return grant
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

  private async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXSessionProjection>> {
    if (!validSessionRef(input.session)) return failure('invalid-request', 'session must be a complete Platform session reference')
    const requested = { providerId: input.session.providerId, session: input.session }
    const grant = await this.authorize('tasks.content.read', requested)
    if (!grant.ok) return grant
    const result = await this.guarded(async () => await optionsFor(this).adapter.readTask(input))
    if (!result.ok) return result
    if (!sameSession(result.value.ref, input.session) || result.value.model.providerId !== input.session.providerId) return safeAdapterFailure()
    if (scopeAllows(grant.value.declaration.scope, { ...requested, cwd: result.value.cwd })) return result
    const identity = pluginIdentity(this.ctx)
    if (identity !== undefined) optionsFor(this).broker.recordScopeDenial(identity, grant.value.declaration.name, { ...requested, cwd: result.value.cwd })
    return failure('permission-scope-denied', 'Session content is outside the declared scope')
  }

  private async createTask(input: CordisXTaskCreateInput): Promise<CordisXPlatformResult<CordisXSessionCreateOutcome>> {
    if (!validModelRef(input.model)) return failure('invalid-request', 'model must be a complete Platform model reference')
    if (!validText(input.cwd) || !absolutePath(input.cwd)) return failure('invalid-request', 'cwd must be an absolute path')
    if (input.initialMessage !== undefined && !validText(input.initialMessage)) return failure('invalid-request', 'initialMessage must be a non-empty string')
    const grant = await this.authorize('tasks.create', { providerId: input.model.providerId, model: input.model, cwd: input.cwd })
    if (!grant.ok) return grant
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

  private async controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    if (!validSessionRef(input.session) || !['continue', 'fork', 'archive', 'restore', 'delete'].includes(input.action)) {
      return failure('invalid-request', 'task control input is invalid')
    }
    const grant = await this.authorize('tasks.control', { providerId: input.session.providerId, session: input.session })
    if (!grant.ok) return grant
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTask(input))
  }

  private async submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    if (!validSessionRef(input.session) || !validText(input.message)) return failure('invalid-request', 'session and message must be valid')
    const grant = await this.authorize('turns.submit', { providerId: input.session.providerId, session: input.session })
    if (!grant.ok) return grant
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.submitTurn(input))
  }

  private async controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    if (!validSessionRef(input.session) || !['steer', 'interrupt'].includes(input.action)) return failure('invalid-request', 'turn control input is invalid')
    if (input.action === 'steer' && !validText(input.message)) return failure('invalid-request', 'steer message must be a non-empty string')
    const grant = await this.authorize('turns.control', { providerId: input.session.providerId, session: input.session })
    if (!grant.ok) return grant
    const scope = await this.ensureSessionScope(grant.value, input.session)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTurn(input))
  }
}
