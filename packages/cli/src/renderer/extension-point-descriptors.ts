import {
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V10,
  type CordisXHostExtensionPointCatalogV10,
} from '../contracts.js'
import type {
  CordisXEffectivePointPolicy,
  CordisXExtensionPointAccessV2,
  CordisXExtensionPointAdapterSupport,
  CordisXExtensionPointAvailability,
  CordisXExtensionPointCurrentContextState,
  CordisXExtensionPointIdentity,
  CordisXExtensionPointKind,
  CordisXExtensionPointMaturity,
  CordisXExtensionPointPayloadFamily,
  CordisXExtensionPointPolicyRecordV1,
  CordisXExtensionPointRuntimeContextV1,
  CordisXExtensionPointStability,
  CordisXHostExtensionPointAnchorDescriptorV2,
  CordisXHostExtensionPointAnchorDescriptorV5,
  CordisXHostExtensionPointCatalogV1,
  CordisXHostExtensionPointCatalogV2,
  CordisXHostExtensionPointCatalogV3,
  CordisXHostExtensionPointCatalogV5,
  CordisXHostExtensionPointCatalogV6,
  CordisXHostExtensionPointCatalogV7,
  CordisXHostExtensionPointCatalogV8,
  CordisXHostExtensionPointCatalogV9,
  CordisXHostExtensionPointDescriptor,
  CordisXHostExtensionPointDescriptorV3,
  CordisXHostExtensionPointDescriptorV5,
  CordisXHostExtensionPointDescriptorV9,
  CordisXLocaleCatalog,
  CordisXLocalizedProjection,
  CordisXLocalizedText,
  CordisXManagerSettingsNavigationDescriptorV9,
  CordisXPluginIdentity,
  CordisXPointPolicy,
} from '../contracts.js'
import {
  CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V6,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V8,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V9,
} from '../contracts.js'
import type { CordisXI18nService } from './i18n.js'
import type { CommandSnapshot } from './commands.js'
import type { NavigationSnapshot, RouteSnapshot } from './navigation.js'
import type { SurfaceContributionSnapshot, SurfaceCurrentContextSnapshot } from './surfaces.js'
import { qualifyOwnedId } from './ownership.js'
import type {
  GenerationVisibilityCoordinator,
  PluginGenerationEffectIdentity,
  PluginGenerationView,
} from './generation-visibility.js'
import { assertLocalId, assertLocalizedText, ICON_TOKEN_PATTERN, immutableSnapshot } from './validation.js'

export const POINT_POLICY_STORAGE_KEY = 'cordisx.extensionPointPolicies.v1'
export const DESCRIPTOR_NAMESPACE = 'cordisx.manager.extension-points'

function catalogMessage(key: string, fallback: string): CordisXLocalizedText {
  return Object.freeze({ namespace: DESCRIPTOR_NAMESPACE, key, fallback })
}

