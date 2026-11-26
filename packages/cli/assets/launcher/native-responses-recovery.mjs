import { configuredOverrides } from './native-configured-overrides.mjs'
import { createHash } from 'node:crypto'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined

/** Only routing and opaque identity digests cross the private Host bridge. */
export function accountRouting(value) {
  const result = object(value), account = object(result?.account) ?? result
  if (account?.type === 'apiKey') return { type: 'apiKey' }
  if (account?.type !== 'chatgpt') return undefined
  const routing = object(result?.workspaceRouting)
  if (!routing) return { type: 'chatgpt' }
  let workspaceDigest = routing.workspaceDigest, ownerDigest = routing.ownerDigest
  if (typeof routing.chatgptAccountId === 'string' && typeof result?.userId === 'string') {
    workspaceDigest = createHash('sha256').update(routing.chatgptAccountId).digest('hex')
    ownerDigest = createHash('sha256').update(JSON.stringify([routing.chatgptAccountId, result.userId])).digest('hex')
  }
  if (typeof workspaceDigest !== 'string' || typeof ownerDigest !== 'string') return { type: 'chatgpt' }
  return {
    type: 'chatgpt',
    workspaceRouting: {
      workspaceDigest,
      ownerDigest,
      backendOrigin: routing.backendOrigin,
      accountRoutingOverride: routing.accountRoutingOverride,
    },
  }
}

/** Prepare the same configured Responses route for either native owner. */
export async function prepareResponsesRecoveryRequest(method, params, { readThread, readAccount, prepare }) {
  if (!['thread/start', 'thread/resume', 'thread/fork'].includes(method) || !object(params)) return params
  if (params.path != null || params.history != null) return params
  const config = object(params.config)
  let provider = params.modelProvider
  if (provider == null && typeof config?.model_provider === 'string') provider = config.model_provider
  if (method !== 'thread/start' && provider == null && typeof params.threadId === 'string') {
    const persisted = await readThread(params.threadId)
    provider = persisted?.thread?.modelProvider
    if (typeof provider !== 'string' || !provider) return params
  }
  if (provider != null && typeof provider !== 'string') return params
  if (typeof config?.model_provider === 'string' && provider != null && config.model_provider !== provider) {
    return params
  }
  // Do not replace routing selected explicitly for this native request.
  if (
    provider === 'openai' && config
    && Object.keys(config).some(key =>
      ['openai_base_url', 'chatgpt_base_url', 'model_providers', 'model_providers.openai'].includes(key)
      || key.startsWith('model_providers.openai.')
    )
  ) return params
  let nativeAccount
  if ((provider === 'openai' || provider == null) && readAccount) {
    try {
      nativeAccount = accountRouting(await readAccount())
    } catch {}
  }
  const overrides = await prepare(provider, nativeAccount)
  if (!object(overrides) || Object.keys(overrides).length === 0) return params
  return { ...params, config: configuredOverrides(config, overrides) }
}

/** Bind the common preparation to the Desktop intermediary's native and Host RPC ports. */
export function prepareNativeResponsesRecovery(method, params, { nativeCall, controlCall, nativeOpenAiRecovery }) {
  return prepareResponsesRecoveryRequest(method, params, {
    readThread: threadId => nativeCall('thread/read', { threadId, includeTurns: false }),
    ...(nativeOpenAiRecovery ? { readAccount: () => nativeCall('account/read', { refreshToken: false }) } : {}),
    prepare: (providerId, nativeAccount) =>
      controlCall('configured-provider', {
        ...(typeof providerId === 'string' ? { providerId } : {}),
        ...(nativeAccount ? { nativeAccount } : {}),
      }),
  })
}
