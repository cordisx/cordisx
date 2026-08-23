import type {
  CordisXEffectivePointPolicy,
  CordisXExtensionPointAccessV1,
  CordisXExtensionPointIdentity,
  CordisXExtensionPointKind,
  CordisXExtensionPointPolicyRecordV1,
  CordisXHostExtensionPointCatalogV1,
  CordisXHostExtensionPointDescriptor,
  CordisXLocaleCatalog,
  CordisXLocalizedProjection,
  CordisXPointPolicy,
  CordisXPluginIdentity,
} from '../contracts.js'
import {
  CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
} from '../contracts.js'
import type { CordisXI18nService } from './i18n.js'
import type { CommandSnapshot } from './commands.js'
import type { NavigationSnapshot, RouteSnapshot } from './navigation.js'
import type { SurfaceContributionSnapshot } from './surfaces.js'
import { qualifyOwnedId } from './ownership.js'
import { ICON_TOKEN_PATTERN, assertLocalId, assertLocalizedText, immutableSnapshot } from './validation.js'

const POINT_POLICY_STORAGE_KEY = 'cordisx.extensionPointPolicies.v1'
const DESCRIPTOR_NAMESPACE = 'cordisx.manager.extension-points'

export interface ExtensionPointDescriptorDiagnostic {
  readonly code: 'invalid-catalog' | 'invalid-descriptor' | 'duplicate-point-id'
  readonly message: string
  readonly pointId?: string
}

export interface HostExtensionPointProjection extends CordisXHostExtensionPointDescriptor {
  readonly titleProjection: CordisXLocalizedProjection
  readonly descriptionProjection: CordisXLocalizedProjection
}

interface DescriptorRegistration {
  readonly descriptors: readonly CordisXHostExtensionPointDescriptor[]
  readonly diagnostics: readonly ExtensionPointDescriptorDiagnostic[]
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

function normalizeDescriptor(value: unknown): CordisXHostExtensionPointDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('descriptor must be an object')
  exactKeys(value, ['id', 'kind', 'title', 'description', 'icon'], 'descriptor')
  const descriptor = value as Partial<CordisXHostExtensionPointDescriptor>
  if (typeof descriptor.id !== 'string') throw new Error('descriptor id is required')
  assertLocalId(descriptor.id, 'extension point id')
  if (descriptor.kind !== 'surface' && descriptor.kind !== 'outlet') throw new Error(`extension point ${descriptor.id} kind is invalid`)
  assertLocalizedText(descriptor.title, `extension point ${descriptor.id} title`)
  assertLocalizedText(descriptor.description, `extension point ${descriptor.id} description`)
  if (descriptor.title.fallback === undefined || descriptor.description.fallback === undefined) {
    throw new Error(`extension point ${descriptor.id} descriptor text requires fallback`)
  }
  if (descriptor.title.fallback.length > 4000 || descriptor.description.fallback.length > 4000) {
    throw new Error(`extension point ${descriptor.id} descriptor fallback is too long`)
  }
  if (typeof descriptor.icon !== 'string' || !ICON_TOKEN_PATTERN.test(descriptor.icon) || !descriptor.icon.startsWith('host:')) {
    throw new Error(`extension point ${descriptor.id} requires a host icon token`)
  }
  return immutableSnapshot(descriptor as CordisXHostExtensionPointDescriptor)
}

/** Runtime ledger for host/adapter-owned descriptors. Invalid declarations remain diagnostic-only. */
export class ExtensionPointDescriptorRegistry {
  private readonly registrations: DescriptorRegistration[] = []
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private projectionI18n: CordisXI18nService | undefined

