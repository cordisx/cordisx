import type { PlaygroundMockTaskDetailsUrl } from '../../renderer/playground-mock-agent-loop.js'
import {
  CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT,
  HostAgentTaskDetailsNavigator,
  navigateHostTaskDetailsSameDocument,
  validateAgentLoopTaskDetailsUrl,
} from '../../renderer/host-ui/AgentTaskDetailsNavigator.js'

export const PLAYGROUND_SIMULATOR_SESSION_PREFIX = 'cordisx.playground.simulator/v1:'

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

/**
 * Restores the Playground page shell in the capture phase so the production
 * route projection observes a mounted Host outlet during the same popstate.
 */
export function subscribePlaygroundTaskLocation(
  view: Window,
  listener: (taskId: string | undefined, synchronous: boolean) => void,
): () => void {
  const onPopState = () => listener(simulatorTaskIdFromPath(view.location.pathname), true)
  const onTaskNavigation = () => listener(simulatorTaskIdFromPath(view.location.pathname), true)
  view.addEventListener('popstate', onPopState, { capture: true })
  view.addEventListener(CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT, onTaskNavigation)
  return () => {
    view.removeEventListener('popstate', onPopState, { capture: true })
    view.removeEventListener(CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT, onTaskNavigation)
  }
}

/** Removes only the Host-private Simulator registry for this browser session. */
export function clearPlaygroundSimulatorSessionRegistry(storage: Storage): void {
  const matching: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(PLAYGROUND_SIMULATOR_SESSION_PREFIX)) matching.push(key)
  }
  for (const key of matching) storage.removeItem(key)
}

export function navigateTaskDetails(
  view: Pick<Window, 'history' | 'dispatchEvent'>,
  detailsUrl: PlaygroundMockTaskDetailsUrl,
  openExternal?: (url: URL) => void,
): boolean {
  const target = taskNavigationTarget(detailsUrl)
  if (target === undefined) return false
  try {
    const navigator = new HostAgentTaskDetailsNavigator({
      navigateHost: () => navigateHostTaskDetailsSameDocument(view, detailsUrl.url),
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
