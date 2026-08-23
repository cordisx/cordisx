import type {
  CordisXEffectivePointPolicy,
  CordisXExtensionPointAccessV2,
  CordisXExtensionPointIdentity,
  CordisXExtensionPointKind,
  CordisXExtensionPointAvailability,
  CordisXExtensionPointPolicyRecordV1,
  CordisXExtensionPointPayloadFamily,
  CordisXExtensionPointStability,
  CordisXHostExtensionPointCatalogV1,
  CordisXHostExtensionPointCatalogV2,
  CordisXHostExtensionPointAnchorDescriptorV2,
  CordisXHostExtensionPointDescriptor,
  CordisXHostExtensionPointDescriptorV2,
  CordisXLocaleCatalog,
  CordisXLocalizedText,
  CordisXLocalizedProjection,
  CordisXPointPolicy,
  CordisXPluginIdentity,
} from '../contracts.js'
import {
  CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
} from '../contracts.js'
import type { CordisXI18nService } from './i18n.js'
import type { CommandSnapshot } from './commands.js'
import type { NavigationSnapshot, RouteSnapshot } from './navigation.js'
import type { SurfaceAvailabilitySnapshot, SurfaceContributionSnapshot } from './surfaces.js'
import { qualifyOwnedId } from './ownership.js'
import { ICON_TOKEN_PATTERN, assertLocalId, assertLocalizedText, immutableSnapshot } from './validation.js'

const POINT_POLICY_STORAGE_KEY = 'cordisx.extensionPointPolicies.v1'
const DESCRIPTOR_NAMESPACE = 'cordisx.manager.extension-points'

export interface ExtensionPointDescriptorDiagnostic {
  readonly code: 'invalid-catalog' | 'invalid-descriptor' | 'duplicate-point-id'
  readonly message: string
  readonly pointId?: string
}

export interface HostExtensionPointAnchorProjection extends CordisXHostExtensionPointAnchorDescriptorV2 {
  readonly diagnosticProjection?: CordisXLocalizedProjection
}

export interface HostExtensionPointProjection extends CordisXHostExtensionPointDescriptorV2 {
  readonly titleProjection: CordisXLocalizedProjection
  readonly descriptionProjection: CordisXLocalizedProjection
  readonly diagnosticProjection?: CordisXLocalizedProjection
  readonly anchors?: readonly HostExtensionPointAnchorProjection[]
}

interface DescriptorRegistration {
  readonly descriptors: readonly CordisXHostExtensionPointDescriptorV2[]
  readonly diagnostics: readonly ExtensionPointDescriptorDiagnostic[]
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

const PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  'action', 'menu-item', 'contextual-action', 'tab', 'presenter', 'navigation-item',
  'environment-section', 'environment-row', 'outlet',
])
const STABILITIES = new Set<CordisXExtensionPointStability>(['stable', 'experimental', 'reserved'])
const AVAILABILITIES = new Set<CordisXExtensionPointAvailability>(['available', 'pending', 'unavailable'])

