import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  type PlaygroundMockAgentLoopSnapshot,
  type PlaygroundMockTaskDetailsUrl,
  type PlaygroundMockTaskTrace,
} from '../../renderer/playground-mock-agent-loop.js'
import {
  type AgentDefinition,
  type AgentDefinitionIdentity,
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
} from '../../agent-loop-contracts.js'
import {
  CORDISX_HOST_TASK_DETAILS_NAVIGATION_EVENT,
  HostAgentTaskDetailsNavigator,
  navigateHostTaskDetailsSameDocument,
  validateAgentLoopTaskDetailsUrl,
} from '../../renderer/host-ui/AgentTaskDetailsNavigator.js'
import {
  isPlaygroundRoomSimulationBinding,
  type PlaygroundRoomSimulationBinding,
} from '../../renderer/playground-room-simulation-bridge.js'
import { clearPlaygroundDisposableSessionData, countPlaygroundDisposableSessionRecords } from './preview-reset.js'

export const PLAYGROUND_SIMULATOR_SESSION_PREFIX = 'cordisx.playground.simulator/v1:'
export const PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY = `${PLAYGROUND_SIMULATOR_SESSION_PREFIX}task-snapshots/v2`

interface PlaygroundSimulatorTaskSnapshotRegistry {
  readonly version: 2
  readonly tasks: readonly PlaygroundMockTaskTrace[]
}

export interface PlaygroundHostSessionTaskContext {
  readonly detailsUrl: PlaygroundMockTaskDetailsUrl
  readonly participantId: string
  readonly memberId: string
  readonly runId: string
  readonly lifecycle: 'active' | 'running' | 'waiting' | 'attention'
  readonly roomLabel: string
  readonly taskLabel: string
  readonly identity: AgentDefinitionIdentity
  readonly agentName: string
  readonly introduction: string
  readonly simulationBinding?: PlaygroundRoomSimulationBinding
}

function stableTaskDetailsUrl(taskRef: string): PlaygroundMockTaskDetailsUrl {
  return {
    url: `app://-/playground/simulator/tasks/${encodeURIComponent(taskRef)}`,
    target: 'host',
  }
}

function normalizeTaskSnapshot(value: unknown): PlaygroundMockTaskTrace | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const task = value as Partial<PlaygroundMockTaskTrace>
  if (
    typeof task.debugTaskId !== 'string' || task.debugTaskId === ''
    || typeof task.agentLabel !== 'string' || task.agentLabel === ''
    || !Array.isArray(task.catalog) || !Array.isArray(task.layers) || !Array.isArray(task.events)
    || task.identity === undefined || task.effective === undefined
  ) return undefined
  const taskRef = typeof task.taskRef === 'string' && task.taskRef !== ''
    ? task.taskRef
    : `legacy-title:${task.debugTaskId}`
  const { simulationBinding, ...rest } = task
  return {
    ...rest,
    taskRef,
    detailsUrl: stableTaskDetailsUrl(taskRef),
    ...(isPlaygroundRoomSimulationBinding(simulationBinding) ? { simulationBinding: { ...simulationBinding } } : {}),
  } as PlaygroundMockTaskTrace
}

export function projectPlaygroundHostSessionTask(
  storage: Storage | undefined,
  input: PlaygroundHostSessionTaskContext,
): PlaygroundMockTaskTrace {
  const target = taskNavigationTarget(input.detailsUrl)
  const routeRef = target?.kind === 'host' && target.historyUrl !== undefined
    ? simulatorTaskIdFromPath(target.historyUrl)
    : undefined
  const cached = readPlaygroundSimulatorTaskSnapshots(storage)?.tasks.find(task =>
    task.taskRef === routeRef || task.debugTaskId === routeRef
  )
  if (cached !== undefined) {
    return input.simulationBinding === undefined
      ? cached
      : { ...cached, simulationBinding: { ...input.simulationBinding } }
  }

  const taskRef = `host-session:${input.runId}`
  const detailsUrl = stableTaskDetailsUrl(taskRef)
  const inherit: AgentDefinition['inherit'] = {
    promptSections: 'append',
    rules: 'append',
    skills: 'append',
    tools: 'merge',
    mcpServers: 'merge',
    runtimeDefaults: 'merge',
  }
  const definition: AgentDefinition = {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: input.identity,
    name: input.agentName,
    inherit,
    promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: input.introduction }],
    rules: [],
    skills: [],
    tools: {},
    mcpServers: {},
    runtimeDefaults: { adapterId: 'host-session' },
  }
  const layer = {
    identity: definition.identity,
    promptSections: definition.promptSections,
    rules: definition.rules,
    skills: definition.skills,
    tools: definition.tools,
    mcpServers: definition.mcpServers,
    runtimeDefaults: definition.runtimeDefaults,
  }
  return {
    taskRef,
    origin: 'host-session',
    debugTaskId: input.taskLabel,
    detailsUrl,
    agentLabel: input.agentName,
    active: true,
    status: input.lifecycle === 'attention' ? 'approval' : 'working',
    ...(input.simulationBinding === undefined ? {} : { simulationBinding: { ...input.simulationBinding } }),
    identity: input.identity,
    catalog: [definition],
    layers: [layer],
    effective: {
      promptSections: definition.promptSections,
      rules: definition.rules,
      skills: definition.skills,
      tools: definition.tools,
      mcpServers: definition.mcpServers,
      runtimeDefaults: definition.runtimeDefaults,
    },
    events: [{
      sequence: 0,
      type: 'task.bound',
      detail: `Host active session ${input.runId} is bound to room ${input.roomLabel}.`,
      participantId: input.participantId,
      memberId: input.memberId,
      runId: input.runId,
    }],
  }
}

