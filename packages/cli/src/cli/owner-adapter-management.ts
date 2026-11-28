import type { PluginManagementService } from '../management/service.js'
import type { OwnerAdapterClient } from './owner-adapter-client.js'

/** Native Manager operations stay with the service owner; polling projects other clients' commits. */
export function createOwnerAdapterManagement(
  client: Pick<OwnerAdapterClient, 'management'>,
): PluginManagementService {
  const listeners = new Set<Parameters<PluginManagementService['subscribe']>[0]>()
  let closed = false
  let pending: Promise<void> | undefined
  let fingerprint: string | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  const query: PluginManagementService['query'] = async () =>
    await client.management({ kind: 'query' }) as Awaited<ReturnType<PluginManagementService['query']>>
  const refresh = (): Promise<void> => {
    if (closed || listeners.size === 0) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      try {
        const snapshot = await query()
        if (closed) return
        const next = JSON.stringify(snapshot)
        if (next === fingerprint) return
        fingerprint = next
        for (const listener of listeners) {
          try {
            listener(snapshot)
          } catch { /* One consumer must not prevent other projections. */ }
        }
      } catch { /* A failed read is not a new authoritative snapshot. */ }
    })().finally(() => pending = undefined)
    return pending
  }
  const changed = async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = await operation()
    await pending
    fingerprint = undefined
    await refresh()
    return result
  }
  return {
    query,
    refreshCatalog: async sourceUrl =>
      await changed(async () =>
        await client.management({
          kind: 'refresh-catalog',
          ...(sourceUrl === undefined ? {} : { sourceUrl }),
        }) as Awaited<ReturnType<PluginManagementService['refreshCatalog']>>
      ),
    queryCatalog: async query =>
      await client.management({ kind: 'query-catalog', ...(query === undefined ? {} : { query }) }) as Awaited<
        ReturnType<PluginManagementService['queryCatalog']>
      >,
    pluginInfo: async query =>
      await client.management({ kind: 'plugin-info', query }) as Awaited<
        ReturnType<PluginManagementService['pluginInfo']>
      >,
    permissionHistory: async pluginId =>
      await client.management({ kind: 'permission-history', pluginId }) as Awaited<
        ReturnType<NonNullable<PluginManagementService['permissionHistory']>>
      >,
    pluginAuthorizationHistory: async pluginId =>
      await client.management({ kind: 'plugin-authorization-history', pluginId }) as Awaited<
        ReturnType<NonNullable<PluginManagementService['pluginAuthorizationHistory']>>
      >,
    plan: async request =>
      await client.management({ kind: 'plan', request }) as Awaited<ReturnType<PluginManagementService['plan']>>,
    execute: async (request, expectedRevision) =>
      await changed(async () =>
        await client.management({
          kind: 'execute',
          request,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        }) as Awaited<ReturnType<PluginManagementService['execute']>>
      ),
    migrateLegacySources: async input =>
      await changed(async () =>
        await client.management({ kind: 'migrate-legacy-sources', input }) as Awaited<
          ReturnType<PluginManagementService['migrateLegacySources']>
        >
      ),
    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      if (!timer) {
        timer = setInterval(() => void refresh(), 2_000)
        timer.unref()
      }
      fingerprint = undefined
      void refresh()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer) {
          clearInterval(timer)
          timer = undefined
          fingerprint = undefined
        }
      }
    },
    close() {
      closed = true
      if (timer) clearInterval(timer)
      timer = undefined
      listeners.clear()
    },
  }
}
