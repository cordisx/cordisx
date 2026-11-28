import { BrowserRouteHistoryAdapter, CodexRouterHistoryAdapter } from './codex-router-history.js'
import { PlaygroundRoomSimulationBridgeRegistry } from './playground-room-simulation-bridge.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

export function createRuntimeRouting(hostKind: CordisXRuntimeMetadata['hostKind'], target: Window) {
  const browserHostedPlayground = hostKind === 'playground' || target.location.protocol !== 'app:'
  const routeHistory = browserHostedPlayground
    ? new BrowserRouteHistoryAdapter(target, true)
    : new CodexRouterHistoryAdapter(target)
  const playgroundRoomSimulationBridgeRegistry = hostKind === 'playground' && target.location.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(target.location.hostname)
    ? new PlaygroundRoomSimulationBridgeRegistry()
    : undefined
  return { browserHostedPlayground, routeHistory, playgroundRoomSimulationBridgeRegistry }
}
