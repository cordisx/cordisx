import {
  BUILTIN_REICON_IDENTITY,
  ICON_STATES,
  ICON_THEME_CATALOG_DIGEST,
  ICON_VARIANTS,
  SEMANTIC_ICON_KEYS,
  isIconState,
  isIconVariant,
  isNormalizedVectorDescriptor,
  isSemanticIconKey,
  type CordisXIconThemeProviderDefinitionV1,
  type IconState,
  type IconThemeCoverage,
  type IconThemeLifecycleResult,
  type IconThemeProviderIdentity,
  type IconThemeProviderReference,
  type IconThemeProviderRegistration,
  type IconThemeResolutionRequest,
  type IconThemeResolutionResult,
  type IconThemeSelection,
  type IconVariant,
  type NormalizedVectorDescriptor,
  type SemanticIconKey,
} from '../icon-theme-contracts.js'
import { resolveBuiltinReiconDescriptor } from './reicon-icon-backend.js'

const REGISTRATION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-provider-registration.v1.schema.json' as const
const SELECTION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-selection.v1.schema.json' as const
const REQUEST_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-request.v1.schema.json' as const
const RESULT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-result.v1.schema.json' as const
const LIFECYCLE_RESULT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-lifecycle-result.v1.schema.json' as const
const BUILTIN_GENERATION = 'reicon-1.2.1' as const
const namespacePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/u
const generationPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const principalPattern = /^ipp_[A-Za-z0-9_-]{16,124}$/u
const semverPattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

export interface IconThemePluginPrincipal {
  readonly principalHandle: `ipp_${string}`
  readonly pluginId: string
  readonly providerGeneration: string
}

interface ProviderRecord {
  readonly providerHandle: `iph_${string}`
  readonly principal: IconThemeProviderRegistration['principal']
  readonly identity: IconThemeProviderIdentity
  readonly providerGeneration: string
  readonly coverage: IconThemeCoverage
  readonly descriptors: ReadonlyMap<string, NormalizedVectorDescriptor>
  status: IconThemeProviderRegistration['status']
  revision: number
  failureCode?: IconThemeProviderRegistration['failureCode']
  lastGoodGeneration?: string
}

export interface IconThemeResolution {
  readonly descriptor: NormalizedVectorDescriptor
  readonly provider: IconThemeProviderReference | { readonly providerId: 'host:neutral' }
  readonly fallback: 'none' | 'reicon' | 'neutral'
  readonly request: IconThemeResolutionRequest
}

export interface RedactedIconThemeSnapshot {
  readonly profileId: string
  readonly profileRevision: number
  readonly selected: Readonly<Pick<IconThemeProviderReference, 'providerId' | 'namespace' | 'protocolVersion' | 'providerVersion' | 'providerGeneration'>>
  readonly providers: readonly {
    readonly providerId: string
    readonly namespace: string
    readonly providerVersion: string
    readonly providerGeneration: string
    readonly status: IconThemeProviderRegistration['status']
    readonly coverage: 'complete' | 'partial'
    readonly tupleCount: number
  }[]
}

export type RedactedIconThemeProvider = RedactedIconThemeSnapshot['providers'][number]

function tupleKey(key: SemanticIconKey, variant: IconVariant, state: IconState): string {
  return `${key}\0${variant}\0${state}`
}

function clone<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}

function cloneDescriptor(descriptor: NormalizedVectorDescriptor): NormalizedVectorDescriptor {
  return clone(descriptor)
}

function providerHandleNonce(): string {
  const value = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID().replaceAll('-', '')
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return value.slice(0, 24).padEnd(24, '0')
}

function reference(record: ProviderRecord): IconThemeProviderReference {
  return {
    providerHandle: record.providerHandle,
    ...record.identity,
    providerGeneration: record.providerGeneration,
  }
}

