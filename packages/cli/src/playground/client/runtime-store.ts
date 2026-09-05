import { useSyncExternalStore } from 'react'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  type PlaygroundMockAgentLoopSnapshot,
} from '../../renderer/playground-mock-agent-loop.js'
import {
  mergePlaygroundSimulatorTaskSnapshots,
  type PlaygroundHostSessionTaskContext,
  projectPlaygroundHostSessionTask,
  readPlaygroundSimulatorTaskSnapshots,
} from './task-details-navigation.js'
import {
  clearPlaygroundDisposableSessionData,
  isPlaygroundPreviewResetEpoch,
  PLAYGROUND_PREVIEW_RESET_RESULT_KEY,
  type PlaygroundPreviewResetEpoch,
  playgroundPreviewResetEpochMatches,
  readPlaygroundPreviewResetApplied,
  readPlaygroundPreviewResetMarker,
  reconcilePlaygroundPreviewBootstrapEpoch,
  writePlaygroundPreviewResetApplied,
  writePlaygroundPreviewResetMarker,
} from './preview-reset.js'

export const PLAYGROUND_PREVIEW_RESET_APPLY_EVENT = 'cordisx:playground-preview-reset-apply-local' as const
const PLAYGROUND_PREVIEW_RESET_BROADCAST_EVENT = 'cordisx:playground-preview-reset' as const

interface RuntimeState {
  readonly status: 'starting' | 'active' | 'failed'
  readonly plugins: readonly PlaygroundPluginSnapshot[]
  readonly error?: string
  readonly simulator?: PlaygroundMockAgentLoopSnapshot
  readonly resetServer?: PlaygroundPreviewResetEpoch
  readonly resetApplied?: PlaygroundPreviewResetEpoch
}

export interface PlaygroundSimulatorSourceBreakdown {
  readonly liveRuntime: number
  readonly agentSessionAuthority: number
  readonly runtimeMemory: number
  readonly taskSnapshotRegistry: number
  readonly hostSessionRegistry: number
  readonly legacyAliasRegistry: number
  readonly finalSelector: number
}

export type PlaygroundSimulatorTaskSource =
  | 'live-runtime'
  | 'agent-session-authority'
  | 'runtime-memory'
  | 'task-snapshot-registry'
  | 'host-session-registry'
  | 'legacy-alias-registry'

function browserSessionStorage(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

const initialResetMarker = readPlaygroundPreviewResetMarker(browserSessionStorage())
const initialResetApplied = readPlaygroundPreviewResetApplied(browserSessionStorage())
let previewResetBlocked = initialResetMarker !== undefined && initialResetMarker.phase !== 'requesting'
let state: RuntimeState = {
  status: 'starting',
  plugins: [],
  ...(initialResetApplied === undefined ? {} : { resetApplied: initialResetApplied }),
}
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let runtimeGeneration = 0
let pendingRuntimeGeneration: number | undefined

function publish(next: RuntimeState): void {
  const samePlugins = next.plugins.length === state.plugins.length
    && next.plugins.every((plugin, index) => {
      const previous = state.plugins[index]
      return previous?.id === plugin.id && previous.status === plugin.status
    })
  const sameSimulator = JSON.stringify(next.simulator) === JSON.stringify(state.simulator)
  const sameReset = JSON.stringify(next.resetServer) === JSON.stringify(state.resetServer)
    && JSON.stringify(next.resetApplied) === JSON.stringify(state.resetApplied)
  if (next.status === state.status && next.error === state.error && samePlugins && sameSimulator && sameReset) return
  state = next
  for (const listener of listeners) listener()
}

function refresh(): void {
  if (pendingRuntimeGeneration !== undefined) return
  const runtime = window.__cordisxRuntime
  if (runtime === undefined) return
  if (previewResetBlocked) {
    publish({ status: 'active', plugins: runtime.snapshot().plugins, ...resetStateProjection() })
    return
  }
  const simulator = mergePlaygroundSimulatorTaskSnapshots(
    browserSessionStorage(),
    runtime.playgroundMockAgentLoop?.(),
    runtime.playgroundAgentSessions?.(),
  )
  publish({
    status: 'active',
    plugins: runtime.snapshot().plugins,
    ...(simulator === undefined ? {} : { simulator }),
    ...resetStateProjection(),
  })
}

export async function bootRuntime(): Promise<void> {
  const generation = ++runtimeGeneration
  pendingRuntimeGeneration = generation
  publish({ status: 'starting', plugins: [], ...resetStateProjection() })
  installHostBridges()
  try {
    if (!await synchronizePlaygroundPreviewResetEpoch()) return
    if (!previewResetBlocked) {
      const cached = readPlaygroundSimulatorTaskSnapshots(browserSessionStorage())
      if (cached !== undefined) {
        publish({ status: 'starting', plugins: [], simulator: cached, ...resetStateProjection() })
      }
    }
    await import('virtual:cordisx-composition')
    if (pendingRuntimeGeneration !== generation) return
    pendingRuntimeGeneration = undefined
    refresh()
  } catch (error) {
    if (pendingRuntimeGeneration !== generation) return
    pendingRuntimeGeneration = undefined
    publish({
      status: 'failed',
      plugins: [],
      error: error instanceof Error ? error.message : String(error),
      ...resetStateProjection(),
    })
  }
}

export function beginPlaygroundPreviewRuntimeReset(): void {
  previewResetBlocked = true
  runtimeGeneration += 1
  pendingRuntimeGeneration = undefined
  publish({ status: 'active', plugins: state.plugins, ...resetStateProjection() })
}

export function completePlaygroundPreviewRuntimeReset(): void {
  previewResetBlocked = false
  refresh()
}

export function cancelPlaygroundPreviewRuntimeReset(): void {
  previewResetBlocked = false
  refresh()
}

function resetStateProjection(): Pick<RuntimeState, 'resetServer' | 'resetApplied'> {
  const applied = readPlaygroundPreviewResetApplied(browserSessionStorage())
  return {
    ...(state.resetServer === undefined ? {} : { resetServer: state.resetServer }),
    ...(applied === undefined ? {} : { resetApplied: applied }),
  }
}

function publishResetEpoch(server: PlaygroundPreviewResetEpoch): void {
  const applied = readPlaygroundPreviewResetApplied(browserSessionStorage())
  publish({
    status: state.status,
    plugins: state.plugins,
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.simulator === undefined ? {} : { simulator: state.simulator }),
    resetServer: server,
    ...(applied === undefined ? {} : { resetApplied: applied }),
  })
}