export const CATALOG_TEXT = Object.freeze({
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
  readonly navigationGroups?: CordisXManagerSettingsNavigationDescriptorV9['navigationGroups']
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
  readonly descriptors: readonly CordisXHostExtensionPointDescriptorV9[]
  readonly diagnostics: readonly ExtensionPointDescriptorDiagnostic[]
}

function exactKeys(value: object, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} has unknown field ${unknown}`)
}

const PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  'action',
  'menu-item',
  'contextual-action',
  'tab',
  'presenter',
  'navigation-item',
  'manager-settings-tab',
  'manager-settings-content-tab',
  'manager-settings-navigation-item',
  'environment-section',
  'environment-row',
  'outlet',
])
const V5_PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  'action',
  'menu-item',
  'contextual-action',
  'tab',
  'manager-settings-content-tab',
  'manager-settings-navigation-item',
  'presenter',
  'navigation-item',
  'environment-section',
  'environment-row',
  'outlet',
])
const V6_PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  ...V5_PAYLOAD_FAMILIES,
  'reasoning-intensity-presentation',
])
const V7_PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  ...V6_PAYLOAD_FAMILIES,
  'session-backdrop-presentation',
])
const V8_PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  ...V7_PAYLOAD_FAMILIES,
  'transient-canvas-presentation',
])
const V9_PAYLOAD_FAMILIES = new Set<CordisXExtensionPointPayloadFamily>([
  ...V8_PAYLOAD_FAMILIES,
  'manager-settings-navigation-item-v2',
])
const AVAILABILITIES = new Set<CordisXExtensionPointAvailability>(['available', 'pending', 'unavailable'])
const MATURITIES = new Set<CordisXExtensionPointMaturity>(['stable', 'experimental', 'reserved'])
const ADAPTER_SUPPORT = new Set<CordisXExtensionPointAdapterSupport>(['supported', 'unsupported', 'unverified'])
const REQUIRED_DESCRIPTOR_LOCALES = Object.freeze(['en', 'zh-CN'] as const)

function messageNamespace(message: CordisXLocalizedText): string {
  return message.namespace ?? 'host'
}

function descriptorMessages(descriptor: CordisXHostExtensionPointDescriptorV9): readonly CordisXLocalizedText[] {
  return [
    descriptor.title,
    descriptor.description,
    ...(descriptor.diagnostic === undefined ? [] : [descriptor.diagnostic]),
    ...(descriptor.anchors ?? []).flatMap(anchor => anchor.diagnostic === undefined ? [] : [anchor.diagnostic]),
    ...('navigationGroups' in descriptor ? descriptor.navigationGroups.groups.map(group => group.label) : []),
  ]
}

/** Fail closed when public descriptor text cannot be projected in every required Host locale. */
export function assertExtensionPointDescriptorLocalization(
  descriptor: CordisXHostExtensionPointDescriptorV9,
  catalogs: readonly CordisXLocaleCatalog[],
): void {
  for (const message of descriptorMessages(descriptor)) {
    const namespace = messageNamespace(message)
    for (const locale of REQUIRED_DESCRIPTOR_LOCALES) {
      const catalog = catalogs.find(item => item.namespace === namespace && item.locale === locale)
      const translated = catalog?.messages[message.key]
      if (typeof translated !== 'string' || translated.trim() === '') {
        throw new Error(
          `extension point ${descriptor.id} message ${namespace}:${message.key} requires ${locale} localization`,
        )
      }
    }
  }
}

function legacyAdapterSupport(availability: CordisXExtensionPointAvailability): CordisXExtensionPointAdapterSupport {
  return availability === 'available' ? 'supported' : availability === 'pending' ? 'unverified' : 'unsupported'
}

function normalizeAnchor(
  value: unknown,
  pointId: string,
  schemaVersion: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9 | 10,
): CordisXHostExtensionPointAnchorDescriptorV5 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`extension point ${pointId} anchor must be an object`)
  }
  exactKeys(
    value,
    schemaVersion >= 5
      ? ['id', 'placements', 'adapterSupport', 'diagnostic']
      : ['id', 'placements', 'availability', 'diagnostic'],
    `extension point ${pointId} anchor`,
  )
  const anchor = value as Partial<
    CordisXHostExtensionPointAnchorDescriptorV2 & CordisXHostExtensionPointAnchorDescriptorV5
  >
  if (typeof anchor.id !== 'string') throw new Error(`extension point ${pointId} anchor id is required`)
  assertLocalId(anchor.id, `extension point ${pointId} anchor id`)
  if (
    !Array.isArray(anchor.placements) || anchor.placements.length === 0 || anchor.placements.length > 3
    || anchor.placements.some(item => !['before', 'after', 'menu'].includes(item))
    || new Set(anchor.placements).size !== anchor.placements.length
  ) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} placements are invalid`)
  }
  const adapterSupport = schemaVersion >= 5
    ? anchor.adapterSupport
    : AVAILABILITIES.has(anchor.availability as CordisXExtensionPointAvailability)
    ? legacyAdapterSupport(anchor.availability as CordisXExtensionPointAvailability)
    : undefined
  if (!ADAPTER_SUPPORT.has(adapterSupport as CordisXExtensionPointAdapterSupport)) {
    throw new Error(`extension point ${pointId} anchor ${anchor.id} adapter support is invalid`)
  }
  if (anchor.diagnostic !== undefined) {
    assertLocalizedText(anchor.diagnostic, `extension point ${pointId} anchor ${anchor.id} diagnostic`)
  }
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

