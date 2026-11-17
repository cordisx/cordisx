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
  /** The unmodified OpenAI-compatible provider manager (not GCP or Bedrock). */
  readonly providerKind: 'openai-compatible'
  readonly providerId: string
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
  readonly responseProviderId: string
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
 * manager into Session::spawn. The OpenAI-compatible provider chooses the
 * unmodified StaticModelsManager for a startup catalog (model-provider/src/
 * provider.rs); other providers can transform the catalog. StaticModelsManager
 * inherits the default
 * for_originator (None), so originator selection retains this static manager. models-manager/src/model_info.rs applies config
 * overrides; protocol/src/openai_models.rs supplies the default percent (95).
 */
export function captureNativeBudgetProvenance(
  startup: NativeStaticCatalogReceipt | null,
  thread: NativeThreadBudgetReceipt | null,
): NativeBudgetProvenance {
  if (
    !startup || !thread || startup.nativeVersion !== '0.167.0-alpha.3.2'
    || startup.providerKind !== 'openai-compatible' || !nonempty(startup.providerId)
    || startup.providerId !== thread.responseProviderId
  ) return unknown
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

/** The request owner captures this exact thread's complete merged config at start. */
export interface NativeThreadConfigReceipt {
  readonly serverId: string
  readonly requestId: string
  readonly responseRequestId: string
  readonly originator: string
  readonly sessionId: string
  readonly requestedModel: string
  readonly responseModel: string
  readonly responseProviderId: string
  /** Complete config layers including the submitted thread overrides; not a later cwd read. */
  readonly mergedConfig: unknown
  /** Null or the complete featureRequirements map from the same effective requirements. */
  readonly featureRequirements: unknown
}

/**
 * Derive the common fresh-thread path using 0.167's feature defaults and
 * model-owned token budget defaults. Requirements, config layers and startup
 * catalog must be captured atomically with the thread/start operation by the
 * caller. Experimental context management and managed budget-feature rules
 * are deliberately unavailable here until their activation can be proven.
 * Source: features/src/lib.rs (three feature defaults); core/src/session/
 * token_budget.rs (apply_model_defaults, has_explicit_settings and
 * resolve_token_budget); core/src/config/mod.rs (fallback_buffer_tokens).
 */
export function deriveNativeBudgetProvenance(
  startup: NativeStaticCatalogReceipt | null,
  thread: NativeThreadConfigReceipt | null,
): NativeBudgetProvenance {
  if (!startup || !thread || !record(thread.mergedConfig)) return unknown
  const requirements = thread.featureRequirements
  if (requirements !== null) {
    if (!record(requirements)) return unknown
    if (['token_budget', 'context_management', 'async_compaction'].some((key) => key in requirements)) {
      return unknown
    }
  }
  const config = thread.mergedConfig
  const features = config.features === undefined || config.features === null ? {} : config.features
  if (!record(features)) return unknown
  const enabled = (value: unknown, key: string): boolean | null => {
    if (value === undefined || value === null) return false
    if (typeof value === 'boolean') return value
    if (!record(value)) return null
    return value[key] === undefined ? false : typeof value[key] === 'boolean' ? value[key] : null
  }
  const contextManagement = enabled(features.context_management, 'experimental_mode')
  const asyncCompaction = enabled(features.async_compaction, 'enabled')
  let tokenBudget = enabled(features.token_budget, 'enabled')
  if (contextManagement !== false || asyncCompaction === null || tokenBudget === null) return unknown

  // Validate the process/session binding before inspecting any metadata.
  const base = captureNativeBudgetProvenance(startup, {
    ...thread,
    modelContextWindow: (config.model_context_window ?? null) as number | null,
    modelAutoCompactLimit: (config.model_auto_compact_token_limit ?? null) as number | null,
    scope: (config.model_auto_compact_token_limit_scope ?? 'total') as 'total' | 'body_after_prefix',
    asyncCompaction,
    postTurnCompactPercent: (config.model_post_turn_compact_threshold_percent ?? 0) as number,
    fallbackBufferTokens: 0,
  })
  if (base.status !== 'verified') return base
  let catalog: unknown
  try {
    catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(startup.catalogBytes))
  } catch {
    return unknown
  }
  if (!record(catalog) || !Array.isArray(catalog.models)) return unknown
  const model: unknown = catalog.models.find((item: unknown) => record(item) && item.slug === thread.responseModel)
  if (!record(model)) return unknown
  const messages = model.model_messages
  if (messages !== undefined && messages !== null && !record(messages)) return unknown
  const modelBudget = record(messages) ? messages.token_budget : undefined
  if (modelBudget !== undefined && modelBudget !== null && !record(modelBudget)) return unknown
  if (record(modelBudget) && modelBudget.enabled !== undefined && typeof modelBudget.enabled !== 'boolean') {
    return unknown
  }

  const configured = features.token_budget
  if (configured === undefined && record(modelBudget) && modelBudget.enabled === true) tokenBudget = true
  let fallbackBufferTokens = 0
  if (tokenBudget) {
    const explicit = record(configured)
      && Object.keys(configured).some((key) => !['enabled', 'use_history_notes_extension'].includes(key))
    if (explicit && record(configured)) {
      const prompt = configured.auto_compact_fallback_prompt
      if (prompt !== undefined && prompt !== null && typeof prompt !== 'string') return unknown
      if (typeof prompt === 'string' && prompt.trim().length > 0) {
        if (!positive(configured.auto_compact_fallback_buffer_tokens)) return unknown
        fallbackBufferTokens = configured.auto_compact_fallback_buffer_tokens
      }
    } else if (record(modelBudget)) {
      const prompt = modelBudget.auto_compact_fallback_prompt
      const reminder = modelBudget.reminder_message_template
      const guidance = modelBudget.guidance_message
      const buffer = modelBudget.auto_compact_fallback_buffer_tokens
      // Invalid model defaults are ignored by native, falling back to an empty config.
      if (
        typeof prompt !== 'string' || typeof reminder !== 'string' || typeof guidance !== 'string'
        || !positive(modelBudget.reminder_threshold_tokens) || !positive(buffer) || !reminder.trim()
        || Buffer.byteLength(prompt) > 2000 || Buffer.byteLength(reminder) > 2000 || Buffer.byteLength(guidance) > 2000
      ) return unknown
      fallbackBufferTokens = buffer
    }
  }
  return {
    ...base,
    evidence: {
      ...base.evidence,
      configuration: {
        ...base.evidence.configuration,
        asyncCompaction: asyncCompaction && !tokenBudget,
        fallbackBufferTokens,
      },
    },
  }
}
