import type { Context } from '@deepseek-ai/cordis'

/** Stable UI extension names owned by CordisX rather than individual plugins. */
export type CordisXSlotName =
  | 'header.actions'
  | 'composer.before'
  | 'composer.after'
  | 'sidebar.footer'
  | 'shell.overlay'

/** DOM surface delivered to one mounted contribution. */
export interface CordisXMountContext {
  readonly container: HTMLElement
  readonly document: Document
  readonly signal: AbortSignal
  readonly slot: CordisXSlotName
}

/** One reversible UI contribution. IDs are unique within a CordisX generation. */
export interface CordisXContribution {
  readonly id: string
  readonly slot: CordisXSlotName
  readonly priority?: number
  mount(context: CordisXMountContext): void | (() => void)
}

/** Public renderer service exposed to Cordis plugins. */
export interface CordisXApi {
  /** Register a contribution for the lifetime of the calling plugin fiber. */
  contribute(contribution: CordisXContribution): () => void | Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** CordisX semantic UI extension service. */
    cordisx: CordisXApi
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
  readonly module: CordisXPluginModule
  readonly config: unknown
}