  registerCatalog(value: CordisXHostExtensionPointCatalogV1 | unknown): () => void {
    if (this.disposed) throw new Error('CordisX extension point descriptor registry is disposed')
    const descriptors: CordisXHostExtensionPointDescriptor[] = []
    const diagnostics: ExtensionPointDescriptorDiagnostic[] = []
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('catalog must be an object')
      exactKeys(value, ['$schema', 'schemaVersion', 'points'], 'extension point catalog')
      const catalog = value as Partial<CordisXHostExtensionPointCatalogV1>
      if (catalog.$schema !== CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1 || catalog.schemaVersion !== 1) {
        throw new Error('extension point catalog schema/version is unsupported')
      }
      if (!Array.isArray(catalog.points) || catalog.points.length > 256) throw new Error('extension point catalog points must be an array of at most 256 items')
      const liveIds = new Set(this.descriptors().map(item => item.id))
      for (const candidate of catalog.points) {
        try {
          const descriptor = normalizeDescriptor(candidate)
          if (liveIds.has(descriptor.id) || descriptors.some(item => item.id === descriptor.id)) {
            diagnostics.push({ code: 'duplicate-point-id', pointId: descriptor.id, message: `duplicate extension point id across families: ${descriptor.id}` })
            continue
          }
          descriptors.push(descriptor)
        } catch (error) {
          const pointId = candidate !== null && typeof candidate === 'object' && typeof (candidate as { id?: unknown }).id === 'string'
            ? (candidate as { id: string }).id
            : undefined
          diagnostics.push({
            code: 'invalid-descriptor',
            message: error instanceof Error ? error.message : String(error),
            ...(pointId === undefined ? {} : { pointId }),
          })
        }
      }
    } catch (error) {
      diagnostics.push({ code: 'invalid-catalog', message: error instanceof Error ? error.message : String(error) })
    }
    const registration = { descriptors: Object.freeze(descriptors), diagnostics: Object.freeze(diagnostics) }
    this.registrations.push(registration)
    this.notify()
    let active = true
    return () => {
      if (!active) return
      active = false
      for (const descriptor of registration.descriptors) {
        this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:title`)
        this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:description`)
      }
      const index = this.registrations.indexOf(registration)
      if (index >= 0) this.registrations.splice(index, 1)
      this.notify()
    }
  }

  descriptors(): readonly CordisXHostExtensionPointDescriptor[] {
    return this.registrations.flatMap(item => item.descriptors).sort((left, right) => left.id.localeCompare(right.id))
  }

  descriptor(id: string): CordisXHostExtensionPointDescriptor | undefined {
    return this.descriptors().find(item => item.id === id)
  }

  diagnostics(): readonly ExtensionPointDescriptorDiagnostic[] {
    return this.registrations.flatMap(item => item.diagnostics)
  }

  project(i18n: CordisXI18nService): readonly HostExtensionPointProjection[] {
    this.projectionI18n = i18n
    return this.descriptors().map(descriptor => ({
      ...descriptor,
      titleProjection: i18n.resolveFor('host', descriptor.title, `extension-point:${descriptor.id}:title`),
      descriptionProjection: i18n.resolveFor('host', descriptor.description, `extension-point:${descriptor.id}:description`),
    }))
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const descriptor of this.descriptors()) {
      this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:title`)
      this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:description`)
    }
    this.projectionI18n = undefined
    this.registrations.length = 0
    this.listeners.clear()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export function canonicalExtensionPointSource(value: string): string {
  if (value.length > 2048) throw new Error('source exceeds 2048 characters')
  const url = new URL(value)
  if (!['file:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('source must be a file or HTTPS URL without credentials, query, or fragment')
  }
  if (url.protocol === 'file:' && url.host !== '') throw new Error('file source must be a local absolute file URL')
  if (url.protocol === 'https:' && url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '')
  return url.href
}

export function extensionPointIdentityKey(identity: CordisXExtensionPointIdentity): string {
  return `${identity.source}\u0000${identity.pluginId}\u0000${identity.pointId}`
}

export interface ExtensionPointPolicyStore {
  read(): readonly CordisXExtensionPointPolicyRecordV1[]
  write(records: readonly CordisXExtensionPointPolicyRecordV1[]): void
}

function copied<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

export class MemoryExtensionPointPolicyStore implements ExtensionPointPolicyStore {
  records: readonly CordisXExtensionPointPolicyRecordV1[]

  constructor(records: readonly CordisXExtensionPointPolicyRecordV1[] = []) {
    this.records = copied(records)
  }

  read(): readonly CordisXExtensionPointPolicyRecordV1[] { return copied(this.records) }
  write(records: readonly CordisXExtensionPointPolicyRecordV1[]): void { this.records = copied(records) }
}

function validStoredPolicy(value: unknown): value is CordisXExtensionPointPolicyRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<CordisXExtensionPointPolicyRecordV1>
  if (Object.keys(value).some(key => !['$schema', 'schemaVersion', 'identity', 'policy'].includes(key))) return false
  if (record.$schema !== CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1 || record.schemaVersion !== 1) return false
  if (!['inherit', 'allow', 'deny'].includes(String(record.policy))) return false
  const identity = record.identity
  if (identity === undefined || typeof identity.source !== 'string' || typeof identity.pluginId !== 'string' || typeof identity.pointId !== 'string') return false
  if (Object.keys(identity).some(key => !['source', 'pluginId', 'pointId'].includes(key))) return false
  try {
    assertLocalId(identity.pluginId, 'point policy plugin id')
    assertLocalId(identity.pointId, 'point policy point id')
    return canonicalExtensionPointSource(identity.source) === identity.source
  } catch {
    return false
  }
}

