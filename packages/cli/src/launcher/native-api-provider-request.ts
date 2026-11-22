import { nativeProviderConfig } from './native-provider-config.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

/** Resolve model defaults before acquiring the existing credential lease for that exact provider. */
export function nativeApiProviderRequest(input: {
  request(
    method: NativeBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    overrides?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>
  prepareStart(params: Record<string, unknown>): Promise<Record<string, unknown>>
  managed(providerId: string): boolean
  prepareManaged(providerId: string): Promise<{ dispose(): void } & Parameters<typeof nativeProviderConfig>[0]>
  prepareConfigured(providerId: string): Promise<Readonly<Record<string, unknown>>>
  leases: Map<string, { dispose(): void }>
}) {
  return async (method: NativeBridgeMethod, value: Readonly<Record<string, unknown>>) => {
    const params = method === 'thread/start' ? await input.prepareStart({ ...value }) : value
    let providerId = typeof params.modelProvider === 'string' ? params.modelProvider : undefined
    if (method === 'turn/start' && typeof params.threadId === 'string') {
      const persisted = await input.request('thread/read', { threadId: params.threadId, includeTurns: false }) as {
        thread?: { modelProvider?: string }
      }
      providerId = persisted.thread?.modelProvider
    }
    if (!['thread/start', 'turn/start'].includes(method) || !providerId) {
      const result = await input.request(method, params)
      if (method === 'thread/read' && typeof params.threadId === 'string') {
        const status = (result as { thread?: { status?: { type?: string } } }).thread?.status?.type
        if (status && status !== 'active') {
          input.leases.get(params.threadId)?.dispose()
          input.leases.delete(params.threadId)
        }
      }
      return result
    }
    if (!input.managed(providerId)) return input.request(method, params, await input.prepareConfigured(providerId))
    let lease: Awaited<ReturnType<typeof input.prepareManaged>> | undefined = await input.prepareManaged(providerId)
    try {
      const result = await input.request(method, {
        ...params,
        config: {
          ...params.config as Record<string, unknown>,
          [`model_providers.${providerId}`]: nativeProviderConfig(lease),
        },
      })
      const threadId = method === 'thread/start' ? (result as { thread?: { id?: string } }).thread?.id : params.threadId
      if (typeof threadId === 'string') {
        input.leases.get(threadId)?.dispose()
        input.leases.set(threadId, lease)
        lease = undefined
      }
      return result
    } finally {
      lease?.dispose()
    }
  }
}
