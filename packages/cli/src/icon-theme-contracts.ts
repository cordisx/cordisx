/**
 * Host implementation types for cordisx-protocol icon-theme/provider v1.
 * Keep these constants synchronized with formal Protocol main; providers only
 * exchange serializable data and never receive a renderer or DOM capability.
 */
export const ICON_THEME_CATALOG_VERSION = 1 as const
export const ICON_THEME_CATALOG_DIGEST =
  'sha256:fabbf2ac3d7177bc353432e4175240cc3fe10d040321e2b785c1da0f77634771' as const

export const SEMANTIC_ICON_KEYS = [
  'action.add',
  'action.back',
  'action.close',
  'action.copy',
  'action.delete',
  'action.disable',
  'action.edit',
  'action.enable',
  'action.export',
  'action.external-link',
  'action.favorite',
  'action.follow',
  'action.import',
  'action.more',
  'action.move',
  'action.open',
  'action.pause',
  'action.refresh',
  'action.reset',
  'action.resume',
  'action.save',
  'action.search',
  'action.settings',
  'action.share',
  'action.submit',
  'agent.reasoning',
  'agent.turn-control',
  'content.acknowledgements',
  'content.calendar',
  'content.clock',
  'content.contributions',
  'content.files',
  'content.folder',
  'content.key',
  'content.layers',
  'content.palette',
  'content.panel',
  'content.tags',
  'control.check',
  'control.chevron-down',
  'control.chevron-left',
  'control.chevron-right',
  'control.chevron-up',
  'control.minus',
  'control.plus',
  'navigation.about',
  'navigation.channels',
  'navigation.dashboard',
  'navigation.extensions',
  'navigation.history',
  'navigation.launcher',
  'navigation.marketplace',
  'navigation.overview',
  'navigation.plugins',
  'navigation.routes',
  'navigation.runtime',
  'navigation.store',
  'status.error',
  'status.info',
  'status.pending',
  'status.success',
  'status.warning',
  'trust.certified',
  'trust.official',
] as const

export const ICON_VARIANTS = ['regular', 'filled', 'duotone'] as const
export const ICON_STATES = [
  'default',
  'hover',
  'active',
  'selected',
  'disabled',
  'danger',
  'success',
  'warning',
] as const

export type SemanticIconKey = typeof SEMANTIC_ICON_KEYS[number]
export type IconVariant = typeof ICON_VARIANTS[number]
export type IconState = typeof ICON_STATES[number]

export type NormalizedVectorCommand =
  | { readonly op: 'move' | 'line'; readonly x: number; readonly y: number }
  | {
    readonly op: 'cubic'
    readonly x1: number
    readonly y1: number
    readonly x2: number
    readonly y2: number
    readonly x: number
    readonly y: number
  }
  | { readonly op: 'quadratic'; readonly x1: number; readonly y1: number; readonly x: number; readonly y: number }
  | { readonly op: 'close' }

export type NormalizedVectorPath =
  | {
    readonly paint: 'fill'
    readonly fillRule?: 'nonzero' | 'evenodd'
    readonly opacity?: number
    readonly commands: readonly NormalizedVectorCommand[]
  }
  | {
    readonly paint: 'stroke'
    readonly strokeWidth: number
    readonly lineCap: 'butt' | 'round' | 'square'
    readonly lineJoin: 'miter' | 'round' | 'bevel'
    readonly opacity?: number
    readonly commands: readonly NormalizedVectorCommand[]
  }

export interface NormalizedVectorDescriptor {
  readonly format: 'cordisx.normalized-vector'
  readonly formatVersion: 1
  readonly viewBox: { readonly minX: 0; readonly minY: 0; readonly width: 24; readonly height: 24 }
  readonly paths: readonly NormalizedVectorPath[]
}

export interface IconThemeProviderIdentity {
  readonly providerId: `builtin:${string}` | `plugin:${string}:${string}`
  readonly namespace: string
  readonly protocolVersion: 1
  readonly providerVersion: string
}

export interface IconThemeProviderReference extends IconThemeProviderIdentity {
  readonly providerHandle: `iph_${string}`
  readonly providerGeneration: string
}

export interface PinnedIconThemeProviderReference extends IconThemeProviderReference {
  readonly profileRevision: number
}

export type IconThemeCoverage =
  | {
    readonly kind: 'complete'
    readonly proof: {
      readonly kind: 'host-conformance'
      readonly proofId: string
      readonly catalogVersion: 1
      readonly catalogDigest: typeof ICON_THEME_CATALOG_DIGEST
      readonly providerId: `builtin:${string}` | `plugin:${string}:${string}`
      readonly namespace: string
      readonly providerVersion: string
      readonly providerGeneration: string
      readonly protocolVersion: 1
      readonly descriptorFormatVersion: 1
      readonly keyCount: 64
      readonly variantCount: 3
      readonly stateCount: 8
      readonly tupleCount: 1536
      readonly outcome: 'passed'
      readonly rawDataExported: false
    }
  }
  | { readonly kind: 'partial'; readonly entries: readonly IconThemeTuple[] }

