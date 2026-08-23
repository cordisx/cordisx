import { Context, Service } from '@deepseek-ai/cordis'
import {
  CORDISX_PLATFORM_CAPABILITIES,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXCapabilityDeclaration,
  type CordisXCapabilityScope,
  type CordisXLocalizedText,
  type CordisXModelDescriptor,
  type CordisXModelsListInput,
  type CordisXPermissionPolicy,
  type CordisXPlatform,
  type CordisXPlatformAdapterStatus,
  type CordisXPlatformCapability,
  type CordisXPlatformDiagnostic,
  type CordisXPlatformResult,
  type CordisXPluginIdentity,
  type CordisXPluginManifestV1,
  type CordisXTaskControlInput,
  type CordisXTaskControlOutcome,
  type CordisXTaskCreateInput,
  type CordisXTaskCreateOutcome,
  type CordisXTaskProjection,
  type CordisXTaskReadInput,
  type CordisXTasksListInput,
  type CordisXTaskSummary,
  type CordisXTurnControlInput,
  type CordisXTurnControlOutcome,
  type CordisXTurnStart,
  type CordisXTurnSubmitInput,
} from '../contracts.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/
const POLICY_STORAGE_KEY = 'cordisx.platform.permissionPolicies.v1'

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

function stringList(
  value: unknown,
  label: string,
  maximum: number,
  validate: (item: string) => boolean = () => true,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum || value.some(item => {
    return typeof item !== 'string' || item.trim() === '' || !validate(item.trim())
  })) {
    throw new Error(`${label} must be a non-empty string array`)
  }
  const normalized = [...new Set(value.map(item => item.trim()))].sort()
  if (normalized.length !== value.length) throw new Error(`${label} must not contain duplicates`)
  return Object.freeze(normalized)
}

