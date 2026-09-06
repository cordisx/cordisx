import type { Disposable, Effect } from '@deepseek-ai/cordis'

import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'

import type {
  NavigationCollectionAction,
  NavigationCollectionActions,
} from '@cordisx/protocol/navigation-collection-actions/v1'

import type { CordisXExtensionPointControlMode } from './control-contracts.js'

export type CordisXMessageParam = string | number | boolean | null

export type CordisXMessageParams = Readonly<Record<string, CordisXMessageParam>>

export interface CordisXLocalizedText<Params extends CordisXMessageParams = CordisXMessageParams> {
  readonly namespace?: string
  readonly key: string
  readonly params?: Params
  readonly fallback?: string
}

export type CordisXMessageSchema = Record<string, CordisXMessageParams | undefined>

export type CordisXMessageDefinition<Messages> = Readonly<
  {
    [Key in keyof Messages]: CordisXMessageParams | undefined
  }
>

export interface CordisXLocaleCatalog<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> {
  readonly namespace: string
  readonly locale: string
  readonly default?: boolean
  readonly messages: Readonly<Partial<{ [Key in keyof Messages]: string }>>
}

export interface CordisXLocalizationSnapshot {
  readonly locale: string
  readonly direction: 'ltr' | 'rtl' | 'auto'
  readonly version: number
}

export type CordisXLocalizationDiagnosticCode =
  | 'missing-namespace'
  | 'missing-key'
  | 'missing-params'
  | 'invalid-message'

export interface CordisXLocalizedProjection {
  readonly text: string
  readonly namespace: string
  readonly key: string
  readonly locale?: string
  readonly diagnostic?: CordisXLocalizationDiagnosticCode
  readonly detail?: string
}

export interface CordisXLocalizationDiagnostic extends CordisXLocalizedProjection {
  readonly owner: string
  readonly message: CordisXLocalizedText
  readonly site?: string
}

export type CordisXMessageArgs<Value> = Value extends CordisXMessageParams ? [params: Value] : [params?: undefined]

export interface CordisXLocalizationSeat<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> {
  readonly namespace: string
  t<Key extends Extract<keyof Messages, string>>(key: Key, ...args: CordisXMessageArgs<Messages[Key]>): string
  message<Key extends Extract<keyof Messages, string>>(
    key: Key,
    ...args: CordisXMessageArgs<Messages[Key]>
  ): CordisXLocalizedText<Messages[Key] extends CordisXMessageParams ? Messages[Key] : CordisXMessageParams>
  getSnapshot(): CordisXLocalizationSnapshot
  subscribe(listener: () => void): Disposable<void>
  effect(setup: (snapshot: CordisXLocalizationSnapshot) => Disposable<void>): Disposable<void>
  bindText(node: Node, message: CordisXLocalizedText): Disposable<void>
  bindAttribute(element: Element, name: string, message: CordisXLocalizedText): Disposable<void>
}

export interface CordisXPageLocalizationProps<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> {
  readonly localeNamespace: string
  readonly t: CordisXLocalizationSeat<Messages>['t']
  readonly localization: CordisXLocalizationSeat<Messages>
}

export interface CordisXI18n {
  define<Messages extends CordisXMessageDefinition<Messages>>(
    catalog: CordisXLocaleCatalog<Messages>,
  ): Disposable<void | Promise<void>>
  inject<Messages extends CordisXMessageDefinition<Messages>>(
    namespace: string,
    setup: (seat: CordisXLocalizationSeat<Messages>) => Effect,
  ): Disposable<void | Promise<void>>
  seat<Messages extends CordisXMessageDefinition<Messages>>(namespace?: string): CordisXLocalizationSeat<Messages>
  resolve(message: CordisXLocalizedText): CordisXLocalizedProjection
  getSnapshot(): CordisXLocalizationSnapshot
  diagnostics(): readonly CordisXLocalizationDiagnostic[]
}

export type CordisXJsonScalar = string | number | boolean | null

export type CordisXJsonValue = CordisXJsonScalar | readonly CordisXJsonValue[] | {
  readonly [key: string]: CordisXJsonValue
}

export const CORDISX_PLUGIN_CONSOLE_ENTRY_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-console-entry.v1.schema.json' as const

export const CORDISX_PLUGIN_CONSOLE_PAGE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-console-page.v1.schema.json' as const

export type CordisXPluginConsoleKind = 'console' | 'invocation' | 'permission' | 'lifecycle' | 'diagnostic'