function normalizeAnchor(value: unknown, pointId: string): CordisXHostExtensionPointAnchorDescriptorV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`extension point ${pointId} anchor must be an object`)
  exactKeys(value, ['id', 'placements', 'availability', 'diagnostic'], `extension point ${pointId} anchor`)
  const anchor = value as Partial<CordisXHostExtensionPointAnchorDescriptorV2>
  if (typeof anchor.id !== 'string') throw new Error(`extension point ${pointId} anchor id is required`)
  assertLocalId(anchor.id, `extension point ${pointId} anchor id`)
  if (!Array.isArray(anchor.placements) || anchor.placements.length === 0 || anchor.placements.length > 3
    || anchor.placements.some(item => !['before', 'after', 'menu'].includes(item))
    || new Set(anchor.placements).size !== anchor.placements.length) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} placements are invalid`)
  }
  if (!AVAILABILITIES.has(anchor.availability as CordisXExtensionPointAvailability)) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} availability is invalid`)
  }
  if (anchor.diagnostic !== undefined) assertLocalizedText(anchor.diagnostic, `extension point ${pointId} anchor ${anchor.id} diagnostic`)
  if (anchor.availability !== 'available' && anchor.diagnostic === undefined) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} requires a diagnostic`)
  }
  return immutableSnapshot(anchor as CordisXHostExtensionPointAnchorDescriptorV2)
}

function normalizeDescriptor(value: unknown, schemaVersion: 1 | 2): CordisXHostExtensionPointDescriptorV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('descriptor must be an object')
  exactKeys(value, schemaVersion === 1
    ? ['id', 'kind', 'title', 'description', 'icon']
    : ['id', 'kind', 'title', 'description', 'icon', 'payloadFamily', 'stability', 'availability', 'diagnostic', 'anchors'], 'descriptor')
  const descriptor = value as Partial<CordisXHostExtensionPointDescriptorV2>
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
  if (schemaVersion === 1) return immutableSnapshot({
    ...(descriptor as CordisXHostExtensionPointDescriptor),
    payloadFamily: descriptor.kind === 'outlet' ? 'outlet' : 'action',
    stability: 'stable',
    availability: 'available',
  })
  if (!PAYLOAD_FAMILIES.has(descriptor.payloadFamily as CordisXExtensionPointPayloadFamily)) {
    throw new Error(`extension point ${descriptor.id} payload family is invalid`)
  }
  if ((descriptor.kind === 'outlet') !== (descriptor.payloadFamily === 'outlet')) {
    throw new Error(`extension point ${descriptor.id} payload family does not match its kind`)
  }
  if (!STABILITIES.has(descriptor.stability as CordisXExtensionPointStability)) throw new Error(`extension point ${descriptor.id} stability is invalid`)
  if (!AVAILABILITIES.has(descriptor.availability as CordisXExtensionPointAvailability)) throw new Error(`extension point ${descriptor.id} availability is invalid`)
  if (descriptor.diagnostic !== undefined) assertLocalizedText(descriptor.diagnostic, `extension point ${descriptor.id} diagnostic`)
  if (descriptor.availability !== 'available' && descriptor.diagnostic === undefined) throw new Error(`extension point ${descriptor.id} requires a diagnostic`)
  if (descriptor.stability === 'reserved' && descriptor.availability !== 'unavailable') throw new Error(`reserved extension point ${descriptor.id} must be unavailable`)
  if (descriptor.anchors !== undefined && (!Array.isArray(descriptor.anchors) || descriptor.anchors.length > 32)) {
    throw new Error(`extension point ${descriptor.id} anchors must be an array of at most 32 items`)
  }
  const pointId = descriptor.id
  const anchors = descriptor.anchors?.map(anchor => normalizeAnchor(anchor, pointId))
  if (anchors !== undefined && new Set(anchors.map(anchor => anchor.id)).size !== anchors.length) throw new Error(`extension point ${descriptor.id} has duplicate anchors`)
  return immutableSnapshot({ ...descriptor, ...(anchors === undefined ? {} : { anchors }) } as CordisXHostExtensionPointDescriptorV2)
}

/** Runtime ledger for host/adapter-owned descriptors. Invalid declarations remain diagnostic-only. */
export class ExtensionPointDescriptorRegistry {
  private readonly registrations: DescriptorRegistration[] = []
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private projectionI18n: CordisXI18nService | undefined

  registerCatalog(value: CordisXHostExtensionPointCatalogV1 | CordisXHostExtensionPointCatalogV2 | unknown): () => void {
    if (this.disposed) throw new Error('CordisX extension point descriptor registry is disposed')
    const descriptors: CordisXHostExtensionPointDescriptorV2[] = []
    const diagnostics: ExtensionPointDescriptorDiagnostic[] = []
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('catalog must be an object')
      exactKeys(value, ['$schema', 'schemaVersion', 'points'], 'extension point catalog')
      const catalog = value as Partial<CordisXHostExtensionPointCatalogV1 | CordisXHostExtensionPointCatalogV2>
      const schemaVersion = catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1 && catalog.schemaVersion === 1
        ? 1
        : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2 && catalog.schemaVersion === 2
          ? 2
          : undefined
      if (schemaVersion === undefined) {
        throw new Error('extension point catalog schema/version is unsupported')
      }
      if (!Array.isArray(catalog.points) || catalog.points.length > 256) throw new Error('extension point catalog points must be an array of at most 256 items')
      const liveIds = new Set(this.descriptors().map(item => item.id))
      for (const candidate of catalog.points) {
        try {
          const descriptor = normalizeDescriptor(candidate, schemaVersion)
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
        this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:diagnostic`)
        for (const anchor of descriptor.anchors ?? []) {
          this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:anchor:${anchor.id}:diagnostic`)
        }
      }
      const index = this.registrations.indexOf(registration)
      if (index >= 0) this.registrations.splice(index, 1)
      this.notify()
    }
  }

  descriptors(): readonly CordisXHostExtensionPointDescriptorV2[] {
    return this.registrations.flatMap(item => item.descriptors).sort((left, right) => left.id.localeCompare(right.id))
  }

  descriptor(id: string): CordisXHostExtensionPointDescriptorV2 | undefined {
    return this.descriptors().find(item => item.id === id)
  }

  diagnostics(): readonly ExtensionPointDescriptorDiagnostic[] {
    return this.registrations.flatMap(item => item.diagnostics)
  }

  project(i18n: CordisXI18nService): readonly HostExtensionPointProjection[] {
    this.projectionI18n = i18n
    return this.descriptors().map(descriptor => {
      const projectedAnchors = descriptor.anchors?.map(anchor => ({
        ...anchor,
        ...(anchor.diagnostic === undefined ? {} : {
          diagnosticProjection: i18n.resolveFor('host', anchor.diagnostic, `extension-point:${descriptor.id}:anchor:${anchor.id}:diagnostic`),
        }),
      }))
      return {
        ...descriptor,
        titleProjection: i18n.resolveFor('host', descriptor.title, `extension-point:${descriptor.id}:title`),
        descriptionProjection: i18n.resolveFor('host', descriptor.description, `extension-point:${descriptor.id}:description`),
        ...(descriptor.diagnostic === undefined ? {} : {
          diagnosticProjection: i18n.resolveFor('host', descriptor.diagnostic, `extension-point:${descriptor.id}:diagnostic`),
        }),
        ...(projectedAnchors === undefined ? {} : { anchors: projectedAnchors }),
      }
    })
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
      this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:diagnostic`)
      for (const anchor of descriptor.anchors ?? []) {
        this.projectionI18n?.clearDiagnosticSite('host', `extension-point:${descriptor.id}:anchor:${anchor.id}:diagnostic`)
      }
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
  setSurfaceAvailability(items: readonly SurfaceAvailabilitySnapshot[]): void
  authorizeSurfaceCommand(owner: string, pointId: string, contributionId: string, commandId: string): ExtensionPointAccessDecision
  authorizeSurfaceRoute(owner: string, pointId: string, contributionId: string, routeId: string): ExtensionPointAccessDecision
  authorizeOutletRoute(owner: string, pointId: string, routeId: string, pageId: string): ExtensionPointAccessDecision
  authorizeOutletPage(owner: string, pointId: string, routeId: string, pageId: string): ExtensionPointAccessDecision
  authorizeOutletPageCommand(owner: string, pointId: string, routeId: string, pageId: string, actionId: string, commandId: string): ExtensionPointAccessDecision
}