function normalizedScope(value: unknown, label: string): CordisXCapabilityScope {
  const scope = object(value, label)
  const unknown = Object.keys(scope).filter(key => !['providers', 'cwdRoots', 'taskIds'].includes(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field ${unknown[0]}`)
  const providers = stringList(scope.providers, `${label}.providers`, 32, item => /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(item))
  const cwdRoots = stringList(scope.cwdRoots, `${label}.cwdRoots`, 32, item => item.length <= 4096)
  const taskIds = stringList(scope.taskIds, `${label}.taskIds`, 100, item => item.length <= 256)
  if (cwdRoots?.some(root => !absolutePath(root)) === true) throw new Error(`${label}.cwdRoots must contain absolute paths`)
  return Object.freeze({
    ...(providers === undefined ? {} : { providers }),
    ...(cwdRoots === undefined ? {} : { cwdRoots }),
    ...(taskIds === undefined ? {} : { taskIds }),
  })
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
    return Object.freeze({
      name: declaration.name as CordisXPlatformCapability,
      required: declaration.required,
      reason: normalizedReason(declaration.reason, `plugin ${expectedId} capability[${index}].reason`),
      scope: normalizedScope(declaration.scope, `plugin ${expectedId} capability[${index}].scope`),
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
  return JSON.stringify([identity.source, identity.id])
}

function declarationFingerprint(declaration: CordisXCapabilityDeclaration): string {
  return JSON.stringify({
    name: declaration.name,
    required: declaration.required,
    reason: declaration.reason,
    scope: declaration.scope,
  })
}

interface StoredPolicy {
  readonly identityKey: string
  readonly capability: CordisXPlatformCapability
  readonly fingerprint: string
  readonly policy: CordisXPermissionPolicy
}

export interface PermissionPolicyStore {
  read(): readonly StoredPolicy[]
  write(records: readonly StoredPolicy[]): void
}

export class MemoryPermissionPolicyStore implements PermissionPolicyStore {
  records: readonly StoredPolicy[]

  constructor(records: readonly StoredPolicy[] = []) {
    this.records = copy(records)
  }

  read(): readonly StoredPolicy[] {
    return copy(this.records)
  }

  write(records: readonly StoredPolicy[]): void {
    this.records = copy(records)
  }
}

export class BrowserPermissionPolicyStore implements PermissionPolicyStore {
  read(): readonly StoredPolicy[] {
    try {
      const value = localStorage.getItem(POLICY_STORAGE_KEY)
      if (value === null) return []
      const records = JSON.parse(value) as unknown
      if (!Array.isArray(records)) return []
      return records.filter((item): item is StoredPolicy => {
        if (item === null || typeof item !== 'object') return false
        const record = item as Partial<StoredPolicy>
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

  write(records: readonly StoredPolicy[]): void {
    try {
      localStorage.setItem(POLICY_STORAGE_KEY, JSON.stringify(records))
    } catch {
      // Renderer-local persistence is best effort; broker enforcement remains active.
    }
  }
}

interface RequestedScope {
  readonly providerId?: string
  readonly cwd?: string
  readonly taskId?: string
}

export interface PermissionPromptRequest {
  readonly identity: CordisXPluginIdentity
  readonly declaration: CordisXCapabilityDeclaration
  readonly requested: RequestedScope
}

export interface PermissionPrompt {
  request(input: PermissionPromptRequest): Promise<'allow' | 'deny'>
}

export class BrowserPermissionPrompt implements PermissionPrompt {
  async request(input: PermissionPromptRequest): Promise<'allow' | 'deny'> {
    const reason = input.declaration.reason.fallback ?? `${input.declaration.reason.namespace ?? input.identity.id}:${input.declaration.reason.key}`
    const ask = globalThis.confirm
    if (typeof ask !== 'function') return 'deny'
    return ask(`${input.identity.id} requests ${input.declaration.name}\n\n${reason}`) ? 'allow' : 'deny'
  }
}

interface AuditRecord {
  lastUsedAt?: string
  lastDeniedAt?: string
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
  if (requested.taskId !== undefined && scope.taskIds !== undefined && !scope.taskIds.includes(requested.taskId)) return false
  if (requested.cwd !== undefined && scope.cwdRoots !== undefined && !scope.cwdRoots.some(root => pathInside(requested.cwd as string, root))) return false
  return true
}

function isoNow(now: () => Date): string {
  return now().toISOString()
}

export class PermissionBroker {
  private readonly registrations = new Map<string, Registration>()
  private readonly policies = new Map<string, StoredPolicy>()
  private readonly audit = new Map<string, AuditRecord>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly store: PermissionPolicyStore,
    private readonly prompt: PermissionPrompt,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const record of store.read()) this.policies.set(this.policyKey(record.identityKey, record.capability, record.fingerprint), record)
  }

  register(identity: CordisXPluginIdentity, manifest: CordisXPluginManifestV1): () => void {
    const key = platformIdentityKey(identity)
    const declarations = new Map(manifest.capabilities.map(item => [item.name, item]))
    const registration = { identity: Object.freeze({ ...identity }), manifest, declarations }
    this.registrations.set(key, registration)
    this.changed()
    return () => {
      if (this.registrations.get(key) !== registration) return
      this.registrations.delete(key)
      for (const auditKey of [...this.audit.keys()]) if (auditKey.startsWith(`${key}\u0000`)) this.audit.delete(auditKey)
      this.changed()
    }
  }

  policy(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability): CordisXPermissionPolicy {
    const registration = this.registrations.get(platformIdentityKey(identity))
    const declaration = registration?.declarations.get(capability)
    if (declaration === undefined) return 'ask'
    const identityKey = platformIdentityKey(identity)
    return this.policies.get(this.policyKey(identityKey, capability, declarationFingerprint(declaration)))?.policy ?? 'ask'
  }

  setPolicy(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability, policy: CordisXPermissionPolicy): void {
    const identityKey = platformIdentityKey(identity)
    const declaration = this.registrations.get(identityKey)?.declarations.get(capability)
    if (declaration === undefined) throw new Error(`plugin ${identity.id} does not declare ${capability}`)
    const fingerprint = declarationFingerprint(declaration)
    const record = { identityKey, capability, fingerprint, policy } satisfies StoredPolicy
    this.policies.set(this.policyKey(identityKey, capability, fingerprint), record)
    this.persist()
    this.changed()
  }

  async authorize(
    identity: CordisXPluginIdentity,
    capability: CordisXPlatformCapability,
    requested: RequestedScope,
  ): Promise<CordisXPlatformResult<AuthorizationGrant>> {
    const identityKey = platformIdentityKey(identity)
    const declaration = this.registrations.get(identityKey)?.declarations.get(capability)
    if (declaration === undefined) {
      this.denied(identityKey, capability)
      return failure('permission-undeclared', `Plugin ${identity.id} does not declare ${capability}`)
    }
    if (!scopeAllows(declaration.scope, requested)) {
      this.denied(identityKey, capability)
      return failure('permission-scope-denied', `Requested parameters are outside the declared ${capability} scope`)
    }
    const policy = this.policy(identity, capability)
    if (policy === 'deny') {
      this.denied(identityKey, capability)
      return failure('permission-denied', `${capability} is denied for plugin ${identity.id}`)
    }
    if (policy === 'ask') {
      let decision: 'allow' | 'deny'
      try {
        decision = await this.prompt.request({ identity, declaration, requested })
      } catch {
        decision = 'deny'
      }
      if (decision === 'deny') {
        this.denied(identityKey, capability)
        return failure('permission-denied', `${capability} was denied for this call`)
      }
    }
    const auditKey = this.auditKey(identityKey, capability)
    const audit = this.audit.get(auditKey) ?? { denialCount: 0 }
    audit.lastUsedAt = isoNow(this.now)
    this.audit.set(auditKey, audit)
    this.changed()
    return { ok: true, value: { declaration } }
  }

  requiredDenied(identity: CordisXPluginIdentity): readonly CordisXPlatformCapability[] {
    const registration = this.registrations.get(platformIdentityKey(identity))
    if (registration === undefined) return []
    return [...registration.declarations.values()]
      .filter(item => item.required && this.policy(identity, item.name) === 'deny')
      .map(item => item.name)
  }

  recordScopeDenial(identity: CordisXPluginIdentity, capability: CordisXPlatformCapability): void {
    this.denied(platformIdentityKey(identity), capability)
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
    this.listeners.clear()
  }

  private denied(identityKey: string, capability: CordisXPlatformCapability): void {
    const key = this.auditKey(identityKey, capability)
    const audit = this.audit.get(key) ?? { denialCount: 0 }
    audit.lastDeniedAt = isoNow(this.now)
    audit.denialCount += 1
    this.audit.set(key, audit)
    this.changed()
  }

  private persist(): void {
    this.store.write([...this.policies.values()])
  }

  private policyKey(identityKey: string, capability: CordisXPlatformCapability, fingerprint: string): string {
    return `${identityKey}\u0000${capability}\u0000${fingerprint}`
  }

  private auditKey(identityKey: string, capability: CordisXPlatformCapability): string {
    return `${identityKey}\u0000${capability}`
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }
}

export interface CordisXPlatformAdapter {
  status(): CordisXPlatformAdapterStatus
  listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<readonly CordisXModelDescriptor[]>>
  listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<readonly CordisXTaskSummary[]>>
  readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXTaskProjection>>
  createTask(input: Omit<CordisXTaskCreateInput, 'initialMessage'>): Promise<CordisXPlatformResult<CordisXTaskSummary>>
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
  readonly models?: readonly CordisXModelDescriptor[]
  readonly tasks?: readonly CordisXTaskSummary[]
  readonly taskContents?: readonly CordisXTaskProjection[]
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
    if (snapshot.tasks !== undefined) supported.push('tasks.catalog.read')
    if (snapshot.taskContents !== undefined) supported.push('tasks.content.read')
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

  async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<readonly CordisXModelDescriptor[]>> {
    const models = this.source.getSnapshot().models
    if (models === undefined) return failure('adapter-unavailable', 'The current model projection is unavailable')
    return { ok: true, value: copy(models.filter(item => input.providerId === undefined || item.providerId === input.providerId)) }
  }

  async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<readonly CordisXTaskSummary[]>> {
    const tasks = this.source.getSnapshot().tasks
    if (tasks === undefined) return failure('adapter-unavailable', 'The complete task catalog projection is unavailable')
    return { ok: true, value: copy(tasks.filter(item => {
      return (input.providerId === undefined || item.providerId === input.providerId)
        && (input.cwd === undefined || normalizedPath(item.cwd) === normalizedPath(input.cwd))
    })) }
  }

  async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXTaskProjection>> {
    const contents = this.source.getSnapshot().taskContents
    if (contents === undefined) return failure('adapter-unavailable', 'The complete task content projection is unavailable')
    const task = contents.find(item => item.id === input.taskId)
    return task === undefined ? failure('task-not-found', `Task ${input.taskId} was not found`) : { ok: true, value: copy(task) }
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

  private async ensureTaskScope(
    grant: AuthorizationGrant,
    taskId: string,
  ): Promise<CordisXPlatformResult<true>> {
    const scope = grant.declaration.scope
    if (scope.providers === undefined && scope.cwdRoots === undefined) return { ok: true, value: true }
    const task = await this.guarded(async () => await optionsFor(this).adapter.readTask({ taskId }))
    if (!task.ok) return task
    if (scopeAllows(scope, { taskId, providerId: task.value.providerId, cwd: task.value.cwd })) return { ok: true, value: true }
    const identity = pluginIdentity(this.ctx)
    if (identity !== undefined) optionsFor(this).broker.recordScopeDenial(identity, grant.declaration.name)
    return failure('permission-scope-denied', `Task ${taskId} is outside the declared ${grant.declaration.name} scope`)
  }

  private async listModels(input: CordisXModelsListInput): Promise<CordisXPlatformResult<readonly CordisXModelDescriptor[]>> {
    if (input.providerId !== undefined && !validText(input.providerId)) return failure('invalid-request', 'providerId must be a non-empty string')
    const grant = await this.authorize('models.read', {
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
    })
    if (!grant.ok) return grant
    const result = await this.guarded(async () => await optionsFor(this).adapter.listModels(input))
    if (!result.ok) return result
    return { ok: true, value: result.value.filter(item => scopeAllows(grant.value.declaration.scope, { providerId: item.providerId })) }
  }

  private async listTasks(input: CordisXTasksListInput): Promise<CordisXPlatformResult<readonly CordisXTaskSummary[]>> {
    if (input.providerId !== undefined && !validText(input.providerId)) return failure('invalid-request', 'providerId must be a non-empty string')
    if (input.cwd !== undefined && (!validText(input.cwd) || !absolutePath(input.cwd))) return failure('invalid-request', 'cwd must be an absolute path')
    const grant = await this.authorize('tasks.catalog.read', {
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    })
    if (!grant.ok) return grant
    const result = await this.guarded(async () => await optionsFor(this).adapter.listTasks(input))
    if (!result.ok) return result
    return { ok: true, value: result.value.filter(item => scopeAllows(grant.value.declaration.scope, {
      providerId: item.providerId,
      cwd: item.cwd,
      taskId: item.id,
    })) }
  }

  private async readTask(input: CordisXTaskReadInput): Promise<CordisXPlatformResult<CordisXTaskProjection>> {
    if (!validText(input.taskId)) return failure('invalid-request', 'taskId must be a non-empty string')
    const grant = await this.authorize('tasks.content.read', { taskId: input.taskId })
    if (!grant.ok) return grant
    const result = await this.guarded(async () => await optionsFor(this).adapter.readTask(input))
    if (!result.ok) return result
    return scopeAllows(grant.value.declaration.scope, { providerId: result.value.providerId, cwd: result.value.cwd, taskId: result.value.id })
      ? result
      : failure('permission-scope-denied', 'Task content is outside the declared scope')
  }

  private async createTask(input: CordisXTaskCreateInput): Promise<CordisXPlatformResult<CordisXTaskCreateOutcome>> {
    if (!validText(input.providerId) || !validText(input.modelId)) return failure('invalid-request', 'providerId and modelId must be non-empty strings')
    if (!validText(input.cwd) || !absolutePath(input.cwd)) return failure('invalid-request', 'cwd must be an absolute path')
    if (input.initialMessage !== undefined && !validText(input.initialMessage)) return failure('invalid-request', 'initialMessage must be a non-empty string')
    const grant = await this.authorize('tasks.create', { providerId: input.providerId, cwd: input.cwd })
    if (!grant.ok) return grant
    const models = await this.guarded(async () => await optionsFor(this).adapter.listModels({}))
    if (!models.ok) return models
    const providerModels = models.value.filter(model => model.providerId === input.providerId)
    if (providerModels.length === 0) return failure('invalid-provider', `Provider ${input.providerId} is not currently available`)
    if (!providerModels.some(model => model.id === input.modelId)) {
      return failure('invalid-model', `Model ${input.modelId} is not currently available from provider ${input.providerId}`)
    }
    const created = await this.guarded(async () => await optionsFor(this).adapter.createTask({
      providerId: input.providerId,
      modelId: input.modelId,
      cwd: input.cwd,
    }))
    if (!created.ok) return created
    if (input.initialMessage === undefined) return { ok: true, value: { status: 'created', task: created.value } }
    const turn = await this.guarded(async () => await optionsFor(this).adapter.submitTurn({ taskId: created.value.id, message: input.initialMessage as string }))
    if (turn.ok) return { ok: true, value: { status: 'created', task: created.value, initialTurn: turn.value } }
    return {
      ok: true,
      value: {
        status: 'created-initial-turn-failed',
        task: created.value,
        error: {
          code: 'initial-turn-failed',
          message: `Task ${created.value.id} was created, but its initial turn did not start: ${turn.error.message}`,
          ...(turn.error.retryable === undefined ? {} : { retryable: turn.error.retryable }),
        },
      },
    }
  }

  private async controlTask(input: CordisXTaskControlInput): Promise<CordisXPlatformResult<CordisXTaskControlOutcome>> {
    if (!validText(input.taskId) || !['continue', 'fork', 'archive', 'restore', 'delete'].includes(input.action)) {
      return failure('invalid-request', 'task control input is invalid')
    }
    const grant = await this.authorize('tasks.control', { taskId: input.taskId })
    if (!grant.ok) return grant
    const scope = await this.ensureTaskScope(grant.value, input.taskId)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTask(input))
  }

  private async submitTurn(input: CordisXTurnSubmitInput): Promise<CordisXPlatformResult<CordisXTurnStart>> {
    if (!validText(input.taskId) || !validText(input.message)) return failure('invalid-request', 'taskId and message must be non-empty strings')
    const grant = await this.authorize('turns.submit', { taskId: input.taskId })
    if (!grant.ok) return grant
    const scope = await this.ensureTaskScope(grant.value, input.taskId)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.submitTurn(input))
  }

  private async controlTurn(input: CordisXTurnControlInput): Promise<CordisXPlatformResult<CordisXTurnControlOutcome>> {
    if (!validText(input.taskId) || !['steer', 'interrupt'].includes(input.action)) return failure('invalid-request', 'turn control input is invalid')
    if (input.action === 'steer' && !validText(input.message)) return failure('invalid-request', 'steer message must be a non-empty string')
    const grant = await this.authorize('turns.control', { taskId: input.taskId })
    if (!grant.ok) return grant
    const scope = await this.ensureTaskScope(grant.value, input.taskId)
    if (!scope.ok) return scope
    return await this.guarded(async () => await optionsFor(this).adapter.controlTurn(input))
  }
}
