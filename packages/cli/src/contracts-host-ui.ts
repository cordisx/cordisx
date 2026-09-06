import type { Context, Disposable, Effect } from '@deepseek-ai/cordis'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import type {
  AgentPageComposerCommandAdapter,
  AgentPageComposerCommandContext,
} from '@cordisx/protocol/agent-page-admission/v2'
import type { ManagerCollectionRegistryV1 } from '@cordisx/protocol/manager-collection/v1'
import type { ManagerContentNavigationDeclarationV2 } from '@cordisx/protocol/manager-content-navigation/v2'
import type {
  ManagerContentNavigationDeclarationV3,
  ManagerContentProjectionV2,
} from '@cordisx/protocol/manager-content-navigation/v3'
import type {
  ManagerContentNavigationDeclarationV4,
  ManagerContentProjectionV3,
} from '@cordisx/protocol/manager-content-navigation/v4'
import type {
  ManagerContentNavigationDeclarationV5,
  ManagerContentProjectionV4,
} from '@cordisx/protocol/manager-content-navigation/v5'
import type {
  NavigationCollectionAction,
  NavigationCollectionActions,
} from '@cordisx/protocol/navigation-collection-actions/v1'
import type { ComponentType } from 'react'
import type { CordisXPluginManifestV1 } from './platform-contracts.js'
import type {
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
} from './permission-contracts.js'
import type { CordisXPluginDependencyV1 } from './plugin-lifecycle-contracts.js'
import type { CordisXExtensionPointControlMode, CordisXExtensionPointControlResultV1 } from './control-contracts.js'
import {
  CORDISX_SURFACE_INVOCATION_CONTEXT_SCHEMA_V1,
  CordisXCommandReference,
  CordisXDisabledState,
  CordisXExtensionPointControlClaimOptions,
  CordisXIconToken,
  CordisXJsonScalar,
  CordisXJsonValue,
  CordisXLocalizedText,
  CordisXMessageDefinition,
  CordisXMessageSchema,
  CordisXNavigationCollectionOptions,
  CordisXNavigationCollectionOptionsV2,
  CordisXNavigationCollectionOptionsV3,
  CordisXNavigationCollectionSource,
  CordisXNavigationCollectionSourceV2,
  CordisXNavigationCollectionSourceV3,
  CordisXNavigationItem,
  CordisXPageChrome,
  CordisXPageLocalizationProps,
  CordisXRouteReference,
  CordisXStructuredAction,
  CordisXWhen,
} from './contracts-extension-navigation.js'