export type CordisXPluginConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'

export type CordisXPluginConsoleCoverage = 'host-mediated' | 'scoped-console' | 'best-effort' | 'unknown'

export type CordisXPluginConsolePhase =
  | 'requested'
  | 'ask'
  | 'allow'
  | 'deny'
  | 'dispatch'
  | 'success'
  | 'failure'
  | 'cancel'
  | 'activate'
  | 'dispose'
  | 'reload'

export type CordisXPluginConsoleStatus = 'pending' | 'success' | 'failure' | 'denied' | 'cancelled'

export interface CordisXPluginConsoleIdentityV1 {
  readonly source: string
  readonly pluginId: string
}

export interface CordisXPluginConsoleValueSummaryV1 {
  readonly type:
    | 'undefined'
    | 'null'
    | 'boolean'
    | 'number'
    | 'string'
    | 'bigint'
    | 'symbol'
    | 'function'
    | 'error'
    | 'array'
    | 'object'
    | 'element'
    | 'circular'
    | 'unavailable'
    | 'redacted'
  readonly preview: string
  readonly value?: string | number | boolean | null
  readonly name?: string
  readonly stack?: string
  readonly items?: readonly CordisXPluginConsoleValueSummaryV1[]
  readonly entries?: readonly { readonly key: string; readonly value: CordisXPluginConsoleValueSummaryV1 }[]
  readonly itemCount?: number
  readonly byteCount?: number
  readonly truncated?: boolean
}

export interface CordisXPluginConsoleConsumptionSummaryV1 {
  readonly type: string
  readonly itemCount?: number
  readonly byteCount?: number
  readonly preview?: string
  readonly truncated?: boolean
}

export interface CordisXPluginConsoleEntryV1 {
  readonly contract: 'cordisx.plugin-console-entry/v1'
  readonly schemaVersion: 1
  readonly entryId: string
  readonly seq: number
  readonly time: number
  readonly plugin: CordisXPluginConsoleIdentityV1
  readonly effectiveOwner?: CordisXPluginConsoleIdentityV1
  readonly generation: string
  readonly coverage: CordisXPluginConsoleCoverage
  readonly kind: CordisXPluginConsoleKind
  readonly method: CordisXPluginConsoleMethod
  readonly source: string
  readonly message: string
  readonly phase?: CordisXPluginConsolePhase
  readonly status?: CordisXPluginConsoleStatus
  readonly correlationId?: string
  readonly sessionId?: string
  readonly context?: { readonly page?: string; readonly invocationKey?: string }
  readonly trigger?: {
    readonly kind: 'capability' | 'registration' | 'lifecycle' | 'error-boundary'
    readonly registrationId?: string
    readonly parentCorrelationId?: string
  }
  readonly durationMs?: number
  readonly args: readonly CordisXPluginConsoleValueSummaryV1[]
  readonly request?: CordisXPluginConsoleConsumptionSummaryV1
  readonly result?: CordisXPluginConsoleConsumptionSummaryV1
  readonly stack?: string
}

export interface CordisXPluginConsolePageV1 {
  readonly contract: 'cordisx.plugin-console-page/v1'
  readonly schemaVersion: 1
  readonly plugin: CordisXPluginConsoleIdentityV1
  readonly generation: string
  readonly generatedAt: number
  readonly partialObservability: true
  readonly droppedEntries?: number
  readonly unattributedEntries?: number
  readonly entries: readonly CordisXPluginConsoleEntryV1[]
}

