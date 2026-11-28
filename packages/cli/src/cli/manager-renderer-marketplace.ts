import { fetchMarketplaceFeed, normalizeMarketplaceRequestUrl } from '../launcher/marketplace.js'
import type { PluginManagementService } from '../management/service.js'
import type { ManagerRendererChannel, ManagerRendererChannelContext } from './manager-renderer-sessions.js'

/** Read configured feeds through the owner without granting arbitrary network access to a page. */
export function createManagerRendererMarketplaceChannel(input: {
  readonly profileId: string
  readonly generation: string
  readonly service: Pick<PluginManagementService, 'query'>
  readonly isCurrent: (context: ManagerRendererChannelContext) => boolean
  readonly fetchFeed?: typeof fetchMarketplaceFeed
}): ManagerRendererChannel {
  const seen = new WeakMap<AbortSignal, Set<string>>()
  const active = new WeakMap<AbortSignal, number>()
  const current = (context: ManagerRendererChannelContext) => {
    try {
      return !context.signal.aborted && context.profileId === input.profileId
        && context.ownerGeneration === input.generation && input.isCurrent(context)
    } catch {
      return false
    }
  }
  const authorized = async (url: string): Promise<boolean> => {
    const snapshot = await input.service.query()
    return snapshot.sources.some(source => {
      try {
        return source.enabled && normalizeMarketplaceRequestUrl(source.url).href === url
      } catch {
        return false
      }
    })
  }
  return {
    prepare(payload, context) {
      if (!current(context) || typeof payload !== 'string' || Buffer.byteLength(payload) > 4096) {
        throw new Error('MARKETPLACE_UNAVAILABLE')
      }
      const value: unknown = JSON.parse(payload)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('MARKETPLACE_INVALID')
      const item = value as Record<string, unknown>
      if (
        Object.keys(item).length !== 2 || Object.keys(item).some(key => !['requestId', 'url'].includes(key))
        || typeof item.requestId !== 'string' || !/^[A-Za-z0-9-]{1,96}$/u.test(item.requestId)
        || typeof item.url !== 'string' || item.url.length === 0 || item.url.length > 2048
      ) throw new Error('MARKETPLACE_INVALID')
      const requestId = item.requestId
      const url = normalizeMarketplaceRequestUrl(item.url).href
      return {
        mode: 'read',
        dispatch: async () => {
          const requests = seen.get(context.signal) ?? new Set<string>()
          if (!current(context) || requests.has(requestId) || requests.size >= 4096) {
            throw new Error('MARKETPLACE_UNAVAILABLE')
          }
          requests.add(requestId)
          seen.set(context.signal, requests)
          if ((active.get(context.signal) ?? 0) >= 4) {
            return { requestId, ok: false, error: 'Marketplace feed is unavailable.' }
          }
          active.set(context.signal, (active.get(context.signal) ?? 0) + 1)
          try {
            if (!await authorized(url) || !current(context)) throw new Error('MARKETPLACE_UNAVAILABLE')
            const result = await (input.fetchFeed ?? fetchMarketplaceFeed)(url, context.signal)
            if (
              !current(context) || !await authorized(url) || !current(context)
              || !Number.isInteger(result.status) || result.status < 100 || result.status > 599
              || typeof result.text !== 'string' || Buffer.byteLength(result.text) > 2 * 1024 * 1024
            ) throw new Error('MARKETPLACE_UNAVAILABLE')
            return {
              requestId,
              ok: result.status >= 200 && result.status < 300,
              status: result.status,
              text: result.text,
            }
          } catch {
            return { requestId, ok: false, error: 'Marketplace feed is unavailable.' }
          } finally {
            active.set(context.signal, (active.get(context.signal) ?? 1) - 1)
          }
        },
      }
    },
  }
}