export interface ExtensionPointAccessDiagnostic {
  readonly request: CordisXExtensionPointAccessV2
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
  | { readonly operation: 'surface.route.navigate'; readonly contributionId: string; readonly routeId: string }
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
  readonly anchors?: readonly ExtensionPointAnchorSnapshot[]
  readonly available: boolean
  readonly availabilityCode?: string
  readonly availabilityDetail?: string
  /** @deprecated Use availabilityDetail. */
  readonly availabilityError?: string
  readonly usingPluginCount: number
  readonly activePluginCount: number
  readonly plugins: readonly ExtensionPointPluginUsageSnapshot[]
}

export interface ExtensionPointAnchorSnapshot extends HostExtensionPointAnchorProjection {
  readonly availabilityCode?: string
  readonly availabilityDetail?: string
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
  readonly surfaceAvailability?: readonly SurfaceAvailabilitySnapshot[]
}): ExtensionPointRuntimeSnapshot {
  const projections = input.descriptors.project(input.i18n)
  const points = projections.map((descriptor): ExtensionPointSnapshot => {
    const outlet = descriptor.kind === 'outlet'
      ? input.navigation.outlets.find(item => item.id === descriptor.id)
      : undefined
    const liveSurface = descriptor.kind === 'surface'
      ? input.surfaceAvailability?.find(item => item.surface === descriptor.id)
      : undefined
    const availability: CordisXExtensionPointAvailability = descriptor.stability === 'reserved'
      ? 'unavailable'
      : descriptor.kind === 'surface'
        ? liveSurface?.state ?? descriptor.availability
        : outlet?.available === true
          ? 'available'
          : descriptor.availability === 'available'
            ? 'unavailable'
            : descriptor.availability
    const availabilityCode = descriptor.kind === 'surface'
      ? liveSurface?.code
      : outlet?.available === true || descriptor.stability === 'reserved' ? undefined : 'outlet-unavailable'
    const availabilityDetail = descriptor.kind === 'surface'
      ? liveSurface?.detail ?? (availability === 'available' ? undefined : descriptor.diagnosticProjection?.text)
      : outlet?.error ?? (availability === 'available' ? undefined : descriptor.diagnosticProjection?.text)
    const anchors = descriptor.anchors?.map((anchor): ExtensionPointAnchorSnapshot => {
      const liveAnchor = liveSurface?.anchors?.find(item => item.id === anchor.id)
      const anchorDetail = liveAnchor?.detail ?? anchor.diagnosticProjection?.text
      return {
        ...anchor,
        availability: liveAnchor?.state ?? anchor.availability,
        ...(liveAnchor?.code === undefined ? {} : { availabilityCode: liveAnchor.code }),
        ...(anchorDetail === undefined ? {} : { availabilityDetail: anchorDetail }),
      }
    })
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
      availability,
      ...(anchors === undefined ? {} : { anchors }),
      available: availability === 'available',
      ...(availabilityCode === undefined ? {} : { availabilityCode }),
      ...(availabilityDetail === undefined ? {} : { availabilityDetail, availabilityError: availabilityDetail }),
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
  private readonly surfaceAvailability = new Map<string, SurfaceAvailabilitySnapshot>()

  constructor(
    private readonly descriptors: ExtensionPointDescriptorRegistry,
    private readonly store: ExtensionPointPolicyStore,
    private readonly generation = 'generation-legacy',
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

  setSurfaceAvailability(items: readonly SurfaceAvailabilitySnapshot[]): void {
    const next = new Map(items.map(item => [item.surface, immutableSnapshot(item)]))
    if (JSON.stringify([...this.surfaceAvailability]) === JSON.stringify([...next])) return
    this.surfaceAvailability.clear()
    for (const [pointId, item] of next) this.surfaceAvailability.set(pointId, item)
    this.changed()
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
    const availability = expectedKind === 'surface'
      ? this.surfaceAvailability.get(pointId)?.state ?? descriptor.availability
      : descriptor.availability
    if (availability !== 'available') return {
      identity,
      policy: this.pointPolicy(identity),
      effectivePolicy: 'deny',
      authorized: false,
      reason: `extension point ${pointId} is ${availability}`,
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

  authorizeSurfaceRoute(owner: string, pointId: string, contributionId: string, routeId: string): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'surface')
    return this.recordAccess(decision, { operation: 'surface.route.navigate', contributionId, routeId })
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
    this.surfaceAvailability.clear()
    this.listeners.clear()
  }

  private recordAccess(
    decision: ExtensionPointAccessDecision,
    operation: ExtensionPointAccessFields,
  ): ExtensionPointAccessDecision {
    if (decision.identity === undefined) return decision
    const request = Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
      schemaVersion: 2,
      generation: this.generation,
      identity: decision.identity,
      ...operation,
    }) as CordisXExtensionPointAccessV2
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
  payloadFamily: CordisXExtensionPointPayloadFamily,
  stability: CordisXExtensionPointStability,
  availability: CordisXExtensionPointAvailability,
  options: Readonly<{
    diagnostic?: CordisXLocalizedText
    anchors?: readonly CordisXHostExtensionPointAnchorDescriptorV2[]
  }> = {},
): CordisXHostExtensionPointDescriptorV2 {
  return Object.freeze({
    id,
    kind,
    title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `${key}.title`, fallback: fallbackTitle }),
    description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `${key}.description`, fallback: fallbackDescription }),
    icon,
    payloadFamily,
    stability,
    availability,
    ...options,
  })
}

