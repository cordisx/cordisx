import {
  CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_EVENT_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_RESULT_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_SNAPSHOT_SCHEMA_V1,
  type CordisXExtensionPointControlAccessV1,
  type CordisXExtensionPointControlAuthorizationV1,
  type CordisXExtensionPointControlBindingsProjectionV1,
  type CordisXExtensionPointControlCandidateSnapshotV1,
  type CordisXExtensionPointControlClaimOptions,
  type CordisXExtensionPointControlClaimReferenceV1,
  type CordisXExtensionPointControlDeclarationV1,
  type CordisXExtensionPointControlEventV1,
  type CordisXExtensionPointControlIdentityV1,
  type CordisXExtensionPointControlMode,
  type CordisXExtensionPointControlLease,
  type CordisXExtensionPointControlLeaseSnapshot,
  type CordisXExtensionPointControlPointSnapshotV1,
  type CordisXExtensionPointControlResultV1,
  type CordisXExtensionPointControlSafeValueSchemaV1,
  type CordisXExtensionPointControlSnapshotV1,
  type CordisXHostExtensionPointControlCatalogV1,
  type CordisXHostExtensionPointControlPointV1,
  type CordisXJsonScalar,
} from '../contracts.js'
import { assertLocalId, immutableSnapshot } from './validation.js'
import type { PluginGenerationView } from './generation-visibility.js'

export interface ControlledSurfaceGeneration {
  readonly principalHandle: string
  readonly principalOrigin: CordisXExtensionPointControlDeclarationV1['origin']
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration?: string
  readonly transactionId?: string
  readonly transactionEpoch?: string
  /** Host-private authenticated transaction view. Never projected into Protocol snapshots. */
  readonly visibilityView?: PluginGenerationView
}

export interface ControlledSurfacePointBinding {
  readonly currentState: () => Readonly<{
    state: 'active' | 'inactive' | 'not-mounted' | 'pending'
    reason: string
  }>
  readonly readProperty: (id: string) => CordisXJsonScalar
  readonly commandAvailability?: (id: string) => Readonly<{ available: boolean; reason?: string }>
  readonly eventAvailability?: (id: string) => Readonly<{ available: boolean; reason?: string }>
  /** Host-only operation. Its result is intentionally discarded by the v1 protocol. */
  readonly dispatch: (id: string, arguments_: Readonly<Record<string, CordisXJsonScalar>>) => void | Promise<void>
}

export interface ControlledSurfaceRegistration {
  readonly declaration: CordisXExtensionPointControlDeclarationV1
  readonly generation: ControlledSurfaceGeneration
  readonly presenter: unknown
  /** Host-private point access gate. It must not be supplied by plugin input. */
  readonly hostAccess?: () => Readonly<{ authorized: boolean; reason?: string }>
}

export interface ControlledSurfaceRegistrationHandle {
  (): void
  dispose: () => void
  updatePresenter: (presenter: unknown) => void
}

export interface ControlledSurfaceGroupChoice {
  readonly pointId: string
  readonly groupId: string
  readonly outcome: 'native' | 'selected'
  readonly selectedClaim?: CordisXExtensionPointControlClaimReferenceV1
}

interface ControlledSurfacePersistedState {
  readonly schemaVersion: 1
  readonly principals: readonly Readonly<{ handle: string; source: string; pluginId: string; origin: CordisXExtensionPointControlDeclarationV1['origin'] }>[]
  readonly authorizations: readonly CordisXExtensionPointControlAuthorizationV1[]
  readonly choices: readonly ControlledSurfaceGroupChoice[]
}

export interface ControlledSurfacePolicyStore {
  read(): unknown
  write(state: ControlledSurfacePersistedState): void
}

export class MemoryControlledSurfacePolicyStore implements ControlledSurfacePolicyStore {
  value: unknown
  constructor(value: unknown = { schemaVersion: 1, principals: [], authorizations: [], choices: [] }) { this.value = structuredClone(value) }
  read(): unknown { return structuredClone(this.value) }
  write(state: ControlledSurfacePersistedState): void { this.value = structuredClone(state) }
}

/** Host-profile scoped persistence; Chromium profile isolation is an additional boundary. */
export class BrowserControlledSurfacePolicyStore implements ControlledSurfacePolicyStore {
  private readonly key: string
  constructor(profileId: string) { this.key = `cordisx.extension-point-control.v1:${profileId}` }
  read(): unknown {
    try { const value = localStorage.getItem(this.key); return value === null ? undefined : JSON.parse(value) } catch { return undefined }
  }
  write(state: ControlledSurfacePersistedState): void {
    try { localStorage.setItem(this.key, JSON.stringify(state)) } catch { /* Live Host policy remains authoritative. */ }
  }
}

export interface ControlledSurfaceManagerSnapshot {
  readonly revision: number
  /** CAS revision for durable authorization and selection writes; independent from runtime snapshot invalidations. */
  readonly policyRevision: number
  readonly hostGeneration: string
  readonly diagnostics: readonly { readonly contributionId: string; readonly message: string }[]
  readonly points: readonly {
    readonly id: string
    readonly state: CordisXExtensionPointControlPointSnapshotV1['state']
    readonly reason: string
    readonly selected: readonly CordisXExtensionPointControlClaimReferenceV1[]
    readonly eligibleCandidates: readonly CordisXExtensionPointControlClaimReferenceV1[]
    readonly deniedCandidates: readonly CordisXExtensionPointControlClaimReferenceV1[]
    readonly groupDecisions: CordisXExtensionPointControlPointSnapshotV1['groupDecisions']
    readonly groups: readonly {
      readonly id: string
      readonly selection: 'user' | 'host-priority'
      readonly nativeFallback: boolean
      readonly modes: readonly CordisXExtensionPointControlMode[]
      /** Current resolved outcome for this exact policy snapshot. */
      readonly decision?: CordisXExtensionPointControlPointSnapshotV1['groupDecisions'][number]
    }[]
    readonly suppression?: CordisXExtensionPointControlPointSnapshotV1['suppression']
    readonly candidates: readonly {
      readonly principalHandle: string
      readonly identity: CordisXExtensionPointControlIdentityV1
      readonly claimId: string
      readonly contributionId: string
      readonly mode: CordisXExtensionPointControlMode
      readonly exclusiveGroup?: string
      readonly priority: number
      readonly authorization: 'allowed' | 'denied'
      readonly policy: 'inherit' | 'allow' | 'deny'
      readonly state: CordisXExtensionPointControlCandidateSnapshotV1['state']
      readonly reason: string
    }[]
  }[]
}

