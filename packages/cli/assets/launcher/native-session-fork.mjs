import { configuredOverrides, optionsAuthority } from './native-configured-overrides.mjs'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
const valid = value => typeof value === 'string' && /^[^\0\r\n]{1,512}$/u.test(value)
const token = value => valid(value) && value.length >= 16 && value.length <= 256
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const failure = message => ({ handled: true, error: { code: -32000, message } })

/** Use only a live, exact source; unknown sources retain the native fork path. */
export async function inheritNativeFork(message, { nativeCall, controlCall }) {
  const params = object(message.params)
  if (
    message.method !== 'thread/fork' || !params || !valid(params.threadId)
    || params.path != null || !['string', 'number'].includes(typeof message.id)
  ) return { handled: false }
  const source = await controlCall('source-configuration', { threadId: params.threadId }).catch(() => undefined)
  if (
    !source || !valid(source.providerId) || !valid(source.model) || !efforts.has(source.reasoningEffort)
    || (source.serviceTier !== null && source.serviceTier !== 'priority')
  ) return { handled: false }
  const inputConfig = object(params.config) ?? {}
  const providerId = params.modelProvider ?? inputConfig.model_provider ?? source.providerId
  const model = params.model ?? inputConfig.model ?? source.model
  if (
    !valid(providerId) || !valid(model)
    || (params.modelProvider != null && inputConfig.model_provider != null
      && params.modelProvider !== inputConfig.model_provider)
  ) return { handled: false }
  const effort = Object.hasOwn(inputConfig, 'model_reasoning_effort')
    ? inputConfig.model_reasoning_effort
    : source.reasoningEffort
  const hasTopTier = Object.hasOwn(params, 'serviceTier')
  const hasConfigTier = Object.hasOwn(inputConfig, 'service_tier')
  const knownTier = value => value === null || value === 'priority'
  // Native schema accepts arbitrary strings and does not specify conflict precedence.
  // Preserve unknown or conflicting explicit settings through the native path.
  if (
    hasTopTier && !knownTier(params.serviceTier) || hasConfigTier && !knownTier(inputConfig.service_tier)
    || hasTopTier && hasConfigTier && params.serviceTier !== inputConfig.service_tier
  ) return { handled: false }
  const tier = hasTopTier ? params.serviceTier : hasConfigTier ? inputConfig.service_tier : source.serviceTier
  if (!efforts.has(effort)) return { handled: false }
  let lease
  try {
    if (providerId !== 'openai') {
      const prepared = await controlCall('fork-prepare', { threadId: params.threadId, providerId, model })
      if (prepared?.kind !== 'resume' || !token(prepared.resumeToken) || !object(prepared.configOverrides)) {
        return failure('Fork provider preparation failed; the source conversation is unchanged.')
      }
      lease = prepared
    }
    const latest = await controlCall('source-configuration', { threadId: params.threadId })
    if (JSON.stringify(latest) !== JSON.stringify(source)) throw new Error('Source configuration changed')
    const overrides = lease?.configOverrides ?? {}
    const config = overrides[optionsAuthority] === undefined
      ? { ...inputConfig, ...overrides }
      : configuredOverrides(inputConfig, overrides)
    config.model_reasoning_effort = effort
    const result = await nativeCall('thread/fork', {
      ...params,
      modelProvider: providerId,
      model,
      serviceTier: tier,
      config,
    })
    const child = result?.thread?.id
    if (
      !valid(child) || child === params.threadId || result.modelProvider !== providerId || result.model !== model
      || result.reasoningEffort !== effort || result.serviceTier !== tier
    ) throw new Error('Fork result is uncertain')
    if (lease) {
      const committed = await controlCall('fork-complete', {
        threadId: params.threadId,
        createdThreadId: child,
        resumeToken: lease.resumeToken,
        succeeded: true,
      })
      lease = undefined
      if (committed !== true) throw new Error('Fork binding is uncertain')
    }
    return { handled: true, result }
  } catch (error) {
    if (lease) {
      await controlCall('fork-complete', {
        threadId: params.threadId,
        resumeToken: lease.resumeToken,
        succeeded: false,
      }).catch(() => undefined)
    }
    return {
      handled: true,
      error: error?.nativeError ?? {
        code: -32000,
        message: 'Fork result is uncertain. Check conversation history before retrying.',
      },
    }
  }
}
