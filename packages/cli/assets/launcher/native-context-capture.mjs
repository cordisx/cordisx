import { createHash } from 'node:crypto'

// Handles retain only the startup catalog and budget projection, never the full config or request.
const pending = new WeakMap()
const unknown = Object.freeze({ status: 'unavailable', reason: 'unknown' })
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0
const optionalPositive = (value) => value == null || positive(value)
const nonempty = (value) => typeof value === 'string' && value.length > 0
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Compare the JSON actually sent, independent of property order, without retaining its contents.
function requestDigest(value) {
  try {
    const normalized = JSON.parse(JSON.stringify(value))
    const sort = (item) => {
      if (Array.isArray(item)) return item.map(sort)
      if (!object(item)) return item
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]))
    }
    return digest(JSON.stringify(sort(normalized)))
  } catch {
    return null
  }
}

function enabled(value, key) {
  if (value == null) return false
  if (typeof value === 'boolean') return value
  if (!object(value)) return null
  return value[key] === undefined ? false : typeof value[key] === 'boolean' ? value[key] : null
}

/**
 * Prepare an exact thread/start for the common 0.167 total-scope path.
 *
 * startup is the actual launch owner's receipt: immutable catalog bytes loaded
 * by this very OpenAI-compatible server, not a disk-cache guess or a per-thread
 * catalog override. preflight is the full same-server config/read for request
 * cwd plus the contemporaneous complete featureRequirements map (null means no
 * managed requirements). Caller must trust these receipts and attach this
 * helper before dispatch. Unsupported or incomplete inputs return unknown.
 *
 * `configPatch` is the only request modification; it fixes the effective
 * budget to values equivalent to the preflight and frozen startup catalog.
 * Callers must preserve all other params, then pass the exact submitted params
 * to finish. Model, provider and any budget-affecting change invalidates it.
 */