export class BrowserExtensionPointPolicyStore implements ExtensionPointPolicyStore {
  read(): readonly CordisXExtensionPointPolicyRecordV1[] {
    try {
      const raw = localStorage.getItem(POINT_POLICY_STORAGE_KEY)
      if (raw === null) return []
      const records = JSON.parse(raw) as unknown
      return Array.isArray(records) ? records.filter(validStoredPolicy) : []
    } catch {
      return []
    }
  }

  write(records: readonly CordisXExtensionPointPolicyRecordV1[]): void {
    try {
      localStorage.setItem(POINT_POLICY_STORAGE_KEY, JSON.stringify(records))
    } catch {
      // Renderer-local persistence is best effort; the live broker still enforces policy.
    }
  }
}

export interface ExtensionPointAccessDecision {
  readonly identity?: CordisXExtensionPointIdentity
  readonly policy: CordisXPointPolicy
  readonly effectivePolicy: CordisXEffectivePointPolicy
  readonly authorized: boolean
  readonly reason?: string
}

export interface ExtensionPointAccessResolver {
  decision(owner: string, pointId: string, expectedKind: CordisXExtensionPointKind): ExtensionPointAccessDecision
  authorizeSurfaceCommand(owner: string, pointId: string, contributionId: string, commandId: string): ExtensionPointAccessDecision
  authorizeOutletRoute(owner: string, pointId: string, routeId: string, pageId: string): ExtensionPointAccessDecision
  authorizeOutletPage(owner: string, pointId: string, routeId: string, pageId: string): ExtensionPointAccessDecision
  authorizeOutletPageCommand(owner: string, pointId: string, routeId: string, pageId: string, actionId: string, commandId: string): ExtensionPointAccessDecision
}

export interface ExtensionPointAccessDiagnostic {
  readonly request: CordisXExtensionPointAccessV1
  readonly authorized: boolean
  readonly effectivePolicy: CordisXEffectivePointPolicy
  readonly reason?: string
}

export interface ExtensionPointPolicyDiagnostic {
  readonly code: 'duplicate-policy' | 'unknown-point'
  readonly message: string
  readonly identity: CordisXExtensionPointIdentity
}

