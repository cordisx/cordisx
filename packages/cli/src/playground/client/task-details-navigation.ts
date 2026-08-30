import type { PlaygroundMockTaskDetailsUrl } from '../../renderer/playground-mock-agent-loop.js'
import {
  HostAgentTaskDetailsNavigator,
  validateAgentLoopTaskDetailsUrl,
} from '../../renderer/host-ui/AgentTaskDetailsNavigator.js'
import { withoutCordisXRouteHistoryEntry } from '../../renderer/codex-router-history.js'

export interface PlaygroundTaskNavigationTarget {
  readonly kind: 'host' | 'external'
  readonly url: URL
  readonly historyUrl?: string
}

export function taskNavigationTarget(detailsUrl: PlaygroundMockTaskDetailsUrl): PlaygroundTaskNavigationTarget | undefined {
  let validated: PlaygroundMockTaskDetailsUrl
  let parsed: URL
  try {
    validated = validateAgentLoopTaskDetailsUrl(detailsUrl)
    parsed = new URL(validated.url)
  } catch {
    return undefined
  }
  if (validated.target === 'host') {
    if (parsed.protocol !== 'app:' || parsed.hostname !== '-') return undefined
    return { kind: 'host', url: parsed, historyUrl: parsed.pathname }
  }
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
  try {
    const navigator = new HostAgentTaskDetailsNavigator({
      navigateHost: () => view.history.pushState(withoutCordisXRouteHistoryEntry(view.history.state), '', target.historyUrl!),
      navigateExternal: () => {
        if (openExternal === undefined) throw new Error('External task navigation is unavailable')
        openExternal(target.url)
      },
    })
    navigator.navigate(detailsUrl)
    return true
  } catch {
    return false
  }
}
