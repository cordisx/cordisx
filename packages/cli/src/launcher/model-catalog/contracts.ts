/** Host-private contracts. No endpoint or credential capability is renderer data. */
export interface CatalogModel {
  readonly id: string
  readonly label: string
  readonly aliases: readonly string[]
  readonly provenance?: readonly ('auto' | 'native' | 'manual' | 'manual-supplement')[]
  readonly notListed?: boolean
  readonly protocolCapabilities?: { readonly responses: boolean }
}

export type CatalogStrategy =
  | { readonly kind: 'native'; readonly mode?: 'only' | 'augment' }
  | { readonly kind: 'manual'; readonly ids: readonly string[] }
  | { readonly kind: 'manual'; readonly file: string }
  | { readonly kind: 'auto'; readonly adapter: string; readonly ttlMs: number; readonly mode?: 'only' | 'augment' }
  | { readonly kind: 'script'; readonly commandRef: string; readonly mode?: 'replace' | 'supplement' }

export interface CatalogSupplement {
  readonly scopeRevision: string
  readonly authorityRevision: string
  readonly models: readonly {
    readonly id: string
    readonly label?: string
    readonly protocolCapabilities?: { readonly responses: boolean }
  }[]
}

export interface CatalogBinding {
  readonly bindingRef: string
  readonly scopeRevision: string
  readonly authorityRevision: string
  readonly strategy: CatalogStrategy
}

export interface DiscoveryRequest {
  /** Exact provider API base. The owner, not the adapter, grants this destination. */
  readonly origin: string
  readonly method: 'GET'
  readonly path: '/models'
}

export const MAX_DISCOVERY_RESPONSE_BYTES = 8 * 1024 * 1024

export interface DiscoveryTarget {
  readonly endpoint: string
  readonly providerName: string
}

export interface DiscoveryConnection extends DiscoveryTarget {
  readonly scopeRevision: string
  /** Host-injected operation capability. No raw credential is exposed to an adapter. */
  readonly request: (operation: DiscoveryRequest, signal: AbortSignal) => Promise<Response>
  readonly current: () => boolean
}

export interface DiscoveryAdapter {
  readonly id: string
  readonly version: string
  readonly pagination: 'none' | 'cursor'
  matches(target: DiscoveryTarget): boolean
  discover(connection: DiscoveryConnection, signal: AbortSignal): Promise<readonly CatalogModel[]>
}

export type CatalogErrorCode =
  | 'unsupported'
  | 'ambiguous'
  | 'credential-unavailable'
  | 'authentication'
  | 'permission'
  | 'account'
  | 'rate-limit'
  | 'temporary'
  | 'protocol'
  | 'source-invalid'
  | 'cancelled'

export class CatalogError extends Error {
  constructor(readonly code: CatalogErrorCode, readonly retryAfterMs?: number) {
    super(code)
  }
}

export interface CatalogSnapshot {
  readonly bindingRef: string
  readonly scopeRevision: string
  readonly authorityRevision: string
  readonly revision: number
  readonly models: readonly CatalogModel[]
  readonly complete: boolean
  readonly freshness: 'unknown' | 'fresh' | 'stale'
  readonly loading: boolean
  readonly lastSuccessAt?: number
  readonly error?: CatalogErrorCode
  readonly supplementError?: 'source-invalid'
}

export const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

export function boundedString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

export function catalogModels(ids: unknown): readonly CatalogModel[] {
  if (!Array.isArray(ids) || ids.length > 10_000 || ids.some(id => !boundedString(id))) {
    throw new CatalogError('source-invalid')
  }
  return Object.freeze(
    [...new Set(ids as string[])].sort().map(id => Object.freeze({ id, label: id, aliases: Object.freeze([]) })),
  )
}

export function parseCatalogStrategy(value: unknown): CatalogStrategy {
  const source = object(value)
  if (!source) throw new CatalogError('source-invalid')
  const exact = (keys: string[]) => Object.keys(source).every(key => keys.includes(key))
  const mode = source.mode
  if (
    source.kind === 'native' && exact(['kind', 'mode']) && (mode === undefined || mode === 'only' || mode === 'augment')
  ) {
    return Object.freeze({ kind: 'native', ...(mode === undefined ? {} : { mode }) })
  }
  if (source.kind === 'manual') {
    if (exact(['kind', 'ids']) && source.ids !== undefined) {
      return Object.freeze({ kind: 'manual', ids: Object.freeze(catalogModels(source.ids).map(model => model.id)) })
    }
    if (exact(['kind', 'file']) && boundedString(source.file, 4096) && !/^[a-z]+:\/\//iu.test(source.file)) {
      return Object.freeze({ kind: 'manual', file: source.file })
    }
  }
  if (
    source.kind === 'auto' && exact(['kind', 'adapter', 'ttlMs', 'mode'])
    && (mode === undefined || mode === 'only' || mode === 'augment')
  ) {
    const adapter = source.adapter ?? 'detect'
    const ttlMs = source.ttlMs ?? 3_600_000
    if (
      boundedString(adapter, 128) && Number.isSafeInteger(ttlMs) && Number(ttlMs) >= 60_000
      && Number(ttlMs) <= 86_400_000
    ) {
      return Object.freeze({ kind: 'auto', adapter, ttlMs: Number(ttlMs), ...(mode === undefined ? {} : { mode }) })
    }
  }
  if (
    source.kind === 'script' && exact(['kind', 'commandRef', 'mode']) && boundedString(source.commandRef, 128)
    && (mode === undefined || mode === 'replace' || mode === 'supplement')
  ) {
    // A recognized strategy is not an execution grant. The runner is not implemented.
    return Object.freeze({ kind: 'script', commandRef: source.commandRef, ...(mode === undefined ? {} : { mode }) })
  }
  throw new CatalogError('source-invalid')
}