type ExtensionPointAccessFields =
  | { readonly operation: 'surface.command.invoke'; readonly contributionId: string; readonly commandId: string }
  | { readonly operation: 'outlet.route.navigate'; readonly routeId: string; readonly pageId: string }
  | { readonly operation: 'outlet.page.mount'; readonly routeId: string; readonly pageId: string }
  | { readonly operation: 'outlet.page.command.invoke'; readonly routeId: string; readonly pageId: string; readonly actionId: string; readonly commandId: string }

export interface ExtensionPointPluginUsageSnapshot {
  readonly identity: CordisXPluginIdentity
  readonly name: string
  readonly status: string
  readonly policy: CordisXPointPolicy
  readonly effectivePolicy: CordisXEffectivePointPolicy
  readonly authorized: boolean
  readonly active: boolean
  readonly registrations: readonly SurfaceContributionSnapshot[]
  readonly commands: readonly CommandSnapshot[]
  readonly routes: readonly RouteSnapshot[]
  readonly pageIds: readonly string[]
}

export interface ExtensionPointSnapshot extends HostExtensionPointProjection {
  readonly available: boolean
  readonly availabilityError?: string
  readonly usingPluginCount: number
  readonly activePluginCount: number
  readonly plugins: readonly ExtensionPointPluginUsageSnapshot[]
}

export interface ExtensionPointRuntimeSnapshot {
  readonly schemaVersion: 1
  readonly points: readonly ExtensionPointSnapshot[]
  readonly policies: readonly CordisXExtensionPointPolicyRecordV1[]
  readonly descriptorDiagnostics: readonly ExtensionPointDescriptorDiagnostic[]
  readonly policyDiagnostics: readonly ExtensionPointPolicyDiagnostic[]
  readonly accessDiagnostics: readonly ExtensionPointAccessDiagnostic[]
}

interface ExtensionPointSnapshotPlugin {
  readonly id: string
  readonly source: string
  readonly name: string
  readonly status: string
}

function commandIds(registration: SurfaceContributionSnapshot): readonly string[] {
  if (registration.item === null || typeof registration.item !== 'object') return []
  const item = registration.item as {
    command?: { id?: unknown }
    actions?: readonly { command?: { id?: unknown } }[]
  }
  const ids = [item.command?.id, ...(item.actions ?? []).map(action => action.command?.id)]
    .filter((id): id is string => typeof id === 'string')
    .map(id => qualifyOwnedId(registration.owner, id))
  return [...new Set(ids)]
}

export function buildExtensionPointRuntimeSnapshot(input: {
  readonly descriptors: ExtensionPointDescriptorRegistry
  readonly broker: ExtensionPointPolicyBroker
  readonly i18n: CordisXI18nService
  readonly plugins: readonly ExtensionPointSnapshotPlugin[]
  readonly registrations: readonly SurfaceContributionSnapshot[]
  readonly commands: readonly CommandSnapshot[]
  readonly navigation: NavigationSnapshot
}): ExtensionPointRuntimeSnapshot {
  const projections = input.descriptors.project(input.i18n)
  const points = projections.map((descriptor): ExtensionPointSnapshot => {
    const outlet = descriptor.kind === 'outlet'
      ? input.navigation.outlets.find(item => item.id === descriptor.id)
      : undefined
    const pluginUsages = input.plugins.flatMap((plugin): ExtensionPointPluginUsageSnapshot[] => {
      const registrations = descriptor.kind === 'surface'
        ? input.registrations.filter(item => item.owner === plugin.id && item.surface === descriptor.id)
        : []
      const routes = descriptor.kind === 'outlet'
        ? input.navigation.routes.filter(item => item.owner === plugin.id && item.definition.outlet === descriptor.id)
        : []
      if (registrations.length === 0 && routes.length === 0) return []
      const decision = input.broker.decision(plugin.id, descriptor.id, descriptor.kind)
      const associatedCommandIds = new Set(registrations.flatMap(commandIds))
      const commands = input.commands.filter(item => associatedCommandIds.has(item.qualifiedId))
      const pageIds = [...new Set(routes.map(route => qualifyOwnedId(route.owner, route.definition.page)))].sort()
      const active = plugin.status === 'active' && decision.authorized && (descriptor.kind === 'surface'
        ? registrations.some(item => item.valid && item.visible && item.authorized && !item.pending && item.rendered)
        : routes.some(item => item.valid && item.authorized))
      return [{
        identity: Object.freeze({ source: plugin.source, id: plugin.id }),
        name: plugin.name,
        status: plugin.status,
        policy: decision.policy,
        effectivePolicy: decision.effectivePolicy,
        authorized: decision.authorized,
        active,
        registrations,
        commands,
        routes,
        pageIds,
      }]
    }).sort((left, right) => left.name.localeCompare(right.name) || left.identity.source.localeCompare(right.identity.source) || left.identity.id.localeCompare(right.identity.id))
    return {
      ...descriptor,
      available: descriptor.kind === 'surface' ? true : outlet?.available === true,
      ...(outlet?.error === undefined ? {} : { availabilityError: outlet.error }),
      usingPluginCount: pluginUsages.length,
      activePluginCount: pluginUsages.filter(item => item.active).length,
      plugins: pluginUsages,
    }
  })
  return {
    schemaVersion: 1,
    points,
    policies: input.broker.policiesSnapshot(),
    descriptorDiagnostics: input.descriptors.diagnostics(),
    policyDiagnostics: input.broker.policyDiagnostics(),
    accessDiagnostics: input.broker.accessDiagnostics(),
  }
}

