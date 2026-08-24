import type {
  CordisXEffectivePointPolicy,
  CordisXExtensionPointAccessV2,
  CordisXExtensionPointIdentity,
  CordisXExtensionPointKind,
  CordisXExtensionPointAvailability,
  CordisXExtensionPointAdapterSupport,
  CordisXExtensionPointCurrentContextState,
  CordisXExtensionPointMaturity,
  CordisXExtensionPointRuntimeContextV1,
  CordisXExtensionPointPolicyRecordV1,
  CordisXExtensionPointPayloadFamily,
  CordisXExtensionPointStability,
  CordisXHostExtensionPointCatalogV1,
  CordisXHostExtensionPointCatalogV2,
  CordisXHostExtensionPointCatalogV3,
  CordisXHostExtensionPointCatalogV5,
  CordisXHostExtensionPointAnchorDescriptorV2,
  CordisXHostExtensionPointAnchorDescriptorV5,
  CordisXHostExtensionPointDescriptor,
  CordisXHostExtensionPointDescriptorV3,
  CordisXHostExtensionPointDescriptorV5,
  CordisXLocaleCatalog,
  CordisXLocalizedText,
  CordisXLocalizedProjection,
  CordisXPointPolicy,
  CordisXPluginIdentity,
} from '../contracts.js'
import {
  CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
  CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
} from '../contracts.js'
import type { CordisXI18nService } from './i18n.js'
import type { CommandSnapshot } from './commands.js'
import type { NavigationSnapshot, RouteSnapshot } from './navigation.js'
import type { SurfaceCurrentContextSnapshot, SurfaceContributionSnapshot } from './surfaces.js'
import { qualifyOwnedId } from './ownership.js'
import type {
  GenerationVisibilityCoordinator,
  PluginGenerationEffectIdentity,
  PluginGenerationView,
} from './generation-visibility.js'
import { ICON_TOKEN_PATTERN, assertLocalId, assertLocalizedText, immutableSnapshot } from './validation.js'

const POINT_POLICY_STORAGE_KEY = 'cordisx.extensionPointPolicies.v1'
const DESCRIPTOR_NAMESPACE = 'cordisx.manager.extension-points'

function catalogMessage(key: string, fallback: string): CordisXLocalizedText {
  return Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key, fallback })
}

const CATALOG_TEXT = Object.freeze({
  categorySurface: catalogMessage('catalog.category.surface', 'Surface'),
  categoryOutlet: catalogMessage('catalog.category.outlet', 'Page outlet'),
  ownerHost: catalogMessage('catalog.owner.host', 'CordisX Host'),
  statusPending: catalogMessage('catalog.status.pending', 'Pending location'),
  statusUnavailable: catalogMessage('catalog.status.unavailable', 'Unavailable'),
  statusError: catalogMessage('catalog.status.error', 'Needs attention'),
  statusDenied: catalogMessage('catalog.status.denied', 'Access denied'),
})

export interface ExtensionPointDescriptorDiagnostic {
  readonly code: 'invalid-catalog' | 'invalid-descriptor' | 'duplicate-point-id'
  readonly message: string
  readonly pointId?: string
}

export interface HostExtensionPointAnchorProjection extends CordisXHostExtensionPointAnchorDescriptorV5 {
  readonly diagnosticProjection?: CordisXLocalizedProjection
}

export interface HostExtensionPointProjection extends CordisXHostExtensionPointDescriptorV5 {
  readonly titleProjection: CordisXLocalizedProjection
  readonly descriptionProjection: CordisXLocalizedProjection
  readonly diagnosticProjection?: CordisXLocalizedProjection
  readonly anchors?: readonly HostExtensionPointAnchorProjection[]
}

export interface ExtensionPointCatalogTextProjection {
  readonly category: Readonly<Record<CordisXExtensionPointKind, CordisXLocalizedProjection>>
  readonly owner: Readonly<{ host: CordisXLocalizedProjection }>
  readonly status: Readonly<{
    pending: CordisXLocalizedProjection
    unavailable: CordisXLocalizedProjection
    error: CordisXLocalizedProjection
    denied: CordisXLocalizedProjection
  }>
}

interface DescriptorRegistration {
  readonly descriptors: readonly CordisXHostExtensionPointDescriptorV5[]
  readonly diagnostics: readonly ExtensionPointDescriptorDiagnostic[]
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

const PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  'action', 'menu-item', 'contextual-action', 'tab', 'presenter', 'navigation-item',
  'manager-settings-tab', 'manager-settings-content-tab', 'manager-settings-navigation-item',
  'environment-section', 'environment-row', 'outlet',
])
const V5_PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  'action', 'menu-item', 'contextual-action', 'tab', 'manager-settings-content-tab',
  'manager-settings-navigation-item', 'presenter', 'navigation-item',
  'environment-section', 'environment-row', 'outlet',
])
const AVAILABILITIES = new Set<CordisXExtensionPointAvailability>(['available', 'pending', 'unavailable'])
const MATURITIES = new Set<CordisXExtensionPointMaturity>(['stable', 'experimental', 'reserved'])
const ADAPTER_SUPPORT = new Set<CordisXExtensionPointAdapterSupport>(['supported', 'unsupported', 'unverified'])
const REQUIRED_DESCRIPTOR_LOCALES = Object.freeze(['en', 'zh-CN'] as const)

function messageNamespace(message: CordisXLocalizedText): string {
  return message.namespace ?? 'host'
}

function descriptorMessages(descriptor: CordisXHostExtensionPointDescriptorV5): readonly CordisXLocalizedText[] {
  return [
    descriptor.title,
    descriptor.description,
    ...(descriptor.diagnostic === undefined ? [] : [descriptor.diagnostic]),
    ...(descriptor.anchors ?? []).flatMap(anchor => anchor.diagnostic === undefined ? [] : [anchor.diagnostic]),
  ]
}

/** Fail closed when public descriptor text cannot be projected in every required Host locale. */
export function assertExtensionPointDescriptorLocalization(
  descriptor: CordisXHostExtensionPointDescriptorV5,
  catalogs: readonly CordisXLocaleCatalog[],
): void {
  for (const message of descriptorMessages(descriptor)) {
    const namespace = messageNamespace(message)
    for (const locale of REQUIRED_DESCRIPTOR_LOCALES) {
      const catalog = catalogs.find(item => item.namespace === namespace && item.locale === locale)
      const translated = catalog?.messages[message.key]
      if (typeof translated !== 'string' || translated.trim() === '') {
        throw new Error(`extension point ${descriptor.id} message ${namespace}:${message.key} requires ${locale} localization`)
      }
    }
  }
}