function normalizeManagerSettingsNavigationGroups(
  value: unknown,
): CordisXManagerSettingsNavigationDescriptorV9['navigationGroups'] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manager.settings.navigation-items requires a navigation group catalog')
  }
  exactKeys(value, ['$schema', 'contract', 'schemaVersion', 'groups', 'fallbackGroup'], 'navigation group catalog')
  const catalog = value as Partial<CordisXManagerSettingsNavigationDescriptorV9['navigationGroups']>
  if (
    catalog.$schema
      !== 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-settings-navigation-groups.v1.schema.json'
    || catalog.contract !== 'cordisx.manager-settings-navigation-groups/v1'
    || catalog.schemaVersion !== 1
    || catalog.fallbackGroup !== 'other'
  ) throw new Error('manager settings navigation group catalog identity is invalid')
  if (!Array.isArray(catalog.groups) || catalog.groups.length !== 4) {
    throw new Error('manager settings navigation group catalog requires four exact groups')
  }
  const expected = [
    ['resources', 100],
    ['development', 200],
    ['collaboration', 300],
    ['other', 1000],
  ] as const
  for (const [index, [id, order]] of expected.entries()) {
    const group = catalog.groups[index]
    if (group === null || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error(`manager settings navigation group ${id} must be an object`)
    }
    exactKeys(group, ['id', 'label', 'order'], `manager settings navigation group ${id}`)
    if (group.id !== id || group.order !== order) {
      throw new Error(`manager settings navigation group ${id} identity/order is invalid`)
    }
    assertLocalizedText(group.label, `manager settings navigation group ${id} label`)
    if (group.label.fallback === undefined) {
      throw new Error(`manager settings navigation group ${id} label requires fallback`)
    }
  }
  return immutableSnapshot(catalog as CordisXManagerSettingsNavigationDescriptorV9['navigationGroups'])
}

