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
  type CordisXExtensionPointControlLease,
  type CordisXExtensionPointControlLeaseSnapshot,
  type CordisXExtensionPointControlMode,
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
  readonly dispatch: (
    id: string,
    arguments_: Readonly<Record<string, CordisXJsonScalar>>,
    context: ControlledSurfaceCommandContext,
  ) => void | Promise<void>
}

export interface ControlledSurfaceSelectedClaim {
  readonly declaration: CordisXExtensionPointControlDeclarationV1
  readonly generation: ControlledSurfaceGeneration
}

export interface ControlledSurfaceCommandContext extends ControlledSurfaceSelectedClaim {
  readonly caller: ControlledSurfaceGeneration
}

/** A Host binding may reject one safe command with a stable protocol reason. */
export class ControlledSurfaceCommandError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'ControlledSurfaceCommandError'
  }
}

export interface ControlledSurfaceRegistration {
  readonly declaration: CordisXExtensionPointControlDeclarationV1
  readonly generation: ControlledSurfaceGeneration
  readonly presenter: unknown
  /** Host-private point access gate. It must not be supplied by plugin input. */
  readonly hostAccess?: () => Readonly<{ authorized: boolean; reason?: string; policy?: 'inherit' | 'allow' | 'deny' }>
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
  readonly principals: readonly Readonly<
    { handle: string; source: string; pluginId: string; origin: CordisXExtensionPointControlDeclarationV1['origin'] }
  >[]
  readonly authorizations: readonly CordisXExtensionPointControlAuthorizationV1[]
  readonly choices: readonly ControlledSurfaceGroupChoice[]
}

export interface ControlledSurfacePolicyStore {
  read(): unknown
  write(state: ControlledSurfacePersistedState): void
}

export class MemoryControlledSurfacePolicyStore implements ControlledSurfacePolicyStore {
  value: unknown
  constructor(value: unknown = { schemaVersion: 1, principals: [], authorizations: [], choices: [] }) {
    this.value = structuredClone(value)
  }
  read(): unknown {
    return structuredClone(this.value)
  }
  write(state: ControlledSurfacePersistedState): void {
    this.value = structuredClone(state)
  }
}

/** Host-profile scoped persistence; Chromium profile isolation is an additional boundary. */
export class BrowserControlledSurfacePolicyStore implements ControlledSurfacePolicyStore {
  private readonly key: string
  constructor(profileId: string) {
    this.key = `cordisx.extension-point-control.v1:${profileId}`
  }
  read(): unknown {
    try {
      const value = localStorage.getItem(this.key)
      return value === null ? undefined : JSON.parse(value)
    } catch {
      return undefined
    }
  }
  write(state: ControlledSurfacePersistedState): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(state))
    } catch { /* Live Host policy remains authoritative. */ }
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
      /** Durable user intent, independent from whether the point is currently mounted. */
      readonly policyChoice?: ControlledSurfaceGroupChoice
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

export interface CandidateRecord {
  readonly key: string
  readonly sequence: number
  readonly declaration: CordisXExtensionPointControlDeclarationV1
  readonly generation: ControlledSurfaceGeneration
  readonly hostAccess?: () => Readonly<{ authorized: boolean; reason?: string; policy?: 'inherit' | 'allow' | 'deny' }>
  presenter?: unknown
  validationError?: string
}

export interface ResolvedCandidate {
  readonly record: CandidateRecord
  readonly snapshot: CordisXExtensionPointControlCandidateSnapshotV1
}

export interface Resolution {
  readonly snapshot: CordisXExtensionPointControlSnapshotV1
  readonly selected: ReadonlyMap<string, ResolvedCandidate>
}

export function claimKey(
  value: {
    readonly principalHandle: string
    readonly identity: CordisXExtensionPointControlIdentityV1
    readonly claimId: string
    readonly mode: CordisXExtensionPointControlMode
  },
): string {
  return `${value.principalHandle}\0${value.identity.source}\0${value.identity.pluginId}\0${value.identity.pointId}\0${value.claimId}\0${value.mode}`
}

/** Protocol ordering is stable across profiles; the random Host principal is deliberately excluded. */
export function canonicalClaimKey(
  value: {
    readonly identity: CordisXExtensionPointControlIdentityV1
    readonly claimId: string
    readonly mode: CordisXExtensionPointControlMode
  },
): string {
  return `${value.identity.source}\0${value.identity.pluginId}\0${value.identity.pointId}\0${value.claimId}\0${value.mode}`
}