function legacyAdapterSupport(availability: CordisXExtensionPointAvailability): CordisXExtensionPointAdapterSupport {
  return availability === 'available' ? 'supported' : availability === 'pending' ? 'unverified' : 'unsupported'
}

function normalizeAnchor(value: unknown, pointId: string, schemaVersion: 1 | 2 | 3 | 5): CordisXHostExtensionPointAnchorDescriptorV5 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`extension point ${pointId} anchor must be an object`)
  exactKeys(value, schemaVersion === 5
    ? ['id', 'placements', 'adapterSupport', 'diagnostic']
    : ['id', 'placements', 'availability', 'diagnostic'], `extension point ${pointId} anchor`)
  const anchor = value as Partial<CordisXHostExtensionPointAnchorDescriptorV2 & CordisXHostExtensionPointAnchorDescriptorV5>
  if (typeof anchor.id !== 'string') throw new Error(`extension point ${pointId} anchor id is required`)
  assertLocalId(anchor.id, `extension point ${pointId} anchor id`)
  if (!Array.isArray(anchor.placements) || anchor.placements.length === 0 || anchor.placements.length > 3
    || anchor.placements.some(item => !['before', 'after', 'menu'].includes(item))
    || new Set(anchor.placements).size !== anchor.placements.length) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} placements are invalid`)
  }
  const adapterSupport = schemaVersion === 5
    ? anchor.adapterSupport
    : AVAILABILITIES.has(anchor.availability as CordisXExtensionPointAvailability)
      ? legacyAdapterSupport(anchor.availability as CordisXExtensionPointAvailability)
      : undefined
  if (!ADAPTER_SUPPORT.has(adapterSupport as CordisXExtensionPointAdapterSupport)) throw new Error(`extension point ${pointId} anchor ${anchor.id} adapter support is invalid`)
  if (anchor.diagnostic !== undefined) assertLocalizedText(anchor.diagnostic, `extension point ${pointId} anchor ${anchor.id} diagnostic`)
  if (adapterSupport !== 'supported' && anchor.diagnostic === undefined) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} requires a diagnostic`)
  }
  return immutableSnapshot({
    id: anchor.id,
    placements: anchor.placements,
    adapterSupport,
    ...(anchor.diagnostic === undefined ? {} : { diagnostic: anchor.diagnostic }),
  } as CordisXHostExtensionPointAnchorDescriptorV5)
}

function normalizeDescriptor(value: unknown, schemaVersion: 1 | 2 | 3 | 5): CordisXHostExtensionPointDescriptorV5 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('descriptor must be an object')
  exactKeys(value, schemaVersion === 1
    ? ['id', 'kind', 'title', 'description', 'icon']
    : schemaVersion === 2
      ? ['id', 'kind', 'title', 'description', 'icon', 'payloadFamily', 'stability', 'availability', 'diagnostic', 'anchors']
      : schemaVersion === 3
        ? ['id', 'kind', 'title', 'description', 'icon', 'payloadFamily', 'stability', 'availability', 'diagnostic', 'anchors', 'pageChrome', 'presentationGroup', 'routePathFamily']
        : ['id', 'kind', 'title', 'description', 'icon', 'payloadFamily', 'maturity', 'adapterSupport', 'diagnostic', 'anchors', 'pageChrome', 'presentationGroup', 'routePathFamily'], 'descriptor')
  const descriptor = value as Partial<CordisXHostExtensionPointDescriptorV3 & CordisXHostExtensionPointDescriptorV5>
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
  const payloadFamily = schemaVersion === 1 ? descriptor.kind === 'outlet' ? 'outlet' : 'action' : descriptor.payloadFamily
  const payloadFamilies = schemaVersion === 5 ? V5_PAYLOAD_FAMILIES : PAYLOAD_FAMILIES
  if (!payloadFamilies.has(payloadFamily as CordisXExtensionPointPayloadFamily)) {
    throw new Error(`extension point ${descriptor.id} payload family is invalid`)
  }
  if ((descriptor.kind === 'outlet') !== (payloadFamily === 'outlet')) {
    throw new Error(`extension point ${descriptor.id} payload family does not match its kind`)
  }
  const maturity = schemaVersion === 1 ? 'stable' : schemaVersion === 5 ? descriptor.maturity : descriptor.stability
  const adapterSupport = schemaVersion === 1
    ? 'supported'
    : schemaVersion === 5
      ? descriptor.adapterSupport
      : AVAILABILITIES.has(descriptor.availability as CordisXExtensionPointAvailability)
        ? legacyAdapterSupport(descriptor.availability as CordisXExtensionPointAvailability)
        : undefined
  if (!MATURITIES.has(maturity as CordisXExtensionPointMaturity)) throw new Error(`extension point ${descriptor.id} maturity is invalid`)
  if (!ADAPTER_SUPPORT.has(adapterSupport as CordisXExtensionPointAdapterSupport)) throw new Error(`extension point ${descriptor.id} adapter support is invalid`)
  if (descriptor.diagnostic !== undefined) assertLocalizedText(descriptor.diagnostic, `extension point ${descriptor.id} diagnostic`)
  if (adapterSupport !== 'supported' && descriptor.diagnostic === undefined) throw new Error(`extension point ${descriptor.id} requires a diagnostic`)
  if (maturity === 'stable' && adapterSupport !== 'supported') throw new Error(`stable extension point ${descriptor.id} must be supported`)
  if (maturity === 'reserved' && adapterSupport !== 'unsupported') throw new Error(`reserved extension point ${descriptor.id} must be unsupported`)
  if (descriptor.anchors !== undefined && (!Array.isArray(descriptor.anchors) || descriptor.anchors.length > 32)) {
    throw new Error(`extension point ${descriptor.id} anchors must be an array of at most 32 items`)
  }
  const pointId = descriptor.id
  const anchors = descriptor.anchors?.map(anchor => normalizeAnchor(anchor, pointId, schemaVersion))
  if (anchors !== undefined && new Set(anchors.map(anchor => anchor.id)).size !== anchors.length) throw new Error(`extension point ${descriptor.id} has duplicate anchors`)
  if (schemaVersion === 3 || schemaVersion === 5) {
    if (descriptor.kind === 'outlet') {
      if (!Array.isArray(descriptor.pageChrome) || descriptor.pageChrome.length === 0 || descriptor.pageChrome.length > 2
        || descriptor.pageChrome.some(item => item !== 'standard' && item !== 'body-only')
        || new Set(descriptor.pageChrome).size !== descriptor.pageChrome.length) {
        throw new Error(`extension point ${descriptor.id} page chrome is invalid`)
      }
      if (descriptor.presentationGroup === undefined) throw new Error(`extension point ${descriptor.id} presentation group is required`)
      assertLocalId(descriptor.presentationGroup, `extension point ${descriptor.id} presentation group`)
      if (!['app', 'main', 'session', 'manager-settings', 'manager', 'host-defined'].includes(String(descriptor.routePathFamily))) {
        throw new Error(`extension point ${descriptor.id} route path family is invalid`)
      }
    } else if (descriptor.pageChrome !== undefined || descriptor.presentationGroup !== undefined || descriptor.routePathFamily !== undefined) {
      throw new Error(`surface extension point ${descriptor.id} cannot declare outlet compatibility fields`)
    }
  }
  const outletCompatibility = descriptor.kind !== 'outlet' ? {} : {
    pageChrome: schemaVersion === 1 || schemaVersion === 2 ? Object.freeze(['standard'] as const) : descriptor.pageChrome,
    presentationGroup: schemaVersion === 1 || schemaVersion === 2 ? 'legacy' : descriptor.presentationGroup,
    routePathFamily: schemaVersion === 1 || schemaVersion === 2 ? 'host-defined' as const : descriptor.routePathFamily,
  }
  return immutableSnapshot({
    id: descriptor.id,
    kind: descriptor.kind,
    title: descriptor.title,
    description: descriptor.description,
    icon: descriptor.icon,
    payloadFamily,
    maturity,
    adapterSupport,
    ...(descriptor.diagnostic === undefined ? {} : { diagnostic: descriptor.diagnostic }),
    ...(anchors === undefined ? {} : { anchors }),
    ...outletCompatibility,
  } as CordisXHostExtensionPointDescriptorV5)
}

