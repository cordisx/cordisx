const FAVORITES_KEY = 'cordisx.manager.favoriteMarketplacePlugins.v1'

function storage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export function readMarketplaceFavorites(): Set<string> {
  try {
    const parsed = JSON.parse(storage()?.getItem(FAVORITES_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeMarketplaceFavorites(favorites: ReadonlySet<string>): void {
  try {
    storage()?.setItem(FAVORITES_KEY, JSON.stringify([...favorites].sort()))
  } catch {}
}