export function prepareNativeContextCapture({ startup, preflight, request } = {}) {
  if (!object(startup) || !object(preflight) || !object(request)) return unknown
  const { nativeVersion, serverId, providerId, providerKind, catalogSha256, catalogBytes } = startup
  if (
    nativeVersion !== '0.167.0-alpha.3.2' || !nonempty(serverId) || providerKind !== 'openai-compatible'
    || !nonempty(providerId) || !(catalogBytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(catalogSha256)
    || digest(catalogBytes) !== catalogSha256 || preflight.serverId !== serverId || !nonempty(preflight.cwd)
    || !nonempty(preflight.originator) || !object(preflight.config) || !object(request.params)
    || request.method !== 'thread/start' || !['string', 'number'].includes(typeof request.id)
    || !nonempty(request.params.model) || request.params.cwd !== preflight.cwd
  ) return unknown
  const requirements = preflight.featureRequirements
  if (requirements !== null) {
    if (
      !object(requirements) || ['token_budget', 'context_management', 'async_compaction'].some((k) => k in requirements)
    ) {
      return unknown
    }
  }
  const params = request.params
  const supplied = params.config == null ? {} : params.config
  if (!object(supplied)) return unknown
  if (
    Object.keys(supplied).some((key) =>
      key === 'features' || key.startsWith('features.')
      || key === 'model_catalog_json' || key === 'model_auto_compact_token_limit_scope'
      || key === 'model_post_turn_compact_threshold_percent'
      || [
        'model_context_window.',
        'model_auto_compact_token_limit.',
        'model_auto_compact_token_limit_scope.',
        'model_post_turn_compact_threshold_percent.',
        'model_catalog_json.',
      ].some((prefix) => key.startsWith(prefix))
    )
    || (params.modelProvider ?? preflight.config.model_provider ?? providerId) !== providerId
    || (supplied.model_provider != null && supplied.model_provider !== providerId)
  ) return unknown
  const config = preflight.config
  const features = config.features ?? {}
  if (
    !object(features) || enabled(features.token_budget, 'enabled') !== false
    || enabled(features.context_management, 'experimental_mode') !== false
    || enabled(features.async_compaction, 'enabled') !== false
    || (config.model_auto_compact_token_limit_scope ?? 'total') !== 'total'
    || (config.model_post_turn_compact_threshold_percent ?? 0) !== 0
  ) return unknown
  let catalog
  try {
    catalog = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes))
  } catch {
    return unknown
  }
  if (!object(catalog) || !Array.isArray(catalog.models)) return unknown
  const matches = catalog.models.filter((value) => object(value) && value.slug === params.model)
  if (matches.length !== 1) return unknown
  const model = matches[0]
  const budget = model.model_messages?.token_budget
  if (budget != null && (!object(budget) || (budget.enabled !== undefined && budget.enabled !== false))) return unknown
  const context = model.context_window ?? null
  const maximum = model.max_context_window ?? null
  const modelLimit = model.auto_compact_token_limit ?? null
  const percent = model.effective_context_window_percent === undefined ? 95 : model.effective_context_window_percent
  const configuredWindow = Object.hasOwn(supplied, 'model_context_window')
    ? supplied.model_context_window
    : config.model_context_window ?? null
  const configuredLimit = Object.hasOwn(supplied, 'model_auto_compact_token_limit')
    ? supplied.model_auto_compact_token_limit
    : config.model_auto_compact_token_limit ?? null
  if (
    !optionalPositive(context) || !optionalPositive(maximum) || !optionalPositive(modelLimit)
    || !optionalPositive(configuredWindow) || !optionalPositive(configuredLimit)
    || !Number.isInteger(percent) || percent < 1 || percent > 100
  ) return unknown
  // JSON null is an empty TOML string, not an unset value, so reject it when explicitly supplied.
  if (
    (Object.hasOwn(supplied, 'model_context_window') && !positive(configuredWindow))
    || (Object.hasOwn(supplied, 'model_auto_compact_token_limit') && !positive(configuredLimit))
  ) return unknown
  const raw = configuredWindow == null ? context ?? maximum : maximum == null
    ? configuredWindow
    : Math.min(configuredWindow, maximum)
  if (!positive(raw) || raw > Math.floor(Number.MAX_SAFE_INTEGER / 100)) return unknown
  const nativeCap = Math.floor(raw * 9 / 10)
  const limit = Math.min(configuredLimit ?? modelLimit ?? nativeCap, nativeCap)
  if (!positive(limit)) return unknown
  const configPatch = Object.freeze({
    model_context_window: raw,
    model_auto_compact_token_limit: limit,
    model_auto_compact_token_limit_scope: 'total',
    model_post_turn_compact_threshold_percent: 0,
    'features.token_budget': false,
    'features.context_management': false,
    'features.async_compaction': false,
  })
  const expectedParams = { ...params, config: { ...supplied, ...configPatch } }
  const expectedDigest = requestDigest(expectedParams)
  if (!expectedDigest) return unknown
  const handle = Object.freeze({})
  pending.set(handle, {
    startup: {
      nativeVersion,
      serverId,
      providerId,
      providerKind,
      catalogSha256,
      catalogBytes: Uint8Array.from(catalogBytes),
    },
    requestId: request.id,
    expectedDigest,
    originator: preflight.originator,
    model: params.model,
    mergedConfig: {
      model_context_window: raw,
      model_auto_compact_token_limit: limit,
      model_auto_compact_token_limit_scope: 'total',
      model_post_turn_compact_threshold_percent: 0,
      features: { token_budget: false, context_management: false, async_compaction: false },
    },
  })
  return { status: 'ready', configPatch, handle }
}

/** Complete exactly once after the same server successfully replies. */
export function finishNativeContextCapture(handle, receipt, deriveNativeBudgetProvenance) {
  if (!object(handle)) return unknown
  const state = pending.get(handle)
  pending.delete(handle)
  if (
    !state || !object(receipt) || typeof deriveNativeBudgetProvenance !== 'function'
    || receipt.serverId !== state.startup.serverId || receipt.requestId !== state.requestId
    || requestDigest(receipt.submittedParams) !== state.expectedDigest || !object(receipt.response)
    || receipt.response.id !== state.requestId || receipt.response.error != null || !object(receipt.response.result)
  ) return unknown
  const result = receipt.response.result
  if (
    !object(result.thread) || !nonempty(result.thread.id) || result.model !== state.model
    || result.modelProvider !== state.startup.providerId
  ) return unknown
  return deriveNativeBudgetProvenance(state.startup, {
    serverId: state.startup.serverId,
    requestId: String(state.requestId),
    responseRequestId: String(receipt.response.id),
    originator: state.originator,
    sessionId: result.thread.id,
    requestedModel: state.model,
    responseModel: result.model,
    responseProviderId: result.modelProvider,
    mergedConfig: state.mergedConfig,
    featureRequirements: null,
  })
}
