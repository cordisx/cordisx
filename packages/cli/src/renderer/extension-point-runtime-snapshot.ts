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
  CordisXHostExtensionPointDescriptor,
  CordisXHostExtensionPointDescriptorV3,
  CordisXHostExtensionPointDescriptorV5,
  CordisXLocaleCatalog,
  CordisXLocalizedProjection,
  CordisXLocalizedText,
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

import {
  CATALOG_TEXT,
  type ExtensionPointCatalogTextProjection,
  type ExtensionPointDescriptorDiagnostic,
  ExtensionPointDescriptorRegistry,
  type HostExtensionPointAnchorProjection,
  type HostExtensionPointProjection,
  POINT_POLICY_STORAGE_KEY,
} from './extension-point-descriptors.js'
import type { ExtensionPointPolicyBroker } from './extension-point-policy.js'

export function canonicalExtensionPointSource(value: string): string {
  if (value.length > 2048) throw new Error('source exceeds 2048 characters')
  const url = new URL(value)
  if (
    !['file:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.search !== ''
    || url.hash !== ''
  ) {
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

  read(): readonly CordisXExtensionPointPolicyRecordV1[] {
    return copied(this.records)
  }
  write(records: readonly CordisXExtensionPointPolicyRecordV1[]): void {
    this.records = copied(records)
  }
}

export function validStoredPolicy(value: unknown): value is CordisXExtensionPointPolicyRecordV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<CordisXExtensionPointPolicyRecordV1>
  if (Object.keys(value).some(key => !['$schema', 'schemaVersion', 'identity', 'policy'].includes(key))) return false
  if (record.$schema !== CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1 || record.schemaVersion !== 1) return false
  if (!['inherit', 'allow', 'deny'].includes(String(record.policy))) return false
  const identity = record.identity
  if (
    identity === undefined || typeof identity.source !== 'string' || typeof identity.pluginId !== 'string'
    || typeof identity.pointId !== 'string'
  ) return false
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
  decision(
    owner: string,
    pointId: string,
    expectedKind: CordisXExtensionPointKind,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision
  surfaceAnchorSupport(pointId: string, anchorId: string): Readonly<{ supported: boolean; reason?: string }>
  authorizeSurfaceCommand(
    owner: string,
    pointId: string,
    contributionId: string,
    commandId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision
  authorizeSurfaceRoute(
    owner: string,
    pointId: string,
    contributionId: string,
    routeId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision
  authorizeOutletRoute(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision
  authorizeOutletPage(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision
  authorizeOutletPageCommand(
    owner: string,
    pointId: string,
    routeId: string,
    pageId: string,
    actionId: string,
    commandId: string,
    view?: PluginGenerationView,
  ): ExtensionPointAccessDecision
}

/** Production authorization seam. Descriptor availability stays owned by this broker; grants stay in PermissionBroker. */
export interface ExtensionPointAuthorizationAuthority {
  access(identity: CordisXPluginIdentity, pointId: string, view?: PluginGenerationView): Readonly<{
    authorized: boolean
    state: 'allowed' | 'denied' | 'pending'
    policy: CordisXPointPolicy
    reason: string
  }>
  policy(identity: CordisXPluginIdentity, pointId: string): CordisXPointPolicy
  policies(): readonly Readonly<{
    identity: CordisXPluginIdentity
    pointId: string
    policy: CordisXPointPolicy
  }>[]
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

export type ExtensionPointAccessFields =
  | { readonly operation: 'surface.command.invoke'; readonly contributionId: string; readonly commandId: string }
  | { readonly operation: 'surface.route.navigate'; readonly contributionId: string; readonly routeId: string }
  | { readonly operation: 'outlet.route.navigate'; readonly routeId: string; readonly pageId: string }
  | { readonly operation: 'outlet.page.mount'; readonly routeId: string; readonly pageId: string }
  | {
    readonly operation: 'outlet.page.command.invoke'
    readonly routeId: string
    readonly pageId: string
    readonly actionId: string
    readonly commandId: string
  }

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
  if (registration.item === null || typeof registration.item !== 'object' || Array.isArray(registration.item)) {
    return undefined
  }
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
    : i18n.resolveFor(
      registration.owner,
      description,
      `extension-point:contribution:${registration.qualifiedId}:description`,
    ).text
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
      unavailable: input.i18n.resolveFor(
        'host',
        CATALOG_TEXT.statusUnavailable,
        'extension-point:catalog:status:unavailable',
      ),
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
      : outlet.mounted
      ? 'active'
      : 'inactive'
    const currentContext: CordisXExtensionPointCurrentContextState = descriptor.adapterSupport === 'supported'
      ? observedContext
      : 'not-mounted'
    const currentContextCode = descriptor.kind === 'surface'
      ? liveSurface?.code
      : currentContext === 'not-mounted'
      ? 'outlet.not-mounted'
      : undefined
    const currentContextDetail = descriptor.kind === 'surface'
      ? liveSurface?.detail === undefined ? undefined : liveSurface.detail.fallback ?? liveSurface.detail.key
      : outlet?.error
    const effectiveAdapterSupport: CordisXExtensionPointAdapterSupport = descriptor.adapterSupport === 'supported'
        && currentContextCode === 'anchor.unresolved'
      ? 'unverified'
      : descriptor.adapterSupport
    const availability: CordisXExtensionPointAvailability = effectiveAdapterSupport === 'supported'
      ? 'available'
      : effectiveAdapterSupport === 'unverified'
      ? 'pending'
      : 'unavailable'
    const availabilityCode = currentContextCode
      ?? (descriptor.adapterSupport === 'supported' ? undefined : `adapter.${descriptor.adapterSupport}`)
    const availabilityDetail = currentContextDetail
      ?? (descriptor.adapterSupport === 'supported' ? undefined : descriptor.diagnosticProjection?.text)
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
        availability: effectiveAnchorSupport === 'supported'
          ? 'available'
          : effectiveAnchorSupport === 'unverified'
          ? 'pending'
          : 'unavailable',
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
        ? registrations.some(item =>
          item.valid && item.visible && item.authorized && !item.pending
          && (descriptor.id === 'manager.settings.tabs' || item.rendered)
        )
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
    }).sort((left, right) =>
      left.name.localeCompare(right.name) || left.identity.source.localeCompare(right.identity.source)
      || left.identity.id.localeCompare(right.identity.id)
    )
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
      points: Object.freeze(points.map(point =>
        Object.freeze({
          id: point.id,
          state: point.currentContext,
          ...(point.currentContextCode === undefined ? {} : { code: point.currentContextCode }),
          ...(point.currentContextDetail === undefined ? {} : {
            detail: Object.freeze({ key: `runtime-context.${point.id}`, fallback: point.currentContextDetail }),
          }),
          ...(point.anchors === undefined ? {} : {
            anchors: Object.freeze(point.anchors.map(anchor =>
              Object.freeze({
                id: anchor.id,
                state: anchor.currentContext,
                ...(anchor.availabilityCode === undefined ? {} : { code: anchor.availabilityCode }),
                ...(anchor.availabilityDetail === undefined ? {} : {
                  detail: Object.freeze({
                    key: `runtime-context.${point.id}.${anchor.id}`,
                    fallback: anchor.availabilityDetail,
                  }),
                }),
              })
            )),
          }),
        })
      )),
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