export function sameGeneration(left: ControlledSurfaceGeneration, right: ControlledSurfaceGeneration): boolean {
  return left.principalHandle === right.principalHandle
    && left.principalOrigin === right.principalOrigin
    && left.source === right.source
    && left.pluginId === right.pluginId
    && left.moduleGeneration === right.moduleGeneration
    && left.transactionId === right.transactionId
    && left.transactionEpoch === right.transactionEpoch
}

export function claimReference(
  declaration: {
    readonly principalHandle: string
    readonly identity: CordisXExtensionPointControlIdentityV1
    readonly claimId: string
    readonly mode: CordisXExtensionPointControlMode
  },
): CordisXExtensionPointControlClaimReferenceV1 {
  return Object.freeze({
    principalHandle: declaration.principalHandle,
    identity: declaration.identity,
    claimId: declaration.claimId,
    mode: declaration.mode,
  })
}

export function sameClaim(
  left: CordisXExtensionPointControlClaimReferenceV1,
  right: CordisXExtensionPointControlClaimReferenceV1,
): boolean {
  return claimKey(left) === claimKey(right)
}

export function reason(value: string, fallback: string): string {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) && value.length <= 128 ? value : fallback
}

export function validSafeValue(
  schema: CordisXExtensionPointControlSafeValueSchemaV1,
  value: unknown,
): value is CordisXJsonScalar {
  if (value === null) return schema.nullable === true
  if (schema.enum !== undefined && !schema.enum.some(candidate => Object.is(candidate, value))) return false
  if (schema.type === 'string') return typeof value === 'string'
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (schema.type === 'integer') return Number.isInteger(value)
  return typeof value === 'boolean'
}

