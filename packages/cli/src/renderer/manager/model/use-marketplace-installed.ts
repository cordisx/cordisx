import { useEffect, useMemo, useState } from 'react'
import type { MarketplaceCatalogPlugin } from '../../marketplace.js'
import type { ManagerPluginSnapshot, ManagerSnapshot } from '../../manager.js'
import type { PluginManagementBinding } from '../../management-binding.js'

const aliasPattern = /^https:\/\/renderer\.cordisx\.invalid\/plugin\/[a-f0-9]{64}$/u

/** Match a private renderer alias only after the owner verifies the exact catalog selection. */
export function useMarketplaceInstalled(
  plugins: readonly MarketplaceCatalogPlugin[],
  snapshot: ManagerSnapshot,
  binding: PluginManagementBinding | undefined,
): ReadonlyMap<string, ManagerPluginSnapshot> {
  const [verified, setVerified] = useState<ReadonlyMap<string, string>>(() => new Map())
  const lookupKey = JSON.stringify(plugins.flatMap(plugin => {
    const installed = snapshot.plugins.find(item => item.id === plugin.id && aliasPattern.test(item.source))
    return installed === undefined ? [] : [{
      identity: plugin.identity,
      alias: installed.source,
      query: {
        pluginId: plugin.id,
        sourceUrl: plugin.feedUrl,
        version: plugin.version,
        expectedCanonicalSource: plugin.source,
        ...(plugin.artifact === undefined ? {} : { expectedArtifactIntegrity: plugin.artifact.integrity }),
      },
    }]
  }))
  useEffect(() => {
    let current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    if (binding?.pluginInfo === undefined) {
      setVerified(new Map())
      return () => {
        current = false
      }
    }
    const lookups = JSON.parse(lookupKey) as Array<{
      identity: string
      alias: string
      query: Parameters<NonNullable<PluginManagementBinding['pluginInfo']>>[0]
    }>
    const verified = new Map<string, string>()
    const retryDelays = [250, 500, 1_000, 2_000, 4_000]
    const lookup = async (pending: typeof lookups, attempt: number): Promise<void> => {
      const results = await Promise.all(pending.map(async item => {
        try {
          const result = await binding.pluginInfo!(item.query)
          if (result?.canonicalSource === item.alias) verified.set(item.identity, item.alias)
          return undefined
        } catch {
          return item
        }
      }))
      if (!current) return
      setVerified(new Map(verified))
      const retry = results.filter((item): item is typeof lookups[number] => item !== undefined)
      const delay = retryDelays[attempt]
      if (retry.length && delay !== undefined) timer = setTimeout(() => void lookup(retry, attempt + 1), delay)
    }
    void lookup(lookups, 0)
    return () => {
      current = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [binding, lookupKey])
  return useMemo(() => {
    const result = new Map<string, ManagerPluginSnapshot>()
    for (const plugin of plugins) {
      const item = snapshot.plugins.find(installed =>
        installed.id === plugin.id
        && (installed.source === plugin.source || installed.source === verified.get(plugin.identity))
      )
      if (item) result.set(plugin.identity, item)
    }
    return result
  }, [plugins, snapshot.plugins, verified])
}