function applyPlaygroundPreviewResetEpoch(server: PlaygroundPreviewResetEpoch, navigate: boolean): boolean {
  const storage = browserSessionStorage()
  if (storage === undefined) return false
  publishResetEpoch(server)
  if (playgroundPreviewResetEpochMatches(readPlaygroundPreviewResetApplied(storage), server)) return false
  previewResetBlocked = true
  runtimeGeneration += 1
  pendingRuntimeGeneration = undefined
  publish({ status: 'active', plugins: state.plugins, resetServer: server })
  window.dispatchEvent(new CustomEvent(PLAYGROUND_PREVIEW_RESET_APPLY_EVENT, { detail: server }))
  resetPlaygroundLiveSimulator()
  clearPlaygroundDisposableSessionData(storage)
  storage.removeItem(PLAYGROUND_PREVIEW_RESET_RESULT_KEY)
  writePlaygroundPreviewResetApplied(storage, server)
  writePlaygroundPreviewResetMarker(storage, {
    version: 1,
    nonce: `${server.instanceId}:${server.generation}`,
    phase: 'awaiting-readback',
    startedAt: new Date().toISOString(),
  })
  publish({ status: 'active', plugins: state.plugins, resetServer: server, resetApplied: server })
  if (navigate) window.location.replace('/')
  return true
}

async function readServerResetEpoch(): Promise<PlaygroundPreviewResetEpoch> {
  const response = await fetch('/api/reset-state', { cache: 'no-store' })
  if (!response.ok) throw new Error(`Preview reset epoch read failed with HTTP ${response.status}`)
  const value: unknown = await response.json()
  if (!isPlaygroundPreviewResetEpoch(value)) throw new Error('Preview reset epoch response is invalid')
  return value
}

async function synchronizePlaygroundPreviewResetEpoch(): Promise<boolean> {
  const server = await readServerResetEpoch()
  if (reconcilePlaygroundPreviewBootstrapEpoch(browserSessionStorage(), server) === 'bootstrap') {
    previewResetBlocked = false
    publishResetEpoch(server)
    return true
  }
  publishResetEpoch(server)
  return !applyPlaygroundPreviewResetEpoch(server, true)
}