/** Identity-bound cooperative enforcement for CordisX-managed point operations. */
export class ExtensionPointPolicyBroker implements ExtensionPointAccessResolver {
  private readonly identities = new Map<string, CordisXPluginIdentity>()
  private readonly policies = new Map<string, CordisXExtensionPointPolicyRecordV1>()
  private readonly duplicatePolicyKeys = new Set<string>()
  private readonly duplicatePolicyIdentities = new Map<string, CordisXExtensionPointIdentity>()
  private readonly accesses: ExtensionPointAccessDiagnostic[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly descriptors: ExtensionPointDescriptorRegistry,
    private readonly store: ExtensionPointPolicyStore,
  ) {
    for (const record of store.read()) {
      if (!validStoredPolicy(record)) continue
      const key = extensionPointIdentityKey(record.identity)
      if (this.policies.has(key) || this.duplicatePolicyKeys.has(key)) {
        this.policies.delete(key)
        this.duplicatePolicyKeys.add(key)
        this.duplicatePolicyIdentities.set(key, immutableSnapshot(record.identity))
        continue
      }
      this.policies.set(key, immutableSnapshot(record))
    }
  }

  register(identity: CordisXPluginIdentity): () => void {
    assertLocalId(identity.id, 'extension point plugin id')
    const source = canonicalExtensionPointSource(identity.source)
    if (source !== identity.source) throw new Error(`plugin ${identity.id} source must use canonical serialization`)
    const existing = this.identities.get(identity.id)
    if (existing !== undefined && (existing.source !== identity.source || existing.id !== identity.id)) {
      throw new Error(`plugin id ${identity.id} is already bound to another source`)
    }
    const frozen = Object.freeze({ ...identity })
    this.identities.set(identity.id, frozen)
    this.changed()
    return () => {
      if (this.identities.get(identity.id) !== frozen) return
      this.identities.delete(identity.id)
      this.changed()
    }
  }

  pointPolicy(identity: CordisXExtensionPointIdentity): CordisXPointPolicy {
    const key = extensionPointIdentityKey(identity)
    if (this.duplicatePolicyKeys.has(key)) return 'inherit'
    return this.policies.get(key)?.policy ?? 'inherit'
  }

