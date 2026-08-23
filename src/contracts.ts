import type { Context, Disposable, Effect } from '@deepseek-ai/cordis'

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

/** One fiber-owned namespace/locale dictionary. Values use ICU MessageFormat. */
export interface CordisXLocaleCatalog<Messages extends CordisXMessageSchema = CordisXMessageSchema> {
  readonly namespace: string
  readonly locale: string
  readonly default?: boolean
  readonly messages: Readonly<{ [Key in keyof Messages]: string }>
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
}

type CordisXMessageArgs<Value> = Value extends CordisXMessageParams ? [params: Value] : [params?: undefined]

/** Typed translator and framework-agnostic reactive bindings injected by the host. */
export interface CordisXLocalizationSeat<Messages extends CordisXMessageSchema = CordisXMessageSchema> {
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
export interface CordisXPageLocalizationProps<Messages extends CordisXMessageSchema = CordisXMessageSchema> {
  readonly localeNamespace: string
  readonly t: CordisXLocalizationSeat<Messages>['t']
  readonly localization: CordisXLocalizationSeat<Messages>
}

/** DSH-style localization service exposed to trusted-local plugins. */
export interface CordisXI18n {
  define<Messages extends CordisXMessageSchema>(catalog: CordisXLocaleCatalog<Messages>): Disposable<void | Promise<void>>
  inject<Messages extends CordisXMessageSchema>(
    namespace: string,
    setup: (seat: CordisXLocalizationSeat<Messages>) => Effect,
  ): Disposable<void | Promise<void>>
  seat<Messages extends CordisXMessageSchema>(namespace?: string): CordisXLocalizationSeat<Messages>
  resolve(message: CordisXLocalizedText): CordisXLocalizedProjection
  getSnapshot(): CordisXLocalizationSnapshot
  diagnostics(): readonly CordisXLocalizationDiagnostic[]
}

/** Host-declared root list slots. Mirrors DSH's SlotMap vocabulary. */
export interface CordisXSlotMap {
  'header.actions': { kind: 'list'; scope: 'root' }
  'composer.before': { kind: 'list'; scope: 'root' }
  'composer.after': { kind: 'list'; scope: 'root' }
  'sidebar.footer': { kind: 'list'; scope: 'root' }
  'shell.overlay': { kind: 'list'; scope: 'root' }
}

/** Stable UI extension names owned by CordisX rather than individual plugins. */
export type CordisXSlotName = keyof CordisXSlotMap

/** Runtime slot list used to reject invalid names from untyped plugins. */
export const CORDISX_SLOT_NAMES = [
  'header.actions',
  'composer.before',
  'composer.after',
  'sidebar.footer',
  'shell.overlay',
] as const satisfies readonly CordisXSlotName[]

/** DOM surface delivered to one mounted contribution. */
export interface CordisXMountContext {
  readonly container: HTMLElement
  readonly document: Document
  readonly signal: AbortSignal
  readonly slot: CordisXSlotName
}

/** DSH-style options for one entry in a CordisX list slot. */
export interface CordisXSlotOptions {
  readonly name: CordisXSlotName
  readonly id: string
  readonly order?: number
  /** Shadowing rank for the same id. The lowest live priority renders. */
  readonly priority?: number
}

/** DOM mount component used because CordisX cannot join Codex's private React tree. */
export type CordisXSlotComponent = (context: CordisXMountContext) => void | Disposable<void>

/** DSH-compatible slot service subset exposed to Cordis plugins. */
export interface CordisXSlots {
  /** Run an effect while the named host slot declaration exists. */
  inject(name: CordisXSlotName, setup: () => Effect): Disposable<void | Promise<void>>
  /** Register a list entry for the lifetime of the calling plugin fiber. */
  register(options: CordisXSlotOptions, component: CordisXSlotComponent): Disposable<void | Promise<void>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH-style semantic UI slot service backed by Codex DOM adapters. */
    slots: CordisXSlots
    /** Fiber-owned locale dictionaries and typed translator seats. */
    i18n: CordisXI18n
  }
}

/** Cordis plugin module after browser bundling. */
export interface CordisXPluginModule {
  readonly name?: string
  readonly inject?: readonly string[] | Record<string, unknown>
  readonly apply?: (ctx: Context, config: unknown) => unknown
  readonly default?: unknown
}

/** Plugin composition delivered from the launcher to the renderer. */
export interface CordisXBrowserPlugin {
  readonly id: string
  readonly enabled: boolean
  readonly module?: CordisXPluginModule
  readonly config: unknown
  /** Adjacent README.md captured by the launcher for this browser generation. */
  readonly readme?: string
}