export async function requestPlaygroundPreviewInstanceReset(requestId: string): Promise<PlaygroundPreviewResetEpoch> {
  if (requestId === '') throw new Error('Preview reset requires an explicit in-document request authority')
  beginPlaygroundPreviewRuntimeReset()
  window.dispatchEvent(new CustomEvent(PLAYGROUND_PREVIEW_RESET_APPLY_EVENT))
  resetPlaygroundLiveSimulator()
  const storage = browserSessionStorage()
  if (storage !== undefined) clearPlaygroundDisposableSessionData(storage)
  const response = await fetch(`/api/reset?client=playground-reset-v1&request=${encodeURIComponent(requestId)}`, {
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Preview reset failed with HTTP ${response.status}`)
  const value = await response.json() as { readonly reset?: unknown }
  if (!isPlaygroundPreviewResetEpoch(value.reset)) {
    throw new Error('Preview reset response did not include a valid epoch')
  }
  applyPlaygroundPreviewResetEpoch(value.reset, true)
  return value.reset
}

export function playgroundPreviewResetEpochReadback(): Readonly<{
  server?: PlaygroundPreviewResetEpoch
  applied?: PlaygroundPreviewResetEpoch
  synchronized: boolean
}> {
  const applied = readPlaygroundPreviewResetApplied(browserSessionStorage())
  return Object.freeze({
    ...(state.resetServer === undefined ? {} : { server: state.resetServer }),
    ...(applied === undefined ? {} : { applied }),
    synchronized: playgroundPreviewResetEpochMatches(applied, state.resetServer),
  })
}

import.meta.hot?.on(PLAYGROUND_PREVIEW_RESET_BROADCAST_EVENT, value => {
  if (isPlaygroundPreviewResetEpoch(value)) applyPlaygroundPreviewResetEpoch(value, true)
})

export function resetPlaygroundLiveSimulator(): Readonly<{ before: number; after: number }> {
  const reset = window.__cordisxRuntime?.resetPlaygroundMockAgentLoop
  if (reset === undefined) {
    const count = window.__cordisxRuntime?.playgroundMockAgentLoop?.().tasks.length ?? 0
    if (count !== 0) throw new Error('Playground live Simulator reset is unavailable')
    return Object.freeze({ before: count, after: count })
  }
  const result = reset()
  if (result.after !== 0) throw new Error(`Playground live Simulator reset left ${result.after} task(s)`)
  return result
}

export function playgroundSimulatorSourceBreakdown(): PlaygroundSimulatorSourceBreakdown {
  const cached = readPlaygroundSimulatorTaskSnapshots(browserSessionStorage())?.tasks ?? []
  const live = window.__cordisxRuntime?.playgroundMockAgentLoop?.().tasks ?? []
  const agentSessions = window.__cordisxRuntime?.playgroundAgentSessions?.()?.tasks ?? []
  const memory = state.simulator?.tasks ?? []
  return Object.freeze({
    liveRuntime: live.length,
    agentSessionAuthority: agentSessions.length,
    runtimeMemory: memory.length,
    taskSnapshotRegistry: cached.length,
    hostSessionRegistry: cached.filter(task => task.origin === 'host-session').length,
    legacyAliasRegistry: cached.filter(task => task.taskRef.startsWith('legacy-title:')).length,
    finalSelector: memory.length,
  })
}

export function playgroundSimulatorTaskSources(taskRef: string): readonly PlaygroundSimulatorTaskSource[] {
  const cached = readPlaygroundSimulatorTaskSnapshots(browserSessionStorage())?.tasks ?? []
  const live = window.__cordisxRuntime?.playgroundMockAgentLoop?.().tasks ?? []
  const agentSessions = window.__cordisxRuntime?.playgroundAgentSessions?.()?.tasks ?? []
  const memory = state.simulator?.tasks ?? []
  const sources: PlaygroundSimulatorTaskSource[] = []
  if (live.some(task => task.taskRef === taskRef)) sources.push('live-runtime')
  if (agentSessions.some(task => task.taskRef === taskRef)) sources.push('agent-session-authority')
  if (memory.some(task => task.taskRef === taskRef)) sources.push('runtime-memory')
  const cachedTask = cached.find(task => task.taskRef === taskRef)
  if (cachedTask !== undefined) sources.push('task-snapshot-registry')
  if (cachedTask?.origin === 'host-session') sources.push('host-session-registry')
  if (cachedTask?.taskRef.startsWith('legacy-title:') === true) sources.push('legacy-alias-registry')
  return Object.freeze(sources)
}

export function registerPlaygroundHostSessionTask(input: PlaygroundHostSessionTaskContext) {
  if (previewResetBlocked) return input.detailsUrl
  const storage = browserSessionStorage()
  const task = projectPlaygroundHostSessionTask(storage, input)
  const simulator = mergePlaygroundSimulatorTaskSnapshots(storage, {
    namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
    label: 'Mock / Simulator',
    tasks: [task],
  })
  if (simulator !== undefined) publish({ ...state, simulator })
  return task.detailsUrl
}

export function useRuntimeState(): RuntimeState {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      if (timer === undefined) timer = setInterval(refresh, 400)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer)
          timer = undefined
        }
      }
    },
    () => state,
  )
}

function installBridge(
  path: string,
  receive: (payload: string) => void,
): (payload: string) => void {
  return payload => {
    void fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }).then(response => response.text()).then(receive).catch(error => {
      const requestId = (JSON.parse(payload) as { requestId?: unknown }).requestId
      receive(JSON.stringify({ requestId, ok: false, error: String(error) }))
    })
  }
}

function installHostBridges(): void {
  window.__cordisxConfigRequestV1 = installBridge('/api/config', value => window.__cordisxConfigReceiveV1?.(value))
  window.__cordisxPlaygroundAgentSessionRequestV1 = installBridge(
    '/api/agent-sessions',
    value => window.__cordisxPlaygroundAgentSessionReceiveV1?.(value),
  )
  window.__cordisxOwnerDocumentRequestV1 = installBridge(
    '/api/documents',
    value => window.__cordisxOwnerDocumentReceiveV1?.(value),
  )
  window.__cordisxServiceConfigRequestV1 = installBridge(
    '/api/service-config',
    value => window.__cordisxServiceConfigReceiveV1?.(value),
  )
  window.__cordisxChannelCredentialRequestV1 = installBridge(
    '/api/channel-credential',
    value => window.__cordisxChannelCredentialReceiveV1?.(value),
  )
  window.__cordisxProviderRequestV1 = installBridge(
    '/api/provider',
    value => window.__cordisxProviderReceiveV1?.(value),
  )
}
