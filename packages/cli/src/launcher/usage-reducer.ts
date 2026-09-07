/** Metadata-only reduction. Filesystem continuity, source deduplication and atomic
 * persistence belong to the owning usage ledger, never to plugin code. */
export interface UsageTokenVector {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
}
export interface UsageSourceState {
  ownerId: string | null
  metadataSeen: boolean
  ownership: 'root' | 'fork' | 'unknown'
  forkBoundary: number | null
  lastOwnedOrdinal: number | null
  lastTotal: UsageTokenVector | null
  counterEpoch: number
}
export type UsageReducerDiagnosticCode =
  | 'invalid-record'
  | 'invalid-owner'
  | 'missing-owner'
  | 'unsupported-fork'
  | 'inherited-record'
  | 'duplicate-record'
  | 'invalid-counter'
  | 'counter-reset'
  | 'counter-gap'
  | 'counter-correction'
  | 'counter-overflow'
export interface UsageReduction {
  state: UsageSourceState
  increment: { inputTokens: number; outputTokens: number }
  diagnostics: { code: UsageReducerDiagnosticCode; count: number }[]
}
const fields = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'total_tokens',
] as const
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function counter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
function identity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(value)
}
function vector(raw: unknown): UsageTokenVector | null {
  if (!record(raw)) return null
  // Older rollout versions omit cache writes; Codex serde gives this field a zero default.
  const normalized: Record<string, unknown> = {
    ...raw,
    cache_write_input_tokens: raw.cache_write_input_tokens === undefined ? 0 : raw.cache_write_input_tokens,
  }
  if (!fields.every(field => counter(normalized[field]))) return null
  const value = normalized as unknown as UsageTokenVector
  if (
    value.input_tokens + value.output_tokens !== value.total_tokens
    || !Number.isSafeInteger(value.input_tokens + value.output_tokens)
    || value.cached_input_tokens > value.input_tokens
    || value.cache_write_input_tokens > value.input_tokens
    || value.reasoning_output_tokens > value.output_tokens
  ) return null
  // Only return the six allowlisted counters, never retain any other payload field.
  return Object.fromEntries(fields.map(field => [field, value[field]])) as unknown as UsageTokenVector
}
function initialState(): UsageSourceState {
  return {
    ownerId: null,
    metadataSeen: false,
    ownership: 'unknown',
    forkBoundary: null,
    lastOwnedOrdinal: null,
    lastTotal: null,
    counterEpoch: 0,
  }
}
/** Persisted checkpoints are security-relevant accounting state. Refuse corrupt
 * state instead of silently returning to a zero baseline or copying unknown keys. */
export function isUsageSourceState(value: unknown): value is UsageSourceState {
  if (!record(value) || typeof value.metadataSeen !== 'boolean' || !counter(value.counterEpoch)) return false
  if (value.ownerId !== null && !identity(value.ownerId)) return false
  if (value.lastOwnedOrdinal !== null && !counter(value.lastOwnedOrdinal)) return false
  if (value.lastTotal !== null && vector(value.lastTotal) === null) return false
  if (value.ownership === 'fork') {
    if (value.ownerId === null || !counter(value.forkBoundary)) return false
  } else if (value.ownership === 'root') {
    if (value.ownerId === null || value.forkBoundary !== null) return false
  } else if (value.ownership !== 'unknown' || value.forkBoundary !== null || value.lastTotal !== null) return false
  return value.metadataSeen || (value.ownerId === null && value.ownership === 'unknown')
}

/** Returns only a metadata allowlist. `baseline` scans establish high-water marks
 * without credit, even when the scan contains many valid request completions. */
