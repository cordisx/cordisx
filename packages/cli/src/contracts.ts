import type { Context, Disposable, Effect } from '@deepseek-ai/cordis'
import type { CordisXPluginManifestV1 } from './platform-contracts.js'
import type { CordisXPluginManifestV4 } from './permission-contracts.js'
import type { CordisXPluginDependencyV1 } from './plugin-lifecycle-contracts.js'

export * from './platform-contracts.js'
export * from './permission-contracts.js'
export * from './agent-contracts.js'
export * from './plugin-lifecycle-contracts.js'

/** Scalar parameter values accepted by LocalizedText and the protocol. */
export type CordisXMessageParam = string | number | boolean | null

/** Serializable ICU message parameters. */
export type CordisXMessageParams = Readonly<Record<string, CordisXMessageParam>>

/** Message reference retained by ledgers and resolved only during host projection. */
export interface CordisXLocalizedText<Params extends CordisXMessageParams = CordisXMessageParams> {
  readonly namespace?: string
  readonly key: string
  readonly params?: Params
  readonly fallback?: string
}

/** Plugin-augmentable key-to-parameter vocabulary used by typed translator seats. */
export type CordisXMessageSchema = Record<string, CordisXMessageParams | undefined>
export type CordisXMessageDefinition<Messages> = Readonly<{
  [Key in keyof Messages]: CordisXMessageParams | undefined
}>

/** One fiber-owned namespace/locale dictionary. Values use ICU MessageFormat. */
export interface CordisXLocaleCatalog<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> {
  readonly namespace: string
  readonly locale: string
  readonly default?: boolean
  readonly messages: Readonly<Partial<{ [Key in keyof Messages]: string }>>
}

/** Current read-only host locale projection. */
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

/** Deterministic resolution result retained for manager diagnostics. */
export interface CordisXLocalizedProjection {
  readonly text: string
  readonly namespace: string
  readonly key: string
  readonly locale?: string
  readonly diagnostic?: CordisXLocalizationDiagnosticCode
  readonly detail?: string
}

/** Read-only manager view of one localization problem. */
export interface CordisXLocalizationDiagnostic extends CordisXLocalizedProjection {
  readonly owner: string
  readonly message: CordisXLocalizedText
  readonly site?: string
}

type CordisXMessageArgs<Value> = Value extends CordisXMessageParams ? [params: Value] : [params?: undefined]

/** Typed translator and framework-agnostic reactive bindings injected by the host. */
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

/** Standard localization props embedded into every controlled page mount. */
export interface CordisXPageLocalizationProps<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> {
  readonly localeNamespace: string
  readonly t: CordisXLocalizationSeat<Messages>['t']
  readonly localization: CordisXLocalizationSeat<Messages>
}