/** Runtime ledger for host/adapter-owned descriptors. Invalid declarations remain diagnostic-only. */
export class ExtensionPointDescriptorRegistry {
  private readonly registrations: DescriptorRegistration[] = []
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private projectionI18n: CordisXI18nService | undefined

  constructor(private readonly localeCatalogs: readonly CordisXLocaleCatalog[]) {
    if (!Array.isArray(localeCatalogs) || localeCatalogs.length === 0) {
      throw new Error('CordisX extension point descriptor registry requires locale catalogs')
    }
  }

  registerCatalog(value: CordisXHostExtensionPointCatalogV1 | CordisXHostExtensionPointCatalogV2 | CordisXHostExtensionPointCatalogV3 | CordisXHostExtensionPointCatalogV5 | unknown): () => void {
    if (this.disposed) throw new Error('CordisX extension point descriptor registry is disposed')
    const descriptors: CordisXHostExtensionPointDescriptorV5[] = []
    const diagnostics: ExtensionPointDescriptorDiagnostic[] = []
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('catalog must be an object')
      exactKeys(value, ['$schema', 'schemaVersion', 'points'], 'extension point catalog')
      const catalog = value as Partial<CordisXHostExtensionPointCatalogV1 | CordisXHostExtensionPointCatalogV2 | CordisXHostExtensionPointCatalogV3 | CordisXHostExtensionPointCatalogV5>
      const schemaVersion = catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1 && catalog.schemaVersion === 1
        ? 1
        : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2 && catalog.schemaVersion === 2
          ? 2
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3 && catalog.schemaVersion === 3
            ? 3
            : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5 && catalog.schemaVersion === 5
              ? 5
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
          assertExtensionPointDescriptorLocalization(descriptor, this.localeCatalogs)
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

  descriptors(): readonly CordisXHostExtensionPointDescriptorV5[] {
    return this.registrations.flatMap(item => item.descriptors).sort((left, right) => left.id.localeCompare(right.id))
  }

  descriptor(id: string): CordisXHostExtensionPointDescriptorV5 | undefined {
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
  decision(owner: string, pointId: string, expectedKind: CordisXExtensionPointKind, view?: PluginGenerationView): ExtensionPointAccessDecision
  surfaceAnchorSupport(pointId: string, anchorId: string): Readonly<{ supported: boolean; reason?: string }>
  authorizeSurfaceCommand(owner: string, pointId: string, contributionId: string, commandId: string, view?: PluginGenerationView): ExtensionPointAccessDecision
  authorizeSurfaceRoute(owner: string, pointId: string, contributionId: string, routeId: string, view?: PluginGenerationView): ExtensionPointAccessDecision
  authorizeOutletRoute(owner: string, pointId: string, routeId: string, pageId: string, view?: PluginGenerationView): ExtensionPointAccessDecision
  authorizeOutletPage(owner: string, pointId: string, routeId: string, pageId: string, view?: PluginGenerationView): ExtensionPointAccessDecision
  authorizeOutletPageCommand(owner: string, pointId: string, routeId: string, pageId: string, actionId: string, commandId: string, view?: PluginGenerationView): ExtensionPointAccessDecision
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
  readonly description?: string
  readonly status: string
  readonly policy: CordisXPointPolicy
  readonly effectivePolicy: CordisXEffectivePointPolicy
  readonly authorized: boolean
  readonly active: boolean
  readonly registrations: readonly ExtensionPointContributionSnapshot[]
  readonly commands: readonly CommandSnapshot[]
  readonly routes: readonly RouteSnapshot[]
  readonly pageIds: readonly string[]
}

export interface ExtensionPointContributionSnapshot extends SurfaceContributionSnapshot {
  /** Current-locale product text projected by the Host; identity remains the raw id below it. */
  readonly titleText: string
  readonly descriptionText?: string
}

export interface ExtensionPointSnapshot extends HostExtensionPointProjection {
  readonly anchors?: readonly ExtensionPointAnchorSnapshot[]
  readonly currentContext: CordisXExtensionPointCurrentContextState
  readonly currentContextCode?: string
  readonly currentContextDetail?: string
  readonly effectiveAdapterSupport: CordisXExtensionPointAdapterSupport
  /** @deprecated Manager compatibility alias for maturity. */
  readonly stability: CordisXExtensionPointStability
  /** @deprecated Manager compatibility projection of adapter support and current context. */
  readonly availability: CordisXExtensionPointAvailability
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
  readonly currentContext: CordisXExtensionPointCurrentContextState
  readonly effectiveAdapterSupport: CordisXExtensionPointAdapterSupport
  /** @deprecated Manager compatibility projection. */
  readonly availability: CordisXExtensionPointAvailability
  readonly availabilityCode?: string
  readonly availabilityDetail?: string
}

export interface ExtensionPointRuntimeSnapshot {
  readonly schemaVersion: 1
  readonly currentContext: CordisXExtensionPointRuntimeContextV1
  readonly catalogText: ExtensionPointCatalogTextProjection
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
  readonly description?: string
  readonly status: string
}

function localizedContributionField(
  registration: SurfaceContributionSnapshot,
  keys: readonly string[],
): CordisXLocalizedText | undefined {
  if (registration.item === null || typeof registration.item !== 'object' || Array.isArray(registration.item)) return undefined
  const item = registration.item as Readonly<Record<string, unknown>>
  for (const key of keys) {
    const value = item[key]
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
    const message = value as Partial<CordisXLocalizedText>
    if (typeof message.key === 'string') return message as CordisXLocalizedText
  }
  return undefined
}

function projectContribution(
  registration: SurfaceContributionSnapshot,
  i18n: CordisXI18nService,
): ExtensionPointContributionSnapshot {
  const title = localizedContributionField(registration, ['label', 'title', 'text'])
  const description = localizedContributionField(registration, ['description', 'detail'])
  const locale = i18n.getSnapshot().locale.toLocaleLowerCase()
  const titleText = title === undefined
    ? locale.startsWith('zh') ? '未提供显示名称' : 'Display name unavailable'
    : i18n.resolveFor(registration.owner, title, `extension-point:contribution:${registration.qualifiedId}:title`).text
  const descriptionText = description === undefined
    ? undefined
    : i18n.resolveFor(registration.owner, description, `extension-point:contribution:${registration.qualifiedId}:description`).text
  return {
    ...registration,
    titleText,
    ...(descriptionText === undefined ? {} : { descriptionText }),
  }
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
  readonly surfaceCurrentContext?: readonly SurfaceCurrentContextSnapshot[]
  /** @deprecated Use surfaceCurrentContext. */
  readonly surfaceAvailability?: readonly SurfaceCurrentContextSnapshot[]
}): ExtensionPointRuntimeSnapshot {
  const projections = input.descriptors.project(input.i18n)
  const catalogText: ExtensionPointCatalogTextProjection = {
    category: {
      surface: input.i18n.resolveFor('host', CATALOG_TEXT.categorySurface, 'extension-point:catalog:category:surface'),
      outlet: input.i18n.resolveFor('host', CATALOG_TEXT.categoryOutlet, 'extension-point:catalog:category:outlet'),
    },
    owner: {
      host: input.i18n.resolveFor('host', CATALOG_TEXT.ownerHost, 'extension-point:catalog:owner:host'),
    },
    status: {
      pending: input.i18n.resolveFor('host', CATALOG_TEXT.statusPending, 'extension-point:catalog:status:pending'),
      unavailable: input.i18n.resolveFor('host', CATALOG_TEXT.statusUnavailable, 'extension-point:catalog:status:unavailable'),
      error: input.i18n.resolveFor('host', CATALOG_TEXT.statusError, 'extension-point:catalog:status:error'),
      denied: input.i18n.resolveFor('host', CATALOG_TEXT.statusDenied, 'extension-point:catalog:status:denied'),
    },
  }
  const points = projections.map((descriptor): ExtensionPointSnapshot => {
    const outlet = descriptor.kind === 'outlet'
      ? input.navigation.outlets.find(item => item.id === descriptor.id)
      : undefined
    const liveSurface = descriptor.kind === 'surface'
      ? (input.surfaceCurrentContext ?? input.surfaceAvailability)?.find(item => item.surface === descriptor.id)
      : undefined
    const observedContext: CordisXExtensionPointCurrentContextState = descriptor.kind === 'surface'
      ? liveSurface?.state ?? 'not-mounted'
      : outlet?.available !== true
        ? 'not-mounted'
        : outlet.mounted ? 'active' : 'inactive'
    const currentContext: CordisXExtensionPointCurrentContextState = descriptor.adapterSupport === 'supported'
      ? observedContext
      : 'not-mounted'
    const currentContextCode = descriptor.kind === 'surface'
      ? liveSurface?.code
      : currentContext === 'not-mounted' ? 'outlet.not-mounted' : undefined
    const currentContextDetail = descriptor.kind === 'surface'
      ? liveSurface?.detail === undefined ? undefined : liveSurface.detail.fallback ?? liveSurface.detail.key
      : outlet?.error
    const effectiveAdapterSupport: CordisXExtensionPointAdapterSupport = descriptor.adapterSupport === 'supported'
      && currentContextCode === 'anchor.unresolved'
      ? 'unverified'
      : descriptor.adapterSupport
    const availability: CordisXExtensionPointAvailability = effectiveAdapterSupport === 'supported'
      ? 'available'
      : effectiveAdapterSupport === 'unverified' ? 'pending' : 'unavailable'
    const availabilityCode = currentContextCode ?? (descriptor.adapterSupport === 'supported' ? undefined : `adapter.${descriptor.adapterSupport}`)
    const availabilityDetail = currentContextDetail ?? (descriptor.adapterSupport === 'supported' ? undefined : descriptor.diagnosticProjection?.text)
    const anchors = descriptor.anchors?.map((anchor): ExtensionPointAnchorSnapshot => {
      const liveAnchor = liveSurface?.anchors?.find(item => item.id === anchor.id)
      const anchorContext = anchor.adapterSupport === 'supported' ? liveAnchor?.state ?? 'not-mounted' : 'not-mounted'
      const effectiveAnchorSupport: CordisXExtensionPointAdapterSupport = anchor.adapterSupport === 'supported'
        && liveAnchor?.code === 'anchor.unresolved'
        ? 'unverified'
        : anchor.adapterSupport
      const anchorDetail = liveAnchor?.detail === undefined
        ? anchor.adapterSupport === 'supported' ? undefined : anchor.diagnosticProjection?.text
        : liveAnchor.detail.fallback ?? liveAnchor.detail.key
      return {
        ...anchor,
        currentContext: anchorContext,
        effectiveAdapterSupport: effectiveAnchorSupport,
        availability: effectiveAnchorSupport === 'supported' ? 'available' : effectiveAnchorSupport === 'unverified' ? 'pending' : 'unavailable',
        ...(liveAnchor?.code === undefined ? {} : { availabilityCode: liveAnchor.code }),
        ...(anchorDetail === undefined ? {} : { availabilityDetail: anchorDetail }),
      }
    })
    const pluginUsages = input.plugins.flatMap((plugin): ExtensionPointPluginUsageSnapshot[] => {
      const registrations = descriptor.kind === 'surface'
        ? input.registrations
          .filter(item => item.owner === plugin.id && item.surface === descriptor.id)
          .map(item => projectContribution(item, input.i18n))
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
        ? registrations.some(item => item.valid && item.visible && item.authorized && !item.pending
          && (descriptor.id === 'manager.settings.tabs' || item.rendered))
        : routes.some(item => item.valid && item.authorized))
      return [{
        identity: Object.freeze({ source: plugin.source, id: plugin.id }),
        name: plugin.name,
        ...(plugin.description === undefined ? {} : { description: plugin.description }),
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
    const { anchors: _descriptorAnchors, ...descriptorWithoutAnchors } = descriptor
    return {
      ...descriptorWithoutAnchors,
      currentContext,
      ...(currentContextCode === undefined ? {} : { currentContextCode }),
      ...(currentContextDetail === undefined ? {} : { currentContextDetail }),
      effectiveAdapterSupport,
      stability: descriptor.maturity,
      availability,
      ...(anchors === undefined ? {} : { anchors }),
      available: effectiveAdapterSupport === 'supported',
      ...(availabilityCode === undefined ? {} : { availabilityCode }),
      ...(availabilityDetail === undefined ? {} : { availabilityDetail, availabilityError: availabilityDetail }),
      usingPluginCount: pluginUsages.length,
      activePluginCount: pluginUsages.filter(item => item.active).length,
      plugins: pluginUsages,
    }
  })
  return {
    schemaVersion: 1,
    currentContext: Object.freeze({
      $schema: CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1,
      schemaVersion: 1,
      points: Object.freeze(points.map(point => Object.freeze({
        id: point.id,
        state: point.currentContext,
        ...(point.currentContextCode === undefined ? {} : { code: point.currentContextCode }),
        ...(point.currentContextDetail === undefined ? {} : {
          detail: Object.freeze({ key: `runtime-context.${point.id}`, fallback: point.currentContextDetail }),
        }),
        ...(point.anchors === undefined ? {} : {
          anchors: Object.freeze(point.anchors.map(anchor => Object.freeze({
            id: anchor.id,
            state: anchor.currentContext,
            ...(anchor.availabilityCode === undefined ? {} : { code: anchor.availabilityCode }),
            ...(anchor.availabilityDetail === undefined ? {} : {
              detail: Object.freeze({ key: `runtime-context.${point.id}.${anchor.id}`, fallback: anchor.availabilityDetail }),
            }),
          }))),
        }),
      }))),
    }),
    catalogText,
    points,
    policies: input.broker.policiesSnapshot(),
    descriptorDiagnostics: input.descriptors.diagnostics(),
    policyDiagnostics: input.broker.policyDiagnostics(),
    accessDiagnostics: input.broker.accessDiagnostics(),
  }
}

/** Identity-bound cooperative enforcement for CordisX-managed point operations. */
export class ExtensionPointPolicyBroker implements ExtensionPointAccessResolver {
  private readonly identities = new Map<string, {
    readonly identity: CordisXPluginIdentity
    readonly generation: PluginGenerationEffectIdentity
    readonly candidateView?: PluginGenerationView
  }>()
  private readonly policies = new Map<string, CordisXExtensionPointPolicyRecordV1>()
  private readonly duplicatePolicyKeys = new Set<string>()
  private readonly duplicatePolicyIdentities = new Map<string, CordisXExtensionPointIdentity>()
  private readonly accesses: ExtensionPointAccessDiagnostic[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly descriptors: ExtensionPointDescriptorRegistry,
    private readonly store: ExtensionPointPolicyStore,
    private readonly generation = 'generation-legacy',
    private readonly visibility?: GenerationVisibilityCoordinator,
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
    visibility?.connect({ notify: () => this.changed() })
  }

  register(
    identity: CordisXPluginIdentity,
    generation: PluginGenerationEffectIdentity = Object.freeze({ pluginId: identity.id }),
    candidateView?: PluginGenerationView,
  ): () => void {
    assertLocalId(identity.id, 'extension point plugin id')
    const source = canonicalExtensionPointSource(identity.source)
    if (source !== identity.source) throw new Error(`plugin ${identity.id} source must use canonical serialization`)
    const frozen = Object.freeze({ ...identity })
    const physicalId = `${identity.id}\u0000${generation.moduleGeneration ?? 'host'}`
    if (this.identities.has(physicalId)) throw new Error(`plugin id ${identity.id} generation is already bound`)
    const registration = { identity: frozen, generation, ...(candidateView === undefined ? {} : { candidateView }) }
    this.identities.set(physicalId, registration)
    if (this.visibility?.visible(generation) !== false) this.changed()
    return () => {
      if (this.identities.get(physicalId) !== registration) return
      this.identities.delete(physicalId)
      if (this.visibility?.visible(generation) !== false) this.changed()
    }
  }

  private identity(owner: string, view?: PluginGenerationView): CordisXPluginIdentity | undefined {
    return [...this.identities.values()].find(item => item.identity.id === owner
      && (this.visibility?.visible(item.generation, view) ?? true))?.identity
  }

  pointPolicy(identity: CordisXExtensionPointIdentity): CordisXPointPolicy {
    const key = extensionPointIdentityKey(identity)
    if (this.duplicatePolicyKeys.has(key)) return 'inherit'
    return this.policies.get(key)?.policy ?? 'inherit'
  }

  surfaceAnchorSupport(pointId: string, anchorId: string): Readonly<{ supported: boolean; reason?: string }> {
    const descriptor = this.descriptors.descriptor(pointId)
    const anchor = descriptor?.anchors?.find(item => item.id === anchorId)
    if (descriptor === undefined) return { supported: false, reason: `unknown extension point: ${pointId}` }
    if (anchor === undefined) return { supported: false, reason: `unknown extension point anchor: ${pointId}/${anchorId}` }
    return anchor.adapterSupport === 'supported'
      ? { supported: true }
      : { supported: false, reason: `extension point anchor ${pointId}/${anchorId} adapter support is ${anchor.adapterSupport}` }
  }

  setPolicy(identity: CordisXPluginIdentity, pointId: string, policy: CordisXPointPolicy): void {
    const bound = this.identity(identity.id)
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

  decision(owner: string, pointId: string, expectedKind: CordisXExtensionPointKind, view?: PluginGenerationView): ExtensionPointAccessDecision {
    const plugin = this.identity(owner, view)
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
    if (descriptor.adapterSupport !== 'supported') return {
      identity,
      policy: this.pointPolicy(identity),
      effectivePolicy: 'deny',
      authorized: false,
      reason: `extension point ${pointId} adapter support is ${descriptor.adapterSupport}`,
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

  authorizeSurfaceCommand(owner: string, pointId: string, contributionId: string, commandId: string, view?: PluginGenerationView): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'surface', view)
    return this.recordAccess(decision, {
      operation: 'surface.command.invoke', contributionId, commandId,
    })
  }

  authorizeSurfaceRoute(owner: string, pointId: string, contributionId: string, routeId: string, view?: PluginGenerationView): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'surface', view)
    return this.recordAccess(decision, { operation: 'surface.route.navigate', contributionId, routeId })
  }

  authorizeOutletRoute(owner: string, pointId: string, routeId: string, pageId: string, view?: PluginGenerationView): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet', view)
    return this.recordAccess(decision, { operation: 'outlet.route.navigate', routeId, pageId })
  }

  authorizeOutletPage(owner: string, pointId: string, routeId: string, pageId: string, view?: PluginGenerationView): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet', view)
    return this.recordAccess(decision, { operation: 'outlet.page.mount', routeId, pageId })
  }

  authorizeOutletPageCommand(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    actionId: string,
    commandId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision {
    const decision = this.decision(owner, pointId, 'outlet', view)
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
  maturity: CordisXExtensionPointMaturity,
  adapterSupport: CordisXExtensionPointAdapterSupport,
  options: Readonly<{
    diagnostic?: CordisXLocalizedText
    anchors?: readonly CordisXHostExtensionPointAnchorDescriptorV5[]
  }> = {},
): CordisXHostExtensionPointDescriptorV5 {
  return Object.freeze({
    id,
    kind,
    title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `${key}.title`, fallback: fallbackTitle }),
    description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `${key}.description`, fallback: fallbackDescription }),
    icon,
    payloadFamily,
    maturity,
    adapterSupport,
    ...options,
    ...(kind !== 'outlet' ? {} : {
      pageChrome: Object.freeze(['standard'] as const),
      presentationGroup: id,
      routePathFamily: id === 'app' ? 'app' as const
        : id === 'main' ? 'main' as const
          : id === 'session.content' ? 'session' as const
            : 'host-defined' as const,
    }),
  })
}