export function reduceUsageRecords(
  previous: UsageSourceState | undefined,
  records: readonly unknown[],
  options: { baseline: boolean },
): UsageReduction {
  if (previous !== undefined && !isUsageSourceState(previous)) throw new Error('Invalid usage source checkpoint')
  const state: UsageSourceState = previous
    ? {
      ownerId: previous.ownerId,
      metadataSeen: previous.metadataSeen,
      ownership: previous.ownership,
      forkBoundary: previous.forkBoundary,
      lastOwnedOrdinal: previous.lastOwnedOrdinal,
      lastTotal: previous.lastTotal ? vector(previous.lastTotal) : null,
      counterEpoch: previous.counterEpoch,
    }
    : initialState()
  const baseline = previous === undefined || options.baseline
  const counts = new Map<UsageReducerDiagnosticCode, number>()
  const note = (code: UsageReducerDiagnosticCode) => counts.set(code, (counts.get(code) ?? 0) + 1)
  const increment = { inputTokens: 0, outputTokens: 0 }
  for (const raw of records) {
    let envelope: unknown = raw
    if (typeof raw === 'string') {
      try {
        envelope = JSON.parse(raw)
      } catch {
        note('invalid-record')
        if (!state.metadataSeen) state.metadataSeen = true
        state.lastTotal = null
        continue
      }
    }
    if (!record(envelope) || !record(envelope.payload)) {
      note('invalid-record')
      if (!state.metadataSeen) state.metadataSeen = true
      state.lastTotal = null
      continue
    }
    const payload = envelope.payload
    if (envelope.type === 'session_meta') {
      // Fork rollout files can contain a later inherited parent header. It cannot
      // replace the first owning identity or clear a rejected first header.
      if (state.metadataSeen) continue
      state.metadataSeen = true
      const owner = payload.id ?? payload.session_id
      if (
        !identity(owner)
        || (payload.id !== undefined && payload.session_id !== undefined && payload.id !== payload.session_id)
      ) {
        note('invalid-owner')
        continue
      }
      state.ownerId = owner
      const source = payload.source
      const forked = payload.forked_from_id != null || payload.parent_thread_id != null
        || source === 'subagent' || (record(source) && source.subagent !== undefined)
      if (!forked) state.ownership = 'root'
      else if (counter(payload.subagent_history_start_ordinal)) {
        state.ownership = 'fork'
        state.forkBoundary = payload.subagent_history_start_ordinal
      } else note('unsupported-fork')
      continue
    }
    if (envelope.type !== 'event_msg' || payload.type !== 'token_count') continue
    if (state.ownerId === null) {
      note('missing-owner')
      continue
    }
    if (state.ownership === 'unknown') {
      note('unsupported-fork')
      continue
    }
    const ordinal = counter(envelope.ordinal) ? envelope.ordinal : null
    if (state.ownership === 'fork' && (ordinal === null || ordinal <= state.forkBoundary!)) {
      note('inherited-record')
      continue
    }
    if (ordinal !== null && state.lastOwnedOrdinal !== null && ordinal <= state.lastOwnedOrdinal) {
      note('duplicate-record')
      continue
    }
    if (ordinal !== null) state.lastOwnedOrdinal = ordinal
    // Rate-limit notifications can intentionally repeat token_count with null info.
    if (payload.info == null) continue
    const info = record(payload.info) ? payload.info : {}
    const total = vector(info.total_token_usage)
    const last = vector(info.last_token_usage)
    if (total === null || last === null) {
      note('invalid-counter')
      state.lastTotal = null
      continue
    }
    const prior = state.lastTotal
    state.lastTotal = total
    if (prior === null) continue
    const delta = Object.fromEntries(
      fields.map(field => [field, total[field] - prior[field]]),
    ) as unknown as UsageTokenVector
    if (fields.every(field => delta[field] === 0)) {
      note('duplicate-record')
      continue
    }
    if (fields.some(field => delta[field] < 0)) {
      state.counterEpoch = Math.min(Number.MAX_SAFE_INTEGER, state.counterEpoch + 1)
      note(total.total_tokens === prior.total_tokens ? 'counter-correction' : 'counter-reset')
      continue
    }
    if (!fields.every(field => delta[field] === last[field])) {
      note('counter-gap')
      continue
    }
    if (baseline) continue
    const input = increment.inputTokens + delta.input_tokens
    const output = increment.outputTokens + delta.output_tokens
    if (!counter(input) || !counter(output) || !counter(input + output)) {
      note('counter-overflow')
      continue
    }
    increment.inputTokens = input
    increment.outputTokens = output
  }
  return { state, increment, diagnostics: [...counts].map(([code, count]) => ({ code, count })) }
}