interface CandidateRecord {
  readonly key: string
  readonly sequence: number
  readonly declaration: CordisXExtensionPointControlDeclarationV1
  readonly generation: ControlledSurfaceGeneration
  readonly hostAccess?: () => Readonly<{ authorized: boolean; reason?: string }>
  presenter?: unknown
  validationError?: string
}

interface ResolvedCandidate {
  readonly record: CandidateRecord
  readonly snapshot: CordisXExtensionPointControlCandidateSnapshotV1
}

interface Resolution {
  readonly snapshot: CordisXExtensionPointControlSnapshotV1
  readonly selected: ReadonlyMap<string, ResolvedCandidate>
}

function claimKey(value: { readonly principalHandle: string; readonly identity: CordisXExtensionPointControlIdentityV1; readonly claimId: string; readonly mode: CordisXExtensionPointControlMode }): string {
  return `${value.principalHandle}\0${value.identity.source}\0${value.identity.pluginId}\0${value.identity.pointId}\0${value.claimId}\0${value.mode}`
}

/** Protocol ordering is stable across profiles; the random Host principal is deliberately excluded. */
function canonicalClaimKey(value: { readonly identity: CordisXExtensionPointControlIdentityV1; readonly claimId: string; readonly mode: CordisXExtensionPointControlMode }): string {
  return `${value.identity.source}\0${value.identity.pluginId}\0${value.identity.pointId}\0${value.claimId}\0${value.mode}`
}

function sameGeneration(left: ControlledSurfaceGeneration, right: ControlledSurfaceGeneration): boolean {
  return left.principalHandle === right.principalHandle
    && left.principalOrigin === right.principalOrigin
    && left.source === right.source
    && left.pluginId === right.pluginId
    && left.moduleGeneration === right.moduleGeneration
    && left.transactionId === right.transactionId
    && left.transactionEpoch === right.transactionEpoch
}

function claimReference(declaration: { readonly principalHandle: string; readonly identity: CordisXExtensionPointControlIdentityV1; readonly claimId: string; readonly mode: CordisXExtensionPointControlMode }): CordisXExtensionPointControlClaimReferenceV1 {
  return Object.freeze({ principalHandle: declaration.principalHandle, identity: declaration.identity, claimId: declaration.claimId, mode: declaration.mode })
}

function sameClaim(left: CordisXExtensionPointControlClaimReferenceV1, right: CordisXExtensionPointControlClaimReferenceV1): boolean {
  return claimKey(left) === claimKey(right)
}

function reason(value: string, fallback: string): string {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) && value.length <= 128 ? value : fallback
}

