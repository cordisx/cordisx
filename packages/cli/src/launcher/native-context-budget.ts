/** Verified inputs for a particular thread, not a projection of global defaults. */
export interface NativeContextBudgetEvidence {
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
  /** The caller must have captured the complete effective configuration for this exact thread. */
  readonly configuration: {
    readonly sessionId: string
    readonly modelContextWindow: number | null
    readonly modelAutoCompactLimit: number | null
    readonly scope: 'total' | 'body_after_prefix'
    readonly asyncCompaction: boolean
    readonly postTurnCompactPercent: number
    /** Zero when a verified effective configuration has no fallback buffer. */
    readonly fallbackBufferTokens: number | null
  }
}

export type NativeContextBudget =
  | { readonly status: 'resolved'; readonly tokens: number; readonly rawWindow: number; readonly usableWindow: number }
  | { readonly status: 'unavailable'; readonly reason: 'unknown' | 'unsupported' }

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const optionalPositive = (value: unknown): value is number | null => value === null || positive(value)

/**
 * Codex 0.149.1 and 0.167.0-alpha.3.2 model and compaction rules, for the
 * provable total-scope path. Unknown provenance must be rejected by the caller.
 */
export function resolveNativeContextBudget(input: NativeContextBudgetEvidence): NativeContextBudget {
  const unknown = { status: 'unavailable', reason: 'unknown' } as const
  const unsupported = { status: 'unavailable', reason: 'unsupported' } as const
  if (
    !['0.149.1', '0.167.0-alpha.3.2'].includes(input.nativeVersion) || !input.sessionId || !input.model
    || input.sessionId !== input.configuration.sessionId || input.model !== input.metadata.model
  ) return unknown
  const { metadata: model, configuration: config } = input
  if (
    !optionalPositive(model.contextWindow) || !optionalPositive(model.maxContextWindow)
    || !optionalPositive(model.autoCompactLimit) || !optionalPositive(config.modelContextWindow)
    || !optionalPositive(config.modelAutoCompactLimit) || !Number.isInteger(model.effectiveContextPercent)
    || model.effectiveContextPercent < 1 || model.effectiveContextPercent > 100
    || !Number.isInteger(config.postTurnCompactPercent) || config.postTurnCompactPercent < 0
    || config.postTurnCompactPercent > 100 || typeof config.asyncCompaction !== 'boolean'
    || !Number.isSafeInteger(config.fallbackBufferTokens) || Number(config.fallbackBufferTokens) < 0
  ) return unknown
  if (config.scope !== 'total' || config.asyncCompaction || config.postTurnCompactPercent !== 0) return unsupported
  const configured = config.modelContextWindow
  const configuredWindow = configured === null
    ? null
    : model.maxContextWindow === null
    ? configured
    : Math.min(configured, model.maxContextWindow)
  const rawWindow = configuredWindow ?? model.contextWindow ?? model.maxContextWindow
  if (!positive(rawWindow) || rawWindow > Math.floor(Number.MAX_SAFE_INTEGER / 100)) return unknown
  const usableWindow = Math.floor(rawWindow * model.effectiveContextPercent / 100)
  const modelLimit = Math.floor(rawWindow * 9 / 10)
  const requested = config.modelAutoCompactLimit ?? model.autoCompactLimit
  const baseLimit = requested === null ? modelLimit : Math.min(requested, modelLimit)
  const bufferedLimit = baseLimit + Number(config.fallbackBufferTokens)
  if (!Number.isSafeInteger(bufferedLimit)) return unknown
  const tokens = Math.min(bufferedLimit, usableWindow)
  if (!positive(tokens) || !positive(usableWindow)) return unknown
  return { status: 'resolved', tokens, rawWindow, usableWindow }
}