export function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`)
}

export function modeCompatible(
  point: CordisXHostExtensionPointControlPointV1,
  left: CordisXExtensionPointControlMode,
  right: CordisXExtensionPointControlMode,
): boolean {
  if (left === right) return true
  const leftMode = point.modes.find(item => item.id === left)
  const rightMode = point.modes.find(item => item.id === right)
  return leftMode?.coexistsWith.includes(right) === true && rightMode?.coexistsWith.includes(left) === true
}

export function pathToAncestor(
  points: ReadonlyMap<string, CordisXHostExtensionPointControlPointV1>,
  pointId: string,
  ancestorId: string,
): readonly string[] | undefined {
  const path = [pointId]
  let current = points.get(pointId)
  while (current?.parentPointId !== undefined) {
    path.push(current.parentPointId)
    if (current.parentPointId === ancestorId) return Object.freeze(path.reverse())
    current = points.get(current.parentPointId)
  }
  return undefined
}

function normalizeBindings(
  options: CordisXExtensionPointControlClaimOptions['requestedBindings'],
): CordisXExtensionPointControlDeclarationV1['requestedBindings'] {
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
    requestedBindings: control === undefined
      ? { properties: [], commands: [], events: [] }
      : normalizeBindings(control.requestedBindings),
  })
}

/** Host-only authorization and user-selection authority. */
export class ControlledSurfacePolicyBroker {
  private readonly authorizations = new Map<string, CordisXExtensionPointControlAuthorizationV1>()
  private readonly choices = new Map<string, ControlledSurfaceGroupChoice>()
  private readonly principals = new Map<
    string,
    Readonly<
      { handle: string; source: string; pluginId: string; origin: CordisXExtensionPointControlDeclarationV1['origin'] }
    >
  >()
  private readonly listeners = new Set<() => void>()
  private currentRevision = 0
  private disposed = false

  constructor(private readonly store: ControlledSurfacePolicyStore = new MemoryControlledSurfacePolicyStore()) {
    const value = store.read()
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const state = value as Partial<ControlledSurfacePersistedState>
    if (
      Object.keys(value).some(key => !['schemaVersion', 'principals', 'authorizations', 'choices'].includes(key))
      || state.schemaVersion !== 1 || !Array.isArray(state.principals) || !Array.isArray(state.authorizations)
      || !Array.isArray(state.choices)
    ) return
    try {
      for (const principal of state.principals) {
        if (
          Object.keys(principal).some(key => !['handle', 'source', 'pluginId', 'origin'].includes(key))
          || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(principal.handle)
          || !['explicit', 'legacy-structured'].includes(principal.origin)
        ) throw new Error('invalid principal')
        const key = `${principal.source}\0${principal.pluginId}\0${principal.origin}`
        if (this.principals.has(key) || [...this.principals.values()].some(item => item.handle === principal.handle)) {
          throw new Error('duplicate principal')
        }
        this.principals.set(key, immutableSnapshot(principal))
      }
      for (const authorization of state.authorizations) {
        if (
          authorization.$schema !== CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1
          || authorization.schemaVersion !== 1
          || Object.keys(authorization).some(key =>
            !['$schema', 'schemaVersion', 'principalHandle', 'identity', 'claimId', 'mode', 'policy'].includes(key)
          )
          || authorization.identity === null || typeof authorization.identity !== 'object'
          || Object.keys(authorization.identity).some(key => !['source', 'pluginId', 'pointId'].includes(key))
          || !['inherit', 'allow', 'deny'].includes(authorization.policy)
        ) throw new Error('invalid authorization')
        const principal = [...this.principals.values()].find(item => item.handle === authorization.principalHandle)
        if (
          principal === undefined || principal.source !== authorization.identity.source
          || principal.pluginId !== authorization.identity.pluginId
        ) throw new Error('authorization principal mismatch')
        if (authorization.policy !== 'inherit') {
          this.authorizations.set(claimKey(authorization), immutableSnapshot(authorization))
        }
      }
      for (const choice of state.choices) {
        if (
          Object.keys(choice).some(key => !['pointId', 'groupId', 'outcome', 'selectedClaim'].includes(key))
          || !['native', 'selected'].includes(choice.outcome)
          || (choice.outcome === 'selected') !== (choice.selectedClaim !== undefined)
        ) throw new Error('invalid choice')
        this.choices.set(`${choice.pointId}\0${choice.groupId}`, immutableSnapshot(choice))
      }
    } catch {
      this.principals.clear()
      this.authorizations.clear()
      this.choices.clear()
    }
  }

  revision(): number {
    return this.currentRevision
  }

  principalHandle(
    source: string,
    pluginId: string,
    origin: CordisXExtensionPointControlDeclarationV1['origin'],
  ): string {
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

  principal(
    handle: string,
  ):
    | Readonly<
      { handle: string; source: string; pluginId: string; origin: CordisXExtensionPointControlDeclarationV1['origin'] }
    >
    | undefined
  {
    return [...this.principals.values()].find(item => item.handle === handle)
  }

  authorization(
    reference: CordisXExtensionPointControlClaimReferenceV1,
  ): CordisXExtensionPointControlAuthorizationV1 | undefined {
    this.assertLive()
    return this.authorizations.get(claimKey(reference))
  }

  /** Read-only migration input; runtime authorization never consults these claim-scoped records. */
  legacyAuthorizations(): readonly CordisXExtensionPointControlAuthorizationV1[] {
    this.assertLive()
    return Object.freeze([...this.authorizations.values()].map(immutableSnapshot))
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

  setGroupChoice(
    expectedRevision: number,
    value: ControlledSurfaceGroupChoice | undefined,
    pointId?: string,
    groupId?: string,
  ): number {
    this.assertRevision(expectedRevision)
    const key = value === undefined ? `${pointId}\0${groupId}` : `${value.pointId}\0${value.groupId}`
    if (value === undefined) this.choices.delete(key)
    else {
      if (value.outcome === 'selected' && value.selectedClaim === undefined) {
        throw new Error('selected group choice requires a claim')
      }
      if (value.outcome === 'native' && value.selectedClaim !== undefined) {
        throw new Error('native group choice cannot select a claim')
      }
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
      try {
        listener()
      } catch { /* One observer cannot split Host policy publication. */ }
    }
    return this.currentRevision
  }

  private persist(): void {
    this.store.write(immutableSnapshot({
      schemaVersion: 1,
      principals: [...this.principals.values()].sort((left, right) => left.handle.localeCompare(right.handle)),
      authorizations: [...this.authorizations.values()].sort((left, right) =>
        claimKey(left).localeCompare(claimKey(right))
      ),
      choices: [...this.choices.values()].sort((left, right) =>
        left.pointId.localeCompare(right.pointId) || left.groupId.localeCompare(right.groupId)
      ),
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
