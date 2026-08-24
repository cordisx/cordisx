import { normalizeMarketplaceSource, type MarketplaceStorage } from './marketplace-source.js'

export const MARKETPLACE_FEED_CACHE_KEY = 'cordisx.manager.marketplaceFeedCache.v1'

const MAX_PERSISTED_CACHE_BYTES = 3 * 1024 * 1024
const MAX_FEED_CACHE_BYTES = 2 * 1024 * 1024

export interface MarketplaceFeedCacheEntry {
  readonly url: string
  readonly text: string
  readonly storedAt: number
}

interface PersistedMarketplaceFeedCacheV1 {
  readonly schemaVersion: 1
  readonly entries: readonly MarketplaceFeedCacheEntry[]
}

function byteLength(value: string): number {
  return new Blob([value]).size
}

function parseEntries(value: unknown): MarketplaceFeedCacheEntry[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const cache = value as { schemaVersion?: unknown; entries?: unknown }
  if (cache.schemaVersion !== 1 || !Array.isArray(cache.entries)) return []
  const entries: MarketplaceFeedCacheEntry[] = []
  const seen = new Set<string>()
  for (const item of cache.entries) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as { url?: unknown; text?: unknown; storedAt?: unknown }
    if (typeof raw.url !== 'string' || typeof raw.text !== 'string' || typeof raw.storedAt !== 'number' || !Number.isFinite(raw.storedAt)) continue
    if (byteLength(raw.text) > MAX_FEED_CACHE_BYTES) continue
    let url: string
    try { url = normalizeMarketplaceSource(raw.url) } catch { continue }
    if (url !== raw.url || seen.has(url)) continue
    seen.add(url)
    entries.push(Object.freeze({ url, text: raw.text, storedAt: raw.storedAt }))
  }
  return entries.sort((left, right) => right.storedAt - left.storedAt)
}

/** Bounded last-good raw feed cache used by the renderer-owned SWR model. */
export class BrowserMarketplaceFeedCache {
  private readonly entries = new Map<string, MarketplaceFeedCacheEntry>()

  constructor(private readonly storage: MarketplaceStorage | undefined) {
    if (storage === undefined) return
    try {
      const stored = storage.getItem(MARKETPLACE_FEED_CACHE_KEY)
      if (stored === null) return
      for (const entry of parseEntries(JSON.parse(stored) as unknown)) this.entries.set(entry.url, entry)
    } catch {
      // A corrupt or over-quota cache is disposable. Source configuration is separate.
    }
  }

  get(value: string): MarketplaceFeedCacheEntry | undefined {
    const entry = this.entries.get(normalizeMarketplaceSource(value))
    return entry === undefined ? undefined : Object.freeze({ ...entry })
  }

  set(value: MarketplaceFeedCacheEntry): void {
    const url = normalizeMarketplaceSource(value.url)
    if (byteLength(value.text) > MAX_FEED_CACHE_BYTES || !Number.isFinite(value.storedAt)) return
    this.entries.set(url, Object.freeze({ url, text: value.text, storedAt: value.storedAt }))
    this.persist()
  }

  delete(value: string): void {
    if (this.entries.delete(normalizeMarketplaceSource(value))) this.persist()
  }

  prune(activeUrls: readonly string[]): void {
    const active = new Set(activeUrls.map(normalizeMarketplaceSource))
    let changed = false
    for (const url of this.entries.keys()) {
      if (active.has(url)) continue
      this.entries.delete(url)
      changed = true
    }
    if (changed) this.persist()
  }

  private persist(): void {
    if (this.storage === undefined) return
    const entries = [...this.entries.values()].sort((left, right) => right.storedAt - left.storedAt)
    while (entries.length > 0) {
      const value: PersistedMarketplaceFeedCacheV1 = { schemaVersion: 1, entries }
      const serialized = JSON.stringify(value)
      if (byteLength(serialized) <= MAX_PERSISTED_CACHE_BYTES) {
        try { this.storage.setItem(MARKETPLACE_FEED_CACHE_KEY, serialized) } catch { /* cache persistence is best-effort */ }
        return
      }
      const removed = entries.pop()
      if (removed !== undefined) this.entries.delete(removed.url)
    }
    try { this.storage.setItem(MARKETPLACE_FEED_CACHE_KEY, JSON.stringify({ schemaVersion: 1, entries: [] })) } catch { /* best-effort */ }
  }
}

export function marketplaceCacheAge(entry: MarketplaceFeedCacheEntry, now: number): number {
  return Math.max(0, now - entry.storedAt)
}