/** Host authority for static, descriptor-only icon-theme transports. */
export class IconThemeRegistry {
  private readonly records = new Map<`iph_${string}`, ProviderRecord>()
  private readonly namespaces = new Map<string, `iph_${string}`>()
  private nextHandle = 1
  private readonly handleNonce = providerHandleNonce()
  readonly builtinProviderHandle: `iph_${string}`
  readonly builtinProviderGeneration = BUILTIN_GENERATION
  private nextRequest = 1
  private profileRevision = 0
  private selectedHandle: `iph_${string}`
  private selectionOutcome: IconThemeSelection['outcome'] = 'default'
  private selectionReason: IconThemeSelection['reason'] = 'host-default'
  private requestedProviderHandle: `iph_${string}` | undefined
  private forceNeutralFallback = false
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(readonly hostGeneration: string, readonly profileId: string) {
    if (!generationPattern.test(hostGeneration) || profileId.length < 1 || profileId.length > 128) throw new Error('invalid icon-theme Host scope')
    this.builtinProviderHandle = `iph_${this.handleNonce}_00000000`
    this.selectedHandle = this.builtinProviderHandle
    for (const key of SEMANTIC_ICON_KEYS) for (const variant of ICON_VARIANTS) for (const state of ICON_STATES) {
      if (!isNormalizedVectorDescriptor(resolveBuiltinReiconDescriptor(key, variant, state))) throw new Error('built-in Reicon conformance failed')
    }
    const coverage: IconThemeCoverage = {
      kind: 'complete',
      proof: {
        kind: 'host-conformance', proofId: 'reiconproof00000001', catalogVersion: 1,
        catalogDigest: ICON_THEME_CATALOG_DIGEST, providerId: BUILTIN_REICON_IDENTITY.providerId,
        namespace: BUILTIN_REICON_IDENTITY.namespace, providerVersion: BUILTIN_REICON_IDENTITY.providerVersion,
        providerGeneration: BUILTIN_GENERATION, protocolVersion: 1, descriptorFormatVersion: 1,
        keyCount: 51, variantCount: 3, stateCount: 8, tupleCount: 1224, outcome: 'passed', rawDataExported: false,
      },
    }
    const builtin: ProviderRecord = {
      providerHandle: this.builtinProviderHandle,
      principal: { kind: 'host' },
      identity: BUILTIN_REICON_IDENTITY,
      providerGeneration: BUILTIN_GENERATION,
      coverage,
      descriptors: new Map(),
      status: 'active',
      revision: 0,
      lastGoodGeneration: BUILTIN_GENERATION,
    }
    this.records.set(this.builtinProviderHandle, builtin)
    this.namespaces.set('reicon', this.builtinProviderHandle)
  }