function diagnostic(key: string, fallback: string): CordisXLocalizedText {
  return Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `diagnostic.${key}`, fallback })
}

const RESERVED = Object.freeze({ diagnostic: diagnostic('reserved', 'Reserved by the protocol; this host does not expose a safe seat.') })
const PENDING_ANCHOR = Object.freeze({ diagnostic: diagnostic('anchor', 'The native host seat is not currently resolved.') })

export const CORDISX_BUILTIN_EXTENSION_POINT_CATALOG = Object.freeze({
  $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
  schemaVersion: 2,
  points: Object.freeze([
    descriptor('sidebar.footer.before-control', 'surface', 'sidebar.footer.before-control', 'Sidebar footer before control', 'Adds a compact action before the designated sidebar footer control.', 'host:open', 'action', 'stable', 'available'),
    descriptor('sidebar.footer.after-control', 'surface', 'sidebar.footer.after-control', 'Sidebar footer after control', 'Adds a compact action after the designated sidebar footer control.', 'host:open', 'action', 'stable', 'available'),
    descriptor('sidebar.footer.menu', 'surface', 'sidebar.footer.menu', 'Sidebar footer menu', 'Adds a host-rendered command to the designated footer control menu.', 'host:more', 'menu-item', 'stable', 'available'),
    descriptor('sidebar.account.menu', 'surface', 'sidebar.account.menu', 'Sidebar account menu', 'Adds a host-rendered command to the native account/profile menu.', 'host:more', 'menu-item', 'stable', 'available'),
    descriptor('sidebar.navigation.items', 'surface', 'sidebar.navigation.items', 'Sidebar navigation', 'Adds a navigation row with a primary action and optional independent shortcuts.', 'host:layers', 'navigation-item', 'stable', 'available'),
    descriptor('sidebar.workspace.menu', 'surface', 'sidebar.workspace.menu', 'Workspace menu', 'Adds host-rendered items to the native workspace menu when its seat is resolved.', 'host:more', 'menu-item', 'experimental', 'pending', PENDING_ANCHOR),
    descriptor('sidebar.session.actions', 'surface', 'sidebar.session.actions', 'Session row actions', 'Adds contextual actions to an identified native session row.', 'host:more', 'contextual-action', 'reserved', 'unavailable', RESERVED),
    descriptor('sidebar.session.menu', 'surface', 'sidebar.session.menu', 'Session row menu', 'Adds contextual items to an identified native session menu.', 'host:more', 'contextual-action', 'reserved', 'unavailable', RESERVED),
    descriptor('workspace.toolbar.items', 'surface', 'workspace.toolbar.items', 'Workspace toolbar', 'Adds an action before, after, or inside the menu of a semantic workspace toolbar anchor.', 'host:more', 'action', 'stable', 'available', {
      anchors: Object.freeze([{ id: 'workspace.primary', placements: Object.freeze(['before', 'after', 'menu'] as const), availability: 'available' }]),
    }),
    descriptor('session.header.actions', 'surface', 'session.header.actions', 'Session header actions', 'Adds host-rendered action and utility groups to the active native session header.', 'host:more', 'contextual-action', 'stable', 'available'),
    descriptor('session.tabs', 'surface', 'session.tabs', 'Session tabs', 'Adds controlled view entries navigated and rendered by the host.', 'host:layers', 'tab', 'reserved', 'unavailable', RESERVED),
    descriptor('session.banner.items', 'surface', 'session.banner.items', 'Session banners', 'Adds limited structured banners to the active session.', 'host:info', 'presenter', 'reserved', 'unavailable', RESERVED),
    descriptor('session.message.actions', 'surface', 'session.message.actions', 'Message actions', 'Adds contextual actions to a canonically identified message.', 'host:more', 'contextual-action', 'reserved', 'unavailable', { diagnostic: diagnostic('message-identity', 'Canonical message identity is unavailable.') }),
    descriptor('session.turn.footer', 'surface', 'session.turn.footer', 'Turn footer', 'Adds a structured presenter after a canonically identified turn.', 'host:info', 'presenter', 'reserved', 'unavailable', RESERVED),
    descriptor('session.tool.actions', 'surface', 'session.tool.actions', 'Tool actions', 'Adds contextual actions to a canonically identified tool item.', 'host:more', 'contextual-action', 'reserved', 'unavailable', { diagnostic: diagnostic('tool-identity', 'Canonical tool identity is unavailable.') }),
    descriptor('composer.toolbar.items', 'surface', 'composer.toolbar.items', 'Composer toolbar', 'Adds a host-rendered action at a verified semantic composer anchor.', 'host:more', 'contextual-action', 'stable', 'available', {
      anchors: Object.freeze([
        { id: 'submit', placements: Object.freeze(['before'] as const), availability: 'available' },
        { id: 'leading', placements: Object.freeze(['before', 'after'] as const), availability: 'pending', diagnostic: diagnostic('anchor-unverified', 'This anchor is not release-verified.') },
        { id: 'model', placements: Object.freeze(['before', 'after', 'menu'] as const), availability: 'pending', diagnostic: diagnostic('anchor-unverified', 'This anchor is not release-verified.') },
      ]),
    }),
    descriptor('composer.command-menu.items', 'surface', 'composer.command-menu.items', 'Composer command menu', 'Adds host-rendered items to the existing native composer command menu.', 'host:more', 'contextual-action', 'experimental', 'pending', PENDING_ANCHOR),
    descriptor('composer.dock.above', 'surface', 'composer.dock.above', 'Composer dock above', 'Adds a limited structured presenter above the composer.', 'host:info', 'presenter', 'experimental', 'pending', PENDING_ANCHOR),
    descriptor('composer.dock.below', 'surface', 'composer.dock.below', 'Composer dock below', 'Adds a limited structured presenter below the composer.', 'host:info', 'presenter', 'experimental', 'pending', PENDING_ANCHOR),
    descriptor('panel.right.header-actions', 'surface', 'panel.right.header-actions', 'Right panel actions', 'Adds contextual actions to a verified visible right panel header.', 'host:more', 'contextual-action', 'experimental', 'pending', PENDING_ANCHOR),
    descriptor('panel.right.tabs', 'surface', 'panel.right.tabs', 'Right panel tabs', 'Adds host-controlled tabs to the right panel.', 'host:layers', 'tab', 'reserved', 'unavailable', RESERVED),
    descriptor('panel.bottom.header-actions', 'surface', 'panel.bottom.header-actions', 'Bottom panel actions', 'Adds contextual actions to a verified visible bottom panel header.', 'host:more', 'contextual-action', 'experimental', 'pending', PENDING_ANCHOR),
    descriptor('panel.bottom.tabs', 'surface', 'panel.bottom.tabs', 'Bottom panel tabs', 'Adds host-controlled tabs to the bottom panel.', 'host:layers', 'tab', 'reserved', 'unavailable', RESERVED),
    descriptor('environment.panel.header-actions', 'surface', 'environment.panel.header-actions', 'Environment panel header', 'Adds a command action to the environment panel header.', 'host:settings', 'action', 'stable', 'available'),
    descriptor('environment.panel.sections', 'surface', 'environment.panel.sections', 'Environment panel sections', 'Adds a host-rendered section to the environment panel.', 'host:layers', 'environment-section', 'stable', 'available'),
    descriptor('environment.section.actions', 'surface', 'environment.section.actions', 'Environment section actions', 'Adds a command action to a declared environment section.', 'host:settings', 'action', 'stable', 'available'),
    descriptor('environment.section.rows', 'surface', 'environment.section.rows', 'Environment section rows', 'Adds a structured label, value, description, and status row to a declared section.', 'host:info', 'environment-row', 'stable', 'available'),
    descriptor('environment.row.trailing-actions', 'surface', 'environment.row.trailing-actions', 'Environment row actions', 'Adds an independent command action to the end of a declared environment row.', 'host:more', 'action', 'stable', 'available'),
    descriptor('app', 'outlet', 'outlet.app', 'Application page', 'Opens a CordisX page over the renderer application region without replacing native content.', 'host:open', 'outlet', 'stable', 'available'),
    descriptor('main', 'outlet', 'outlet.main', 'Main workspace page', 'Opens a CordisX page over the region to the right of the sidebar and follows the current main context.', 'host:layers', 'outlet', 'stable', 'available'),
    descriptor('session.content', 'outlet', 'outlet.session.content', 'Session content page', 'Opens a CordisX page below the active session header while preserving side and bottom panels.', 'host:history', 'outlet', 'stable', 'available'),
    descriptor('panel.right.content', 'outlet', 'outlet.panel.right.content', 'Right panel content', 'Hosts controlled trusted-local page content in the right panel.', 'host:layers', 'outlet', 'reserved', 'unavailable', RESERVED),
    descriptor('panel.bottom.content', 'outlet', 'outlet.panel.bottom.content', 'Bottom panel content', 'Hosts controlled trusted-local page content in the bottom panel.', 'host:layers', 'outlet', 'reserved', 'unavailable', RESERVED),
  ]),
}) satisfies CordisXHostExtensionPointCatalogV2