export function readPlaygroundSimulatorTaskSnapshots(
  storage: Storage | undefined,
): PlaygroundMockAgentLoopSnapshot | undefined {
  try {
    if (storage === undefined) return undefined
    const raw = storage.getItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY)
    if (raw === null) return undefined
    const value = JSON.parse(raw) as Partial<PlaygroundSimulatorTaskSnapshotRegistry>
    if (value.version !== 2 || !Array.isArray(value.tasks)) return undefined
    const tasks = value.tasks.map(normalizeTaskSnapshot).filter((task): task is PlaygroundMockTaskTrace =>
      task !== undefined
    )
    if (tasks.length === 0) return undefined
    return { namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, label: 'Mock / Simulator', tasks }
  } catch {
    return undefined
  }
}

export function mergePlaygroundSimulatorTaskSnapshots(
  storage: Storage | undefined,
  live: PlaygroundMockAgentLoopSnapshot | undefined,
  agentSessions?: PlaygroundMockAgentLoopSnapshot,
): PlaygroundMockAgentLoopSnapshot | undefined {
  const cached = readPlaygroundSimulatorTaskSnapshots(storage)
  const tasks = new Map<string, PlaygroundMockTaskTrace>()
  // Agent/Session rows are never recovered from this browser cache. Their only
  // durable source is the Host SessionEvent authority.
  for (const task of cached?.tasks ?? []) if (task.origin !== 'agent-session') tasks.set(task.taskRef, task)
  for (const value of live?.tasks ?? []) {
    const task = normalizeTaskSnapshot(value)
    if (task !== undefined) {
      const cachedTask = tasks.get(task.taskRef)
      tasks.set(
        task.taskRef,
        task.simulationBinding !== undefined || cachedTask?.simulationBinding === undefined
          ? task
          : { ...task, simulationBinding: cachedTask.simulationBinding },
      )
    }
  }
  const cachedSnapshot = {
    namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
    label: 'Mock / Simulator' as const,
    tasks: [...tasks.values()],
  }
  try {
    if (storage !== undefined) {
      const registry: PlaygroundSimulatorTaskSnapshotRegistry = { version: 2, tasks: cachedSnapshot.tasks }
      storage.setItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY, JSON.stringify(registry))
    }
  } catch {
    // The current live snapshot remains usable if browser session storage is unavailable.
  }
  for (const value of agentSessions?.tasks ?? []) {
    const task = normalizeTaskSnapshot(value)
    if (task !== undefined && task.origin === 'agent-session') tasks.set(task.taskRef, task)
  }
  if (tasks.size === 0) return undefined
  const snapshot = {
    namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
    label: 'Mock / Simulator' as const,
    tasks: [...tasks.values()],
  }
  return snapshot
}

export interface PlaygroundTaskNavigationTarget {
  readonly kind: 'host' | 'external'
  readonly url: URL
  readonly historyUrl?: string
}

export function taskNavigationTarget(
  detailsUrl: PlaygroundMockTaskDetailsUrl,
): PlaygroundTaskNavigationTarget | undefined {
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
  clearPlaygroundDisposableSessionData(storage)
}

/** Content-free readback used by the Playground reset surface and manual preview checks. */
export function countPlaygroundSimulatorSessionRecords(storage: Storage): number {
  const disposableContainers = countPlaygroundDisposableSessionRecords(storage)
  const rawRegistry = storage.getItem(PLAYGROUND_SIMULATOR_TASK_SNAPSHOT_KEY)
  if (rawRegistry === null) return disposableContainers
  try {
    const registry = JSON.parse(rawRegistry) as Partial<PlaygroundSimulatorTaskSnapshotRegistry>
    if (registry.version !== 2 || !Array.isArray(registry.tasks)) return disposableContainers
    return disposableContainers - 1 + registry.tasks.length
  } catch {
    return disposableContainers
  }
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
