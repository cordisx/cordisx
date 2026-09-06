import type { Context, Disposable } from '@deepseek-ai/cordis'

import type { CordisXPluginManifestV1 } from './platform-contracts.js'

import type {
  CordisXPluginManifestV4,
  CordisXPluginManifestV5,
  CordisXPluginManifestV6,
  CordisXPluginManifestV7,
  CordisXPluginManifestV8,
} from './permission-contracts.js'

import type { CordisXPluginDependencyV1 } from './plugin-lifecycle-contracts.js'

import type {
  CordisXCommands,
  CordisXConfigAppliesInput,
  CordisXManagerContentNavigation,
  CordisXPages,
  CordisXRoutes,
  CordisXSlots,
} from './contracts-host-ui.js'

import type {
  CordisXI18n,
  CordisXJsonScalar,
  CordisXJsonValue,
  CordisXLocalizedText,
  CordisXPluginConsoleFacade,
} from './contracts-extension-navigation.js'

export interface CordisXStandardSchemaResult<T = unknown> {
  readonly value?: T
  readonly issues?: readonly {
    readonly message: string
    readonly path?: readonly (string | number | { readonly key: PropertyKey })[]
  }[]
}

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

export type CordisXConfigFormIcon =
  | 'host:calendar'
  | 'host:clock'
  | 'host:palette'
  | 'host:tags'
  | 'host:folder'
  | 'host:key'
  | 'host:settings'
  | 'host:info'
  | 'host:files'
  | 'host:save'
  | 'host:reset'

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

export type CordisXConfigFormPresenterKind =
  | 'choice.select'
  | 'choice.radio'
  | 'choice.segmented'
  | 'number.input'
  | 'number.stepper'
  | 'number.slider'
  | 'array.scalar-tags'
  | 'array.scalar-rows'
  | 'array.object-auto'
  | 'array.object-dialog'
  | 'array.object-page'

export interface CordisXConfigFormPresenter {
  readonly version: 1
  readonly kind: CordisXConfigFormPresenterKind
  readonly options?: {
    readonly density?: 'compact' | 'regular'
    readonly maxInlineItems?: number
    readonly allowReorder?: boolean
  }
}

export interface CordisXConfigFormSchemaNode {
  readonly type: string
  readonly role?: string
  readonly label?: string
  readonly description?: string
  /** Whether this nested schema node declares a safe explicit default. */
  readonly hasDefault?: boolean
  /** Renderer-safe nested default; omitted for sensitive roles. */
  readonly defaultValue?: CordisXJsonValue
  readonly disabled: boolean
  readonly required: boolean
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly choices?: readonly { readonly label: string; readonly value: CordisXJsonScalar }[]
  readonly arrayItemType?: 'string' | 'number' | 'natural' | 'boolean'
  readonly presenter?: CordisXConfigFormPresenter
  readonly fields?: readonly { readonly key: string; readonly schema: CordisXConfigFormSchemaNode }[]
  readonly item?: CordisXConfigFormSchemaNode
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
  readonly arrayItemType?: 'string' | 'number' | 'natural' | 'boolean'
  /** Closed Host-owned presenter request; no renderer authority is conveyed. */
  readonly presenter?: CordisXConfigFormPresenter
  /** Recursive, renderer-safe item schema for a bounded object array. */
  readonly arrayItemSchema?: CordisXConfigFormSchemaNode
  /** Host-derived default item used by a bounded Add operation when available. */
  readonly arrayItemDefault?: CordisXJsonValue
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
    /** Data-only semantic icon descriptors; Host derives identity and owns rendering. */
    iconThemes: import('./icon-theme-contracts.js').CordisXIconThemes
    /** Owner-scoped, fiber-owned renderers for bounded Host visual seats. */
    visuals: import('./visual-contracts.js').CordisXVisuals
  }
}

export interface CordisXPluginPresentation {
  readonly name: CordisXLocalizedText
  readonly description?: CordisXLocalizedText
}

export interface CordisXPluginModule {
  readonly name?: string
  /** Optional local brand artwork. The Host validates and renders it inside Host-owned chrome. */
  readonly icon?: CordisXPluginBrandIcon
  /** User-facing identity; stable ids and manifest names remain untranslated fallbacks. */
  readonly presentation?: CordisXPluginPresentation
  readonly manifest?:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
  readonly inject?: readonly string[] | Record<string, unknown>
  readonly Config?: CordisXStandardSchema
  readonly configApplies?: CordisXConfigAppliesInput
  readonly apply?: (ctx: Context, config: unknown) => unknown
  readonly default?: unknown
}

export interface CordisXPluginBrandIcon {
  readonly mediaType: 'image/png' | 'image/webp'
  readonly data: string
}

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
  readonly manifest?:
    | CordisXPluginManifestV1
    | CordisXPluginManifestV4
    | CordisXPluginManifestV5
    | CordisXPluginManifestV6
    | CordisXPluginManifestV7
    | CordisXPluginManifestV8
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
  /** Locale-keyed adjacent READMEs; `default` is README.md. */
  readonly readmes?: Readonly<Record<string, string>>
}