function normalizeDescriptor(
  value: unknown,
  schemaVersion: 1 | 2 | 3 | 5 | 6 | 7 | 8 | 9 | 10,
): CordisXHostExtensionPointDescriptorV9 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('descriptor must be an object')
  }
  exactKeys(
    value,
    schemaVersion === 1
      ? ['id', 'kind', 'title', 'description', 'icon']
      : schemaVersion === 2
      ? [
        'id',
        'kind',
        'title',
        'description',
        'icon',
        'payloadFamily',
        'stability',
        'availability',
        'diagnostic',
        'anchors',
      ]
      : schemaVersion === 3
      ? [
        'id',
        'kind',
        'title',
        'description',
        'icon',
        'payloadFamily',
        'stability',
        'availability',
        'diagnostic',
        'anchors',
        'pageChrome',
        'presentationGroup',
        'routePathFamily',
      ]
      : [
        'id',
        'kind',
        'title',
        'description',
        'icon',
        'payloadFamily',
        'maturity',
        'adapterSupport',
        'diagnostic',
        'anchors',
        'pageChrome',
        'presentationGroup',
        'routePathFamily',
        ...(schemaVersion >= 9 ? ['navigationGroups'] : []),
        ...(schemaVersion === 10 ? ['events'] : []),
      ],
    'descriptor',
  )
  const descriptor = value as
    & Partial<
      & Omit<CordisXHostExtensionPointDescriptorV3, 'payloadFamily'>
      & Omit<CordisXHostExtensionPointDescriptorV5, 'payloadFamily'>
      & Omit<CordisXManagerSettingsNavigationDescriptorV9, 'payloadFamily'>
    >
    & { payloadFamily?: CordisXExtensionPointPayloadFamily }
  if (typeof descriptor.id !== 'string') throw new Error('descriptor id is required')
  assertLocalId(descriptor.id, 'extension point id')
  if (descriptor.kind !== 'surface' && descriptor.kind !== 'outlet') {
    throw new Error(`extension point ${descriptor.id} kind is invalid`)
  }
  assertLocalizedText(descriptor.title, `extension point ${descriptor.id} title`)
  assertLocalizedText(descriptor.description, `extension point ${descriptor.id} description`)
  if (descriptor.title.fallback === undefined || descriptor.description.fallback === undefined) {
    throw new Error(`extension point ${descriptor.id} descriptor text requires fallback`)
  }
  if (descriptor.title.fallback.length > 4000 || descriptor.description.fallback.length > 4000) {
    throw new Error(`extension point ${descriptor.id} descriptor fallback is too long`)
  }
  if (
    typeof descriptor.icon !== 'string' || !ICON_TOKEN_PATTERN.test(descriptor.icon)
    || !descriptor.icon.startsWith('host:')
  ) {
    throw new Error(`extension point ${descriptor.id} requires a host icon token`)
  }
  const payloadFamily = schemaVersion === 1
    ? descriptor.kind === 'outlet' ? 'outlet' : 'action'
    : descriptor.payloadFamily
  const payloadFamilies = schemaVersion === 10
    ? new Set([...V9_PAYLOAD_FAMILIES, 'extension-point-visual-v1'])
    : schemaVersion >= 9
    ? V9_PAYLOAD_FAMILIES
    : schemaVersion === 8
    ? V8_PAYLOAD_FAMILIES
    : schemaVersion === 7
    ? V7_PAYLOAD_FAMILIES
    : schemaVersion === 6
    ? V6_PAYLOAD_FAMILIES
    : schemaVersion === 5
    ? V5_PAYLOAD_FAMILIES
    : PAYLOAD_FAMILIES
  if (!payloadFamilies.has(payloadFamily as CordisXExtensionPointPayloadFamily)) {
    throw new Error(`extension point ${descriptor.id} payload family is invalid`)
  }
  if ((descriptor.kind === 'outlet') !== (payloadFamily === 'outlet')) {
    throw new Error(`extension point ${descriptor.id} payload family does not match its kind`)
  }
  const maturity = schemaVersion === 1 ? 'stable' : schemaVersion >= 5 ? descriptor.maturity : descriptor.stability
  const adapterSupport = schemaVersion === 1
    ? 'supported'
    : schemaVersion >= 5
    ? descriptor.adapterSupport
    : AVAILABILITIES.has(descriptor.availability as CordisXExtensionPointAvailability)
    ? legacyAdapterSupport(descriptor.availability as CordisXExtensionPointAvailability)
    : undefined
  if (!MATURITIES.has(maturity as CordisXExtensionPointMaturity)) {
    throw new Error(`extension point ${descriptor.id} maturity is invalid`)
  }
  if (!ADAPTER_SUPPORT.has(adapterSupport as CordisXExtensionPointAdapterSupport)) {
    throw new Error(`extension point ${descriptor.id} adapter support is invalid`)
  }
  if (descriptor.diagnostic !== undefined) {
    assertLocalizedText(descriptor.diagnostic, `extension point ${descriptor.id} diagnostic`)
  }
  if (adapterSupport !== 'supported' && descriptor.diagnostic === undefined) {
    throw new Error(`extension point ${descriptor.id} requires a diagnostic`)
  }
  if (maturity === 'stable' && adapterSupport !== 'supported') {
    throw new Error(`stable extension point ${descriptor.id} must be supported`)
  }
  if (maturity === 'reserved' && adapterSupport !== 'unsupported') {
    throw new Error(`reserved extension point ${descriptor.id} must be unsupported`)
  }
  if (descriptor.anchors !== undefined && (!Array.isArray(descriptor.anchors) || descriptor.anchors.length > 32)) {
    throw new Error(`extension point ${descriptor.id} anchors must be an array of at most 32 items`)
  }
  const pointId = descriptor.id
  const anchors = descriptor.anchors?.map(anchor => normalizeAnchor(anchor, pointId, schemaVersion))
  if (anchors !== undefined && new Set(anchors.map(anchor => anchor.id)).size !== anchors.length) {
    throw new Error(`extension point ${descriptor.id} has duplicate anchors`)
  }
  if (schemaVersion === 3 || schemaVersion >= 5) {
    if (descriptor.kind === 'outlet') {
      if (
        !Array.isArray(descriptor.pageChrome) || descriptor.pageChrome.length === 0 || descriptor.pageChrome.length > 2
        || descriptor.pageChrome.some(item => item !== 'standard' && item !== 'body-only')
        || new Set(descriptor.pageChrome).size !== descriptor.pageChrome.length
      ) {
        throw new Error(`extension point ${descriptor.id} page chrome is invalid`)
      }
      if (descriptor.presentationGroup === undefined) {
        throw new Error(`extension point ${descriptor.id} presentation group is required`)
      }
      assertLocalId(descriptor.presentationGroup, `extension point ${descriptor.id} presentation group`)
      if (
        !['app', 'main', 'session', 'manager-settings', 'manager', 'host-defined'].includes(
          String(descriptor.routePathFamily),
        )
      ) {
        throw new Error(`extension point ${descriptor.id} route path family is invalid`)
      }
    } else if (
      descriptor.pageChrome !== undefined || descriptor.presentationGroup !== undefined
      || descriptor.routePathFamily !== undefined
    ) {
      throw new Error(`surface extension point ${descriptor.id} cannot declare outlet compatibility fields`)
    }
  }
  const outletCompatibility = descriptor.kind !== 'outlet' ? {} : {
    pageChrome: schemaVersion === 1 || schemaVersion === 2
      ? Object.freeze(['standard'] as const)
      : descriptor.pageChrome,
    presentationGroup: schemaVersion === 1 || schemaVersion === 2 ? 'legacy' : descriptor.presentationGroup,
    routePathFamily: schemaVersion === 1 || schemaVersion === 2 ? 'host-defined' as const : descriptor.routePathFamily,
  }
  const navigationGroups = schemaVersion >= 9 && descriptor.id === 'manager.settings.navigation-items'
    ? normalizeManagerSettingsNavigationGroups(descriptor.navigationGroups)
    : undefined
  if (schemaVersion >= 9) {
    if (descriptor.id === 'manager.settings.navigation-items') {
      if (payloadFamily !== 'manager-settings-navigation-item-v2') {
        throw new Error('manager.settings.navigation-items v9 requires manager-settings-navigation-item-v2')
      }
    } else if (descriptor.navigationGroups !== undefined) {
      throw new Error(`extension point ${descriptor.id} cannot declare manager navigation groups`)
    }
  }
  const visualEvents = (value as { events?: unknown }).events
  if (schemaVersion === 10 && payloadFamily === 'extension-point-visual-v1') {
    if (
      !['composer.primary-action.visual', 'composer.frame.overlay'].includes(descriptor.id)
      || descriptor.kind !== 'surface'
      || !Array.isArray(visualEvents) || visualEvents.some(event => event !== 'pointer.observe')
      || new Set(visualEvents).size !== visualEvents.length
    ) throw new Error('Invalid composer visual descriptor')
  } else if (visualEvents !== undefined) throw new Error('Events require a visual descriptor')
  return immutableSnapshot({
    ...(visualEvents === undefined ? {} : { events: visualEvents }),
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
    ...(navigationGroups === undefined ? {} : { navigationGroups }),
    ...outletCompatibility,
  } as CordisXHostExtensionPointDescriptorV9)
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

  registerCatalog(
    value:
      | CordisXHostExtensionPointCatalogV1
      | CordisXHostExtensionPointCatalogV2
      | CordisXHostExtensionPointCatalogV3
      | CordisXHostExtensionPointCatalogV5
      | CordisXHostExtensionPointCatalogV6
      | CordisXHostExtensionPointCatalogV7
      | CordisXHostExtensionPointCatalogV8
      | CordisXHostExtensionPointCatalogV9
      | unknown,
  ): () => void {
    if (this.disposed) throw new Error('CordisX extension point descriptor registry is disposed')
    const descriptors: CordisXHostExtensionPointDescriptorV9[] = []
    const diagnostics: ExtensionPointDescriptorDiagnostic[] = []
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('catalog must be an object')
      }
      exactKeys(value, ['$schema', 'schemaVersion', 'points'], 'extension point catalog')
      const catalog = value as Partial<
        | CordisXHostExtensionPointCatalogV1
        | CordisXHostExtensionPointCatalogV2
        | CordisXHostExtensionPointCatalogV3
        | CordisXHostExtensionPointCatalogV5
        | CordisXHostExtensionPointCatalogV6
        | CordisXHostExtensionPointCatalogV7
        | CordisXHostExtensionPointCatalogV8
        | CordisXHostExtensionPointCatalogV9
        | CordisXHostExtensionPointCatalogV10
      >
      const schemaVersion =
        catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1 && catalog.schemaVersion === 1
          ? 1
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2 && catalog.schemaVersion === 2
          ? 2
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3 && catalog.schemaVersion === 3
          ? 3
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5 && catalog.schemaVersion === 5
          ? 5
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V6 && catalog.schemaVersion === 6
          ? 6
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7 && catalog.schemaVersion === 7
          ? 7
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V8 && catalog.schemaVersion === 8
          ? 8
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V9 && catalog.schemaVersion === 9
          ? 9
          : catalog.$schema === CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V10 && catalog.schemaVersion === 10
          ? 10
          : undefined
      if (schemaVersion === undefined) {
        throw new Error('extension point catalog schema/version is unsupported')
      }
      if (!Array.isArray(catalog.points) || catalog.points.length > 256) {
        throw new Error('extension point catalog points must be an array of at most 256 items')
      }
      const liveIds = new Set(this.descriptors().map(item => item.id))
      for (const candidate of catalog.points) {
        try {
          const descriptor = normalizeDescriptor(candidate, schemaVersion)
          if (liveIds.has(descriptor.id) || descriptors.some(item => item.id === descriptor.id)) {
            diagnostics.push({
              code: 'duplicate-point-id',
              pointId: descriptor.id,
              message: `duplicate extension point id across families: ${descriptor.id}`,
            })
            continue
          }
          assertExtensionPointDescriptorLocalization(descriptor, this.localeCatalogs)
          descriptors.push(descriptor)
        } catch (error) {
          const pointId = candidate !== null && typeof candidate === 'object'
              && typeof (candidate as { id?: unknown }).id === 'string'
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
          this.projectionI18n?.clearDiagnosticSite(
            'host',
            `extension-point:${descriptor.id}:anchor:${anchor.id}:diagnostic`,
          )
        }
      }
      const index = this.registrations.indexOf(registration)
      if (index >= 0) this.registrations.splice(index, 1)
      this.notify()
    }
  }

  descriptors(): readonly CordisXHostExtensionPointDescriptorV9[] {
    return this.registrations.flatMap(item => item.descriptors).sort((left, right) => left.id.localeCompare(right.id))
  }

  descriptor(id: string): CordisXHostExtensionPointDescriptorV9 | undefined {
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
          diagnosticProjection: i18n.resolveFor(
            'host',
            anchor.diagnostic,
            `extension-point:${descriptor.id}:anchor:${anchor.id}:diagnostic`,
          ),
        }),
      }))
      return {
        ...descriptor,
        titleProjection: i18n.resolveFor('host', descriptor.title, `extension-point:${descriptor.id}:title`),
        descriptionProjection: i18n.resolveFor(
          'host',
          descriptor.description,
          `extension-point:${descriptor.id}:description`,
        ),
        ...(descriptor.diagnostic === undefined ? {} : {
          diagnosticProjection: i18n.resolveFor(
            'host',
            descriptor.diagnostic,
            `extension-point:${descriptor.id}:diagnostic`,
          ),
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
        this.projectionI18n?.clearDiagnosticSite(
          'host',
          `extension-point:${descriptor.id}:anchor:${anchor.id}:diagnostic`,
        )
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