  subscribe(listener: () => void): () => void {
    this.assertLive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Host chrome can bypass provider routing while retaining fallback truth. */
  hostBuiltinFallback(): 'none' | 'reicon' | 'neutral' {
    this.assertLive()
    if (this.forceNeutralFallback) return 'neutral'
    return this.selectedHandle === this.builtinProviderHandle ? 'none' : 'reicon'
  }

  private notify(): void { for (const listener of this.listeners) listener() }

  private assertLive(): void { if (this.disposed) throw new Error('icon-theme registry is disposed') }

  private active(): ProviderRecord { return this.records.get(this.selectedHandle)! }

  private result(
    requestId: string,
    operation: IconThemeLifecycleResult['operation'],
    outcome: IconThemeLifecycleResult['outcome'],
    extra: Pick<IconThemeLifecycleResult, 'affectedProviderHandle' | 'disposedGeneration' | 'error'> = {},
  ): IconThemeLifecycleResult {
    return {
      $schema: LIFECYCLE_RESULT_SCHEMA, schemaVersion: 1, authority: 'host', requestId,
      profileId: this.profileId, operation, outcome, profileRevision: this.profileRevision,
      hostGeneration: this.hostGeneration, activeProvider: reference(this.active()), ...extra,
    }
  }

  private fence(
    requestId: string,
    operation: IconThemeLifecycleResult['operation'],
    expectedProfileRevision: number,
    hostGeneration: string,
  ): IconThemeLifecycleResult | undefined {
    if (hostGeneration !== this.hostGeneration) return this.result(requestId, operation, 'conflict', { error: { code: 'stale-host-generation' } })
    if (expectedProfileRevision !== this.profileRevision) return this.result(requestId, operation, 'conflict', { error: { code: 'stale-revision' } })
    return undefined
  }

  registerPlugin(
    requestId: string,
    expectedProfileRevision: number,
    hostGeneration: string,
    principal: IconThemePluginPrincipal,
    definition: CordisXIconThemeProviderDefinitionV1,
  ): { readonly result: IconThemeLifecycleResult; readonly registration?: IconThemeProviderRegistration } {
    this.assertLive()
    const conflict = this.fence(requestId, 'register', expectedProfileRevision, hostGeneration)
    if (conflict !== undefined) return { result: conflict }
    if (!pluginIdPattern.test(principal.pluginId) || !principalPattern.test(principal.principalHandle)
      || !generationPattern.test(principal.providerGeneration) || definition === null || typeof definition !== 'object'
      || Object.keys(definition).sort().join(',') !== 'descriptors,namespace,providerVersion,schemaVersion'
      || definition.schemaVersion !== 1 || !namespacePattern.test(definition.namespace)
      || !semverPattern.test(definition.providerVersion) || !Array.isArray(definition.descriptors)
      || definition.descriptors.length < 1 || definition.descriptors.length > 1223) {
      return { result: this.result(requestId, 'register', 'rejected', { error: { code: 'identity-mismatch' } }) }
    }
    if (this.namespaces.has(definition.namespace)) return { result: this.result(requestId, 'register', 'rejected', { error: { code: 'namespace-conflict' } }) }
    const descriptors = new Map<string, NormalizedVectorDescriptor>()
    try {
      for (const entry of definition.descriptors) {
        if (entry === null || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'descriptor,key,state,variant'
          || !isSemanticIconKey(entry.key) || !isIconVariant(entry.variant) || !isIconState(entry.state)
          || !isNormalizedVectorDescriptor(entry.descriptor)) throw new Error('invalid descriptor entry')
        const key = tupleKey(entry.key, entry.variant, entry.state)
        if (descriptors.has(key)) throw new Error('duplicate descriptor tuple')
        descriptors.set(key, cloneDescriptor(entry.descriptor))
      }
    } catch {
      return { result: this.result(requestId, 'register', 'rejected', { error: { code: 'invalid-descriptor' } }) }
    }
    const providerHandle = `iph_${this.handleNonce}_${String(this.nextHandle++).padStart(8, '0')}` as const
    const identity = Object.freeze({
      providerId: `plugin:${principal.pluginId}:${definition.namespace}`,
      namespace: definition.namespace,
      protocolVersion: 1,
      providerVersion: definition.providerVersion,
    } as const satisfies IconThemeProviderIdentity)
    const coverage: IconThemeCoverage = {
      kind: 'partial',
      entries: definition.descriptors.map(({ key, variant, state }) => ({ key, variant, state })),
    }
    this.profileRevision += 1
    const record: ProviderRecord = {
      providerHandle,
      principal: { kind: 'plugin', principalHandle: principal.principalHandle, pluginId: principal.pluginId },
      identity,
      providerGeneration: principal.providerGeneration,
      coverage,
      descriptors,
      status: 'ready',
      revision: this.profileRevision,
    }
    this.records.set(providerHandle, record)
    this.namespaces.set(identity.namespace, providerHandle)
    this.notify()
    return {
      result: this.result(requestId, 'register', 'staged', { affectedProviderHandle: providerHandle }),
      registration: this.registration(providerHandle)!,
    }
  }

  select(requestId: string, expectedProfileRevision: number, hostGeneration: string, providerHandle: `iph_${string}`, providerGeneration: string): IconThemeLifecycleResult {
    this.assertLive()
    const conflict = this.fence(requestId, 'select', expectedProfileRevision, hostGeneration)
    if (conflict !== undefined) return conflict
    const record = this.records.get(providerHandle)
    if (record === undefined) return this.result(requestId, 'select', 'rejected', { error: { code: 'unknown-provider' } })
    if (record.providerGeneration !== providerGeneration) return this.result(requestId, 'select', 'rejected', { affectedProviderHandle: providerHandle, error: { code: 'stale-provider-generation' } })
    if (record.status !== 'ready' && record.status !== 'active') return this.result(requestId, 'select', 'rejected', { affectedProviderHandle: providerHandle, error: { code: 'prepare-failed' } })
    const previous = this.active()
    if (previous.providerHandle !== this.builtinProviderHandle && previous.providerHandle !== providerHandle) previous.status = 'ready'
    record.status = 'active'
    record.lastGoodGeneration = record.providerGeneration
    this.selectedHandle = providerHandle
    this.requestedProviderHandle = providerHandle
    this.selectionOutcome = providerHandle === this.builtinProviderHandle ? 'default' : 'selected'
    this.selectionReason = providerHandle === this.builtinProviderHandle ? 'host-default' : 'user-selection'
    this.forceNeutralFallback = false
    this.profileRevision += 1
    record.revision = this.profileRevision
    this.notify()
    return this.result(requestId, 'select', 'applied', { affectedProviderHandle: providerHandle })
  }

  /** Host Manager selects one exact redacted identity; opaque handles stay private. */
  selectProvider(
    requestId: string,
    expectedProfileRevision: number,
    hostGeneration: string,
    candidate: Pick<RedactedIconThemeProvider, 'providerId' | 'namespace' | 'providerVersion' | 'providerGeneration'>,
  ): IconThemeLifecycleResult {
    this.assertLive()
    const conflict = this.fence(requestId, 'select', expectedProfileRevision, hostGeneration)
    if (conflict !== undefined) return conflict
    const record = [...this.records.values()].find(item => item.identity.providerId === candidate.providerId
      && item.identity.namespace === candidate.namespace && item.identity.providerVersion === candidate.providerVersion
      && item.providerGeneration === candidate.providerGeneration)
    if (record === undefined) return this.result(requestId, 'select', 'rejected', { error: { code: 'unknown-provider' } })
    return this.select(requestId, expectedProfileRevision, hostGeneration, record.providerHandle, candidate.providerGeneration)
  }

  disposeProvider(requestId: string, expectedProfileRevision: number, hostGeneration: string, providerHandle: `iph_${string}`, providerGeneration: string): IconThemeLifecycleResult {
    this.assertLive()
    const conflict = this.fence(requestId, 'dispose', expectedProfileRevision, hostGeneration)
    if (conflict !== undefined) return conflict
    const record = this.records.get(providerHandle)
    if (record === undefined) return this.result(requestId, 'dispose', 'rejected', { error: { code: 'unknown-provider' } })
    if (record.providerGeneration !== providerGeneration) return this.result(requestId, 'dispose', 'rejected', { affectedProviderHandle: providerHandle, error: { code: 'stale-provider-generation' } })
    if (this.selectedHandle === providerHandle) return this.result(requestId, 'dispose', 'rejected', { affectedProviderHandle: providerHandle, error: { code: 'provider-selected' } })
    if (record.status === 'disposed') return this.result(requestId, 'dispose', 'applied', { affectedProviderHandle: providerHandle, disposedGeneration: providerGeneration })
    record.status = 'disposed'
    record.failureCode = 'disposed'
    this.namespaces.delete(record.identity.namespace)
    this.profileRevision += 1
    record.revision = this.profileRevision
    this.notify()
    return this.result(requestId, 'dispose', 'applied', { affectedProviderHandle: providerHandle, disposedGeneration: providerGeneration })
  }

  rollback(
    requestId: string,
    expectedProfileRevision: number,
    hostGeneration: string,
    failedProviderHandle: `iph_${string}`,
    failedGeneration: string,
    restoreProviderHandle: `iph_${string}`,
    restoreGeneration: string,
    reason: 'prepare-failed' | 'resolution-failed' | 'invalid-descriptor' | 'provider-unavailable' = 'resolution-failed',
  ): IconThemeLifecycleResult {
    this.assertLive()
    const conflict = this.fence(requestId, 'rollback', expectedProfileRevision, hostGeneration)
    if (conflict !== undefined) return conflict
    const failed = this.records.get(failedProviderHandle)
    const restore = this.records.get(restoreProviderHandle)
    if (failed === undefined || failed.providerGeneration !== failedGeneration || this.selectedHandle !== failedProviderHandle
      || restore === undefined || restore.providerHandle !== this.builtinProviderHandle || restore.providerGeneration !== restoreGeneration || restore.status === 'disposed') {
      if (failed !== undefined && failed.providerGeneration === failedGeneration && this.selectedHandle === failedProviderHandle) failed.status = 'failed'
      this.forceNeutralFallback = true
      this.notify()
      return this.result(requestId, 'rollback', 'rollback-failed', { affectedProviderHandle: failedProviderHandle, error: { code: 'rollback-failed' } })
    }
    failed.status = 'failed'
    failed.failureCode = reason === 'provider-unavailable' ? 'resolution-failed' : reason
    restore.status = 'active'
    this.selectedHandle = this.builtinProviderHandle
    this.requestedProviderHandle = failedProviderHandle
    this.selectionOutcome = 'rolled-back'
    this.selectionReason = reason
    this.forceNeutralFallback = false
    this.profileRevision += 1
    failed.revision = this.profileRevision
    restore.revision = this.profileRevision
    this.notify()
    return this.result(requestId, 'rollback', 'rolled-back', { affectedProviderHandle: failedProviderHandle })
  }

  createResolutionRequest(key: SemanticIconKey, variant: IconVariant, state: IconState): IconThemeResolutionRequest {
    this.assertLive()
    const selected = this.active()
    return {
      $schema: REQUEST_SCHEMA, schemaVersion: 1, requestId: `iconrequest_${String(this.nextRequest++).padStart(16, '0')}`,
      hostGeneration: this.hostGeneration, providerHandle: selected.providerHandle,
      providerGeneration: selected.providerGeneration, key, variant, state,
    }
  }

  acceptResolution(request: IconThemeResolutionRequest, result: IconThemeResolutionResult): IconThemeResolution {
    this.assertLive()
    const record = this.records.get(request.providerHandle)
    const correlated = request.$schema === REQUEST_SCHEMA && request.schemaVersion === 1
      && request.hostGeneration === this.hostGeneration && isSemanticIconKey(request.key)
      && isIconVariant(request.variant) && isIconState(request.state)
      && result.$schema === RESULT_SCHEMA && result.schemaVersion === 1
      && result.requestId === request.requestId && result.providerGeneration === request.providerGeneration
      && record !== undefined && record.providerGeneration === request.providerGeneration
      && record.status !== 'disposed' && record.status !== 'failed' && this.selectedHandle === request.providerHandle
    if (correlated && result.outcome === 'resolved' && isNormalizedVectorDescriptor(result.descriptor)
      && record.descriptors.has(tupleKey(request.key, request.variant, request.state))) {
      return { descriptor: cloneDescriptor(result.descriptor), provider: reference(record), fallback: 'none', request }
    }
    return this.reiconFallback(request)
  }

  resolve(key: SemanticIconKey, variant: IconVariant, state: IconState): IconThemeResolution {
    const request = this.createResolutionRequest(key, variant, state)
    const record = this.active()
    if (record.providerHandle !== this.builtinProviderHandle) {
      const descriptor = record.descriptors.get(tupleKey(key, variant, state))
      if (descriptor !== undefined) {
        return this.acceptResolution(request, {
          $schema: RESULT_SCHEMA, schemaVersion: 1, requestId: request.requestId,
          providerGeneration: record.providerGeneration, outcome: 'resolved', descriptor,
        })
      }
    }
    return this.reiconFallback(request, record.providerHandle === this.builtinProviderHandle ? 'none' : 'reicon')
  }

  private reiconFallback(request: IconThemeResolutionRequest, fallback: 'none' | 'reicon' = 'reicon'): IconThemeResolution {
    if (this.forceNeutralFallback) {
      return {
        descriptor: resolveBuiltinReiconDescriptor('control.minus', 'regular', 'default'),
        provider: { providerId: 'host:neutral' }, fallback: 'neutral', request,
      }
    }
    const builtin = this.records.get(this.builtinProviderHandle)
    if (builtin !== undefined && builtin.status !== 'disposed' && builtin.status !== 'failed') {
      return { descriptor: resolveBuiltinReiconDescriptor(request.key, request.variant, request.state), provider: reference(builtin), fallback, request }
    }
    return {
      descriptor: resolveBuiltinReiconDescriptor('control.minus', 'regular', 'default'),
      provider: { providerId: 'host:neutral' }, fallback: 'neutral', request,
    }
  }

  registration(providerHandle: `iph_${string}`): IconThemeProviderRegistration | undefined {
    const record = this.records.get(providerHandle)
    if (record === undefined) return undefined
    return {
      $schema: REGISTRATION_SCHEMA, schemaVersion: 1, authority: 'host', hostGeneration: this.hostGeneration,
      revision: record.revision, providerHandle: record.providerHandle, principal: clone(record.principal),
      identity: { ...record.identity }, providerGeneration: record.providerGeneration, status: record.status,
      coverage: clone(record.coverage),
      ...(record.lastGoodGeneration === undefined ? {} : { lastGoodGeneration: record.lastGoodGeneration }),
      ...(record.failureCode === undefined ? {} : { failureCode: record.failureCode }),
    }
  }

  selection(): IconThemeSelection {
    const builtin = this.records.get(this.builtinProviderHandle)!
    const selected = this.active()
    const pin = <T extends ProviderRecord>(record: T) => ({ ...reference(record), profileRevision: this.profileRevision })
    const builtinPin = {
      providerHandle: builtin.providerHandle,
      providerId: 'builtin:reicon' as const,
      namespace: 'reicon' as const,
      protocolVersion: 1 as const,
      providerVersion: builtin.identity.providerVersion,
      providerGeneration: builtin.providerGeneration,
      profileRevision: this.profileRevision,
    }
    return {
      $schema: SELECTION_SCHEMA, schemaVersion: 1, authority: 'host', profileId: this.profileId,
      profileRevision: this.profileRevision, hostGeneration: this.hostGeneration,
      ...(this.requestedProviderHandle === undefined ? {} : { requestedProviderHandle: this.requestedProviderHandle }),
      defaultProvider: builtinPin, selectedProvider: pin(selected), fallbackProvider: { ...builtinPin },
      outcome: this.selectionOutcome, reason: this.selectionReason,
    }
  }

  redactedSnapshot(): RedactedIconThemeSnapshot {
    const selected = reference(this.active())
    return {
      profileId: this.profileId,
      profileRevision: this.profileRevision,
      selected: {
        providerId: selected.providerId, namespace: selected.namespace, protocolVersion: selected.protocolVersion,
        providerVersion: selected.providerVersion, providerGeneration: selected.providerGeneration,
      },
      providers: [...this.records.values()].map(record => ({
        providerId: record.identity.providerId, namespace: record.identity.namespace,
        providerVersion: record.identity.providerVersion, providerGeneration: record.providerGeneration,
        status: record.status, coverage: record.coverage.kind,
        tupleCount: record.coverage.kind === 'complete' ? record.coverage.proof.tupleCount : record.coverage.entries.length,
      })),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.records.clear()
    this.namespaces.clear()
    this.listeners.clear()
  }
}

export const BUILTIN_REICON_PROVIDER_GENERATION = BUILTIN_GENERATION