export interface IconThemeTuple {
  readonly key: SemanticIconKey
  readonly variant: IconVariant
  readonly state: IconState
}

export interface IconThemeDescriptorEntry extends IconThemeTuple {
  readonly descriptor: NormalizedVectorDescriptor
}

/** Public data-only registration payload. Host derives identity and generation. */
export interface CordisXIconThemeProviderDefinitionV1 {
  readonly schemaVersion: 1
  readonly namespace: string
  readonly providerVersion: string
  readonly descriptors: readonly IconThemeDescriptorEntry[]
}

export interface CordisXIconThemeRegistrationHandle {
  readonly providerHandle: `iph_${string}`
  readonly providerGeneration: string
  readonly providerId: `plugin:${string}:${string}`
  dispose(): void
}

export interface CordisXIconThemes {
  /** Register bounded static descriptors; identity and generation are Host-derived. */
  register(definition: CordisXIconThemeProviderDefinitionV1): CordisXIconThemeRegistrationHandle
}

export interface IconThemeProviderRegistration {
  readonly $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-provider-registration.v1.schema.json'
  readonly schemaVersion: 1
  readonly authority: 'host'
  readonly hostGeneration: string
  readonly revision: number
  readonly providerHandle: `iph_${string}`
  readonly principal: { readonly kind: 'host' } | {
    readonly kind: 'plugin'
    readonly principalHandle: `ipp_${string}`
    readonly pluginId: string
  }
  readonly identity: IconThemeProviderIdentity
  readonly providerGeneration: string
  readonly status: 'staged' | 'ready' | 'active' | 'retiring' | 'failed' | 'disposed'
  readonly coverage: IconThemeCoverage
  readonly lastGoodGeneration?: string
  readonly failureCode?:
    | 'prepare-failed'
    | 'resolution-failed'
    | 'invalid-descriptor'
    | 'disposed'
    | 'generation-replaced'
}

export interface IconThemeSelection {
  readonly $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-selection.v1.schema.json'
  readonly schemaVersion: 1
  readonly authority: 'host'
  readonly profileId: string
  readonly profileRevision: number
  readonly hostGeneration: string
  readonly requestedProviderHandle?: `iph_${string}`
  readonly defaultProvider: PinnedIconThemeProviderReference & {
    readonly providerId: 'builtin:reicon'
    readonly namespace: 'reicon'
  }
  readonly selectedProvider: PinnedIconThemeProviderReference
  readonly fallbackProvider: PinnedIconThemeProviderReference & {
    readonly providerId: 'builtin:reicon'
    readonly namespace: 'reicon'
  }
  readonly outcome: 'default' | 'selected' | 'rolled-back'
  readonly reason:
    | 'user-selection'
    | 'host-default'
    | 'provider-unavailable'
    | 'prepare-failed'
    | 'resolution-failed'
    | 'invalid-descriptor'
}

export interface IconThemeResolutionRequest extends IconThemeTuple {
  readonly $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-request.v1.schema.json'
  readonly schemaVersion: 1
  readonly requestId: string
  readonly hostGeneration: string
  readonly providerHandle: `iph_${string}`
  readonly providerGeneration: string
}

export type IconThemeResolutionResult =
  | {
    readonly $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-result.v1.schema.json'
    readonly schemaVersion: 1
    readonly requestId: string
    readonly providerGeneration: string
    readonly outcome: 'resolved'
    readonly descriptor: NormalizedVectorDescriptor
  }
  | {
    readonly $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-resolution-result.v1.schema.json'
    readonly schemaVersion: 1
    readonly requestId: string
    readonly providerGeneration: string
    readonly outcome: 'missing' | 'rejected' | 'stale-generation'
    readonly reason:
      | 'not-covered'
      | 'unsupported-variant'
      | 'unsupported-state'
      | 'invalid-request'
      | 'provider-unavailable'
      | 'generation-mismatch'
  }