  setPolicy(identity: CordisXPluginIdentity, pointId: string, policy: CordisXPointPolicy): void {
    const bound = this.identities.get(identity.id)
    if (bound === undefined || bound.source !== identity.source) throw new Error(`plugin ${identity.id} is not bound to source ${identity.source}`)
    if (this.descriptors.descriptor(pointId) === undefined) throw new Error(`unknown extension point: ${pointId}`)
    if (!['inherit', 'allow', 'deny'].includes(policy)) throw new Error(`unknown extension point policy: ${String(policy)}`)
    const pointIdentity = Object.freeze({ source: identity.source, pluginId: identity.id, pointId })
    const record = Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
      schemaVersion: 1,
      identity: pointIdentity,
      policy,
    }) satisfies CordisXExtensionPointPolicyRecordV1
    const key = extensionPointIdentityKey(pointIdentity)
    this.duplicatePolicyKeys.delete(key)
    this.duplicatePolicyIdentities.delete(key)
    this.policies.set(key, record)
    this.store.write([...this.policies.values()].sort((left, right) => extensionPointIdentityKey(left.identity).localeCompare(extensionPointIdentityKey(right.identity))))
    this.changed()
  }

  decision(owner: string, pointId: string, expectedKind: CordisXExtensionPointKind): ExtensionPointAccessDecision {
    const plugin = this.identities.get(owner)
    const descriptor = this.descriptors.descriptor(pointId)
    if (plugin === undefined) return { policy: 'inherit', effectivePolicy: 'deny', authorized: false, reason: `plugin ${owner} has no launcher-bound source identity` }
    const identity = { source: plugin.source, pluginId: plugin.id, pointId }
    if (descriptor === undefined) return { identity, policy: this.pointPolicy(identity), effectivePolicy: 'deny', authorized: false, reason: `unknown extension point: ${pointId}` }
    if (descriptor.kind !== expectedKind) return {
      identity,
      policy: this.pointPolicy(identity),
      effectivePolicy: 'deny',
      authorized: false,
      reason: `extension point ${pointId} is ${descriptor.kind}, expected ${expectedKind}`,
    }
    if (this.duplicatePolicyKeys.has(extensionPointIdentityKey(identity))) return {
      identity,
      policy: 'inherit',
      effectivePolicy: 'deny',
      authorized: false,
      reason: `duplicate point policy identity: ${extensionPointIdentityKey(identity)}`,
    }
    const policy = this.pointPolicy(identity)
    const effectivePolicy: CordisXEffectivePointPolicy = policy === 'deny' ? 'deny' : 'allow'
    return { identity, policy, effectivePolicy, authorized: effectivePolicy === 'allow' }
  }

  authorizeSurfaceCommand(owner: string, pointId: string, contributionId: string, commandId: string): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'surface')
    return this.recordAccess(decision, {
      operation: 'surface.command.invoke', contributionId, commandId,
    })
  }

  authorizeOutletRoute(owner: string, pointId: string, routeId: string, pageId: string): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet')
    return this.recordAccess(decision, { operation: 'outlet.route.navigate', routeId, pageId })
  }

  authorizeOutletPage(owner: string, pointId: string, routeId: string, pageId: string): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet')
    return this.recordAccess(decision, { operation: 'outlet.page.mount', routeId, pageId })
  }

  authorizeOutletPageCommand(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    actionId: string,
    commandId: string,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet')
    return this.recordAccess(decision, {
      operation: 'outlet.page.command.invoke', routeId, pageId, actionId, commandId,
    })
  }

  policiesSnapshot(): readonly CordisXExtensionPointPolicyRecordV1[] {
    return [...this.policies.values()]
      .filter(record => this.descriptors.descriptor(record.identity.pointId) !== undefined)
      .sort((left, right) => extensionPointIdentityKey(left.identity).localeCompare(extensionPointIdentityKey(right.identity)))
  }

  policyDiagnostics(): readonly ExtensionPointPolicyDiagnostic[] {
    const duplicates = [...this.duplicatePolicyIdentities.values()].map(identity => ({
      code: 'duplicate-policy' as const,
      message: `duplicate point policy identity: ${extensionPointIdentityKey(identity)}`,
      identity,
    }))
    const unknown = [...this.policies.values()]
      .filter(record => this.descriptors.descriptor(record.identity.pointId) === undefined)
      .map(record => ({
        code: 'unknown-point' as const,
        message: `point policy references unknown point: ${record.identity.pointId}`,
        identity: record.identity,
      }))
    return [...duplicates, ...unknown].sort((left, right) => extensionPointIdentityKey(left.identity).localeCompare(extensionPointIdentityKey(right.identity)))
  }

  accessDiagnostics(): readonly ExtensionPointAccessDiagnostic[] { return [...this.accesses] }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.identities.clear()
    this.policies.clear()
    this.duplicatePolicyKeys.clear()
    this.duplicatePolicyIdentities.clear()
    this.accesses.length = 0
    this.listeners.clear()
  }

  private recordAccess(
    decision: ExtensionPointAccessDecision,
    operation: ExtensionPointAccessFields,
  ): ExtensionPointAccessDecision {
    if (decision.identity === undefined) return decision
    const request = Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V1,
      schemaVersion: 1,
      identity: decision.identity,
      ...operation,
    }) as CordisXExtensionPointAccessV1
    this.accesses.push(Object.freeze({
      request,
      authorized: decision.authorized,
      effectivePolicy: decision.effectivePolicy,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    }))
    if (this.accesses.length > 256) this.accesses.shift()
    return decision
  }

  private changed(): void { for (const listener of this.listeners) listener() }
}

