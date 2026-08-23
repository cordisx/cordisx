import type { Context, Disposable, Effect } from '@deepseek-ai/cordis'
import type { CordisXPluginManifestV1 } from './platform-contracts.js'

export * from './platform-contracts.js'

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

export type CordisXIconToken = `${string}:${string}`

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
  readonly command: CordisXCommandReference
}

export interface CordisXNavigationAction extends CordisXStructuredAction {
  readonly id: string
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

export interface CordisXEnvironmentSection {
  readonly sectionId: string
  readonly title: CordisXLocalizedText
  readonly description?: CordisXLocalizedText
  readonly icon?: CordisXIconToken
}

export interface CordisXEnvironmentSectionAction extends CordisXStructuredAction {
  readonly sectionId: string
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
}

/** Extensible structured-surface vocabulary. Plugins may augment this map. */
export interface CordisXSurfaceMap {
  'sidebar.footer.before-control': CordisXStructuredAction
  'sidebar.footer.after-control': CordisXStructuredAction
  'sidebar.footer.menu': CordisXStructuredAction
  'sidebar.navigation.items': CordisXNavigationItem
  'workspace.toolbar.items': CordisXToolbarItem
  'environment.panel.header-actions': CordisXStructuredAction
  'environment.panel.sections': CordisXEnvironmentSection
  'environment.section.actions': CordisXEnvironmentSectionAction
  'environment.section.rows': CordisXEnvironmentRow
  'environment.row.trailing-actions': CordisXEnvironmentRowAction
}

export type CordisXSurfaceName = Extract<keyof CordisXSurfaceMap, string>

export const CORDISX_SURFACE_NAMES = [
  'sidebar.footer.before-control',
  'sidebar.footer.after-control',
  'sidebar.footer.menu',
  'sidebar.navigation.items',
  'workspace.toolbar.items',
  'environment.panel.header-actions',
  'environment.panel.sections',
  'environment.section.actions',
  'environment.section.rows',
  'environment.row.trailing-actions',
] as const satisfies readonly CordisXSurfaceName[]

export interface CordisXContributionOptions<Name extends CordisXSurfaceName = CordisXSurfaceName> {
  readonly name: Name
  readonly id: string
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
}

export type CordisXOutletName = Extract<keyof CordisXOutletMap, string>

export interface CordisXPageTab {
  readonly id: string
  readonly label: CordisXLocalizedText
  readonly icon?: CordisXIconToken
}

export interface CordisXPageMetadata {
  readonly id: string
  readonly title: CordisXLocalizedText
  readonly icon?: CordisXIconToken
  readonly breadcrumbs?: readonly CordisXLocalizedText[]
  readonly tabs?: readonly CordisXPageTab[]
  readonly localeNamespace?: string
}

export interface CordisXPageNavigation {
  navigate(reference: CordisXRouteReference): Promise<void>
  back(outlet?: CordisXOutletName): Promise<void>
  close(outlet?: CordisXOutletName): Promise<void>
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
  readonly id: string
  readonly path: string
  readonly outlet: Outlet
  readonly page: string
  readonly title?: CordisXLocalizedText
  readonly when?: CordisXWhen
}

export interface CordisXRoutes extends CordisXPageNavigation {
  register<Outlet extends CordisXOutletName>(definition: CordisXRouteDefinition<Outlet>): Disposable<void | Promise<void>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH-style semantic UI slot service backed by Codex DOM adapters. */
    slots: CordisXSlots
    commands: CordisXCommands
    pages: CordisXPages
    routes: CordisXRoutes
    /** Fiber-owned locale dictionaries and typed translator seats. */
    i18n: CordisXI18n
  }
}

/** Cordis plugin module after browser bundling. */
export interface CordisXPluginModule {
  readonly name?: string
  readonly manifest?: CordisXPluginManifestV1
  readonly inject?: readonly string[] | Record<string, unknown>
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
  readonly config: unknown
  /** Adjacent README.md captured by the launcher for this browser generation. */
  readonly readme?: string
}