export interface CordisXPluginConsoleFacade {
  debug(...data: unknown[]): void
  log(...data: unknown[]): void
  info(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

export type CordisXIconToken = `${string}:${string}`

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v1.schema.json' as const

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v2.schema.json' as const

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v3.schema.json' as const

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v5.schema.json' as const

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V6 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v6.schema.json' as const

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v7.schema.json' as const

export const CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V8 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-extension-point-catalog.v8.schema.json' as const

export const CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-runtime-context.v1.schema.json' as const

export const CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-policy.v1.schema.json' as const

export const CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-access.v1.schema.json' as const

export const CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-access.v2.schema.json' as const

export interface CordisXExtensionPointControlClaimOptions {
  readonly claimId: string
  readonly mode: CordisXExtensionPointControlMode
  readonly priority?: number
  readonly requestedBindings?: Readonly<{
    properties?: readonly string[]
    commands?: readonly string[]
    events?: readonly string[]
  }>
}

export const CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-invocation-context.v1.schema.json' as const

export type CordisXExtensionPointKind = 'surface' | 'outlet'

export type CordisXPointPolicy = 'inherit' | 'allow' | 'deny'

export type CordisXEffectivePointPolicy = 'allow' | 'deny'

export type CordisXExtensionPointPayloadFamily =
  | 'action'
  | 'menu-item'
  | 'contextual-action'
  | 'tab'
  | 'manager-settings-tab'
  | 'manager-settings-content-tab'
  | 'manager-settings-navigation-item'
  | 'reasoning-intensity-presentation'
  | 'session-backdrop-presentation'
  | 'transient-canvas-presentation'
  | 'presenter'
  | 'navigation-item'
  | 'environment-section'
  | 'environment-row'
  | 'outlet'

export type CordisXExtensionPointStability = 'stable' | 'experimental' | 'reserved'

export type CordisXExtensionPointAvailability = 'available' | 'pending' | 'unavailable'

export type CordisXExtensionPointMaturity = 'stable' | 'experimental' | 'reserved'

export type CordisXExtensionPointAdapterSupport = 'supported' | 'unsupported' | 'unverified'

export type CordisXExtensionPointCurrentContextState = 'active' | 'inactive' | 'not-mounted'

export interface CordisXHostExtensionPointDescriptor {
  readonly id: string
  readonly kind: CordisXExtensionPointKind
  readonly title: CordisXLocalizedText
  readonly description: CordisXLocalizedText
  readonly icon: CordisXIconToken
}

export interface CordisXHostExtensionPointCatalogV1 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1
  readonly schemaVersion: 1
  readonly points: readonly CordisXHostExtensionPointDescriptor[]
}

export interface CordisXHostExtensionPointAnchorDescriptorV2 {
  readonly id: string
  readonly placements: readonly ('before' | 'after' | 'menu')[]
  readonly availability: CordisXExtensionPointAvailability
  readonly diagnostic?: CordisXLocalizedText
}

export interface CordisXHostExtensionPointDescriptorV2 extends CordisXHostExtensionPointDescriptor {
  readonly payloadFamily: CordisXExtensionPointPayloadFamily
  readonly stability: CordisXExtensionPointStability
  readonly availability: CordisXExtensionPointAvailability
  readonly diagnostic?: CordisXLocalizedText
  readonly anchors?: readonly CordisXHostExtensionPointAnchorDescriptorV2[]
}

export interface CordisXHostExtensionPointCatalogV2 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2
  readonly schemaVersion: 2
  readonly points: readonly CordisXHostExtensionPointDescriptorV2[]
}

export type CordisXPageChrome = 'standard' | 'body-only'

export interface CordisXHostExtensionPointDescriptorV3 extends CordisXHostExtensionPointDescriptorV2 {
  readonly pageChrome?: readonly CordisXPageChrome[]
  readonly presentationGroup?: string
  readonly routePathFamily?: 'app' | 'main' | 'session' | 'manager-settings' | 'host-defined'
}

export interface CordisXHostExtensionPointCatalogV3 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3
  readonly schemaVersion: 3
  readonly points: readonly CordisXHostExtensionPointDescriptorV3[]
}

export interface CordisXHostExtensionPointAnchorDescriptorV5 {
  readonly id: string
  readonly placements: readonly ('before' | 'after' | 'menu')[]
  readonly adapterSupport: CordisXExtensionPointAdapterSupport
  readonly diagnostic?: CordisXLocalizedText
}

export interface CordisXHostExtensionPointDescriptorV5 extends CordisXHostExtensionPointDescriptor {
  readonly payloadFamily: CordisXExtensionPointPayloadFamily
  readonly maturity: CordisXExtensionPointMaturity
  readonly adapterSupport: CordisXExtensionPointAdapterSupport
  readonly diagnostic?: CordisXLocalizedText
  readonly anchors?: readonly CordisXHostExtensionPointAnchorDescriptorV5[]
  readonly pageChrome?: readonly CordisXPageChrome[]
  readonly presentationGroup?: string
  readonly routePathFamily?: 'app' | 'main' | 'session' | 'manager-settings' | 'manager' | 'host-defined'
}

export interface CordisXHostExtensionPointCatalogV5 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5
  readonly schemaVersion: 5
  readonly points: readonly CordisXHostExtensionPointDescriptorV5[]
}

export type CordisXHostExtensionPointDescriptorV6 = CordisXHostExtensionPointDescriptorV5