function diagnostic(key: string, fallback: string): CordisXLocalizedText {
  return Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: `diagnostic.${key}`, fallback })
}

const RESERVED = Object.freeze({ diagnostic: diagnostic('reserved', 'Reserved by the protocol; this host does not support this seat.') })
const UNVERIFIED_ADAPTER = Object.freeze({ diagnostic: diagnostic('adapter-unverified', 'This adapter seat is not release-verified.') })

export const CORDISX_BUILTIN_EXTENSION_POINT_CATALOG = Object.freeze({
  $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
  schemaVersion: 5,
  points: Object.freeze([
    descriptor('sidebar.footer.before-control', 'surface', 'sidebar.footer.before-control', 'Sidebar footer before control', 'Adds a compact action before the designated sidebar footer control.', 'host:open', 'action', 'stable', 'supported'),
    descriptor('sidebar.footer.after-control', 'surface', 'sidebar.footer.after-control', 'Sidebar footer after control', 'Adds a compact action after the designated sidebar footer control.', 'host:open', 'action', 'stable', 'supported'),
    descriptor('sidebar.footer.menu', 'surface', 'sidebar.footer.menu', 'Sidebar footer menu', 'Adds a host-rendered command to the designated footer control menu.', 'host:more', 'menu-item', 'stable', 'supported'),
    descriptor('sidebar.account.menu', 'surface', 'sidebar.account.menu', 'Sidebar account menu', 'Adds a host-rendered command to the native account/profile menu.', 'host:more', 'menu-item', 'stable', 'supported'),
    descriptor('sidebar.navigation.items', 'surface', 'sidebar.navigation.items', 'Sidebar navigation', 'Adds a navigation row with a primary action and optional independent shortcuts.', 'host:layers', 'navigation-item', 'stable', 'supported'),
    descriptor('sidebar.workspace.menu', 'surface', 'sidebar.workspace.menu', 'Workspace menu', 'Adds host-rendered items to the native workspace menu when its seat is resolved.', 'host:more', 'menu-item', 'experimental', 'unverified', UNVERIFIED_ADAPTER),
    descriptor('sidebar.session.actions', 'surface', 'sidebar.session.actions', 'Session row actions', 'Adds contextual actions to an identified native session row.', 'host:more', 'contextual-action', 'reserved', 'unsupported', RESERVED),
    descriptor('sidebar.session.menu', 'surface', 'sidebar.session.menu', 'Session row menu', 'Adds contextual items to an identified native session menu.', 'host:more', 'contextual-action', 'reserved', 'unsupported', RESERVED),
    descriptor('workspace.toolbar.items', 'surface', 'workspace.toolbar.items', 'Workspace toolbar', 'Adds an action before, after, or inside the menu of a semantic workspace toolbar anchor.', 'host:more', 'action', 'stable', 'supported', {
      anchors: Object.freeze([{ id: 'workspace.primary', placements: Object.freeze(['before', 'after', 'menu'] as const), adapterSupport: 'supported' }]),
    }),
    descriptor('session.header.actions', 'surface', 'session.header.actions', 'Session header actions', 'Adds host-rendered action and utility groups to the active native session header.', 'host:more', 'contextual-action', 'stable', 'supported'),
    descriptor('session.tabs', 'surface', 'session.tabs', 'Session tabs', 'Adds controlled view entries navigated and rendered by the host.', 'host:layers', 'tab', 'reserved', 'unsupported', RESERVED),
    descriptor('session.banner.items', 'surface', 'session.banner.items', 'Session banners', 'Adds limited structured banners to the active session.', 'host:info', 'presenter', 'reserved', 'unsupported', RESERVED),
    descriptor('session.message.actions', 'surface', 'session.message.actions', 'Message actions', 'Adds contextual actions to a canonically identified message.', 'host:more', 'contextual-action', 'reserved', 'unsupported', { diagnostic: diagnostic('message-identity', 'Canonical message identity is unavailable.') }),
    descriptor('session.turn.footer', 'surface', 'session.turn.footer', 'Turn footer', 'Adds a structured presenter after a canonically identified turn.', 'host:info', 'presenter', 'reserved', 'unsupported', RESERVED),
    descriptor('session.tool.actions', 'surface', 'session.tool.actions', 'Tool actions', 'Adds contextual actions to a canonically identified tool item.', 'host:more', 'contextual-action', 'reserved', 'unsupported', { diagnostic: diagnostic('tool-identity', 'Canonical tool identity is unavailable.') }),
    descriptor('composer.toolbar.items', 'surface', 'composer.toolbar.items', 'Composer toolbar', 'Adds a host-rendered action at a verified semantic composer anchor.', 'host:more', 'contextual-action', 'stable', 'supported', {
      anchors: Object.freeze([
        { id: 'submit', placements: Object.freeze(['before'] as const), adapterSupport: 'supported' },
        { id: 'leading', placements: Object.freeze(['before', 'after'] as const), adapterSupport: 'unverified', diagnostic: diagnostic('anchor-unverified', 'This anchor is not release-verified.') },
        { id: 'model', placements: Object.freeze(['before', 'after', 'menu'] as const), adapterSupport: 'unverified', diagnostic: diagnostic('anchor-unverified', 'This anchor is not release-verified.') },
      ]),
    }),
    descriptor('composer.command-menu.items', 'surface', 'composer.command-menu.items', 'Composer command menu', 'Adds host-rendered items to the existing native composer command menu.', 'host:more', 'contextual-action', 'experimental', 'unverified', UNVERIFIED_ADAPTER),
    descriptor('composer.dock.above', 'surface', 'composer.dock.above', 'Composer dock above', 'Adds a limited structured presenter above the composer.', 'host:info', 'presenter', 'experimental', 'unverified', UNVERIFIED_ADAPTER),
    descriptor('composer.dock.below', 'surface', 'composer.dock.below', 'Composer dock below', 'Adds a limited structured presenter below the composer.', 'host:info', 'presenter', 'experimental', 'unverified', UNVERIFIED_ADAPTER),
    descriptor('panel.right.header-actions', 'surface', 'panel.right.header-actions', 'Right panel actions', 'Adds contextual actions to a verified visible right panel header.', 'host:more', 'contextual-action', 'experimental', 'unverified', UNVERIFIED_ADAPTER),
    descriptor('panel.right.tabs', 'surface', 'panel.right.tabs', 'Right panel tabs', 'Adds host-controlled tabs to the right panel.', 'host:layers', 'tab', 'reserved', 'unsupported', RESERVED),
    descriptor('panel.bottom.header-actions', 'surface', 'panel.bottom.header-actions', 'Bottom panel actions', 'Adds contextual actions to a verified visible bottom panel header.', 'host:more', 'contextual-action', 'experimental', 'unverified', UNVERIFIED_ADAPTER),
    descriptor('panel.bottom.tabs', 'surface', 'panel.bottom.tabs', 'Bottom panel tabs', 'Adds host-controlled tabs to the bottom panel.', 'host:layers', 'tab', 'reserved', 'unsupported', RESERVED),
    descriptor('environment.panel.header-actions', 'surface', 'environment.panel.header-actions', 'Environment panel header', 'Adds a command action to the environment panel header.', 'host:settings', 'action', 'stable', 'supported'),
    descriptor('environment.panel.sections', 'surface', 'environment.panel.sections', 'Environment panel sections', 'Adds a host-rendered section to the environment panel.', 'host:layers', 'environment-section', 'stable', 'supported'),
    descriptor('environment.section.actions', 'surface', 'environment.section.actions', 'Environment section actions', 'Adds a command action to a declared environment section.', 'host:settings', 'action', 'stable', 'supported'),
    descriptor('environment.section.rows', 'surface', 'environment.section.rows', 'Environment section rows', 'Adds a structured label, value, description, and status row to a declared section.', 'host:info', 'environment-row', 'stable', 'supported'),
    descriptor('environment.row.trailing-actions', 'surface', 'environment.row.trailing-actions', 'Environment row actions', 'Adds an independent command action to the end of a declared environment row.', 'host:more', 'action', 'stable', 'supported'),
    descriptor('app', 'outlet', 'outlet.app', 'Application page', 'Opens a CordisX page over the renderer application region without replacing native content.', 'host:open', 'outlet', 'stable', 'supported'),
    descriptor('main', 'outlet', 'outlet.main', 'Main workspace page', 'Opens a CordisX page over the region to the right of the sidebar and follows the current main context.', 'host:layers', 'outlet', 'stable', 'supported'),
    descriptor('session.content', 'outlet', 'outlet.session.content', 'Session content page', 'Opens a CordisX page below the active session header while preserving side and bottom panels.', 'host:history', 'outlet', 'stable', 'supported'),
    descriptor('panel.right.content', 'outlet', 'outlet.panel.right.content', 'Right panel content', 'Hosts controlled trusted-local page content in the right panel.', 'host:layers', 'outlet', 'reserved', 'unsupported', RESERVED),
    descriptor('panel.bottom.content', 'outlet', 'outlet.panel.bottom.content', 'Bottom panel content', 'Hosts controlled trusted-local page content in the bottom panel.', 'host:layers', 'outlet', 'reserved', 'unsupported', RESERVED),
  ]),
}) satisfies CordisXHostExtensionPointCatalogV5

