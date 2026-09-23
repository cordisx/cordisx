export type ProviderSyncAdapterId = 'codex' | 'claude-code' | 'gemini-cli' | 'opencode'
export type ProviderSyncIdKind = 'connection' | 'binding'

const ID = /^cx-(?:connection|binding)-[A-Za-z0-9_-]{16,96}$/u
const LOCAL_PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const PROFILE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u
const MODEL_ID = /^[^\0\r\n]{1,512}$/u

export interface ProviderSyncTargetProfileRef {
  readonly adapterId: ProviderSyncAdapterId
  readonly hostInstanceId: string
  readonly profileId: string
  readonly configRoot: string
}

export interface ProviderSyncConnectionDefinition {
  readonly connectionId: string
  readonly revision: string
  readonly title: string
  readonly endpoint: string
  readonly protocol: 'responses' | 'chat-completions'
  readonly credential: {
    readonly secretRef: string
    readonly revision: string
  }
  readonly models: {
    readonly ids: readonly string[]
    readonly completeness: 'unknown' | 'partial' | 'complete'
  }
  readonly enabled: boolean
}

export interface ProviderSyncBindingDefinition {
  readonly bindingId: string
  readonly connectionId: string
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly localProviderId: string
  readonly enabled: boolean
  readonly credentialDelivery: 'process-env'
  readonly overlay?: {
    readonly title?: string
    readonly iconRef?: string
  }
}

export interface ProviderSyncNativeConnection {
  readonly sourceKind: 'native'
  readonly sourceRef: string
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly nativeLocalId: string
  readonly title: string
  readonly endpoint?: string
  readonly protocol?: 'responses' | 'chat-completions'
  readonly credential: {
    readonly kind: 'environment' | 'inline-private' | 'native' | 'unknown'
    readonly reference?: string
  }
  readonly activeModelId?: string
}

export interface ProviderSyncAdapterCapabilities {
  readonly adapterId: ProviderSyncAdapterId
  readonly status: 'supported' | 'partial' | 'unsupported'
  readonly discovery: boolean
  readonly managedSync: boolean
  readonly import: boolean
  readonly adoption: boolean
  readonly detach: boolean
  readonly nativeDisable: boolean
  readonly resolvedRead: boolean
  readonly runtimeRead: boolean
  readonly reason?: string
}

export type ProviderSyncDiagnosticCode =
  | 'binding-disabled'
  | 'binding-detached'
  | 'connection-unavailable'
  | 'concurrent-edit'
  | 'config-invalid'
  | 'id-conflict'
  | 'recovery-required'
  | 'route-conflict'
  | 'unsupported-adapter'
  | 'unsupported-config-shape'

export interface ProviderSyncDiagnostic {
  readonly code: ProviderSyncDiagnosticCode
  readonly severity: 'info' | 'warning' | 'error'
  readonly bindingId?: string
  readonly localProviderId?: string
  readonly fieldGroup?: 'display' | 'routing'
  readonly fingerprint?: string
  /** False retains the state marker without re-notifying an unchanged warning. */
  readonly notify?: boolean
}

export interface ProviderSyncProviderProjection {
  readonly localProviderId: string
  readonly owner: 'native' | 'cordisx'
  readonly bindingId?: string
  readonly connectionId?: string
  readonly title: string
  readonly endpoint?: string
  readonly protocol?: 'responses' | 'chat-completions'
  readonly credential: {
    readonly kind: 'environment' | 'inline-private' | 'native' | 'unknown'
    readonly referenceAvailable: boolean
  }
  readonly models: {
    readonly ids: readonly string[]
    readonly completeness: 'unknown' | 'partial' | 'complete'
    readonly evidence: 'active-model' | 'binding-ledger' | 'none'
  }
  readonly sync: {
    readonly applied: boolean
    readonly skippedGroups: readonly ('display' | 'routing')[]
  }
  readonly overlay?: ProviderSyncBindingDefinition['overlay']
}

export interface ProviderSyncProfileProjection {
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly context: {
    readonly adapterVersion: string
    readonly parserRef: string
  }
  readonly persisted: {
    readonly status: 'ok' | 'missing' | 'invalid'
    readonly revision?: string
  }
  readonly resolved: {
    readonly status: 'unsupported'
  }
  readonly runtime: {
    readonly status: 'not-running' | 'unverified'
  }
  readonly sync: {
    readonly status: 'not-managed' | 'in-sync' | 'pending' | 'warning' | 'failed' | 'recovery-required'
  }
  readonly providers: readonly ProviderSyncProviderProjection[]
  readonly diagnostics: readonly ProviderSyncDiagnostic[]
}