export interface CordisXHostExtensionPointCatalogV6 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V6
  readonly schemaVersion: 6
  readonly points: readonly CordisXHostExtensionPointDescriptorV6[]
}

export type CordisXHostExtensionPointDescriptorV7 = CordisXHostExtensionPointDescriptorV6

export interface CordisXHostExtensionPointCatalogV7 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7
  readonly schemaVersion: 7
  readonly points: readonly CordisXHostExtensionPointDescriptorV7[]
}

export type CordisXHostExtensionPointDescriptorV8 = CordisXHostExtensionPointDescriptorV7

export interface CordisXHostExtensionPointCatalogV8 {
  readonly $schema: typeof CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V8
  readonly schemaVersion: 8
  readonly points: readonly CordisXHostExtensionPointDescriptorV8[]
}

export interface CordisXExtensionPointAnchorCurrentContextV1 {
  readonly id: string
  readonly state: CordisXExtensionPointCurrentContextState
  readonly code?: string
  readonly detail?: CordisXLocalizedText
}

export interface CordisXExtensionPointCurrentContextV1 {
  readonly id: string
  readonly state: CordisXExtensionPointCurrentContextState
  readonly code?: string
  readonly detail?: CordisXLocalizedText
  readonly anchors?: readonly CordisXExtensionPointAnchorCurrentContextV1[]
}

export interface CordisXExtensionPointRuntimeContextV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly points: readonly CordisXExtensionPointCurrentContextV1[]
}

export interface CordisXExtensionPointIdentity {
  readonly source: string
  readonly pluginId: string
  readonly pointId: string
}

export interface CordisXExtensionPointPolicyRecordV1 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1
  readonly schemaVersion: 1
  readonly identity: CordisXExtensionPointIdentity
  readonly policy: CordisXPointPolicy
}

export interface CordisXExtensionPointAccessBase {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V1
  readonly schemaVersion: 1
  readonly identity: CordisXExtensionPointIdentity
}

export interface CordisXSurfaceCommandAccessV1 extends CordisXExtensionPointAccessBase {
  readonly operation: 'surface.command.invoke'
  readonly contributionId: string
  readonly commandId: string
}

export interface CordisXOutletRouteAccessV1 extends CordisXExtensionPointAccessBase {
  readonly operation: 'outlet.route.navigate'
  readonly routeId: string
  readonly pageId: string
}

export interface CordisXOutletPageAccessV1 extends CordisXExtensionPointAccessBase {
  readonly operation: 'outlet.page.mount'
  readonly routeId: string
  readonly pageId: string
}

export interface CordisXOutletPageCommandAccessV1 extends CordisXExtensionPointAccessBase {
  readonly operation: 'outlet.page.command.invoke'
  readonly routeId: string
  readonly pageId: string
  readonly actionId: string
  readonly commandId: string
}

export type CordisXExtensionPointAccessV1 =
  | CordisXSurfaceCommandAccessV1
  | CordisXOutletRouteAccessV1
  | CordisXOutletPageAccessV1
  | CordisXOutletPageCommandAccessV1

export interface CordisXExtensionPointAccessBaseV2 {
  readonly $schema: typeof CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2
  readonly schemaVersion: 2
  readonly generation: string
  readonly identity: CordisXExtensionPointIdentity
}

export interface CordisXSurfaceCommandAccessV2 extends CordisXExtensionPointAccessBaseV2 {
  readonly operation: 'surface.command.invoke'
  readonly contributionId: string
  readonly commandId: string
}

export interface CordisXSurfaceRouteAccessV2 extends CordisXExtensionPointAccessBaseV2 {
  readonly operation: 'surface.route.navigate'
  readonly contributionId: string
  readonly routeId: string
}

export interface CordisXOutletRouteAccessV2 extends CordisXExtensionPointAccessBaseV2 {
  readonly operation: 'outlet.route.navigate'
  readonly routeId: string
  readonly pageId: string
}

export interface CordisXOutletPageAccessV2 extends CordisXExtensionPointAccessBaseV2 {
  readonly operation: 'outlet.page.mount'
  readonly routeId: string
  readonly pageId: string
}

export interface CordisXOutletPageCommandAccessV2 extends CordisXExtensionPointAccessBaseV2 {
  readonly operation: 'outlet.page.command.invoke'
  readonly routeId: string
  readonly pageId: string
  readonly actionId: string
  readonly commandId: string
}