export const CORDISX_MANAGER_EXTENSION_POINT_CATALOG = Object.freeze({
  $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
  schemaVersion: 5,
  points: Object.freeze([
    Object.freeze({
      id: 'manager.settings.tabs',
      kind: 'surface',
      title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.settings.tabs.title', fallback: 'Manager settings content tabs' }),
      description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.settings.tabs.description', fallback: 'Compatibility surface for Hosts that expose Settings; it is not mounted in the current Manager layout.' }),
      icon: 'host:settings',
      payloadFamily: 'manager-settings-content-tab',
      maturity: 'stable',
      adapterSupport: 'supported',
    }),
    Object.freeze({
      id: 'manager.settings.content',
      kind: 'outlet',
      title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.settings.content.title', fallback: 'Manager settings content' }),
      description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.settings.content.description', fallback: 'Compatibility body outlet for a mounted Settings content tab; it is not mounted in the current Manager layout.' }),
      icon: 'host:settings',
      payloadFamily: 'outlet',
      maturity: 'stable',
      adapterSupport: 'supported',
      pageChrome: Object.freeze(['body-only'] as const),
      presentationGroup: 'manager.settings',
      routePathFamily: 'manager-settings',
    }),
    Object.freeze({
      id: 'manager.settings.navigation-items',
      kind: 'surface',
      title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.settings.navigation-items.title', fallback: 'Manager settings navigation items' }),
      description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.settings.navigation-items.description', fallback: 'Adds an independent Host-rendered plugin destination across the Manager settings extension seam.' }),
      icon: 'host:layers',
      payloadFamily: 'manager-settings-navigation-item',
      maturity: 'stable',
      adapterSupport: 'supported',
    }),
    Object.freeze({
      id: 'manager.content',
      kind: 'outlet',
      title: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.content.title', fallback: 'Manager content' }),
      description: Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key: 'manager.content.description', fallback: 'Mounts a trusted-local plugin body beneath a standard Host-owned Manager page header.' }),
      icon: 'host:layers',
      payloadFamily: 'outlet',
      maturity: 'stable',
      adapterSupport: 'supported',
      pageChrome: Object.freeze(['standard'] as const),
      presentationGroup: 'manager',
      routePathFamily: 'manager',
    }),
  ]),
}) satisfies CordisXHostExtensionPointCatalogV5