export interface IconThemeLifecycleResult {
  readonly $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/icon-theme-lifecycle-result.v1.schema.json'
  readonly schemaVersion: 1
  readonly authority: 'host'
  readonly requestId: string
  readonly profileId: string
  readonly operation: 'register' | 'select' | 'dispose' | 'rollback'
  readonly outcome: 'staged' | 'applied' | 'conflict' | 'rejected' | 'rolled-back' | 'rollback-failed'
  readonly profileRevision: number
  readonly hostGeneration: string
  readonly activeProvider: IconThemeProviderReference
  readonly affectedProviderHandle?: `iph_${string}`
  readonly disposedGeneration?: string
  readonly error?: {
    readonly code:
      | 'stale-revision'
      | 'stale-host-generation'
      | 'unknown-provider'
      | 'stale-provider-generation'
      | 'provider-selected'
      | 'identity-mismatch'
      | 'namespace-conflict'
      | 'prepare-failed'
      | 'resolution-failed'
      | 'invalid-descriptor'
      | 'dispose-failed'
      | 'rollback-failed'
  }
}

export const BUILTIN_REICON_IDENTITY = Object.freeze(
  {
    providerId: 'builtin:reicon',
    namespace: 'reicon',
    protocolVersion: 1,
    providerVersion: '1.2.1',
  } as const satisfies IconThemeProviderIdentity,
)

export function isSemanticIconKey(value: unknown): value is SemanticIconKey {
  return typeof value === 'string' && (SEMANTIC_ICON_KEYS as readonly string[]).includes(value)
}

export function isIconVariant(value: unknown): value is IconVariant {
  return typeof value === 'string' && (ICON_VARIANTS as readonly string[]).includes(value)
}

export function isIconState(value: unknown): value is IconState {
  return typeof value === 'string' && (ICON_STATES as readonly string[]).includes(value)
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

function boundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/** Strict hostile-input validator. Unknown fields invalidate the whole payload. */
export function isNormalizedVectorDescriptor(value: unknown): value is NormalizedVectorDescriptor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptor = value as Record<string, unknown>
  if (
    !exactKeys(descriptor, ['format', 'formatVersion', 'viewBox', 'paths'])
    || descriptor.format !== 'cordisx.normalized-vector' || descriptor.formatVersion !== 1
    || descriptor.viewBox === null || typeof descriptor.viewBox !== 'object' || Array.isArray(descriptor.viewBox)
    || !exactKeys(descriptor.viewBox as object, ['minX', 'minY', 'width', 'height'])
  ) return false
  const viewBox = descriptor.viewBox as Record<string, unknown>
  if (
    viewBox.minX !== 0 || viewBox.minY !== 0 || viewBox.width !== 24 || viewBox.height !== 24
    || !Array.isArray(descriptor.paths) || descriptor.paths.length < 1 || descriptor.paths.length > 16
  ) return false
  return descriptor.paths.every(pathValue => {
    if (pathValue === null || typeof pathValue !== 'object' || Array.isArray(pathValue)) return false
    const path = pathValue as Record<string, unknown>
    const fill = path.paint === 'fill'
    const expected = fill
      ? ['commands', 'fillRule', 'opacity', 'paint'].filter(key => path[key] !== undefined)
      : ['commands', 'lineCap', 'lineJoin', 'opacity', 'paint', 'strokeWidth'].filter(key => path[key] !== undefined)
    if (!exactKeys(path, expected) || (!fill && path.paint !== 'stroke')) return false
    if (fill && path.fillRule !== undefined && path.fillRule !== 'nonzero' && path.fillRule !== 'evenodd') return false
    if (
      !fill && (!boundedNumber(path.strokeWidth, 0.25, 4)
        || !['butt', 'round', 'square'].includes(String(path.lineCap))
        || !['miter', 'round', 'bevel'].includes(String(path.lineJoin)))
    ) return false
    if (path.opacity !== undefined && !boundedNumber(path.opacity, 0, 1)) return false
    if (!Array.isArray(path.commands) || path.commands.length < 2 || path.commands.length > 512) return false
    const commands = path.commands as unknown[]
    return commands.every((commandValue, index) => {
      if (commandValue === null || typeof commandValue !== 'object' || Array.isArray(commandValue)) return false
      const command = commandValue as Record<string, unknown>
      if (index === 0 && command.op !== 'move') return false
      if (command.op === 'close') return index === commands.length - 1 && exactKeys(command, ['op'])
      if (command.op === 'move' || command.op === 'line') {
        return exactKeys(command, ['op', 'x', 'y']) && boundedNumber(command.x, -64, 64)
          && boundedNumber(command.y, -64, 64)
      }
      if (command.op === 'quadratic') {
        return exactKeys(command, ['op', 'x', 'x1', 'y', 'y1'])
          && [command.x1, command.y1, command.x, command.y].every(item => boundedNumber(item, -64, 64))
      }
      if (command.op === 'cubic') {
        return exactKeys(command, ['op', 'x', 'x1', 'x2', 'y', 'y1', 'y2'])
          && [command.x1, command.y1, command.x2, command.y2, command.x, command.y].every(item =>
            boundedNumber(item, -64, 64)
          )
      }
      return false
    })
  })
}