export interface ProviderSyncResult {
  readonly targetProfileRef: ProviderSyncTargetProfileRef
  readonly targetChanged: boolean
  readonly ledgerChanged: boolean
  readonly appliedBindingIds: readonly string[]
  readonly diagnostics: readonly ProviderSyncDiagnostic[]
  readonly projection: ProviderSyncProfileProjection
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' || value.trim().length === 0 || value.length > maximum
    || /[\0\r\n]/u.test(value)
  ) throw new Error(`${label} is invalid`)
  return value
}

export function assertProviderSyncId(value: unknown, kind?: ProviderSyncIdKind): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value) || (kind !== undefined && !value.startsWith(`cx-${kind}-`))) {
    throw new Error(`${kind ?? 'provider sync'} id is invalid`)
  }
}

export function parseProviderSyncTargetProfileRef(value: ProviderSyncTargetProfileRef): ProviderSyncTargetProfileRef {
  if (!['codex', 'claude-code', 'gemini-cli', 'opencode'].includes(value.adapterId)) {
    throw new Error('target adapter is invalid')
  }
  if (!PROFILE_COMPONENT.test(value.hostInstanceId) || !PROFILE_COMPONENT.test(value.profileId)) {
    throw new Error('target profile identity is invalid')
  }
  if (typeof value.configRoot !== 'string' || value.configRoot.length === 0) {
    throw new Error('target config root is invalid')
  }
  return Object.freeze({ ...value })
}

export function targetProfileRefKey(value: ProviderSyncTargetProfileRef): string {
  const target = parseProviderSyncTargetProfileRef(value)
  return JSON.stringify([target.adapterId, target.hostInstanceId, target.profileId, target.configRoot])
}

export function parseProviderSyncConnection(
  value: ProviderSyncConnectionDefinition,
): ProviderSyncConnectionDefinition {
  assertProviderSyncId(value.connectionId, 'connection')
  boundedText(value.revision, 'connection revision', 128)
  boundedText(value.title, 'connection title', 256)
  let endpoint: URL
  try {
    endpoint = new URL(value.endpoint)
  } catch {
    throw new Error('connection endpoint is invalid')
  }
  if (
    !['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash
  ) throw new Error('connection endpoint is invalid')
  if (!['responses', 'chat-completions'].includes(value.protocol)) throw new Error('connection protocol is invalid')
  boundedText(value.credential.secretRef, 'credential reference', 512)
  boundedText(value.credential.revision, 'credential revision', 128)
  if (!['unknown', 'partial', 'complete'].includes(value.models.completeness)) {
    throw new Error('model completeness is invalid')
  }
  if (
    value.models.ids.length > 2048 || new Set(value.models.ids).size !== value.models.ids.length
    || value.models.ids.some(id => !MODEL_ID.test(id))
  ) throw new Error('connection models are invalid')
  if (typeof value.enabled !== 'boolean') throw new Error('connection enabled is invalid')
  return Object.freeze({
    ...value,
    credential: Object.freeze({ ...value.credential }),
    models: Object.freeze({ ...value.models, ids: Object.freeze([...value.models.ids]) }),
  })
}

export function parseProviderSyncBinding(value: ProviderSyncBindingDefinition): ProviderSyncBindingDefinition {
  assertProviderSyncId(value.bindingId, 'binding')
  assertProviderSyncId(value.connectionId, 'connection')
  if (!LOCAL_PROVIDER_ID.test(value.localProviderId) || value.localProviderId === 'openai') {
    throw new Error('binding local provider id is invalid')
  }
  if (value.credentialDelivery !== 'process-env') throw new Error('credential delivery is unsupported')
  if (typeof value.enabled !== 'boolean') throw new Error('binding enabled is invalid')
  if (value.overlay?.title !== undefined) boundedText(value.overlay.title, 'binding title overlay', 256)
  if (value.overlay?.iconRef !== undefined) boundedText(value.overlay.iconRef, 'binding icon overlay', 256)
  return Object.freeze({
    ...value,
    targetProfileRef: parseProviderSyncTargetProfileRef(value.targetProfileRef),
    ...(value.overlay === undefined ? {} : { overlay: Object.freeze({ ...value.overlay }) }),
  })
}

export function providerSyncAdapterCapabilities(adapterId: ProviderSyncAdapterId): ProviderSyncAdapterCapabilities {
  if (adapterId === 'codex') {
    return Object.freeze({
      adapterId,
      status: 'supported',
      discovery: true,
      managedSync: true,
      import: true,
      adoption: true,
      detach: true,
      nativeDisable: false,
      resolvedRead: false,
      runtimeRead: false,
      reason:
        'Direct Codex profile persistence is supported; layered resolution and runtime activation are unverified.',
    })
  }
  return Object.freeze({
    adapterId,
    status: 'unsupported',
    discovery: false,
    managedSync: false,
    import: false,
    adoption: false,
    detach: false,
    nativeDisable: false,
    resolvedRead: false,
    runtimeRead: false,
    reason: 'No production target configuration adapter is implemented.',
  })
}