const ALL_EXTENSION_POINT_DESCRIPTORS: readonly CordisXHostExtensionPointDescriptorV5[] = [
  ...CORDISX_BUILTIN_EXTENSION_POINT_CATALOG.points,
  ...CORDISX_MANAGER_EXTENSION_POINT_CATALOG.points,
] as const

const EN_MESSAGES = Object.fromEntries([
  ...ALL_EXTENSION_POINT_DESCRIPTORS.flatMap(point => [
    [point.title.key, point.title.fallback!],
    [point.description.key, point.description.fallback!],
    ...(point.diagnostic === undefined ? [] : [[point.diagnostic.key, point.diagnostic.fallback!]]),
    ...(point.anchors ?? []).flatMap(anchor => anchor.diagnostic === undefined ? [] : [[anchor.diagnostic.key, anchor.diagnostic.fallback!]]),
  ]),
  ...Object.values(CATALOG_TEXT).map(message => [message.key, message.fallback!]),
])

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
  'sidebar.workspace.menu.title': '工作区菜单',
  'sidebar.workspace.menu.description': '当原生位置已定位时，向工作区菜单添加由宿主渲染的条目。',
  'sidebar.session.actions.title': '会话条目操作',
  'sidebar.session.actions.description': '向已识别的原生会话条目添加上下文操作。',
  'sidebar.session.menu.title': '会话条目菜单',
  'sidebar.session.menu.description': '向已识别的原生会话菜单添加上下文条目。',
  'workspace.toolbar.items.title': '工作区工具栏',
  'workspace.toolbar.items.description': '在语义工具栏锚点前后或菜单中添加操作。',
  'session.header.actions.title': '会话标题操作',
  'session.header.actions.description': '向当前原生会话标题添加由宿主渲染的操作和工具分组。',
  'session.tabs.title': '会话标签页',
  'session.tabs.description': '添加由宿主导航和渲染的受控视图入口。',
  'session.banner.items.title': '会话横幅',
  'session.banner.items.description': '向当前会话添加有限的结构化横幅。',
  'session.message.actions.title': '消息操作',
  'session.message.actions.description': '向具有规范标识的消息添加上下文操作。',
  'session.turn.footer.title': '轮次尾部',
  'session.turn.footer.description': '在具有规范标识的轮次之后添加结构化展示项。',
  'session.tool.actions.title': '工具项操作',
  'session.tool.actions.description': '向具有规范标识的工具项添加上下文操作。',
  'composer.toolbar.items.title': '输入区工具栏',
  'composer.toolbar.items.description': '在已验证的语义输入区锚点添加由宿主渲染的操作。',
  'composer.command-menu.items.title': '输入区命令菜单',
  'composer.command-menu.items.description': '向现有原生输入区命令菜单添加由宿主渲染的条目。',
  'composer.dock.above.title': '输入区上方停靠区',
  'composer.dock.above.description': '在输入区上方添加有限的结构化展示项。',
  'composer.dock.below.title': '输入区下方停靠区',
  'composer.dock.below.description': '在输入区下方添加有限的结构化展示项。',
  'panel.right.header-actions.title': '右侧面板操作',
  'panel.right.header-actions.description': '向已验证且可见的右侧面板标题区添加上下文操作。',
  'panel.right.tabs.title': '右侧面板标签页',
  'panel.right.tabs.description': '向右侧面板添加由宿主控制的标签页。',
  'panel.bottom.header-actions.title': '底部面板操作',
  'panel.bottom.header-actions.description': '向已验证且可见的底部面板标题区添加上下文操作。',
  'panel.bottom.tabs.title': '底部面板标签页',
  'panel.bottom.tabs.description': '向底部面板添加由宿主控制的标签页。',
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
  'outlet.panel.right.content.title': '右侧面板内容',
  'outlet.panel.right.content.description': '在右侧面板承载受控的可信本地页面内容。',
  'outlet.panel.bottom.content.title': '底部面板内容',
  'outlet.panel.bottom.content.description': '在底部面板承载受控的可信本地页面内容。',
  'manager.settings.tabs.title': '管理器配置内容标签页',
  'manager.settings.tabs.description': '兼容仍提供配置页的宿主；当前管理器布局未挂载此点位。',
  'manager.settings.content.title': '管理器配置内容',
  'manager.settings.content.description': '兼容已挂载的配置内容标签页；当前管理器布局未挂载此出口。',
  'manager.settings.navigation-items.title': '管理器配置导航条目',
  'manager.settings.navigation-items.description': '跨越管理器配置扩展缝隙添加由宿主渲染的独立插件页面入口。',
  'manager.content.title': '管理器内容',
  'manager.content.description': '在宿主拥有的标准管理器页面标题下挂载受控的可信本地插件正文。',
  'diagnostic.anchor': '当前未定位到原生宿主点位。',
  'diagnostic.adapter-unverified': '该适配器点位尚未通过发布验证。',
  'diagnostic.anchor-unverified': '该锚点尚未通过发布验证。',
  'diagnostic.message-identity': '当前无法取得规范消息标识。',
  'diagnostic.reserved': '协议已保留该点位；当前宿主未开放安全位置。',
  'diagnostic.tool-identity': '当前无法取得规范工具标识。',
  'catalog.category.surface': '界面点位',
  'catalog.category.outlet': '页面出口',
  'catalog.owner.host': 'CordisX 宿主',
  'catalog.status.pending': '待定位',
  'catalog.status.unavailable': '不可用',
  'catalog.status.error': '需要处理',
  'catalog.status.denied': '访问已拒绝',
}

export const CORDISX_EXTENSION_POINT_LOCALE_CATALOGS: readonly CordisXLocaleCatalog[] = Object.freeze([
  Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, locale: 'en', default: true, messages: Object.freeze(EN_MESSAGES) }),
  Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, locale: 'zh-CN', messages: Object.freeze(ZH_MESSAGES) }),
])
