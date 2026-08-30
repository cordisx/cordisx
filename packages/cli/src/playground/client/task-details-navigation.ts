import type { PlaygroundMockTaskDetailsUrl } from '../../renderer/playground-mock-agent-loop.js'

const EXTERNAL_SCHEMES = new Set(['https:', 'codex:', 'claude:'])

export interface PlaygroundTaskNavigationTarget {
  readonly kind: 'host' | 'external'
  readonly url: URL
  readonly historyUrl?: string
}

export function taskNavigationTarget(detailsUrl: PlaygroundMockTaskDetailsUrl): PlaygroundTaskNavigationTarget | undefined {
  let parsed: URL
  try {
    parsed = new URL(detailsUrl.url)
  } catch {
    return undefined
  }
  if (detailsUrl.target === 'host') {
    if (parsed.protocol !== 'app:' || parsed.hostname !== '-') return undefined
    return { kind: 'host', url: parsed, historyUrl: `${parsed.pathname}${parsed.search}${parsed.hash}` }
  }
  if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return undefined
  return { kind: 'external', url: parsed }
}

export function simulatorTaskIdFromPath(pathname: string): string | undefined {
  const prefix = '/playground/simulator/tasks/'
  if (!pathname.startsWith(prefix)) return undefined
  const encoded = pathname.slice(prefix.length)
  if (encoded === '' || encoded.includes('/')) return undefined
  try {
    return decodeURIComponent(encoded)
  } catch {
    return undefined
  }
}

export function navigateTaskDetails(
  view: Pick<Window, 'history'>,
  detailsUrl: PlaygroundMockTaskDetailsUrl,
  openExternal?: (url: URL) => void,
): boolean {
  const target = taskNavigationTarget(detailsUrl)
  if (target === undefined) return false
  if (target.kind === 'host') view.history.pushState(view.history.state, '', target.historyUrl)
  else {
    if (openExternal === undefined) return false
    openExternal(target.url)
  }
  return true
}