function validSafeValue(schema: CordisXExtensionPointControlSafeValueSchemaV1, value: unknown): value is CordisXJsonScalar {
  if (value === null) return schema.nullable === true
  if (schema.enum !== undefined && !schema.enum.some(candidate => Object.is(candidate, value))) return false
  if (schema.type === 'string') return typeof value === 'string'
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (schema.type === 'integer') return Number.isInteger(value)
  return typeof value === 'boolean'
}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`)
}

function modeCompatible(point: CordisXHostExtensionPointControlPointV1, left: CordisXExtensionPointControlMode, right: CordisXExtensionPointControlMode): boolean {
  if (left === right) return true
  const leftMode = point.modes.find(item => item.id === left)
  const rightMode = point.modes.find(item => item.id === right)
  return leftMode?.coexistsWith.includes(right) === true && rightMode?.coexistsWith.includes(left) === true
}

function pathToAncestor(points: ReadonlyMap<string, CordisXHostExtensionPointControlPointV1>, pointId: string, ancestorId: string): readonly string[] | undefined {
  const path = [pointId]
  let current = points.get(pointId)
  while (current?.parentPointId !== undefined) {
    path.push(current.parentPointId)
    if (current.parentPointId === ancestorId) return Object.freeze(path.reverse())
    current = points.get(current.parentPointId)
  }
  return undefined
}

function normalizeBindings(options: CordisXExtensionPointControlClaimOptions['requestedBindings']): CordisXExtensionPointControlDeclarationV1['requestedBindings'] {
  return Object.freeze({
    properties: Object.freeze([...(options?.properties ?? [])]),
    commands: Object.freeze([...(options?.commands ?? [])]),
    events: Object.freeze([...(options?.events ?? [])]),
  })
}

/** Host normalization prevents a plugin from declaring canonical identity fields. */
export function normalizeControlledSurfaceDeclaration(input: {
  readonly principalHandle: string
  readonly source: string
  readonly pluginId: string
  readonly pointId: string
  readonly contributionId: string
  readonly order?: number
  readonly control?: CordisXExtensionPointControlClaimOptions
}): CordisXExtensionPointControlDeclarationV1 {
  const control = input.control
  return immutableSnapshot({
    $schema: CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1,
    schemaVersion: 1,
    principalHandle: input.principalHandle,
    origin: control === undefined ? 'legacy-structured' : 'explicit',
    identity: { source: input.source, pluginId: input.pluginId, pointId: input.pointId },
    claimId: control?.claimId ?? input.contributionId,
    contributionId: input.contributionId,
    mode: control?.mode ?? 'compose',
    priority: control?.priority ?? -(input.order ?? 0),
    ...(control === undefined ? { legacyOrder: input.order ?? 0 } : {}),
    requestedBindings: control === undefined ? { properties: [], commands: [], events: [] } : normalizeBindings(control.requestedBindings),
  })
}

/** Host-only authorization and user-selection authority. */
export class ControlledSurfacePolicyBroker {
  private readonly authorizations = new Map<string, CordisXExtensionPointControlAuthorizationV1>()
  private readonly choices = new Map<string, ControlledSurfaceGroupChoice>()
  private readonly principals = new Map<string, Readonly<{ handle: string; source: string; pluginId: string; origin: CordisXExtensionPointControlDeclarationV1['origin'] }>>()
  private readonly listeners = new Set<() => void>()
  private currentRevision = 0
  private disposed = false

  constructor(private readonly store: ControlledSurfacePolicyStore = new MemoryControlledSurfacePolicyStore()) {
    const value = store.read()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const state = value as Partial<ControlledSurfacePersistedState>
    if (Object.keys(value).some(key => !['schemaVersion', 'principals', 'authorizations', 'choices'].includes(key))
      || state.schemaVersion !== 1 || !Array.isArray(state.principals) || !Array.isArray(state.authorizations) || !Array.isArray(state.choices)) return
    try {
      for (const principal of state.principals) {
        if (Object.keys(principal).some(key => !['handle', 'source', 'pluginId', 'origin'].includes(key))
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(principal.handle)
          || !['explicit', 'legacy-structured'].includes(principal.origin)) throw new Error('invalid principal')
        const key = `${principal.source}\0${principal.pluginId}\0${principal.origin}`
        if (this.principals.has(key) || [...this.principals.values()].some(item => item.handle === principal.handle)) throw new Error('duplicate principal')
        this.principals.set(key, immutableSnapshot(principal))
      }
      for (const authorization of state.authorizations) {
        if (authorization.$schema !== CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1 || authorization.schemaVersion !== 1
          || Object.keys(authorization).some(key => !['$schema', 'schemaVersion', 'principalHandle', 'identity', 'claimId', 'mode', 'policy'].includes(key))
          || authorization.identity === null || typeof authorization.identity !== 'object'
          || Object.keys(authorization.identity).some(key => !['source', 'pluginId', 'pointId'].includes(key))
          || !['inherit', 'allow', 'deny'].includes(authorization.policy)) throw new Error('invalid authorization')
        const principal = [...this.principals.values()].find(item => item.handle === authorization.principalHandle)
        if (principal === undefined || principal.source !== authorization.identity.source || principal.pluginId !== authorization.identity.pluginId) throw new Error('authorization principal mismatch')
        if (authorization.policy !== 'inherit') this.authorizations.set(claimKey(authorization), immutableSnapshot(authorization))
      }
      for (const choice of state.choices) {
        if (Object.keys(choice).some(key => !['pointId', 'groupId', 'outcome', 'selectedClaim'].includes(key))
          || !['native', 'selected'].includes(choice.outcome) || (choice.outcome === 'selected') !== (choice.selectedClaim !== undefined)) throw new Error('invalid choice')
        this.choices.set(`${choice.pointId}\0${choice.groupId}`, immutableSnapshot(choice))
      }
    } catch {
      this.principals.clear(); this.authorizations.clear(); this.choices.clear()
    }
  }

  revision(): number { return this.currentRevision }

  principalHandle(source: string, pluginId: string, origin: CordisXExtensionPointControlDeclarationV1['origin']): string {
    this.assertLive()
    const key = `${source}\0${pluginId}\0${origin}`
    const existing = this.principals.get(key)
    if (existing !== undefined) return existing.handle
    const handle = typeof globalThis.crypto?.randomUUID === 'function'
      ? `principal:${globalThis.crypto.randomUUID()}`
      : `principal:${Date.now()}:${Math.random().toString(36).slice(2)}`
    this.principals.set(key, Object.freeze({ handle, source, pluginId, origin }))
    this.persist()
    return handle
  }

  principal(handle: string): Readonly<{ handle: string; source: string; pluginId: string; origin: CordisXExtensionPointControlDeclarationV1['origin'] }> | undefined {
    return [...this.principals.values()].find(item => item.handle === handle)
  }

  authorization(reference: CordisXExtensionPointControlClaimReferenceV1): CordisXExtensionPointControlAuthorizationV1 | undefined {
    this.assertLive()
    return this.authorizations.get(claimKey(reference))
  }

  choice(pointId: string, groupId: string): ControlledSurfaceGroupChoice | undefined {
    this.assertLive()
    return this.choices.get(`${pointId}\0${groupId}`)
  }

  setAuthorization(expectedRevision: number, value: CordisXExtensionPointControlAuthorizationV1): number {
    this.assertRevision(expectedRevision)
    if (value.$schema !== CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1 || value.schemaVersion !== 1) {
      throw new Error('unsupported controlled surface authorization schema')
    }
    const key = claimKey(value)
    if (value.policy === 'inherit') this.authorizations.delete(key)
    else this.authorizations.set(key, immutableSnapshot(value))
    return this.publish()
  }

  setGroupChoice(expectedRevision: number, value: ControlledSurfaceGroupChoice | undefined, pointId?: string, groupId?: string): number {
    this.assertRevision(expectedRevision)
    const key = value === undefined ? `${pointId}\0${groupId}` : `${value.pointId}\0${value.groupId}`
    if (value === undefined) this.choices.delete(key)
    else {
      if (value.outcome === 'selected' && value.selectedClaim === undefined) throw new Error('selected group choice requires a claim')
      if (value.outcome === 'native' && value.selectedClaim !== undefined) throw new Error('native group choice cannot select a claim')
      this.choices.set(key, immutableSnapshot(value))
    }
    return this.publish()
  }

  subscribe(listener: () => void): () => void {
    this.assertLive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.authorizations.clear()
    this.choices.clear()
    this.principals.clear()
    this.listeners.clear()
  }

  private assertRevision(expectedRevision: number): void {
    this.assertLive()
    if (expectedRevision !== this.currentRevision) throw new Error('stale controlled surface policy revision')
  }

  private publish(): number {
    this.currentRevision += 1
    this.persist()
    for (const listener of this.listeners) {
      try { listener() } catch { /* One observer cannot split Host policy publication. */ }
    }
    return this.currentRevision
  }

  private persist(): void {
    this.store.write(immutableSnapshot({
      schemaVersion: 1,
      principals: [...this.principals.values()].sort((left, right) => left.handle.localeCompare(right.handle)),
      authorizations: [...this.authorizations.values()].sort((left, right) => claimKey(left).localeCompare(claimKey(right))),
      choices: [...this.choices.values()].sort((left, right) => left.pointId.localeCompare(right.pointId) || left.groupId.localeCompare(right.groupId)),
    }))
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('controlled surface policy broker is disposed')
  }
}

/**
 * Protocol-aligned Host authority. It emits structured effects and diagnostics;
 * native selectors, nodes, callbacks, and cleanup remain in the adapter.
 */
export class ControlledSurfaceCoordinator {
  private readonly points: ReadonlyMap<string, CordisXHostExtensionPointControlPointV1>
  private readonly candidates = new Map<string, CandidateRecord>()
  private readonly lastEvents = new Map<string, Map<string, Readonly<{ sequence: number; payload: Readonly<Record<string, CordisXJsonScalar>> }>>>()
  private readonly listeners = new Set<() => void>()
  private nextSequence = 0
  private snapshotRevision = 0
  private eventSequence = 0
  private disposed = false
  private readonly disconnectPolicy: () => void

  constructor(
    readonly catalog: CordisXHostExtensionPointControlCatalogV1,
    private readonly bindings: Readonly<Record<string, ControlledSurfacePointBinding>>,
    readonly hostGeneration: string,
    readonly policies = new ControlledSurfacePolicyBroker(),
    private readonly isGenerationVisible: (generation: ControlledSurfaceGeneration, view?: PluginGenerationView) => boolean = () => true,
    private readonly isGenerationCallable: (generation: ControlledSurfaceGeneration) => boolean = generation => this.isGenerationVisible(generation),
  ) {
    if (catalog.schemaVersion !== 1 || catalog.points.length > 256 || hostGeneration.length === 0) {
      throw new Error('invalid controlled surface Host scope')
    }
    const points = new Map<string, CordisXHostExtensionPointControlPointV1>()
    for (const point of catalog.points) {
      assertLocalId(point.id, 'controlled surface point id')
      if (points.has(point.id)) throw new Error(`duplicate controlled surface point ${point.id}`)
      if (this.bindings[point.id] === undefined) throw new Error(`controlled surface point ${point.id} requires a Host binding`)
      this.validatePoint(point)
      points.set(point.id, immutableSnapshot(point))
    }
    for (const point of points.values()) {
      if (point.parentPointId !== undefined && !points.has(point.parentPointId)) throw new Error(`unknown parent point ${point.parentPointId}`)
      if (pathToAncestor(points, point.id, point.id) !== undefined) throw new Error(`controlled surface hierarchy contains a cycle at ${point.id}`)
    }
    this.points = points
    this.disconnectPolicy = policies.subscribe(() => this.invalidate())
  }

  register(input: ControlledSurfaceRegistration): ControlledSurfaceRegistrationHandle {
    this.assertLive()
    const declaration = immutableSnapshot(input.declaration)
    const principal = this.policies.principal(declaration.principalHandle)
    if (principal === undefined || principal.source !== input.generation.source || principal.pluginId !== input.generation.pluginId
      || principal.origin !== input.generation.principalOrigin) {
      throw new Error('control principal handle does not match its Host-private registry')
    }
    if (declaration.origin !== input.generation.principalOrigin) throw new Error('control declaration origin does not match its Host-private principal')
    const key = `${claimKey(declaration)}\0${input.generation.moduleGeneration ?? 'host'}\0${input.generation.transactionId ?? ''}\0${input.generation.transactionEpoch ?? ''}`
    if (this.candidates.has(key)) throw new Error(`controlled surface claim already registered: ${claimKey(declaration)}`)
    let presenter: unknown
    let validationError: string | undefined
    try {
      this.validateDeclaration(declaration, input.generation)
      presenter = immutableSnapshot(input.presenter)
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error)
    }
    const record: CandidateRecord = {
      key,
      sequence: this.nextSequence++,
      declaration,
      generation: Object.freeze({ ...input.generation }),
      ...(input.hostAccess === undefined ? {} : { hostAccess: input.hostAccess }),
      ...(presenter === undefined ? {} : { presenter }),
      ...(validationError === undefined ? {} : { validationError }),
    }
    this.candidates.set(key, record)
    this.invalidate()
    let active = true
    const dispose = (): void => {
      if (!active) return
      active = false
      this.candidates.delete(key)
      this.invalidate()
    }
    const handle = dispose as ControlledSurfaceRegistrationHandle
    handle.dispose = dispose
    handle.updatePresenter = (next: unknown): void => {
      if (!active) throw new Error('controlled surface claim is disposed')
      if (!this.callableGeneration(record.generation)) throw new Error('stale controlled surface generation')
      try {
        record.presenter = immutableSnapshot(next)
        delete record.validationError
        this.validateDeclaration(record.declaration, record.generation)
      } catch (error) {
        record.presenter = undefined
        record.validationError = error instanceof Error ? error.message : String(error)
      }
      this.invalidate()
    }
    return handle
  }

  snapshot(view?: PluginGenerationView): CordisXExtensionPointControlSnapshotV1 {
    return this.resolve(view).snapshot
  }

  hasPoint(pointId: string): boolean {
    this.assertLive()
    return this.points.has(pointId)
  }

  setAuthorization(expectedRevision: number, authorization: CordisXExtensionPointControlAuthorizationV1): number {
    this.assertLive()
    const record = [...this.candidates.values()].find(candidate => claimKey(candidate.declaration) === claimKey(authorization))
    if (record === undefined || record.declaration.principalHandle !== authorization.principalHandle) throw new Error('authorization does not match an exact control claim')
    return this.policies.setAuthorization(expectedRevision, authorization)
  }

  setGroupChoice(expectedRevision: number, choice: ControlledSurfaceGroupChoice): number {
    this.assertLive()
    const group = this.points.get(choice.pointId)?.exclusiveGroups.find(item => item.id === choice.groupId)
    if (group === undefined || group.selection !== 'user') throw new Error('control group is not user-selectable')
    if (choice.outcome === 'native' && !group.nativeFallback) throw new Error('control group has no native fallback')
    if (choice.outcome === 'selected') {
      const candidate = choice.selectedClaim === undefined ? undefined : [...this.candidates.values()].find(item => sameClaim(item.declaration, choice.selectedClaim!))
      if (candidate === undefined || !group.modes.includes(candidate.declaration.mode)) throw new Error('control group choice does not match an exact candidate')
    }
    return this.policies.setGroupChoice(expectedRevision, choice)
  }

  createLease(declaration: CordisXExtensionPointControlDeclarationV1, generation: ControlledSurfaceGeneration): CordisXExtensionPointControlLease & { dispose(): void } {
    this.assertLive()
    const key = claimKey(declaration)
    let active = true
    const listeners = new Set<() => void>()
    const revoked = (): CordisXExtensionPointControlLeaseSnapshot => Object.freeze({
      revision: this.snapshotRevision,
      state: 'revoked',
      reason: 'lease.revoked',
      properties: Object.freeze({}),
      commands: Object.freeze([]),
      events: Object.freeze([]),
    })
    const currentSnapshot = (): CordisXExtensionPointControlLeaseSnapshot => {
      if (!active || !this.visibleGeneration(generation)) return revoked()
      const point = this.snapshot().points.find(item => item.id === declaration.identity.pointId)
      const candidate = point?.candidates.find(item => claimKey(item) === key)
      if (candidate === undefined) return revoked()
      const selected = candidate.state === 'selected' && candidate.authorization === 'allowed'
      const eventMap = selected ? this.lastEvents.get(key) : undefined
      return Object.freeze({
        revision: this.snapshotRevision,
        state: candidate.state,
        reason: candidate.reason,
        properties: selected ? immutableSnapshot(Object.fromEntries((candidate.bindings?.properties ?? []).map(item => [item.id, item.value]))) : Object.freeze({}),
        commands: selected ? candidate.bindings?.commands ?? Object.freeze([]) : Object.freeze([]),
        events: selected ? Object.freeze([...(eventMap ?? [])].map(([id, event]) => Object.freeze({ id, sequence: event.sequence, payload: event.payload }))) : Object.freeze([]),
      })
    }
    const disconnect = this.subscribe(() => {
      for (const listener of listeners) {
        try { listener() } catch { /* A plugin observer cannot split Host publication. */ }
      }
    })
    return Object.freeze({
      snapshot: currentSnapshot,
      subscribe: (listener: () => void): (() => void) => {
        if (!active) throw new Error('controlled surface lease is revoked')
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      invoke: async (commandId: string, arguments_: Readonly<Record<string, CordisXJsonScalar>> = {}): Promise<CordisXExtensionPointControlResultV1> => {
        const invocationId = typeof globalThis.crypto?.randomUUID === 'function'
          ? globalThis.crypto.randomUUID()
          : `control-${Date.now()}-${Math.random().toString(36).slice(2)}`
        return await this.invoke(generation, {
          $schema: CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
          schemaVersion: 1,
          principalHandle: declaration.principalHandle,
          invocationId,
          hostGeneration: this.hostGeneration,
          operation: 'point.host-command.invoke',
          identity: declaration.identity,
          claimId: declaration.claimId,
          contributionId: declaration.contributionId,
          mode: declaration.mode,
          commandId,
          arguments: immutableSnapshot(arguments_),
        })
      },
      dispose: (): void => {
        if (!active) return
        active = false
        listeners.clear()
        disconnect()
      },
    })
  }

  managerSnapshot(): ControlledSurfaceManagerSnapshot {
    const snapshot = this.snapshot()
    return Object.freeze({
      revision: snapshot.revision,
      policyRevision: this.policies.revision(),
      hostGeneration: snapshot.hostGeneration,
      diagnostics: Object.freeze([...this.candidates.values()]
        .filter(item => item.validationError !== undefined)
        .map(item => Object.freeze({ contributionId: item.declaration.contributionId, message: item.validationError! }))
        .sort((left, right) => left.contributionId.localeCompare(right.contributionId))),
      points: Object.freeze(snapshot.points.map(point => Object.freeze({
        id: point.id,
        state: point.state,
        reason: point.reason,
        selected: Object.freeze(point.candidates.filter(item => item.state === 'selected').map(claimReference)),
        eligibleCandidates: Object.freeze(point.candidates.filter(item => item.state === 'eligible').map(claimReference)),
        deniedCandidates: Object.freeze(point.candidates.filter(item => item.authorization === 'denied').map(claimReference)),
        groupDecisions: point.groupDecisions,
        groups: Object.freeze((this.points.get(point.id)?.exclusiveGroups ?? []).map(group => {
          const decision = point.groupDecisions.find(item => item.groupId === group.id)
          return Object.freeze({
            id: group.id,
            selection: group.selection,
            nativeFallback: group.nativeFallback,
            modes: group.modes,
            ...(decision === undefined ? {} : { decision }),
          })
        })),
        ...(point.suppression === undefined ? {} : { suppression: point.suppression }),
        candidates: Object.freeze(point.candidates.map(item => Object.freeze({
          principalHandle: item.principalHandle,
          identity: item.identity,
          claimId: item.claimId,
          contributionId: item.contributionId,
          mode: item.mode,
          ...(this.points.get(point.id)?.modes.find(mode => mode.id === item.mode)?.exclusiveGroup === undefined ? {} : {
            exclusiveGroup: this.points.get(point.id)!.modes.find(mode => mode.id === item.mode)!.exclusiveGroup,
          }),
          priority: item.priority,
          authorization: item.authorization,
          policy: this.policies.authorization(claimReference(item))?.policy ?? 'inherit',
          state: item.state,
          reason: item.reason,
        }))),
      }))),
    })
  }

  selectedPresenters(pointId: string): readonly { readonly declaration: CordisXExtensionPointControlDeclarationV1; readonly presenter: unknown }[] {
    const selected = this.resolve().selected
    return Object.freeze([...selected.values()]
      .filter(item => item.record.declaration.identity.pointId === pointId)
      .map(item => Object.freeze({ declaration: item.record.declaration, presenter: item.record.presenter })))
  }

  async invoke(caller: ControlledSurfaceGeneration, request: CordisXExtensionPointControlAccessV1): Promise<CordisXExtensionPointControlResultV1> {
    const reject = (why: string): CordisXExtensionPointControlResultV1 => Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_CONTROL_RESULT_SCHEMA_V1,
      schemaVersion: 1,
      authority: 'host',
      invocationId: request.invocationId,
      hostGeneration: this.hostGeneration,
      revision: this.snapshotRevision,
      outcome: 'rejected',
      reason: why,
    })
    if (request.$schema !== CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1 || request.schemaVersion !== 1
      || request.hostGeneration !== this.hostGeneration || request.operation !== 'point.host-command.invoke') return reject('request.stale')
    if (caller.principalHandle !== request.principalHandle || caller.pluginId !== request.identity.pluginId
      || caller.source !== request.identity.source || !this.callableGeneration(caller)) return reject('caller.stale')
    const resolution = this.resolve()
    const resolved = resolution.selected.get(claimKey(request))
    if (resolved === undefined || resolved.record.declaration.contributionId !== request.contributionId) return reject('claim.not-selected')
    if (!sameGeneration(resolved.record.generation, caller)) return reject('generation.stale')
    const point = this.points.get(request.identity.pointId)
    const command = point?.safeCommands.find(item => item.id === request.commandId)
    const projected = resolved.snapshot.bindings?.commands.find(item => item.id === request.commandId)
    if (command === undefined || projected?.available !== true) return reject('command.unavailable')
    if (!this.validFields(command.arguments, request.arguments)) return reject('arguments.invalid')
    try {
      await this.bindings[point!.id]!.dispatch(request.commandId, immutableSnapshot(request.arguments))
      return Object.freeze({ ...reject('command.accepted'), outcome: 'accepted', reason: 'command.accepted', revision: this.snapshotRevision })
    } catch {
      return reject('command.failed')
    }
  }

  publishEvent(pointId: string, eventId: string, payload: Readonly<Record<string, CordisXJsonScalar>>): readonly CordisXExtensionPointControlEventV1[] {
    const point = this.points.get(pointId)
    const event = point?.safeEvents.find(item => item.id === eventId)
    if (point === undefined || event === undefined || !this.validFields(event.payload, payload)) return Object.freeze([])
    const sequence = ++this.eventSequence
    const published = Object.freeze([...this.resolve().selected.values()].flatMap(({ record, snapshot }) => {
      if (record.declaration.identity.pointId !== pointId
        || !record.declaration.requestedBindings.events.includes(eventId)
        || snapshot.bindings?.events.find(item => item.id === eventId)?.available !== true) return []
      const projectedPayload = immutableSnapshot(payload)
      const events = this.lastEvents.get(claimKey(record.declaration)) ?? new Map()
      events.set(eventId, Object.freeze({ sequence, payload: projectedPayload }))
      this.lastEvents.set(claimKey(record.declaration), events)
      return [Object.freeze({
        $schema: CORDISX_EXTENSION_POINT_CONTROL_EVENT_SCHEMA_V1,
        schemaVersion: 1,
        authority: 'host' as const,
        principalHandle: record.declaration.principalHandle,
        hostGeneration: this.hostGeneration,
        sequence,
        identity: record.declaration.identity,
        claimId: record.declaration.claimId,
        contributionId: record.declaration.contributionId,
        mode: record.declaration.mode,
        eventId,
        payload: projectedPayload,
      })]
    }))
    if (published.length > 0) for (const listener of this.listeners) {
      try { listener() } catch { /* One event observer cannot split Host delivery. */ }
    }
    return published
  }

  invalidate(): void {
    this.assertLive()
    this.lastEvents.clear()
    this.snapshotRevision += 1
    for (const listener of this.listeners) {
      try { listener() } catch { /* One observer cannot split one Host revision. */ }
    }
  }

  subscribe(listener: () => void): () => void {
    this.assertLive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectPolicy()
      this.candidates.clear()
    this.lastEvents.clear()
    this.listeners.clear()
  }

  private resolve(view?: PluginGenerationView): Resolution {
    this.assertLive()
    const pointSnapshots = new Map<string, CordisXExtensionPointControlPointSnapshotV1>()
    const selected = new Map<string, ResolvedCandidate>()
    const points = [...this.points.values()].sort((left, right) => {
      const depth = (point: CordisXHostExtensionPointControlPointV1): number => {
        let result = 0
        let parent = point.parentPointId
        while (parent !== undefined) { result += 1; parent = this.points.get(parent)?.parentPointId }
        return result
      }
      return depth(left) - depth(right) || left.id.localeCompare(right.id)
    })
    for (const point of points) {
      const binding = this.bindings[point.id]!
      let current: ReturnType<ControlledSurfacePointBinding['currentState']>
      try { current = immutableSnapshot(binding.currentState()) } catch { current = { state: 'pending', reason: 'binding.failed' } }
      const visibleRecords = [...this.candidates.values()]
        .filter(item => item.declaration.identity.pointId === point.id && item.validationError === undefined
          && this.visibleGeneration(item.generation, view))
        .sort((left, right) => right.declaration.priority - left.declaration.priority
          || canonicalClaimKey(left.declaration).localeCompare(canonicalClaimKey(right.declaration))
          || left.sequence - right.sequence)
      const seenClaims = new Set<string>()
      const records = visibleRecords.filter((record) => {
        const key = canonicalClaimKey(record.declaration)
        if (seenClaims.has(key)) return false
        seenClaims.add(key)
        return true
      })
      const suppressor = [...selected.values()].find(item => {
        const ancestor = this.points.get(item.record.declaration.identity.pointId)
        return ancestor?.ownership.scope === 'subtree'
          && ancestor.ownership.suppressesDescendantsWhenModes.includes(item.record.declaration.mode)
          && pathToAncestor(this.points, point.id, ancestor.id) !== undefined
      })
      if (suppressor !== undefined) {
        const ancestorId = suppressor.record.declaration.identity.pointId
        const path = pathToAncestor(this.points, point.id, ancestorId)!
        const candidates = records.map(record => this.candidateSnapshot(record, 'suppressed', 'ancestor.ownership', undefined, undefined, 'suppressed'))
        pointSnapshots.set(point.id, Object.freeze({
          id: point.id,
          state: 'suppressed',
          reason: 'ancestor.ownership',
          candidates: Object.freeze(candidates),
          groupDecisions: Object.freeze([]),
          suppression: Object.freeze({
            kind: 'ancestor-ownership',
            ancestorPointId: ancestorId,
            ancestorClaim: claimReference(suppressor.record.declaration),
            path,
            hostGeneration: this.hostGeneration,
            reason: 'ancestor.ownership',
          }),
        }))
        continue
      }

      const initial = new Map<string, { state: CordisXExtensionPointControlCandidateSnapshotV1['state']; reason: string; authorization: 'allowed' | 'denied'; bindings?: CordisXExtensionPointControlBindingsProjectionV1 }>()
      for (const record of records) {
        const mode = point.modes.find(item => item.id === record.declaration.mode)
        let hostAccess: Readonly<{ authorized: boolean; reason?: string }>
        try { hostAccess = record.hostAccess?.() ?? { authorized: true } } catch { hostAccess = { authorized: false, reason: 'point-policy.failed' } }
        const authorizationRecord = this.policies.authorization(claimReference(record.declaration))
        const authorization = !hostAccess.authorized
          ? 'denied' as const
          : authorizationRecord?.policy === 'allow'
          ? 'allowed' as const
          : authorizationRecord?.policy === 'deny'
            ? 'denied' as const
            : mode?.defaultAuthorization === 'allow' ? 'allowed' as const : 'denied' as const
        if (authorization === 'denied') initial.set(record.key, {
          state: 'denied',
          reason: hostAccess.authorized ? 'authorization.denied' : reason(hostAccess.reason ?? 'point-policy.denied', 'point-policy.denied'),
          authorization,
        })
        else if (current.state !== 'active') initial.set(record.key, { state: 'pending', reason: 'point.not-active', authorization })
        else {
          const bindingsProjection = this.projectBindings(point, record)
          if (bindingsProjection === undefined) initial.set(record.key, { state: 'pending', reason: 'binding.invalid', authorization })
          else initial.set(record.key, { state: 'eligible', reason: 'policy.eligible', authorization, bindings: bindingsProjection })
        }
      }

      const selectedRecords: CandidateRecord[] = []
      const decisions: CordisXExtensionPointControlPointSnapshotV1['groupDecisions'][number][] = []
      for (const group of point.exclusiveGroups) {
        const eligible = records.filter(record => group.modes.includes(record.declaration.mode) && initial.get(record.key)?.state === 'eligible')
        const choice = group.selection === 'user' ? this.policies.choice(point.id, group.id) : undefined
        const winner = group.selection === 'host-priority'
          ? eligible[0]
          : choice?.outcome === 'selected' && choice.selectedClaim !== undefined
            ? eligible.find(record => sameClaim(record.declaration, choice.selectedClaim!))
            : undefined
        if (winner !== undefined) {
          selectedRecords.push(winner)
          initial.set(winner.key, { ...initial.get(winner.key)!, state: 'selected', reason: group.selection === 'user' ? 'user.selected' : 'policy.priority' })
          decisions.push(Object.freeze({
            groupId: group.id,
            outcome: 'selected',
            selectedClaim: claimReference(winner.declaration),
            authority: group.selection === 'user' ? 'user' : 'host-policy',
            hostGeneration: this.hostGeneration,
            reason: group.selection === 'user' ? 'user.selected' : 'policy.priority',
          }))
        } else {
          const useNative = group.nativeFallback && choice?.outcome !== 'selected'
          decisions.push(Object.freeze({
            groupId: group.id,
            outcome: useNative ? 'native' : 'none',
            authority: group.selection === 'user' ? 'user' : 'host-policy',
            hostGeneration: this.hostGeneration,
            reason: useNative ? 'user.native' : eligible.length === 0 ? 'policy.no-candidate' : 'policy.no-selection',
          }))
        }
      }
      let orderedRank = 0
      for (const record of records.filter(item => point.modes.find(mode => mode.id === item.declaration.mode)?.stacking === 'ordered'
        && initial.get(item.key)?.state === 'eligible')) {
        const compatible = selectedRecords.every(selectedRecord => modeCompatible(point, record.declaration.mode, selectedRecord.declaration.mode))
        initial.set(record.key, { ...initial.get(record.key)!, state: compatible ? 'selected' : 'conflicted', reason: compatible ? 'policy.ordered' : 'mode.conflict' })
        if (compatible) selectedRecords.push(record)
      }
      const candidates = records.map(record => {
        const state = initial.get(record.key)!
        const group = point.modes.find(item => item.id === record.declaration.mode)?.exclusiveGroup
        const stacking = point.modes.find(item => item.id === record.declaration.mode)?.stacking
        const selection = state.state !== 'selected' ? undefined : {
          authority: group === undefined ? 'host-policy' as const : point.exclusiveGroups.find(item => item.id === group)?.selection === 'user' ? 'user' as const : 'host-policy' as const,
          hostGeneration: this.hostGeneration,
          ...(group === undefined ? {} : { exclusiveGroup: group }),
          ...(stacking === 'ordered' ? { rank: orderedRank++ } : {}),
          reason: state.reason,
        }
        const snapshot = this.candidateSnapshot(record, state.state, state.reason, state.authorization, state.bindings, undefined, selection)
        if (state.state === 'selected') selected.set(claimKey(record.declaration), { record, snapshot })
        return snapshot
      })
      pointSnapshots.set(point.id, Object.freeze({
        id: point.id,
        state: current.state,
        reason: reason(current.reason, current.state === 'active' ? 'point.mounted' : 'point.not-mounted'),
        candidates: Object.freeze(candidates),
        groupDecisions: Object.freeze(decisions),
      }))
    }
    return {
      snapshot: Object.freeze({
        $schema: CORDISX_EXTENSION_POINT_CONTROL_SNAPSHOT_SCHEMA_V1,
        schemaVersion: 1,
        authority: 'host',
        hostGeneration: this.hostGeneration,
        revision: this.snapshotRevision,
        points: Object.freeze([...pointSnapshots.values()].sort((left, right) => left.id.localeCompare(right.id))),
      }),
      selected,
    }
  }

  private candidateSnapshot(
    record: CandidateRecord,
    state: CordisXExtensionPointControlCandidateSnapshotV1['state'],
    why: string,
    authorization: 'allowed' | 'denied' | undefined,
    bindings: CordisXExtensionPointControlBindingsProjectionV1 | undefined,
    forcedState?: 'suppressed',
    selection?: CordisXExtensionPointControlCandidateSnapshotV1['selection'],
  ): CordisXExtensionPointControlCandidateSnapshotV1 {
    const auth = authorization ?? this.effectiveAuthorization(record)
    return Object.freeze({
      principalHandle: record.declaration.principalHandle,
      origin: record.declaration.origin,
      identity: record.declaration.identity,
      claimId: record.declaration.claimId,
      contributionId: record.declaration.contributionId,
      mode: record.declaration.mode,
      priority: record.declaration.priority,
      authorization: auth,
      state: forcedState ?? state,
      reason: why,
      ...(selection === undefined ? {} : { selection: Object.freeze(selection) }),
      ...(bindings === undefined || state !== 'selected' ? {} : { bindings }),
    })
  }

  private effectiveAuthorization(record: CandidateRecord): 'allowed' | 'denied' {
    try { if (record.hostAccess?.().authorized === false) return 'denied' } catch { return 'denied' }
    const declaration = record.declaration
    const policy = this.policies.authorization(claimReference(declaration))?.policy
    if (policy === 'allow') return 'allowed'
    if (policy === 'deny') return 'denied'
    return this.points.get(declaration.identity.pointId)?.modes.find(item => item.id === declaration.mode)?.defaultAuthorization === 'allow'
      ? 'allowed' : 'denied'
  }

  private projectBindings(point: CordisXHostExtensionPointControlPointV1, record: CandidateRecord): CordisXExtensionPointControlBindingsProjectionV1 | undefined {
    const binding = this.bindings[point.id]!
    try {
      const properties = record.declaration.requestedBindings.properties.map(id => {
        const descriptor = point.safeProperties.find(item => item.id === id)
        const value = descriptor === undefined ? undefined : binding.readProperty(id)
        if (descriptor === undefined || !validSafeValue(descriptor.schema, value)) throw new Error('invalid property')
        return Object.freeze({ id, value })
      })
      const commands = record.declaration.requestedBindings.commands.map(id => {
        if (!point.safeCommands.some(item => item.id === id)) throw new Error('invalid command')
        const availability = binding.commandAvailability?.(id) ?? { available: true }
        return Object.freeze({ id, available: availability.available, ...(availability.available || availability.reason === undefined ? {} : { reason: reason(availability.reason, 'command.unavailable') }) })
      })
      const events = record.declaration.requestedBindings.events.map(id => {
        if (!point.safeEvents.some(item => item.id === id)) throw new Error('invalid event')
        const availability = binding.eventAvailability?.(id) ?? { available: true }
        return Object.freeze({ id, available: availability.available, ...(availability.available || availability.reason === undefined ? {} : { reason: reason(availability.reason, 'event.unavailable') }) })
      })
      return Object.freeze({ properties: Object.freeze(properties), commands: Object.freeze(commands), events: Object.freeze(events) })
    } catch {
      return undefined
    }
  }

  private validatePoint(point: CordisXHostExtensionPointControlPointV1): void {
    unique(point.modes.map(item => item.id), `point ${point.id} modes`)
    unique(point.exclusiveGroups.map(item => item.id), `point ${point.id} groups`)
    unique(point.safeProperties.map(item => item.id), `point ${point.id} properties`)
    unique(point.safeCommands.map(item => item.id), `point ${point.id} commands`)
    unique(point.safeEvents.map(item => item.id), `point ${point.id} events`)
    const compose = point.modes.find(item => item.id === 'compose')
    if (compose?.stacking !== 'ordered' || compose.defaultAuthorization !== 'allow') throw new Error(`point ${point.id} requires compatible compose mode`)
    for (const mode of point.modes) {
      if (mode.id !== 'compose' && mode.defaultAuthorization !== 'deny') throw new Error(`point ${point.id}/${mode.id} must default deny`)
      if (mode.coexistsWith.some(peer => !point.modes.find(item => item.id === peer)?.coexistsWith.includes(mode.id))) throw new Error(`point ${point.id}/${mode.id} coexistence is not reciprocal`)
      const groups = point.exclusiveGroups.filter(group => group.modes.includes(mode.id))
      if (mode.stacking === 'exclusive' && (groups.length !== 1 || groups[0]!.id !== mode.exclusiveGroup)) throw new Error(`point ${point.id}/${mode.id} lacks exact exclusive group`)
      if (mode.stacking === 'ordered' && (mode.exclusiveGroup !== undefined || groups.length > 0)) throw new Error(`point ${point.id}/${mode.id} ordered mode cannot join a group`)
    }
    for (const group of point.exclusiveGroups) {
      unique(group.modes, `point ${point.id}/${group.id} modes`)
      if (group.modes.some(modeId => point.modes.find(mode => mode.id === modeId)?.stacking !== 'exclusive')) throw new Error(`point ${point.id}/${group.id} references a non-exclusive mode`)
    }
    for (let leftIndex = 0; leftIndex < point.exclusiveGroups.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < point.exclusiveGroups.length; rightIndex += 1) {
        for (const left of point.exclusiveGroups[leftIndex]!.modes) for (const right of point.exclusiveGroups[rightIndex]!.modes) {
          if (!modeCompatible(point, left, right)) throw new Error(`point ${point.id} exclusive groups cannot coexist`)
        }
      }
    }
    if (point.ownership.scope === 'point' && point.ownership.suppressesDescendantsWhenModes.length > 0) throw new Error(`point ${point.id} cannot suppress descendants`)
  }

  private validateDeclaration(declaration: CordisXExtensionPointControlDeclarationV1, generation: ControlledSurfaceGeneration): void {
    if (declaration.$schema !== CORDISX_EXTENSION_POINT_CONTROL_DECLARATION_SCHEMA_V1 || declaration.schemaVersion !== 1) throw new Error('unsupported control declaration')
    if (declaration.principalHandle !== generation.principalHandle || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(declaration.principalHandle)) throw new Error('control principal is invalid')
    if (declaration.identity.pluginId !== generation.pluginId || declaration.identity.source !== generation.source) throw new Error('control declaration identity does not match its fiber')
    const point = this.points.get(declaration.identity.pointId)
    if (point === undefined || !point.modes.some(item => item.id === declaration.mode)) throw new Error('control declaration targets an unavailable point or mode')
    if (!Number.isInteger(declaration.priority) || declaration.priority < -100000 || declaration.priority > 100000) throw new Error('control priority is invalid')
    assertLocalId(declaration.claimId, 'control claim id')
    assertLocalId(declaration.contributionId, 'control contribution id')
    for (const [kind, ids] of Object.entries(declaration.requestedBindings)) unique(ids, `control ${kind}`)
    if (declaration.origin === 'legacy-structured' && (declaration.mode !== 'compose'
      || declaration.requestedBindings.properties.length + declaration.requestedBindings.commands.length + declaration.requestedBindings.events.length > 0)) {
      throw new Error('legacy contribution cannot gain control authority')
    }
    if (declaration.origin === 'legacy-structured' && (declaration.claimId !== declaration.contributionId
      || declaration.legacyOrder === undefined || declaration.priority !== -declaration.legacyOrder)) throw new Error('legacy contribution normalization drift')
    if (declaration.origin === 'explicit' && declaration.legacyOrder !== undefined) throw new Error('explicit contribution cannot carry legacy order')
    if (declaration.requestedBindings.properties.some(id => !point.safeProperties.some(item => item.id === id))
      || declaration.requestedBindings.commands.some(id => !point.safeCommands.some(item => item.id === id))
      || declaration.requestedBindings.events.some(id => !point.safeEvents.some(item => item.id === id))) throw new Error('control declaration requests an unknown binding')
  }

  private validFields(descriptors: readonly { readonly id: string; readonly schema: CordisXExtensionPointControlSafeValueSchemaV1; readonly required: boolean }[], value: Readonly<Record<string, CordisXJsonScalar>>): boolean {
    if (Object.keys(value).some(key => !descriptors.some(item => item.id === key))) return false
    return descriptors.every(descriptor => {
      const candidate = value[descriptor.id]
      return candidate === undefined ? !descriptor.required : validSafeValue(descriptor.schema, candidate)
    })
  }

  private visibleGeneration(generation: ControlledSurfaceGeneration, view?: PluginGenerationView): boolean {
    try { return this.isGenerationVisible(generation, view) } catch { return false }
  }

  private callableGeneration(generation: ControlledSurfaceGeneration): boolean {
    try { return this.isGenerationCallable(generation) } catch { return false }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('controlled surface coordinator is disposed')
  }
}