function descriptor(
  id: string,
  kind: CordisXExtensionPointKind,
  key: string,
  fallbackTitle: string,
  fallbackDescription: string,
  icon: `host:${string}`,
): CordisXHostExtensionPointDescriptor {
  return Object.freeze({
    id,
    kind,
    title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `${key}.title`, fallback: fallbackTitle }),
    description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `${key}.description`, fallback: fallbackDescription }),
    icon,
  })
}

export const CORDISX_BUILTIN_EXTENSION_POINT_CATALOG = Object.freeze({
  $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  schemaVersion: 1,
  points: Object.freeze([
    descriptor('sidebar.footer.before-control', 'surface', 'sidebar.footer.before-control', 'Sidebar footer before control', 'Adds a compact action before the designated sidebar footer control.', 'host:open'),
    descriptor('sidebar.footer.after-control', 'surface', 'sidebar.footer.after-control', 'Sidebar footer after control', 'Adds a compact action after the designated sidebar footer control.', 'host:open'),
    descriptor('sidebar.footer.menu', 'surface', 'sidebar.footer.menu', 'Sidebar footer menu', 'Adds a host-rendered command to the designated footer control menu.', 'host:more'),
    descriptor('sidebar.account.menu', 'surface', 'sidebar.account.menu', 'Sidebar account menu', 'Adds a host-rendered command to the native account/profile menu.', 'host:more'),
    descriptor('sidebar.navigation.items', 'surface', 'sidebar.navigation.items', 'Sidebar navigation', 'Adds a navigation row with a primary action and optional independent shortcuts.', 'host:layers'),
    descriptor('workspace.toolbar.items', 'surface', 'workspace.toolbar.items', 'Workspace toolbar', 'Adds an action before, after, or inside the menu of a semantic workspace toolbar anchor.', 'host:more'),
    descriptor('environment.panel.header-actions', 'surface', 'environment.panel.header-actions', 'Environment panel header', 'Adds a command action to the environment panel header.', 'host:settings'),
    descriptor('environment.panel.sections', 'surface', 'environment.panel.sections', 'Environment panel sections', 'Adds a host-rendered section to the environment panel.', 'host:layers'),
    descriptor('environment.section.actions', 'surface', 'environment.section.actions', 'Environment section actions', 'Adds a command action to a declared environment section.', 'host:settings'),
    descriptor('environment.section.rows', 'surface', 'environment.section.rows', 'Environment section rows', 'Adds a structured label, value, description, and status row to a declared section.', 'host:info'),
    descriptor('environment.row.trailing-actions', 'surface', 'environment.row.trailing-actions', 'Environment row actions', 'Adds an independent command action to the end of a declared environment row.', 'host:more'),
    descriptor('app', 'outlet', 'outlet.app', 'Application page', 'Opens a CordisX page over the renderer application region without replacing native content.', 'host:open'),
    descriptor('main', 'outlet', 'outlet.main', 'Main workspace page', 'Opens a CordisX page over the region to the right of the sidebar and follows the current main context.', 'host:layers'),
    descriptor('session.content', 'outlet', 'outlet.session.content', 'Session content page', 'Opens a CordisX page below the active session header while preserving side and bottom panels.', 'host:history'),
  ]),
}) satisfies CordisXHostExtensionPointCatalogV1

