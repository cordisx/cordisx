import { createHash } from 'node:crypto'

/**
 * A receipt from the owner of the actual app-server, made when that process
 * starts with an immutable model_catalog_json. A thread/start catalog override
 * is not such a receipt: 0.167 constructs its models manager at server startup.
 * The caller must retain the original bytes until the server has loaded them.
 */
export interface NativeStaticCatalogReceipt {
  readonly nativeVersion: string
  readonly serverId: string
  readonly catalogSha256: string
  readonly catalogBytes: Uint8Array
}

/**
 * All fields are from the exact successful thread/start and its effective
 * budget configuration, not a later cwd-scoped config/read. The caller must
 * establish the effective feature state and fallback buffer, including model
 * defaults and managed requirements. If any field cannot be proven, do not
 * create this receipt. Invalidate it on server, model or budget config change.
 */
export interface NativeThreadBudgetReceipt {
  readonly serverId: string
  readonly requestId: string
  /** Native startup context originator for this exact thread. */
  readonly originator: string
  readonly responseRequestId: string
  readonly sessionId: string
  readonly requestedModel: string
  readonly responseModel: string
  readonly modelContextWindow: number | null
  readonly modelAutoCompactLimit: number | null
  readonly scope: 'total' | 'body_after_prefix'
  readonly asyncCompaction: boolean
  readonly postTurnCompactPercent: number
  readonly fallbackBufferTokens: number | null
}

/** Shape consumed by the native owner's resolveNativeContextBudget. */
export interface NativeBudgetProvenanceEvidence {
  readonly nativeVersion: string
  readonly sessionId: string
  readonly model: string
  readonly metadata: {
    readonly model: string
    readonly contextWindow: number | null
    readonly maxContextWindow: number | null
    readonly autoCompactLimit: number | null
    readonly effectiveContextPercent: number
  }
  readonly configuration: {
    readonly sessionId: string
    readonly modelContextWindow: number | null
    readonly modelAutoCompactLimit: number | null
    readonly scope: 'total' | 'body_after_prefix'
    readonly asyncCompaction: boolean
    readonly postTurnCompactPercent: number
    readonly fallbackBufferTokens: number
  }
}

export type NativeBudgetProvenance =
  | {
    readonly status: 'verified'
    readonly evidence: NativeBudgetProvenanceEvidence
    readonly binding: {
      readonly serverId: string
      readonly requestId: string
      readonly originator: string
      readonly catalogSha256: string
    }
  }
  | { readonly status: 'unavailable'; readonly reason: 'unknown' }

const unknown = { status: 'unavailable', reason: 'unknown' } as const
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const optionalPositive = (value: unknown): value is number | null => value === null || positive(value)
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/**
 * Extract only budget fields from the startup catalog. Hash equality checks the
 * supplied bytes; the process owner must attest that these are the bytes loaded
 * at startup. A disk cache, a separate process, or a thread-level catalog path
 * is not an acceptable startup receipt. No prompts or full config are retained.
 *
 * Native source tag rust-v0.167.0-alpha.3.2: app-server/src/message_processor.rs
 * builds ThreadManager at startup; core/src/thread_manager.rs passes its models
 * manager into Session::spawn. StaticModelsManager inherits the default
 * for_originator (None), so originator selection retains this static manager. models-manager/src/model_info.rs applies config
 * overrides; protocol/src/openai_models.rs supplies the default percent (95).
 */
export function captureNativeBudgetProvenance(
  startup: NativeStaticCatalogReceipt | null,
  thread: NativeThreadBudgetReceipt | null,
): NativeBudgetProvenance {
  if (!startup || !thread || startup.nativeVersion !== '0.167.0-alpha.3.2') return unknown
  if (
    !nonempty(startup.serverId) || startup.serverId !== thread.serverId || !nonempty(thread.requestId)
    || thread.requestId !== thread.responseRequestId || !nonempty(thread.originator) || !nonempty(thread.sessionId)
    || !nonempty(thread.requestedModel) || thread.requestedModel !== thread.responseModel
    || !(startup.catalogBytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(startup.catalogSha256)
    || createHash('sha256').update(startup.catalogBytes).digest('hex') !== startup.catalogSha256
    || !optionalPositive(thread.modelContextWindow) || !optionalPositive(thread.modelAutoCompactLimit)
    || !['total', 'body_after_prefix'].includes(thread.scope) || typeof thread.asyncCompaction !== 'boolean'
    || !Number.isInteger(thread.postTurnCompactPercent) || thread.postTurnCompactPercent < 0
    || thread.postTurnCompactPercent > 100 || !nonnegative(thread.fallbackBufferTokens)
  ) return unknown
  let catalog: unknown
  try {
    catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(startup.catalogBytes))
  } catch {
    return unknown
  }
  if (!record(catalog) || !Array.isArray(catalog.models)) return unknown
  const matches = catalog.models.filter((model: unknown) => record(model) && model.slug === thread.responseModel)
  if (matches.length !== 1 || !record(matches[0])) return unknown
  const model = matches[0]
  const contextWindow = model.context_window ?? null
  const maxContextWindow = model.max_context_window ?? null
  const autoCompactLimit = model.auto_compact_token_limit ?? null
  const effectiveContextPercent = model.effective_context_window_percent === undefined
    ? 95
    : model.effective_context_window_percent
  if (
    !optionalPositive(contextWindow) || !optionalPositive(maxContextWindow) || !optionalPositive(autoCompactLimit)
    || !Number.isInteger(effectiveContextPercent) || Number(effectiveContextPercent) < 1
    || Number(effectiveContextPercent) > 100
  ) return unknown
  return {
    status: 'verified',
    binding: {
      serverId: startup.serverId,
      requestId: thread.requestId,
      originator: thread.originator,
      catalogSha256: startup.catalogSha256,
    },
    evidence: {
      nativeVersion: startup.nativeVersion,
      sessionId: thread.sessionId,
      model: thread.responseModel,
      metadata: {
        model: thread.responseModel,
        contextWindow,
        maxContextWindow,
        autoCompactLimit,
        effectiveContextPercent: Number(effectiveContextPercent),
      },
      configuration: {
        sessionId: thread.sessionId,
        modelContextWindow: thread.modelContextWindow,
        modelAutoCompactLimit: thread.modelAutoCompactLimit,
        scope: thread.scope,
        asyncCompaction: thread.asyncCompaction,
        postTurnCompactPercent: thread.postTurnCompactPercent,
        fallbackBufferTokens: thread.fallbackBufferTokens,
      },
    },
  }
}