export interface CordisXNavigationCollectionRegistration {
  dispose(): void
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

export interface CordisXManagerSettingsContentTabItem {
  readonly title: CordisXLocalizedText
  readonly icon: CordisXIconToken
  readonly route: CordisXRouteReference
}

export type CordisXManagerSettingsTabItem = CordisXManagerSettingsContentTabItem

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

export type CordisXReasoningIntensityMaterial = 'plastic' | 'bronze' | 'steel' | 'silver' | 'gold'

export interface CordisXReasoningIntensityStage {
  readonly label: CordisXLocalizedText
  readonly material: CordisXReasoningIntensityMaterial
}

export interface CordisXReasoningIntensityPresentation {
  readonly variant: 'imperium'
  readonly title: CordisXLocalizedText
  readonly motion?: 'smooth' | 'ascension'
  readonly stages: readonly CordisXReasoningIntensityStage[]
}

export type CordisXSessionBackdropAmbience = 'dormant' | 'ember' | 'forged' | 'luminous' | 'imperial'

export interface CordisXEmbeddedPng {
  readonly mediaType: 'image/png'
  readonly data: string
  readonly alt: CordisXLocalizedText
}

export interface CordisXSessionBackdropStage {
  readonly material: CordisXReasoningIntensityMaterial
  readonly ambience: CordisXSessionBackdropAmbience
  readonly portrait: CordisXEmbeddedPng
}

export interface CordisXSessionBackdropLayers {
  readonly portrait?: boolean
  readonly effects?: boolean
}

export interface CordisXSessionBackdropPresentation {
  readonly variant: 'imperium'
  readonly driver: 'reasoning-intensity'
  readonly motion?: 'smooth' | 'ascension'
  readonly layers?: CordisXSessionBackdropLayers
  readonly stages: readonly CordisXSessionBackdropStage[]
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
  'session.backdrop': CordisXSessionBackdropPresentation
  'composer.toolbar.items': CordisXToolbarItem
  'composer.reasoning-intensity': CordisXReasoningIntensityPresentation
  'composer.submit.effects': CordisXTransientCanvasPresentation
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

export interface CordisXTransientCanvasPresentation {
  readonly kind: 'isolated-canvas'
  readonly durationMs: number
  readonly reducedMotion: 'skip' | 'static'
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
  'session.backdrop',
  'composer.toolbar.items',
  'composer.reasoning-intensity',
  'composer.submit.effects',
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
  'session.backdrop',
  'composer.toolbar.items',
  'composer.reasoning-intensity',
  'composer.submit.effects',
  'environment.panel.header-actions',
  'environment.panel.sections',
  'environment.section.actions',
  'environment.section.rows',
  'environment.row.trailing-actions',
  'manager.settings.tabs',
  'manager.settings.navigation-items',
] as const satisfies readonly CordisXSurfaceName[]

export interface CordisXContributionOptionsBase<Name extends CordisXSurfaceName> {
  readonly name: Name
  readonly id: string
  readonly order?: number
  readonly when?: CordisXWhen
  readonly disabled?: CordisXDisabledState
  readonly control?: CordisXExtensionPointControlClaimOptions
}

export type CordisXManagerSettingsNavigationGroup = 'before-settings' | 'after-settings'

export type CordisXContributionOptions<Name extends CordisXSurfaceName = CordisXSurfaceName> =
  & CordisXContributionOptionsBase<Name>
  & (Name extends 'manager.settings.navigation-items' ? { readonly group: CordisXManagerSettingsNavigationGroup }
    : Name extends 'manager.settings.tabs' | 'composer.reasoning-intensity' | 'composer.submit.effects'
      ? { readonly group?: never }
    : { readonly group?: string })

export interface CordisXContributionPresentationOptions {
  readonly group?: string
  readonly order?: number
  readonly when?: CordisXWhen
  readonly disabled?: CordisXDisabledState
}

export interface CordisXContributionHandle<Item> {
  (): void
  dispose(): void
  update(snapshot: Item): void
  updateOptions(options: CordisXContributionPresentationOptions): void
  /** Present only for an explicit controlled claim; all values and commands are Host-stamped. */
  readonly control?: CordisXExtensionPointControlLease
}

export interface CordisXExtensionPointControlLeaseSnapshot {
  readonly revision: number
  readonly state: 'selected' | 'eligible' | 'denied' | 'conflicted' | 'suppressed' | 'pending' | 'revoked'
  readonly reason: string
  readonly properties: Readonly<Record<string, CordisXJsonScalar>>
  readonly commands: readonly Readonly<{ id: string; available: boolean; reason?: string }>[]
  readonly events: readonly Readonly<
    { id: string; sequence: number; payload: Readonly<Record<string, CordisXJsonScalar>> }
  >[]
}

export interface CordisXExtensionPointControlLease {
  snapshot(): CordisXExtensionPointControlLeaseSnapshot
  subscribe(listener: () => void): () => void
  invoke(
    commandId: string,
    arguments_?: Readonly<Record<string, CordisXJsonScalar>>,
  ): Promise<CordisXExtensionPointControlResultV1>
}

export interface CordisXSlots {
  inject<Name extends CordisXSurfaceName>(name: Name, setup: () => Effect): Disposable<void | Promise<void>>
  register<Name extends CordisXSurfaceName>(
    options: CordisXContributionOptions<Name>,
    item: CordisXSurfaceMap[Name],
  ): CordisXContributionHandle<CordisXSurfaceMap[Name]>
  registerCollection(
    options: CordisXNavigationCollectionOptionsV3,
    source: CordisXNavigationCollectionSourceV3,
  ): CordisXNavigationCollectionRegistration
  registerCollection(
    options: CordisXNavigationCollectionOptionsV2,
    source: CordisXNavigationCollectionSourceV2,
  ): CordisXNavigationCollectionRegistration
  registerCollection(
    options: CordisXNavigationCollectionOptions,
    source: CordisXNavigationCollectionSource,
  ): CordisXNavigationCollectionRegistration
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
  /** Host-injected source context; page composer authority is never plugin-authored. */
  readonly hostContext?: CordisXSurfaceInvocationContextV1 | AgentPageComposerCommandContext
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

export const CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v1.schema.json' as const

export const CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v2.schema.json' as const

export const CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v3.schema.json' as const

export const CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V4 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v4.schema.json' as const

export const CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-navigation.v5.schema.json' as const

export const CORDISX_MANAGER_CONTENT_PROJECTION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-projection.v1.schema.json' as const

export const CORDISX_MANAGER_CONTENT_PROJECTION_SCHEMA_V2 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-projection.v2.schema.json' as const

export const CORDISX_MANAGER_CONTENT_PROJECTION_SCHEMA_V3 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-projection.v3.schema.json' as const

export const CORDISX_MANAGER_CONTENT_PROJECTION_SCHEMA_V4 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-projection.v4.schema.json' as const

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

export type CordisXManagerContentNavigationDeclarationV2 = ManagerContentNavigationDeclarationV2

export type CordisXManagerContentNavigationDeclarationV3 = ManagerContentNavigationDeclarationV3

export type CordisXManagerContentNavigationDeclarationV4 = ManagerContentNavigationDeclarationV4

export type CordisXManagerContentNavigationDeclarationV5 = ManagerContentNavigationDeclarationV5

export type CordisXManagerContentProjectionV2 = ManagerContentProjectionV2

export type CordisXManagerContentProjectionV3 = ManagerContentProjectionV3

export type CordisXManagerContentProjectionV4 = ManagerContentProjectionV4

export interface CordisXManagerContentRecordTitleV1 {
  readonly id: string
  readonly title: CordisXLocalizedText
}

export interface CordisXManagerContentNavigationProjectionV1 {
  readonly declarations: readonly (
    CordisXManagerContentNavigationDeclarationV1 | CordisXManagerContentNavigationDeclarationV2
  )[]
  readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
}

export interface CordisXManagerContentNavigationCatalogProjectionV2 {
  readonly declarations: readonly (
    | CordisXManagerContentNavigationDeclarationV1
    | CordisXManagerContentNavigationDeclarationV2
    | CordisXManagerContentNavigationDeclarationV3
  )[]
  readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
}

export interface CordisXManagerContentNavigationCatalogProjectionV3 {
  readonly declarations: readonly (
    | CordisXManagerContentNavigationDeclarationV1
    | CordisXManagerContentNavigationDeclarationV2
    | CordisXManagerContentNavigationDeclarationV3
    | CordisXManagerContentNavigationDeclarationV4
  )[]
  readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
}

export interface CordisXManagerContentNavigationCatalogProjectionV4 {
  readonly declarations: readonly (
    | CordisXManagerContentNavigationDeclarationV1
    | CordisXManagerContentNavigationDeclarationV2
    | CordisXManagerContentNavigationDeclarationV3
    | CordisXManagerContentNavigationDeclarationV4
    | CordisXManagerContentNavigationDeclarationV5
  )[]
  readonly recordTitles: readonly CordisXManagerContentRecordTitleV1[]
}

export interface CordisXManagerContentNavigation {
  register(declaration: CordisXManagerContentNavigationDeclarationV1): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV2): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV3): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV4): Disposable<void | Promise<void>>
  register(declaration: CordisXManagerContentNavigationDeclarationV5): Disposable<void | Promise<void>>
  registerRecordTitles(records: readonly CordisXManagerContentRecordTitleV1[]): Disposable<void | Promise<void>>
  replaceProjection(projection: CordisXManagerContentNavigationProjectionV1): Disposable<void | Promise<void>>
  replaceProjection(projection: CordisXManagerContentNavigationCatalogProjectionV2): Disposable<void | Promise<void>>
  replaceProjection(projection: CordisXManagerContentNavigationCatalogProjectionV3): Disposable<void | Promise<void>>
  replaceProjection(projection: CordisXManagerContentNavigationCatalogProjectionV4): Disposable<void | Promise<void>>
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

export type CordisXPageMetadataV3 =
  & Omit<
    CordisXPageMetadata,
    '$schema' | 'schemaVersion' | 'description' | 'localeNamespace'
  >
  & {
    readonly $schema: typeof CORDISX_PAGE_SCHEMA_V3
    readonly schemaVersion: 3
    readonly description: CordisXLocalizedText
  }

export interface CordisXPageNavigation {
  /**
   * Plugin page-body navigation records an ordinary Host Manager history
   * entry. Host-rendered `manager.content` sibling tabs do not call this
   * helper; their activation replaces the current Manager history entry.
   */
  navigate(reference: CordisXRouteReference): Promise<void>
  back(outlet?: CordisXOutletName): Promise<void>
  close(outlet?: CordisXOutletName): Promise<void>
}

export interface CordisXPageSelectControl<Value extends CordisXJsonScalar = CordisXJsonScalar> {
  readonly root: HTMLElement
  readonly value: Value | undefined
  set(
    options: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[],
    value?: Value,
  ): void
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
> extends CordisXPageLocalizationProps<Messages> {
  readonly container: HTMLElement
  readonly document: Document
  readonly signal: AbortSignal
  readonly routeId: string
  /** Exact local route declaration id, supplied by the Host route registry when available. */
  readonly routeDefinitionId?: string
  readonly outlet: CordisXOutletName
  readonly params: Readonly<Record<string, CordisXJsonScalar>>
  readonly navigation: CordisXPageNavigation
  /** Present only while the Host has authenticated this mounted page for a page composer command. */
  readonly pageComposer?: AgentPageComposerCommandAdapter
  /** Host-owned semantic controls available to contributed page bodies. */
  readonly controls: CordisXPageControls
  /** Present only for the active authorized manager.content page mount. */
  readonly managerCollection?: ManagerCollectionRegistryV1
  readonly tabId?: string
}

export type CordisXPageMount<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> = (
  context: CordisXPageMountContext<Messages>,
) => void | Disposable<void>

export type CordisXReactPageProps<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> = Omit<CordisXPageMountContext<Messages>, 'container' | 'document' | 'controls'>

export type CordisXReactPageComponent<
  Messages extends CordisXMessageDefinition<Messages> = CordisXMessageSchema,
> = ComponentType<CordisXReactPageProps<Messages>>

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

export type CordisXRouteDefinitionV2<Outlet extends CordisXOutletName = CordisXOutletName> =
  & Omit<
    CordisXRouteDefinition<Outlet>,
    '$schema' | 'schemaVersion' | 'title' | 'description'
  >
  & {
    readonly $schema: typeof CORDISX_ROUTE_SCHEMA_V2
    readonly schemaVersion: 2
    readonly title: CordisXLocalizedText
    readonly description: CordisXLocalizedText
  }

export interface CordisXRoutes extends CordisXPageNavigation {
  register<Outlet extends CordisXOutletName>(
    definition: CordisXRouteDefinition<Outlet>,
  ): Disposable<void | Promise<void>>
}

export type CordisXConfigApplies = 'live' | 'plugin-restart' | 'service-restart' | 'app-restart'

export type CordisXConfigAppliesInput = CordisXConfigApplies | 'restart'
