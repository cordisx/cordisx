import type { Context, Disposable, Effect } from '@deepseek-ai/cordis'

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
}