export type CordisXExtensionPointAccessV2 =
  | CordisXSurfaceCommandAccessV2
  | CordisXSurfaceRouteAccessV2
  | CordisXOutletRouteAccessV2
  | CordisXOutletPageAccessV2
  | CordisXOutletPageCommandAccessV2

export type CordisXWhen =
  | { readonly key: string; readonly exists: boolean }
  | { readonly key: string; readonly equals: CordisXJsonScalar }
  | { readonly key: string; readonly notEquals: CordisXJsonScalar }
  | { readonly all: readonly CordisXWhen[] }
  | { readonly any: readonly CordisXWhen[] }
  | { readonly not: CordisXWhen }

export interface CordisXDisabledState {
  readonly value: boolean
  readonly reason?: CordisXLocalizedText
}

export interface CordisXCommandReference {
  readonly id: string
  readonly arguments?: CordisXJsonValue
}

export interface CordisXRouteReference {
  readonly id: string
  readonly params?: Readonly<Record<string, CordisXJsonScalar>>
}

export interface CordisXStructuredAction {
  readonly label: CordisXLocalizedText
  readonly ariaLabel?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly command?: CordisXCommandReference
  readonly route?: CordisXRouteReference
  /** Host-owned route activation and selected/pressed projection. Defaults to navigate. */
  readonly routeBehavior?: 'navigate' | 'toggle'
}

export interface CordisXNavigationAction extends CordisXStructuredAction {
  readonly id: string
  readonly command: CordisXCommandReference
  readonly when?: CordisXWhen
  readonly disabled?: CordisXDisabledState
}

export interface CordisXNavigationItem {
  readonly label: CordisXLocalizedText
  readonly description?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly command?: CordisXCommandReference
  readonly route?: CordisXRouteReference
  readonly actions?: readonly CordisXNavigationAction[]
}

export interface CordisXNavigationCollectionItem {
  readonly id: string
  readonly label: CordisXLocalizedText
  readonly description?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly route: CordisXRouteReference
  /** Lower values render first. A Room provider uses this for latest-first ordering. */
  readonly order: number
  readonly disabled?: CordisXDisabledState
}

export type CordisXNavigationCollectionAction = NavigationCollectionAction

export type CordisXNavigationCollectionActions = NavigationCollectionActions

export interface CordisXNavigationCollectionItemV2 extends CordisXNavigationCollectionItem {
  readonly actions?: CordisXNavigationCollectionActions
}

export interface CordisXNavigationCollectionImageLeadingVisual {
  readonly kind: 'image'
  readonly image: RasterImageSnapshotV1
}

export type CordisXNavigationCollectionLeadingVisual = CordisXNavigationCollectionImageLeadingVisual

export interface CordisXNavigationCollectionItemV3 extends CordisXNavigationCollectionItemV2 {
  /** Decorative image inside the Host-owned row; mutually exclusive with icon. */
  readonly leadingVisual?: CordisXNavigationCollectionLeadingVisual
}

export interface CordisXNavigationCollectionSnapshot {
  readonly revision: number
  readonly items: readonly CordisXNavigationCollectionItem[]
}

export interface CordisXNavigationCollectionSource {
  snapshot(): CordisXNavigationCollectionSnapshot
  subscribe(listener: () => void): () => void
  dispose?(): void
}

export interface CordisXNavigationCollectionSnapshotV2 {
  readonly revision: number
  readonly items: readonly CordisXNavigationCollectionItemV2[]
}

export interface CordisXNavigationCollectionSourceV2 {
  snapshot(): CordisXNavigationCollectionSnapshotV2
  subscribe(listener: () => void): () => void
  dispose?(): void
}

export interface CordisXNavigationCollectionSnapshotV3 {
  readonly revision: number
  readonly items: readonly CordisXNavigationCollectionItemV3[]
}

export interface CordisXNavigationCollectionSourceV3 {
  snapshot(): CordisXNavigationCollectionSnapshotV3
  subscribe(listener: () => void): () => void
  dispose?(): void
}

export interface CordisXNavigationCollectionOptions {
  readonly name: 'sidebar.navigation.items'
  readonly id: string
  readonly group: Readonly<{
    readonly id: string
    readonly label: CordisXLocalizedText
    readonly order?: number
  }>
}

export interface CordisXNavigationCollectionOptionsV2 extends CordisXNavigationCollectionOptions {
  readonly contract: 'cordisx.navigation-collection/v2'
}

export interface CordisXNavigationCollectionOptionsV3 extends CordisXNavigationCollectionOptions {
  readonly contract: 'cordisx.navigation-collection/v3'
}