const EN_MESSAGES = Object.fromEntries(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG.points.flatMap(point => [
  [point.title.key, point.title.fallback!],
  [point.description.key, point.description.fallback!],
  ...(point.diagnostic === undefined ? [] : [[point.diagnostic.key, point.diagnostic.fallback!]]),
  ...(point.anchors ?? []).flatMap(anchor => anchor.diagnostic === undefined ? [] : [[anchor.diagnostic.key, anchor.diagnostic.fallback!]]),
]))

const ZH_MESSAGES: Readonly<Record<string, string>> = {
  ...EN_MESSAGES,
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
  'session.header.actions.title': '会话标题操作',
  'session.header.actions.description': '向当前原生会话标题添加由宿主渲染的操作和工具分组。',
  'composer.toolbar.items.title': '输入区工具栏',
  'composer.toolbar.items.description': '在已验证的语义输入区锚点添加由宿主渲染的操作。',
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
  'diagnostic.anchor': '当前未定位到原生宿主点位。',
  'diagnostic.anchor-unverified': '该锚点尚未通过发布验证。',
  'diagnostic.message-identity': '当前无法取得规范消息标识。',
  'diagnostic.reserved': '协议已保留该点位；当前宿主未开放安全位置。',
  'diagnostic.tool-identity': '当前无法取得规范工具标识。',
}

export const CORDISX_EXTENSION_POINT_LOCALE_CATALOGS: readonly CordisXLocaleCatalog[] = Object.freeze([
  Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, locale: 'en', default: true, messages: Object.freeze(EN_MESSAGES) }),
  Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, locale: 'zh-CN', messages: Object.freeze(ZH_MESSAGES) }),
])