/** DSH-style localization service exposed to trusted-local plugins. */
export interface CordisXI18n {
  define<Messages extends CordisXMessageDefinition<Messages>>(catalog: CordisXLocaleCatalog<Messages>): Disposable<void | Promise<void>>
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
export type CordisXJsonValue = CordisXJsonScalar | readonly CordisXJsonValue[] | { readonly [key: string]: CordisXJsonValue }

export const CORDISX_PLUGIN_CONSOLE_ENTRY_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-console-entry.v1.schema.json' as const
export const CORDISX_PLUGIN_CONSOLE_PAGE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-console-page.v1.schema.json' as const

export type CordisXPluginConsoleKind = 'console' | 'invocation' | 'permission' | 'lifecycle' | 'diagnostic'
export type CordisXPluginConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error'
export type CordisXPluginConsoleCoverage = 'host-mediated' | 'scoped-console' | 'best-effort' | 'unknown'
export type CordisXPluginConsolePhase =
  | 'requested' | 'ask' | 'allow' | 'deny' | 'dispatch'
  | 'success' | 'failure' | 'cancel' | 'activate' | 'dispose' | 'reload'
export type CordisXPluginConsoleStatus = 'pending' | 'success' | 'failure' | 'denied' | 'cancelled'

export interface CordisXPluginConsoleIdentityV1 {
  readonly source: string
  readonly pluginId: string
}

export interface CordisXPluginConsoleValueSummaryV1 {
  readonly type: 'undefined' | 'null' | 'boolean' | 'number' | 'string' | 'bigint' | 'symbol' | 'function' | 'error' | 'array' | 'object' | 'element' | 'circular' | 'unavailable' | 'redacted'
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

/** Browser-compatible console subset lexically injected into one plugin bundle. */
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
export const CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-runtime-context.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-policy.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-access.v1.schema.json' as const
export const CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/extension-point-access.v2.schema.json' as const
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

/** Protocol-v1 host-owned identity for one structured surface or controlled outlet. */
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

/** Protocol-v2 descriptor. Stability is a product promise; availability is a live host fact. */
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

/** Protocol-v3 descriptor additions for controlled outlet compatibility. */
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

/** Protocol-v5 static host support contract. Current page/DOM state is intentionally absent. */
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

/** Launcher-bound canonical tuple; plugins never provide or override source. */
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

interface CordisXExtensionPointAccessBase {
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

interface CordisXExtensionPointAccessBaseV2 {
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

export interface CordisXToolbarItem extends CordisXStructuredAction {
  readonly anchor: string
  readonly placement: 'before' | 'after' | 'menu'
}

export interface CordisXTabItem {
  readonly id: string
  readonly title: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly route: CordisXRouteReference
  readonly badge?: CordisXLocalizedText | string | number
  readonly order?: number
  readonly when?: CordisXWhen
}

/** Manager Settings content-tab header data. Envelope options own identity/order/state. */
export interface CordisXManagerSettingsContentTabItem {
  readonly title: CordisXLocalizedText
  readonly icon: CordisXIconToken
  readonly route: CordisXRouteReference
}

/** @deprecated Use CordisXManagerSettingsContentTabItem. The stable surface id remains manager.settings.tabs. */
export type CordisXManagerSettingsTabItem = CordisXManagerSettingsContentTabItem

/** Manager Settings-adjacent navigation data; route/page metadata owns all display text and icons. */
export interface CordisXManagerSettingsNavigationItem {
  readonly route: CordisXRouteReference
}

export interface CordisXPresenterItem {
  readonly kind: 'banner' | 'status' | 'chip' | 'progress'
  readonly text: CordisXLocalizedText
  readonly detail?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'error'
  readonly command?: CordisXCommandReference
  readonly route?: CordisXRouteReference
  readonly progress?: Readonly<{ current: number; total: number }>
}

export interface CordisXEnvironmentSection {
  readonly sectionId: string
  readonly title: CordisXLocalizedText
  readonly description?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
}

export interface CordisXEnvironmentSectionAction extends CordisXStructuredAction {
  readonly sectionId: string
  readonly command: CordisXCommandReference
}

export interface CordisXEnvironmentRow {
  readonly sectionId: string
  readonly rowId: string
  readonly label: CordisXLocalizedText
  readonly value?: CordisXLocalizedText | CordisXJsonScalar
  readonly description?: CordisXLocalizedText
  readonly status?: CordisXIconToken
}

export interface CordisXEnvironmentRowAction extends CordisXStructuredAction {
  readonly rowId: string
  readonly command: CordisXCommandReference
}

/** Extensible structured-surface vocabulary. Plugins may augment this map. */
export interface CordisXSurfaceMap {
  'sidebar.footer.before-control': CordisXStructuredAction
  'sidebar.footer.after-control': CordisXStructuredAction
  'sidebar.footer.menu': CordisXStructuredAction
  'sidebar.account.menu': CordisXStructuredAction
  'sidebar.navigation.items': CordisXNavigationItem
  'sidebar.workspace.menu': CordisXStructuredAction
  'sidebar.session.actions': CordisXStructuredAction
  'sidebar.session.menu': CordisXStructuredAction
  'workspace.toolbar.items': CordisXToolbarItem
  'session.header.actions': CordisXStructuredAction
  'session.tabs': CordisXTabItem
  'session.banner.items': CordisXPresenterItem
  'session.message.actions': CordisXStructuredAction
  'session.turn.footer': CordisXPresenterItem
  'session.tool.actions': CordisXStructuredAction
  'composer.toolbar.items': CordisXToolbarItem
  'composer.command-menu.items': CordisXStructuredAction
  'composer.dock.above': CordisXPresenterItem
  'composer.dock.below': CordisXPresenterItem
  'panel.right.header-actions': CordisXStructuredAction
  'panel.right.tabs': CordisXTabItem
  'panel.bottom.header-actions': CordisXStructuredAction
  'panel.bottom.tabs': CordisXTabItem
  'environment.panel.header-actions': CordisXStructuredAction
  'environment.panel.sections': CordisXEnvironmentSection
  'environment.section.actions': CordisXEnvironmentSectionAction
  'environment.section.rows': CordisXEnvironmentRow
  'environment.row.trailing-actions': CordisXEnvironmentRowAction
  'manager.settings.tabs': CordisXManagerSettingsContentTabItem
  'manager.settings.navigation-items': CordisXManagerSettingsNavigationItem
}

export type CordisXSurfaceName = Extract<keyof CordisXSurfaceMap, string>

export const CORDISX_SURFACE_NAMES = [
  'sidebar.footer.before-control',
  'sidebar.footer.after-control',
  'sidebar.footer.menu',
  'sidebar.account.menu',
  'sidebar.navigation.items',
  'sidebar.workspace.menu',
  'sidebar.session.actions',
  'sidebar.session.menu',
  'workspace.toolbar.items',
  'session.header.actions',
  'session.tabs',
  'session.banner.items',
  'session.message.actions',
  'session.turn.footer',
  'session.tool.actions',
  'composer.toolbar.items',
  'composer.command-menu.items',
  'composer.dock.above',
  'composer.dock.below',
  'panel.right.header-actions',
  'panel.right.tabs',
  'panel.bottom.header-actions',
  'panel.bottom.tabs',
  'environment.panel.header-actions',
  'environment.panel.sections',
  'environment.section.actions',
  'environment.section.rows',
  'environment.row.trailing-actions',
  'manager.settings.tabs',
  'manager.settings.navigation-items',
] as const satisfies readonly CordisXSurfaceName[]

export const CORDISX_IMPLEMENTED_SURFACE_NAMES = [
  'sidebar.footer.before-control',
  'sidebar.footer.after-control',
  'sidebar.footer.menu',
  'sidebar.account.menu',
  'sidebar.navigation.items',
  'workspace.toolbar.items',
  'session.header.actions',
  'composer.toolbar.items',
  'environment.panel.header-actions',
  'environment.panel.sections',
  'environment.section.actions',
  'environment.section.rows',
  'environment.row.trailing-actions',
  'manager.settings.tabs',
  'manager.settings.navigation-items',
] as const satisfies readonly CordisXSurfaceName[]

interface CordisXContributionOptionsBase<Name extends CordisXSurfaceName> {
  readonly name: Name
  readonly id: string
  readonly order?: number
  readonly when?: CordisXWhen
  readonly disabled?: CordisXDisabledState
}

export type CordisXManagerSettingsNavigationGroup = 'before-settings' | 'after-settings'

export type CordisXContributionOptions<Name extends CordisXSurfaceName = CordisXSurfaceName> =
  CordisXContributionOptionsBase<Name>
  & (Name extends 'manager.settings.navigation-items'
    ? { readonly group: CordisXManagerSettingsNavigationGroup }
    : Name extends 'manager.settings.tabs'
      ? { readonly group?: never }
      : { readonly group?: string })

export interface CordisXContributionPresentationOptions {
  readonly group?: string
  readonly order?: number
  readonly when?: CordisXWhen
  readonly disabled?: CordisXDisabledState
}

/** Callable fiber-owned disposer with immutable snapshot replacement. */
export interface CordisXContributionHandle<Item> {
  (): void
  dispose(): void
  update(snapshot: Item): void
  updateOptions(options: CordisXContributionPresentationOptions): void
}

/** DSH-style slot service with structured data instead of a DOM component. */
export interface CordisXSlots {
  inject<Name extends CordisXSurfaceName>(name: Name, setup: () => Effect): Disposable<void | Promise<void>>
  register<Name extends CordisXSurfaceName>(
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]>
}

export interface CordisXCommandMetadata {
  readonly id: string
  readonly title: CordisXLocalizedText
  readonly category?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly public?: boolean
}

export interface CordisXCommandContext {
  readonly owner: string
  readonly id: string
  readonly arguments: CordisXJsonValue | undefined
  readonly signal: AbortSignal
  readonly invocationKey: string
  readonly hostContext?: CordisXSurfaceInvocationContextV1
}

export interface CordisXSurfaceInvocationContextV1 {
  readonly $schema: typeof CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1
  readonly schemaVersion: 1
  readonly generation: string
  readonly contextRef: string
  readonly pointId: string
  readonly contributionId: string
  readonly commandId: string
  readonly provenance: 'observed' | 'cordisx' | 'inferred'
  readonly source:
    | Readonly<{ kind: 'adapter'; adapterId: string; adapterVersion: string; hostId: string }>
    | Readonly<{ kind: 'cordisx'; component: string; generation: string }>
  readonly identity: Readonly<{
    workspaceRef?: string
    agent?: Readonly<{
      sessionKey: string
      turnId?: string
      stepId?: string
      itemId?: string
      messageId?: string
      toolCallId?: string
    }>
    platformSession?: Readonly<{ providerId: string; remoteSessionId: string }>
    contextId?: string
  }>
}

export type CordisXCommandHandler = (context: CordisXCommandContext) => unknown | Promise<unknown>

export interface CordisXCommands {
  register(metadata: CordisXCommandMetadata, handler: CordisXCommandHandler): Disposable<void | Promise<void>>
  execute(reference: CordisXCommandReference, invocationKey?: string): Promise<unknown>
}

/** Open outlet map. Host adapters extend this through module augmentation. */
export interface CordisXOutletMap {
  app: { readonly scope: 'renderer' }
  main: { readonly scope: 'main' }
  'session.content': { readonly scope: 'session' }
  'manager.settings.content': { readonly scope: 'manager-settings' }
  'manager.content': { readonly scope: 'manager' }
}

export type CordisXOutletName = Extract<keyof CordisXOutletMap, string>

export interface CordisXPageTab {
  readonly id: string
  readonly label: CordisXLocalizedText
  readonly icon?: CordisXIconToken
}

/** Host-rendered page-chrome action. Plugins provide data and a command reference only. */
export interface CordisXPageHeaderAction extends CordisXStructuredAction {
  readonly id: string
  readonly command: CordisXCommandReference
  readonly when?: CordisXWhen
  readonly disabled?: CordisXDisabledState
}

export const CORDISX_PAGE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v1.schema.json' as const
export const CORDISX_PAGE_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v2.schema.json' as const
export const CORDISX_PAGE_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v3.schema.json' as const
export const CORDISX_ROUTE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v1.schema.json' as const
export const CORDISX_ROUTE_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v2.schema.json' as const
/** Data-only Manager subroute declaration. The Host, never a plugin body, owns the chrome. */
export const CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v1.schema.json' as const
/** Renderer-safe Host projection of an active Manager subroute. */
export const CORDISX_MANAGER_CONTENT_PROJECTION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-projection.v1.schema.json' as const

export interface CordisXManagerContentNavigationDeclarationV1 {
  readonly $schema: typeof CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1
  readonly schemaVersion: 1
  readonly id: string
  readonly route: CordisXRouteReference
  readonly parentRoute?: CordisXRouteReference
  readonly header: Readonly<{
    readonly title:
      | Readonly<{ readonly kind: 'route' }>
      | Readonly<{ readonly kind: 'record'; readonly recordIdParam: string; readonly fallback: CordisXLocalizedText }>
  }>
  readonly tabs?: readonly Readonly<{ readonly id: string; readonly route: CordisXRouteReference }>[]
}

/**
 * A bounded record-title catalog.  It is data only: no DOM, CSS, callback,
 * secret, path, or raw bridge crosses this boundary.
 */
export interface CordisXManagerContentRecordTitleV1 {
  readonly id: string
  readonly title: CordisXLocalizedText
}

/**
 * An atomic, renderer-safe replacement for one plugin's Manager-content
 * catalog. It prevents observers from ever seeing a route catalog without
 * the record it is currently rendering.
 */
export interface CordisXManagerContentNavigationProjectionV1 {
  readonly declarations: readonly CordisXManagerContentNavigationDeclarationV1[]
  readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
}

export interface CordisXManagerContentNavigation {
  register(declaration: CordisXManagerContentNavigationDeclarationV1): Disposable<void | Promise<void>>
  registerRecordTitles(records: readonly CordisXManagerContentRecordTitleV1[]): Disposable<void | Promise<void>>
  replaceProjection(projection: CordisXManagerContentNavigationProjectionV1): Disposable<void | Promise<void>>
}

export interface CordisXPageMetadata {
  /** Omitted only for the pre-versioned third-party compatibility path. */
  readonly $schema?: typeof CORDISX_PAGE_SCHEMA_V1 | typeof CORDISX_PAGE_SCHEMA_V2 | typeof CORDISX_PAGE_SCHEMA_V3
  /** Omitted only for the pre-versioned third-party compatibility path. */
  readonly schemaVersion?: 1 | 2 | 3
  readonly id: string
  readonly title: CordisXLocalizedText
  /** User-facing purpose and applicable context; never an implementation note. */
  readonly description?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  /** Host-rendered chrome policy. Body-only remains subject to the target outlet policy. */
  readonly chrome?: CordisXPageChrome
  readonly breadcrumbs?: readonly CordisXLocalizedText[]
  readonly tabs?: readonly CordisXPageTab[]
  readonly headerActions?: readonly CordisXPageHeaderAction[]
  readonly localeNamespace?: string
}

/** Closed protocol page.v3 document. Owner-default i18n replaces the legacy localeNamespace hint. */
export type CordisXPageMetadataV3 = Omit<
  CordisXPageMetadata,
  '$schema' | 'schemaVersion' | 'description' | 'localeNamespace'
> & {
  readonly $schema: typeof CORDISX_PAGE_SCHEMA_V3
  readonly schemaVersion: 3
  readonly description: CordisXLocalizedText
}

export interface CordisXPageNavigation {
  navigate(reference: CordisXRouteReference): Promise<void>
  back(outlet?: CordisXOutletName): Promise<void>
  close(outlet?: CordisXOutletName): Promise<void>
}

/**
 * A small Host-owned control surface for contributed pages.  Plugins receive
 * a semantic select model, never a framework instance, selector, or styling
 * handle.  The Host owns the actual control, portal, keyboard behaviour, and
 * disposal.
 */
export interface CordisXPageSelectControl<Value extends CordisXJsonScalar = CordisXJsonScalar> {
  readonly root: HTMLElement
  readonly value: Value | undefined
  set(options: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[], value?: Value): void
  dispose(): void
}

export interface CordisXPageControls {
  select<Value extends CordisXJsonScalar>(options: {
    readonly id?: string
    readonly label: string
    readonly options: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[]
    readonly value?: Value
    readonly disabled?: boolean
    readonly clearable?: boolean
    readonly onChange: (value: Value | undefined) => void
  }): CordisXPageSelectControl<Value>
  dispose(): void
}

export interface CordisXPageMountContext<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
>
  extends CordisXPageLocalizationProps<Messages> {
  readonly container: HTMLElement
  readonly document: Document
  readonly signal: AbortSignal
  readonly routeId: string
  readonly outlet: CordisXOutletName
  readonly params: Readonly<Record<string, CordisXJsonScalar>>
  readonly navigation: CordisXPageNavigation
  /** Host-owned semantic controls available to contributed page bodies. */
  readonly controls: CordisXPageControls
  readonly tabId?: string
}

export type CordisXPageMount<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> = (
  context: CordisXPageMountContext<Messages>,
) => void | Disposable<void>

export interface CordisXPages {
  register<Messages extends CordisXMessageDefinition<Messages>>(
    metadata: CordisXPageMetadata,
    mount: CordisXPageMount<Messages>,
  ): Disposable<void | Promise<void>>
}

export interface CordisXRouteDefinition<Outlet extends CordisXOutletName = CordisXOutletName> {
  /** Omitted only for the pre-versioned third-party compatibility path. */
  readonly $schema?: typeof CORDISX_ROUTE_SCHEMA_V1 | typeof CORDISX_ROUTE_SCHEMA_V2
  /** Omitted only for the pre-versioned third-party compatibility path. */
  readonly schemaVersion?: 1 | 2
  readonly id: string
  readonly path: string
  readonly outlet: Outlet
  readonly page: string
  readonly title?: CordisXLocalizedText
  /** User-facing purpose and entry context; canonical route fields remain untranslated. */
  readonly description?: CordisXLocalizedText
  readonly when?: CordisXWhen
}

/** Closed protocol route.v2 document with required localized product metadata. */
export type CordisXRouteDefinitionV2<Outlet extends CordisXOutletName = CordisXOutletName> = Omit<
  CordisXRouteDefinition<Outlet>,
  '$schema' | 'schemaVersion' | 'title' | 'description'
> & {
  readonly $schema: typeof CORDISX_ROUTE_SCHEMA_V2
  readonly schemaVersion: 2
  readonly title: CordisXLocalizedText
  readonly description: CordisXLocalizedText
}

export interface CordisXRoutes extends CordisXPageNavigation {
  register<Outlet extends CordisXOutletName>(definition: CordisXRouteDefinition<Outlet>): Disposable<void | Promise<void>>
}

/** Canonical configuration-v2 application plane exposed by runtime snapshots. */
export type CordisXConfigApplies = 'live' | 'plugin-restart' | 'service-restart' | 'app-restart'

/** Closed v1 module spelling accepted only as a compatibility input. */
export type CordisXConfigAppliesInput = CordisXConfigApplies | 'restart'

export interface CordisXStandardSchemaResult<T = unknown> {
  readonly value?: T
  readonly issues?: readonly {
    readonly message: string
    readonly path?: readonly (string | number | { readonly key: PropertyKey })[]
  }[]
}

/** Structural Standard Schema boundary; validators must be synchronous in the renderer runtime. */
export interface CordisXStandardSchema<T = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => CordisXStandardSchemaResult<T> | Promise<CordisXStandardSchemaResult<T>>
  }
}

export interface CordisXPluginSettings {
  /** Return the calling plugin's current normalized, immutable config snapshot. */
  get<T = unknown>(): T
  /** Observe committed live snapshots. Restart modes never publish a false live update. */
  watch<T = unknown>(listener: (value: T) => void): Disposable<void>
}

export type CordisXConfigFieldPath = readonly string[]

/** Closed semantic icon vocabulary for Host-owned configuration presentation. */
export type CordisXConfigFormIcon =
  | 'host:calendar' | 'host:clock' | 'host:palette' | 'host:tags'
  | 'host:folder' | 'host:key' | 'host:settings' | 'host:info'
  | 'host:files' | 'host:save' | 'host:reset'

export interface CordisXConfigFormGroupSnapshot {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly icon?: CordisXConfigFormIcon
}

export interface CordisXConfigFormActionIcons {
  readonly save?: CordisXConfigFormIcon
  readonly reset?: CordisXConfigFormIcon
}

export type CordisXConfigRendererSelector =
  | { readonly role: string }
  | { readonly path: CordisXConfigFieldPath }
  | { readonly namespace: string }

export interface CordisXConfigRendererOptions {
  readonly id: string
  readonly selector: CordisXConfigRendererSelector
  readonly order?: number
}

export interface CordisXConfigFieldSnapshot {
  readonly namespace: string
  readonly path: CordisXConfigFieldPath
  readonly type: string
  readonly role?: string
  readonly label?: string
  readonly description?: string
  readonly value: unknown
  /** Whether the leaf schema declares an explicit default value. */
  readonly hasDefault?: boolean
  /**
   * Resolved leaf default for Host-owned draft projection. Never projected for
   * sensitive roles.
   */
  readonly defaultValue?: unknown
  readonly disabled: boolean
  readonly required: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly choices?: readonly { readonly label: string; readonly value: CordisXJsonScalar }[]
  /** Scalar element type for a bounded primitive array. */
  readonly arrayItemType?: 'string' | 'number' | 'natural'
  /** Host-validated semantic icon. No URL, SVG, CSS, or DOM is accepted. */
  readonly icon?: CordisXConfigFormIcon
  readonly group?: CordisXConfigFormGroupSnapshot
}

export interface CordisXConfigFieldController extends CordisXConfigFieldSnapshot {
  readonly signal: AbortSignal
  setDraft(value: unknown): void
}

export type CordisXConfigRendererMount = (
  container: HTMLElement,
  field: CordisXConfigFieldController,
) => void | Disposable<void> | Promise<void | Disposable<void>>

export interface CordisXConfigRenderers {
  register(options: CordisXConfigRendererOptions, mount: CordisXConfigRendererMount): Disposable<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH-style semantic UI slot service backed by Codex DOM adapters. */
    slots: CordisXSlots
    commands: CordisXCommands
    pages: CordisXPages
    routes: CordisXRoutes
    /** Data-only Manager subroute declarations; the Host renders chrome and controls history. */
    managerContent: CordisXManagerContentNavigation
    /** Fiber-owned locale dictionaries and typed translator seats. */
    i18n: CordisXI18n
    /** Owner-bound config snapshots and live subscriptions. */
    settings: CordisXPluginSettings
    /** Fiber-owned custom field renderers inside Host-controlled form chrome. */
    configRenderers: CordisXConfigRenderers
  }
}

/** Cordis plugin module after browser bundling. */
export interface CordisXPluginModule {
  readonly name?: string
  readonly manifest?: CordisXPluginManifestV1 | CordisXPluginManifestV4
  readonly inject?: readonly string[] | Record<string, unknown>
  readonly Config?: CordisXStandardSchema
  readonly configApplies?: CordisXConfigAppliesInput
  readonly apply?: (ctx: Context, config: unknown) => unknown
  readonly default?: unknown
}

/** Plugin composition delivered from the launcher to the renderer. */
export interface CordisXBrowserPlugin {
  readonly id: string
  /** Launcher-owned canonical source; module code cannot replace it. */
  readonly source: string
  readonly enabled: boolean
  readonly module?: CordisXPluginModule
  /** Launcher-created lazy module factory with a lexical, owner-scoped console. */
  readonly moduleFactory?: (console: CordisXPluginConsoleFacade) => CordisXPluginModule
  readonly config: unknown
  readonly revision: number
  /** Package-authoritative manifest, used instead of executing module metadata when present. */
  readonly manifest?: CordisXPluginManifestV1 | CordisXPluginManifestV4
  /** Immutable package and module generation metadata owned by the launcher. */
  readonly package?: {
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly moduleGeneration: string
    readonly dependencies: readonly CordisXPluginDependencyV1[]
    readonly canonicalSource?: string
  }
  /** Adjacent README.md captured by the launcher for this browser generation. */
  readonly readme?: string
}