const EN_MESSAGES = Object.fromEntries(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG.points.flatMap(point => [
  [point.title.key, point.title.fallback!],
  [point.description.key, point.description.fallback!],
]))

const ZH_MESSAGES: Readonly<Record<string, string>> = {
  'sidebar.footer.before-control.title': '侧边栏底部前置操作',
  'sidebar.footer.before-control.description': '在侧边栏底部指定控件左侧添加紧凑操作。',
  'sidebar.footer.after-control.title': '侧边栏底部后置操作',
  'sidebar.footer.after-control.description': '在侧边栏底部指定控件右侧添加紧凑操作。',
  'sidebar.footer.menu.title': '侧边栏底部菜单',
  'sidebar.footer.menu.description': '向侧边栏底部指定控件的菜单添加宿主渲染命令。',
  'sidebar.account.menu.title': '侧边栏账户菜单',
  'sidebar.account.menu.description': '向原生账户或个人资料菜单添加宿主渲染命令。',
  'sidebar.navigation.items.title': '侧边栏导航',
  'sidebar.navigation.items.description': '添加带主操作和独立快捷操作的导航条目。',
  'workspace.toolbar.items.title': '工作区工具栏',
  'workspace.toolbar.items.description': '在语义工具栏锚点前后或菜单中添加操作。',
  'environment.panel.header-actions.title': '环境面板标题操作',
  'environment.panel.header-actions.description': '向环境面板标题区添加命令操作。',
  'environment.panel.sections.title': '环境面板分区',
  'environment.panel.sections.description': '向环境面板添加由宿主渲染的分区。',
  'environment.section.actions.title': '环境分区操作',
  'environment.section.actions.description': '向已声明的环境分区添加命令操作。',
  'environment.section.rows.title': '环境分区条目',
  'environment.section.rows.description': '向已声明的分区添加结构化标签、值、说明和状态。',
  'environment.row.trailing-actions.title': '环境条目尾部操作',
  'environment.row.trailing-actions.description': '向环境条目末尾添加独立命令操作。',
  'outlet.app.title': '应用页面',
  'outlet.app.description': '在整个 renderer 应用区域上覆盖 CordisX 页面，不替换原生内容。',
  'outlet.main.title': '主工作区页面',
  'outlet.main.description': '在侧边栏右侧区域覆盖 CordisX 页面，并跟随当前主上下文。',
  'outlet.session.content.title': '会话内容页面',
  'outlet.session.content.description': '在当前会话标题下方覆盖 CordisX 页面，同时保留侧边和底部面板。',
}

export const CORDISX_EXTENSION_POINT_LOCALE_CATALOGS: readonly CordisXLocaleCatalog[] = Object.freeze([
  Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, locale: 'en', default: true, messages: Object.freeze(EN_MESSAGES) }),
  Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, locale: 'zh-CN', messages: Object.freeze(ZH_MESSAGES) }),
])
