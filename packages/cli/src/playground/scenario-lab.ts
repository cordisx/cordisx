import type {
  AgentDefinition,
  AgentLoopCommandV4,
  AgentLoopTaskBindingV4,
  BoundAgentLoopClientV4,
} from '../agent-loop-contracts.js'
import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v3'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
} from '../agent-loop-contracts.js'
import { CordisXAgentLoopBrokerV4 } from '../renderer/agent-loop-v4.js'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  PlaygroundMockAgentLoopHost,
  PlaygroundMockAgentLoopV4Transport,
  type PlaygroundMockTaskTrace,
} from '../renderer/playground-mock-agent-loop.js'
import {
  createAgentConversationModel,
  type AgentConversationApproval,
  type AgentConversationEntry,
  type AgentConversationMessage,
  type AgentConversationModel,
} from '../renderer/host-ui/conversation/model.js'
import type {
  PlaygroundRoomSimulationBinding,
  PlaygroundRoomSimulationDelegationTarget,
  PlaygroundRoomSimulationEvent,
  PlaygroundRoomSimulationForwardingClient,
  PlaygroundRoomSimulationOperationReceipt,
  PlaygroundRoomSimulationResult,
  PlaygroundRoomSimulationSnapshot,
} from '../renderer/playground-room-simulation-bridge.js'

export type PlaygroundScenarioId =
  | 'continuous-sends'
  | 'human-interruption'
  | 'approval-decision'
  | 'multi-binding'
  | 'failure-retry'
  | 'plain-text-stress'

export interface PlaygroundScenarioCatalogEntry {
  readonly id: PlaygroundScenarioId
  readonly title: { readonly 'zh-CN': string; readonly en: string }
  readonly description: { readonly 'zh-CN': string; readonly en: string }
  readonly availability: { readonly state: 'available' }
}

export const PLAYGROUND_SCENARIO_CATALOG: readonly PlaygroundScenarioCatalogEntry[] = Object.freeze([
  {
    id: 'continuous-sends',
    title: { 'zh-CN': '连续发送', en: 'Continuous sends' },
    description: { 'zh-CN': '同一 binding 短时间提交四条独立消息，并保持操作与响应顺序。', en: 'Submit four independent messages to one binding while preserving operation and response order.' },
    availability: { state: 'available' },
  },
  {
    id: 'human-interruption',
    title: { 'zh-CN': '人类消息打断', en: 'Human interruption' },
    description: { 'zh-CN': '在人类消息前后显示同一 Agent 回复，证明分组边界会被人类消息打断。', en: 'Place replies from the same Agent around human input to prove that human messages break grouping.' },
    availability: { state: 'available' },
  },
  {
    id: 'approval-decision',
    title: { 'zh-CN': '权限申请', en: 'Approval request' },
    description: { 'zh-CN': '通过正式 AgentLoop v4 命令分别完成允许、拒绝与取消决策。', en: 'Exercise approve, deny, and cancel through formal AgentLoop v4 commands.' },
    availability: { state: 'available' },
  },
  {
    id: 'multi-binding',
    title: { 'zh-CN': '多 Agent 并发', en: 'Concurrent agents' },
    description: { 'zh-CN': '为三个通用 Agent 创建独立 binding，并并发提交互不串流的输入。', en: 'Create independent bindings for three generic agents and submit isolated inputs concurrently.' },
    availability: { state: 'available' },
  },
  {
    id: 'failure-retry',
    title: { 'zh-CN': '失败与重试', en: 'Failure and retry' },
    description: { 'zh-CN': '先触发 typed CLI failure，再以新的逻辑操作重试并恢复。', en: 'Trigger a typed CLI failure, then retry as a new logical operation and recover.' },
    availability: { state: 'available' },
  },
  {
    id: 'plain-text-stress',
    title: { 'zh-CN': '富文本压力', en: 'Rich text stress' },
    description: { 'zh-CN': '提交长文本、多行、代码和链接，验证纯文本 AgentLoop 内容边界。', en: 'Submit long text, multiple lines, code, and links through the text-only AgentLoop boundary.' },
    availability: { state: 'available' },
  },
])

export interface PlaygroundScenarioActivity {
  readonly sequence: number
  readonly kind: 'operation' | 'result'
  readonly message: string
}

export interface PlaygroundScenarioLabSnapshot {
  readonly owner: 'host-playground-scenario-lab'
  readonly sourceTask: PlaygroundScenarioTaskContext
  readonly disposableGeneration: string
  readonly selectedScenarioId: PlaygroundScenarioId
  readonly phase: 'idle' | 'running' | 'paused' | 'completed' | 'failed'
  readonly cursor: number
  readonly stepCount: number
  readonly activities: readonly PlaygroundScenarioActivity[]
  readonly trace: readonly PlaygroundTaskTraceEntry[]
  readonly injector: PlaygroundEventInjectorSnapshot
  readonly tasks: readonly PlaygroundMockTaskTrace[]
  readonly conversation: AgentConversationModel
  readonly error?: string
}

export type PlaygroundScenarioTaskContext = Readonly<Pick<PlaygroundMockTaskTrace,
  'taskRef' | 'debugTaskId' | 'detailsUrl' | 'agentLabel' | 'status' | 'identity' | 'catalog' | 'input' | 'execution' | 'events' | 'simulationBinding'
>>

export type PlaygroundTaskTraceDirection =
  | 'chatroom-to-agent-host'
  | 'agent-host-to-chatroom'
  | 'injector-to-agent-host'
  | 'simulator-to-chatroom'
  | 'host-lifecycle'

export interface PlaygroundTaskTraceEntry {
  readonly id: string
  readonly source: 'original' | 'simulated'
  readonly generation: 'original' | string
  readonly direction: PlaygroundTaskTraceDirection
  readonly type: string
  readonly summary: string
  readonly timestamp?: string
  readonly payload: unknown
  readonly correlations: {
    readonly operationId?: string
    readonly turn?: string
    readonly messageId?: string
    readonly participantId?: string
    readonly memberId?: string
    readonly runId?: string
  }
}

export interface PlaygroundEventInjectorSnapshot {
  readonly phase: 'idle' | 'injecting' | 'failed'
  readonly eventCount: number
  readonly roomBridge: {
    readonly state: 'checking' | 'available' | 'unavailable'
    readonly delegationTargets: readonly PlaygroundRoomSimulationDelegationTarget[]
    readonly message?: string
  }
  readonly pendingApproval?: {
    readonly turn: string
    readonly approvalId: string
  }
}

interface ScenarioContext {
  readonly client: BoundAgentLoopClientV4
  readonly bindings: Map<string, AgentLoopTaskBindingV4>
  append(kind: PlaygroundScenarioActivity['kind'], message: string): void
  create(alias: string, definition: AgentDefinition): Promise<void>
  send(alias: string, ordinal: number, text: string): Promise<void>
  decide(alias: string, ordinal: number, decision: 'approved' | 'denied' | 'cancelled'): Promise<void>
}

export interface PlaygroundScenarioLabRuntime {
  readonly host: PlaygroundMockAgentLoopHost
  readonly broker: CordisXAgentLoopBrokerV4
  readonly client: BoundAgentLoopClientV4
}

export type PlaygroundScenarioLabRuntimeFactory = () => PlaygroundScenarioLabRuntime

interface ScenarioStep {
  readonly id: string
  execute(context: ScenarioContext): Promise<void>
}

const inherit: AgentDefinition['inherit'] = Object.freeze({
  promptSections: 'append', rules: 'append', skills: 'append', tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge',
})

const aliases = ['a', 'b', 'c'] as const
const labelFor = (alias: string): string => `Agent ${alias.toUpperCase()}`

function stableLocalTaskScope(taskRef: string): string {
  let hash = 2166136261
  for (const character of taskRef) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  const slug = taskRef.toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return `${slug === '' ? 'task' : slug}-${hash.toString(36)}`
}

function traceDirection(type: PlaygroundMockTaskTrace['events'][number]['type'], source: 'original' | 'simulated'): PlaygroundTaskTraceDirection {
  if (type === 'task.created' || type === 'task.bound' || type === 'task.closed' || type === 'execution.started') return 'host-lifecycle'
  if (type === 'approval.required') return source === 'simulated' ? 'simulator-to-chatroom' : 'agent-host-to-chatroom'
  if (type === 'execution.completed' || type === 'execution.failed') return 'agent-host-to-chatroom'
  return source === 'simulated' ? 'injector-to-agent-host' : 'chatroom-to-agent-host'
}

function eventCorrelations(event: PlaygroundMockTaskTrace['events'][number]): PlaygroundTaskTraceEntry['correlations'] {
  return {
    ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    ...(event.participantId === undefined ? {} : { participantId: event.participantId }),
    ...(event.memberId === undefined ? {} : { memberId: event.memberId }),
    ...(event.runId === undefined ? {} : { runId: event.runId }),
  }
}

function originalTrace(sourceTask: PlaygroundScenarioTaskContext): readonly PlaygroundTaskTraceEntry[] {
  return sourceTask.events.map((event, index) => Object.freeze({
    id: `original-${event.sequence}`,
    source: 'original' as const,
    generation: 'original' as const,
    direction: traceDirection(event.type, 'original'),
    type: event.type,
    summary: event.detail,
    payload: Object.freeze({
      event,
      ...(index === 0 && sourceTask.simulationBinding !== undefined
        ? { roomSimulationBinding: sourceTask.simulationBinding }
        : {}),
      ...(event.type === 'input.accepted' && sourceTask.input !== undefined ? { latestTaskInputSnapshot: sourceTask.input } : {}),
      ...((event.type === 'execution.completed' || event.type === 'execution.failed') && sourceTask.execution !== undefined
        ? { latestTaskExecutionSnapshot: sourceTask.execution }
        : {}),
    }),
    correlations: eventCorrelations(event),
  }))
}

function agent(alias: 'a' | 'b' | 'c'): AgentDefinition {
  const label = labelFor(alias)
  const definition: AgentDefinition = {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: `playground.scenario.${alias}`, revision: 'phase-1' },
    name: label,
    inherit,
    promptSections: [
      { sectionId: 'introduction', kind: 'introduction', text: `${label} is a deterministic interaction-scenario participant.` },
      { sectionId: 'role', kind: 'role', text: `Process only inputs addressed to ${label}.` },
    ],
    rules: ['Keep every binding isolated.', 'Return deterministic plain text.'],
    skills: ['debug:scenario/plain-text'],
    tools: { include: ['debug:agent-loop/mock/v1'] },
    mcpServers: { exclude: ['*'] },
    runtimeDefaults: { adapterId: 'playground-simulator', effort: 'low' },
  }
  return Object.freeze(definition)
}

function scenarioCommandId(scope: string, suffix: string): string {
  return `host-scenario:${scope === '' ? '' : `${scope}:`}${suffix}`
}

const SCENARIO_OPERATION_AUTHORITY = Symbol.for('cordisx.playground.scenario-operation-authority/v1')

function scenarioOperationOrdinals(): Map<string, number> {
  const owner = globalThis as typeof globalThis & Record<symbol, unknown>
  const existing = owner[SCENARIO_OPERATION_AUTHORITY]
  if (existing instanceof Map) return existing as Map<string, number>
  const created = new Map<string, number>()
  Object.defineProperty(owner, SCENARIO_OPERATION_AUTHORITY, {
    configurable: false,
    enumerable: false,
    value: created,
    writable: false,
  })
  return created
}

function nextScenarioOperationOrdinal(scope: string): number {
  const ordinals = scenarioOperationOrdinals()
  const next = (ordinals.get(scope) ?? 0) + 1
  ordinals.set(scope, next)
  return next
}

function observeScenarioRoomOperationId(scope: string, operationId: string | undefined): void {
  if (operationId === undefined) return
  const prefix = scenarioCommandId(scope, 'room:')
  if (!operationId.startsWith(prefix)) return
  const [, , ordinalText] = operationId.slice(prefix.length).split(':')
  const ordinal = Number(ordinalText)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return
  const ordinals = scenarioOperationOrdinals()
  if ((ordinals.get(scope) ?? 0) < ordinal) ordinals.set(scope, ordinal)
}

function createCommand(
  scenarioId: string,
  scope: string,
  alias: string,
  definition: AgentDefinition,
  definitions: readonly AgentDefinition[],
): Extract<AgentLoopCommandV4, { type: 'create-or-bind' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
    contract: 'cordisx.agent-loop-command/v4',
    schemaVersion: 4,
    commandId: scenarioCommandId(scope, `${scenarioId}:create:${alias}`),
    type: 'create-or-bind',
    definition: definition.identity,
    definitions,
    target: { mode: 'create' },
  }
}

function sendCommand(
  scenarioId: string,
  scope: string,
  alias: string,
  ordinal: number,
  binding: AgentLoopTaskBindingV4,
  text: string,
): Extract<AgentLoopCommandV4, { type: 'send' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
    contract: 'cordisx.agent-loop-command/v4',
    schemaVersion: 4,
    commandId: scenarioCommandId(scope, `${scenarioId}:send:${alias}:${ordinal}`),
    type: 'send', binding, content: [{ kind: 'text', text }],
  }
}

function approvalCommand(
  scenarioId: string,
  scope: string,
  alias: string,
  ordinal: number,
  binding: AgentLoopTaskBindingV4,
  decision: 'approved' | 'denied' | 'cancelled',
): Extract<AgentLoopCommandV4, { type: 'approval-decision' }> {
  const turn = `simulated-turn-${ordinal}`
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
    contract: 'cordisx.agent-loop-command/v4', schemaVersion: 4,
    commandId: scenarioCommandId(scope, `${scenarioId}:approval:${alias}:${ordinal}:${decision}`),
    type: 'approval-decision', binding, turn,
    approvalId: `simulated-approval-${turn}`, decision,
  }
}

function stepsFor(id: PlaygroundScenarioId): readonly ScenarioStep[] {
  if (id === 'continuous-sends') return [
    { id: 'create-a', execute: context => context.create('a', agent('a')) },
    {
      id: 'send-four',
      execute: async context => {
        await Promise.all([
          context.send('a', 1, 'First short message.'),
          context.send('a', 2, 'Second short message.'),
          context.send('a', 3, 'Third short message.'),
          context.send('a', 4, 'Fourth short message.'),
        ])
      },
    },
  ]
  if (id === 'human-interruption') return [
    { id: 'create-a', execute: context => context.create('a', agent('a')) },
    {
      id: 'send-around-human', execute: async context => {
        await context.send('a', 1, 'First human message before the interruption boundary.')
        await context.send('a', 2, 'Second human message interrupts the Agent message group.')
      },
    },
  ]
  if (id === 'multi-binding') return [
    {
      id: 'create-three', execute: async context => {
        await Promise.all((['a', 'b', 'c'] as const).map(alias => context.create(alias, agent(alias))))
      },
    },
    {
      id: 'send-three', execute: async context => {
        await Promise.all((['a', 'b', 'c'] as const).map((alias, index) => context.send(alias, index + 1, `Independent input for Agent ${alias.toUpperCase()}.`)))
      },
    },
  ]
  if (id === 'approval-decision') return [
    { id: 'create-a', execute: context => context.create('a', agent('a')) },
    {
      id: 'request-three', execute: async context => {
        for (let ordinal = 1; ordinal <= 3; ordinal += 1) await context.send('a', ordinal, `Request approval ${ordinal}. [approval]`)
      },
    },
    {
      id: 'decide-three', execute: async context => {
        await context.decide('a', 1, 'approved')
        await context.decide('a', 2, 'denied')
        await context.decide('a', 3, 'cancelled')
      },
    },
  ]
  if (id === 'failure-retry') return [
    { id: 'create-a', execute: context => context.create('a', agent('a')) },
    { id: 'fail', execute: context => context.send('a', 1, 'Exercise the typed failure path. [cli-fail]') },
    { id: 'retry', execute: context => context.send('a', 2, 'Retry with a fresh logical operation.') },
  ]
  if (id === 'plain-text-stress') return [
    { id: 'create-a', execute: context => context.create('a', agent('a')) },
    {
      id: 'stress', execute: context => context.send('a', 1, [
        'A deliberately long first paragraph verifies wrapping without changing the structured AgentLoop content boundary. '.repeat(4),
        '',
        '```ts',
        "const link = new URL('https://example.com/scenario')",
        'console.log(link.href)',
        '```',
        '',
        'Reference: https://example.com/scenario?mode=deterministic',
      ].join('\n')),
    },
  ]
  return []
}

type Listener = () => void

export function createPlaygroundScenarioLabRuntime(): PlaygroundScenarioLabRuntime {
  const host = new PlaygroundMockAgentLoopHost()
  const broker = new CordisXAgentLoopBrokerV4(
    new PlaygroundMockAgentLoopV4Transport(host),
    host,
    'playground',
    'scenario-lab',
    () => new Date('2026-08-31T00:00:00.000Z'),
  )
  const client = broker.bind({
    ownerKey: 'host-playground-scenario-lab',
    active: () => true,
    authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
  })
  return Object.freeze({ host, broker, client })
}

function standaloneScenarioTaskContext(): PlaygroundScenarioTaskContext {
  const definition = agent('a')
  return Object.freeze({
    taskRef: 'debug:scenario-lab/standalone',
    debugTaskId: 'Standalone Scenario Task',
    detailsUrl: { url: 'app://-/playground/simulator/tasks/Standalone%20Scenario%20Task', target: 'host' },
    agentLabel: definition.name ?? definition.identity.agentId,
    status: 'created',
    identity: definition.identity,
    catalog: Object.freeze([definition]),
    events: Object.freeze([]),
  })
}

export class PlaygroundScenarioLabController {
  private runtime!: PlaygroundScenarioLabRuntime
  private readonly listeners = new Set<Listener>()
  private selectedScenarioId: PlaygroundScenarioId = 'continuous-sends'
  private phase: PlaygroundScenarioLabSnapshot['phase'] = 'idle'
  private cursor = 0
  private activities: PlaygroundScenarioActivity[] = []
  private bindings = new Map<string, AgentLoopTaskBindingV4>()
  private definitions = new Map<string, AgentDefinition>()
  private detailsUrls = new Map<string, AgentLoopTaskDetailsUrl>()
  private conversationEntries: AgentConversationEntry[] = []
  private conversationSequence = 0
  private generation = 0
  private running: Promise<void> | undefined
  private error: string | undefined
  private injectorPhase: PlaygroundEventInjectorSnapshot['phase'] = 'idle'
  private simulatedTrace: PlaygroundTaskTraceEntry[] = []
  private simulatedEventCursors = new Map<string, number>()
  private pendingApproval: {
    readonly binding: PlaygroundRoomSimulationBinding
    readonly requestOperationId: string
    readonly turn: string
    readonly approvalId: string
  } | undefined
  private latestInjectedSend: {
    readonly binding: AgentLoopTaskBindingV4
    readonly ordinal: number
    readonly turn: string
    readonly messageId: string
  } | undefined
  private readonly sourceTask: PlaygroundScenarioTaskContext
  private readonly delay: () => Promise<void>
  private readonly runtimeFactory: PlaygroundScenarioLabRuntimeFactory
  private roomBridgeState: PlaygroundEventInjectorSnapshot['roomBridge'] = {
    state: 'checking',
    delegationTargets: Object.freeze([]),
  }
  private roomBridgeSubscription: (() => void) | undefined
  private roomBridgeConnection = 0
  private readonly roomBridgeOperationIds = new Set<string>()
  private readonly roomBridgeEventFingerprints = new Set<string>()

  constructor(sourceTask: PlaygroundScenarioTaskContext)
  constructor(delay?: () => Promise<void>, runtimeFactory?: PlaygroundScenarioLabRuntimeFactory)
  constructor(
    sourceTaskOrDelay: PlaygroundScenarioTaskContext | (() => Promise<void>) = () => new Promise(resolve => setTimeout(resolve, 160)),
    runtimeFactory: PlaygroundScenarioLabRuntimeFactory = createPlaygroundScenarioLabRuntime,
  ) {
    this.sourceTask = typeof sourceTaskOrDelay === 'function' ? standaloneScenarioTaskContext() : sourceTaskOrDelay
    this.delay = typeof sourceTaskOrDelay === 'function'
      ? sourceTaskOrDelay
      : () => new Promise(resolve => setTimeout(resolve, 160))
    this.runtimeFactory = runtimeFactory
    this.replaceRuntime()
    this.connectRoomBridge()
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): PlaygroundScenarioLabSnapshot => {
    return Object.freeze({
      owner: 'host-playground-scenario-lab',
      sourceTask: this.sourceTask,
      disposableGeneration: this.disposableGeneration(),
      selectedScenarioId: this.selectedScenarioId,
      phase: this.phase,
      cursor: this.cursor,
      stepCount: stepsFor(this.selectedScenarioId).length,
      activities: Object.freeze([...this.activities]),
      trace: Object.freeze([...originalTrace(this.sourceTask), ...this.simulatedTrace]),
      injector: Object.freeze({
        phase: this.injectorPhase,
        eventCount: this.simulatedTrace.length,
        roomBridge: Object.freeze({ ...this.roomBridgeState }),
        ...(this.pendingApproval === undefined ? {} : {
          pendingApproval: Object.freeze({ turn: this.pendingApproval.turn, approvalId: this.pendingApproval.approvalId }),
        }),
      }),
      tasks: this.runtime.host.snapshot().tasks,
      conversation: this.conversation(),
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  select(id: PlaygroundScenarioId): void {
    if (this.selectedScenarioId === id) return
    this.selectedScenarioId = id
    this.reset()
  }

  next(): Promise<void> {
    if (this.phase === 'running') return this.running ?? Promise.resolve()
    return this.executeNext('paused')
  }

  run(): Promise<void> {
    if (this.running !== undefined) return this.running
    const generation = this.generation
    this.phase = 'running'
    this.publish()
    this.running = (async () => {
      while (generation === this.generation && this.phase === 'running' && this.cursor < stepsFor(this.selectedScenarioId).length) {
        await this.executeNext('running')
        if (generation === this.generation && this.phase === 'running' && this.cursor < stepsFor(this.selectedScenarioId).length) await this.delay()
      }
    })().finally(() => {
      if (generation !== this.generation) return
      this.running = undefined
      if (this.cursor >= stepsFor(this.selectedScenarioId).length && this.phase !== 'failed') this.phase = 'completed'
      this.publish()
    })
    return this.running
  }

  pause(): void {
    if (this.phase !== 'running') return
    this.phase = 'paused'
    this.publish()
  }

  injectAgentReply(text: string): Promise<void> {
    return this.emitRoomAgentReply(text)
  }

  injectAgentApprovalRequest(reason: string): Promise<void> {
    return this.emitRoomAgentApprovalRequest(reason)
  }

  injectTaskDelegation(memberId: string, task: string): Promise<void> {
    return this.emitRoomTaskDelegation(memberId, task)
  }

  injectFailure(message: string): Promise<void> {
    return this.injectIsolatedFailure(`${message}\n[cli-fail]`)
  }

  injectMemberSelfIntroduction(input: {
    readonly participantId: string
    readonly memberId: string
    readonly runId: string
  }): Promise<void> {
    return this.injectIntroductionEvent(input)
  }

  resolvePendingApproval(decision: 'approved' | 'denied' | 'cancelled'): Promise<void> {
    return this.resolveInjectorApproval(decision)
  }

  reset(): void {
    this.generation += 1
    this.disconnectRoomBridge()
    this.runtime.client.dispose()
    this.runtime.broker.dispose()
    this.cursor = 0
    this.activities = []
    this.bindings = new Map()
    this.definitions = new Map()
    this.detailsUrls = new Map()
    this.conversationEntries = []
    this.conversationSequence = 0
    this.injectorPhase = 'idle'
    this.simulatedTrace = []
    this.simulatedEventCursors = new Map()
    this.roomBridgeOperationIds.clear()
    this.roomBridgeEventFingerprints.clear()
    this.pendingApproval = undefined
    this.latestInjectedSend = undefined
    this.error = undefined
    this.phase = 'idle'
    this.running = undefined
    this.replaceRuntime()
    this.connectRoomBridge()
    this.publish()
  }

  dispose(): void {
    this.generation += 1
    this.disconnectRoomBridge()
    this.runtime.client.dispose()
    this.runtime.broker.dispose()
    this.listeners.clear()
  }

  private replaceRuntime(): void {
    this.runtime = this.runtimeFactory()
  }

  private disposableGeneration(): string {
    return `${this.sourceTask.debugTaskId}:debug:${this.generation + 1}`
  }

  private appendSimulatedTrace(input: Omit<PlaygroundTaskTraceEntry, 'id' | 'source' | 'generation'>): void {
    this.simulatedTrace = [...this.simulatedTrace, Object.freeze({
      ...input,
      id: `simulated-${this.generation + 1}-${this.simulatedTrace.length + 1}`,
      source: 'simulated' as const,
      generation: this.disposableGeneration(),
    })]
    this.publish()
  }

  private captureRuntimeTrace(taskRef: string, timestamp: string): void {
    const task = this.runtime.host.snapshot().tasks.find(candidate => candidate.taskRef === taskRef)
    if (task === undefined) return
    const cursor = this.simulatedEventCursors.get(taskRef) ?? 0
    for (const event of task.events.slice(cursor)) {
      this.appendSimulatedTrace({
        direction: traceDirection(event.type, 'simulated'),
        type: event.type,
        summary: event.detail,
        timestamp,
        payload: Object.freeze({
          event,
          ...(event.type === 'input.accepted' && task.input !== undefined ? { input: task.input } : {}),
          ...((event.type === 'execution.completed' || event.type === 'execution.failed') && task.execution !== undefined
            ? { execution: task.execution }
            : {}),
        }),
        correlations: eventCorrelations(event),
      })
    }
    this.simulatedEventCursors.set(taskRef, task.events.length)
  }

  private async ensureInjectorBinding(): Promise<AgentLoopTaskBindingV4> {
    const existing = this.bindings.get('a')
    if (existing !== undefined) return existing
    await this.create(this.generation, this.runtime, this.bindings, 'a', agent('a'), 'event-injector')
    const binding = this.bindings.get('a')
    if (binding === undefined) throw new Error('The disposable AgentLoop binding was not created')
    this.captureRuntimeTrace(binding.task, new Date().toISOString())
    return binding
  }

  private async performInjection(
    type: string,
    payload: unknown,
    operation: () => Promise<void>,
    request?: {
      readonly direction: PlaygroundTaskTraceDirection
      readonly summary: string
      readonly correlations?: PlaygroundTaskTraceEntry['correlations']
    },
  ): Promise<void> {
    if (this.injectorPhase === 'injecting') return
    this.injectorPhase = 'injecting'
    this.error = undefined
    this.appendSimulatedTrace({
      direction: request?.direction ?? 'injector-to-agent-host',
      type: `${type}.request`,
      summary: request?.summary ?? `Inject ${type} into the disposable task generation.`,
      timestamp: new Date().toISOString(),
      payload,
      correlations: request?.correlations ?? {},
    })
    try {
      await operation()
      this.injectorPhase = 'idle'
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.error = message
      this.injectorPhase = 'failed'
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: `${type}.failed`,
        summary: message,
        timestamp: new Date().toISOString(),
        payload: { error: message },
        correlations: {},
      })
    }
    this.publish()
  }

  private async injectIsolatedFailure(text: string): Promise<void> {
    const normalized = text.trim()
    if (normalized === '') return
    const visibleText = normalized.replace(/\n?\[(?:approval|cli-fail)\]\s*$/iu, '').trim()
    await this.performInjection('typed-failure', { kind: 'typed-failure', text: visibleText }, async () => {
      const binding = await this.ensureInjectorBinding()
      const ordinal = this.nextInjectionOrdinal()
      await this.send(this.generation, this.runtime, this.bindings, 'a', ordinal, normalized, 'event-injector')
      this.captureRuntimeTrace(binding.task, new Date().toISOString())
      const sent = this.latestInjectedSend
      if (sent === undefined || sent.ordinal !== ordinal) throw new Error('The disposable send result was not correlated')
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'typed-failure.observed',
        summary: 'The isolated failure probe completed through AgentLoop v4.',
        timestamp: new Date().toISOString(),
        payload: { turn: sent.turn, messageId: sent.messageId, taskRef: binding.task },
        correlations: { turn: sent.turn, messageId: sent.messageId },
      })
    })
  }

  private async emitRoomAgentReply(text: string): Promise<void> {
    const normalized = text.trim()
    const binding = this.sourceTask.simulationBinding
    if (normalized === '' || binding === undefined) {
      if (binding === undefined) this.markRoomBridgeUnavailable('当前 task 没有关联可用的 Chatroom Room binding。')
      return
    }
    const operationId = this.roomBridgeOperationId(`agent-reply:${this.nextInjectionOrdinal()}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('agent-reply', { text: normalized, binding }, async () => {
      const client = await this.requireRoomBridge(binding)
      const result = await client.emitAgentReply(binding, operationId, { text: normalized })
      const receipt = this.requireRoomBridgeReceipt(result, 'Agent reply emission')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') throw new Error(this.receiptFailure('Agent reply emission', receipt))
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'agent-egress.accepted',
        summary: 'Chatroom accepted the bound Agent reply for the associated Room.',
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: {
          operationId,
          ...(receipt.turnId === undefined ? {} : { turn: receipt.turnId }),
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          runId: receipt.runId ?? binding.runId,
          memberId: binding.memberId,
        },
      })
      await this.refreshRoomBridgeSnapshot(client, binding)
    }, {
      direction: 'agent-host-to-chatroom',
      summary: 'Emit a reply from the bound Agent into the associated Playground Room.',
      correlations: { operationId, runId: binding.runId, memberId: binding.memberId },
    })
  }

  private async emitRoomAgentApprovalRequest(reason: string): Promise<void> {
    const normalized = reason.trim()
    const binding = this.sourceTask.simulationBinding
    if (normalized === '' || binding === undefined) {
      if (binding === undefined) this.markRoomBridgeUnavailable('当前 task 没有关联可用的 Chatroom Room binding。')
      return
    }
    const operationId = this.roomBridgeOperationId(`permission:${this.nextInjectionOrdinal()}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('agent-approval-request', { reason: normalized, binding }, async () => {
      const client = await this.requireRoomBridge(binding)
      const result = await client.emitAgentApprovalRequest(binding, operationId, { reason: normalized })
      const receipt = this.requireRoomBridgeReceipt(result, 'Agent approval request')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') throw new Error(this.receiptFailure('Agent approval request', receipt))
      if (receipt.approvalId !== undefined) {
        this.pendingApproval = {
          binding,
          requestOperationId: operationId,
          turn: receipt.turnId ?? receipt.approvalId,
          approvalId: receipt.approvalId,
        }
      }
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'agent-approval.request.accepted',
        summary: 'Chatroom accepted the bound Agent approval request for the associated Room.',
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: {
          operationId,
          ...(receipt.turnId === undefined ? {} : { turn: receipt.turnId }),
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          runId: receipt.runId ?? binding.runId,
          memberId: binding.memberId,
        },
      })
      await this.refreshRoomBridgeSnapshot(client, binding)
    }, {
      direction: 'agent-host-to-chatroom',
      summary: 'Emit an approval request from the bound Agent into the associated Playground Room.',
      correlations: { operationId, runId: binding.runId, memberId: binding.memberId },
    })
  }

  private async emitRoomTaskDelegation(memberId: string, task: string): Promise<void> {
    const normalizedMemberId = memberId.trim()
    const normalizedTask = task.trim()
    const binding = this.sourceTask.simulationBinding
    if (normalizedMemberId === '' || normalizedTask === '' || binding === undefined) {
      if (binding === undefined) this.markRoomBridgeUnavailable('当前 task 没有关联可用的 Chatroom Room binding。')
      return
    }
    const operationId = this.roomBridgeOperationId(`delegation:${this.nextInjectionOrdinal()}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('agent-task-delegation', {
      memberId: normalizedMemberId,
      task: normalizedTask,
      binding,
    }, async () => {
      const client = await this.requireRoomBridge(binding)
      const result = await client.delegateTask(binding, operationId, {
        memberId: normalizedMemberId,
        task: normalizedTask,
      })
      const receipt = this.requireRoomBridgeReceipt(result, 'Agent task delegation')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') {
        throw new Error(this.receiptFailure('Agent task delegation', receipt))
      }
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'agent-task-delegation.accepted',
        summary: 'Chatroom created a new target Agent session and accepted the delegated task.',
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: {
          operationId,
          ...(receipt.turnId === undefined ? {} : { turn: receipt.turnId }),
          ...(receipt.messageId === undefined ? {} : { messageId: receipt.messageId }),
          runId: receipt.runId ?? binding.runId,
          memberId: normalizedMemberId,
        },
      })
      await this.refreshRoomBridgeSnapshot(client, binding)
    }, {
      direction: 'agent-host-to-chatroom',
      summary: 'Delegate a task from the bound Agent to another Room entity in a new session.',
      correlations: { operationId, memberId: normalizedMemberId },
    })
  }

  private roomBridgeOperationId(suffix: string): string {
    return scenarioCommandId(this.commandScope(), `room:${this.generation + 1}:${suffix}`)
  }

  private nextInjectionOrdinal(): number {
    return nextScenarioOperationOrdinal(this.commandScope())
  }

  private roomBridgeClient(): PlaygroundRoomSimulationForwardingClient | undefined {
    if (typeof window === 'undefined') return undefined
    return (window as Window & {
      readonly __cordisxRuntime?: {
        readonly playgroundRoomSimulationBridge?: PlaygroundRoomSimulationForwardingClient
      }
    }).__cordisxRuntime?.playgroundRoomSimulationBridge
  }

  private connectRoomBridge(): void {
    this.disconnectRoomBridge()
    const connection = this.roomBridgeConnection
    const binding = this.sourceTask.simulationBinding
    const client = this.roomBridgeClient()
    if (binding === undefined) {
      this.roomBridgeState = { state: 'unavailable', delegationTargets: Object.freeze([]), message: '当前 task 没有关联可用的 Chatroom Room binding。' }
      return
    }
    if (client === undefined) {
      this.roomBridgeState = { state: 'unavailable', delegationTargets: Object.freeze([]), message: '当前 Playground 未安装 Room simulation bridge。' }
      return
    }
    this.roomBridgeState = { state: 'checking', delegationTargets: Object.freeze([]) }
    this.roomBridgeSubscription = client.subscribe(binding, result => {
      if (connection !== this.roomBridgeConnection) return
      this.consumeRoomBridgeEvent(result)
    })
    void Promise.all([client.inspect(binding), client.snapshot(binding)]).then(([result, snapshot]) => {
      if (connection !== this.roomBridgeConnection) return
      if (result.status === 'unavailable') {
        this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
        return
      }
      if (snapshot.status === 'unavailable') {
        this.markRoomBridgeUnavailable(`${snapshot.code}: ${snapshot.message}`)
        return
      }
      if (result.value.lifecycle !== 'active') {
        this.markRoomBridgeUnavailable(result.value.reason ?? `关联 Room 当前状态为 ${result.value.lifecycle}。`)
        return
      }
      this.observeRoomBridgeSnapshotOperationIds(snapshot.value)
      this.roomBridgeState = {
        state: 'available',
        delegationTargets: Object.freeze([...result.value.delegationTargets]),
      }
      this.publish()
    }).catch(cause => {
      if (connection === this.roomBridgeConnection) this.markRoomBridgeUnavailable(cause instanceof Error ? cause.message : String(cause))
    })
  }

  private disconnectRoomBridge(): void {
    this.roomBridgeConnection += 1
    this.roomBridgeSubscription?.()
    this.roomBridgeSubscription = undefined
  }

  private markRoomBridgeUnavailable(message: string): void {
    this.roomBridgeState = { state: 'unavailable', delegationTargets: Object.freeze([]), message }
    this.publish()
  }

  private async requireRoomBridge(binding: PlaygroundRoomSimulationBinding): Promise<PlaygroundRoomSimulationForwardingClient> {
    const client = this.roomBridgeClient()
    if (client === undefined) throw new Error('The Playground Room simulation bridge is unavailable.')
    const inspection = await client.inspect(binding)
    if (inspection.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${inspection.code}: ${inspection.message}`)
      throw new Error(`${inspection.code}: ${inspection.message}`)
    }
    if (inspection.value.lifecycle !== 'active') {
      const message = inspection.value.reason ?? `The associated Room is ${inspection.value.lifecycle}.`
      this.markRoomBridgeUnavailable(message)
      throw new Error(message)
    }
    this.roomBridgeState = {
      state: 'available',
      delegationTargets: Object.freeze([...inspection.value.delegationTargets]),
    }
    return client
  }

  private requireRoomBridgeReceipt(
    result: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationOperationReceipt>,
    action: string,
  ): PlaygroundRoomSimulationOperationReceipt {
    if (result.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
      throw new Error(`${action}: ${result.code}: ${result.message}`)
    }
    return result.value
  }

  private receiptFailure(action: string, receipt: PlaygroundRoomSimulationOperationReceipt): string {
    const code = typeof receipt.detail?.code === 'string' ? `/${receipt.detail.code}` : ''
    return `${action}: ${receipt.phase}${code}`
  }

  private async refreshRoomBridgeSnapshot(
    client: PlaygroundRoomSimulationForwardingClient,
    binding: PlaygroundRoomSimulationBinding,
  ): Promise<void> {
    const result = await client.snapshot(binding)
    if (result.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
      return
    }
    this.consumeRoomBridgeSnapshot(result.value)
  }

  private consumeRoomBridgeSnapshot(snapshot: PlaygroundRoomSimulationSnapshot): void {
    this.observeRoomBridgeSnapshotOperationIds(snapshot)
    for (const event of snapshot.events) {
      this.consumeRoomBridgeEvent({ status: 'available', ownerGeneration: event.binding.ownerGeneration, value: event })
    }
  }

  private observeRoomBridgeSnapshotOperationIds(snapshot: PlaygroundRoomSimulationSnapshot): void {
    for (const event of snapshot.events) this.observeRoomBridgeEventOperationIds(event)
  }

  private observeRoomBridgeEventOperationIds(event: PlaygroundRoomSimulationEvent): void {
    const scope = this.commandScope()
    observeScenarioRoomOperationId(scope, event.operationId)
    observeScenarioRoomOperationId(scope, typeof event.detail?.requestOperationId === 'string'
      ? event.detail.requestOperationId
      : undefined)
  }

  private consumeRoomBridgeEvent(result: PlaygroundRoomSimulationResult<PlaygroundRoomSimulationEvent>): void {
    if (result.status === 'unavailable') {
      this.markRoomBridgeUnavailable(`${result.code}: ${result.message}`)
      return
    }
    this.roomBridgeState = { ...this.roomBridgeState, state: 'available' }
    const event = result.value
    this.observeRoomBridgeEventOperationIds(event)
    const requestOperationId = typeof event.detail?.requestOperationId === 'string'
      ? event.detail.requestOperationId
      : undefined
    const isTrackedOperation = event.operationId !== undefined && this.roomBridgeOperationIds.has(event.operationId)
    const isTrackedRequest = requestOperationId !== undefined && this.roomBridgeOperationIds.has(requestOperationId)
    if (event.operationId !== undefined && !isTrackedOperation && !isTrackedRequest) return
    if (event.operationId === undefined && !isTrackedRequest
      && (event.kind !== 'room.run.lifecycle' || this.roomBridgeOperationIds.size === 0)) return
    const fingerprint = event.kind === 'room.agent-task-delegation.projected'
      ? `${event.kind}\u0000${event.operationId ?? ''}`
      : `${event.kind}\u0000${event.operationId ?? ''}\u0000${JSON.stringify(event.detail ?? {})}`
    if (this.roomBridgeEventFingerprints.has(fingerprint)) return
    this.roomBridgeEventFingerprints.add(fingerprint)
    const approvalId = typeof event.detail?.approvalId === 'string' ? event.detail.approvalId : undefined
    const turn = typeof event.detail?.turnId === 'string' ? event.detail.turnId : undefined
    if ((event.kind === 'room.agent-approval.pending' || event.kind === 'room.permission.pending')
      && approvalId !== undefined && event.operationId !== undefined) {
      this.pendingApproval = {
        binding: event.binding,
        requestOperationId: event.operationId,
        turn: turn ?? approvalId,
        approvalId,
      }
    } else if ((event.kind === 'room.agent-approval.terminal' || event.kind === 'room.permission.terminal' || event.kind === 'room.permission-decision.terminal')
      && approvalId !== undefined && this.pendingApproval?.approvalId === approvalId) {
      this.pendingApproval = undefined
    }
    this.appendSimulatedTrace({
      direction: this.roomBridgeEventDirection(event),
      type: event.kind,
      summary: this.roomBridgeEventSummary(event),
      timestamp: event.occurredAt ?? new Date().toISOString(),
      payload: event,
      correlations: {
        ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
        ...(turn === undefined ? {} : { turn }),
        ...(typeof event.detail?.messageId === 'string' ? { messageId: event.detail.messageId } : {}),
        memberId: event.binding.memberId,
        runId: event.binding.runId,
      },
    })
  }

  private roomBridgeEventDirection(event: PlaygroundRoomSimulationEvent): PlaygroundTaskTraceDirection {
    if (event.kind === 'room.message.projected') return 'simulator-to-chatroom'
    if (event.kind === 'room.agent-message.projected'
      || event.kind.startsWith('room.agent-message.targeted.')
      || event.kind.startsWith('room.agent-egress.')
      || event.kind.startsWith('room.agent-task-delegation.')
      || event.kind.startsWith('room.agent-approval.')
      || event.kind === 'room.permission.pending' || event.kind === 'room.permission.terminal') {
      return 'agent-host-to-chatroom'
    }
    if (event.kind.startsWith('room.permission-decision.')) return 'simulator-to-chatroom'
    return 'host-lifecycle'
  }

  private roomBridgeEventSummary(event: PlaygroundRoomSimulationEvent): string {
    const detail = event.detail ?? {}
    if (event.kind === 'room.message.projected') return 'The simulated input is visible in the associated Room timeline.'
    if (event.kind === 'room.agent-message.projected') return 'The Agent response is visible in the associated Room timeline.'
    if (event.kind === 'room.agent-message.targeted.projected') return 'The addressed Agent message is visible in the associated Room timeline.'
    if (event.kind === 'room.agent-message.targeted.accepted') return `Chatroom delivered the message only to ${String(detail.targetMemberId ?? 'the mentioned entity')}.`
    if (event.kind === 'room.agent-egress.projected') return 'The bound Agent reply is visible in the associated Room timeline.'
    if (event.kind === 'room.agent-egress.delivery.accepted') return 'Chatroom accepted the bound Agent reply delivery.'
    if (event.kind === 'room.agent-egress.ack.terminal') return `The Agent reply acknowledgement reached ${String(detail.state ?? 'a terminal state')}.`
    if (event.kind === 'room.agent-task-delegation.projected') return 'The delegated task is visible in the associated Room timeline.'
    if (event.kind === 'room.agent-task-delegation.accepted') return `Chatroom accepted the delegated task for ${String(detail.targetMemberId ?? 'the target entity')}.`
    if (event.kind === 'room.agent-approval.projected') return 'The bound Agent approval card is visible in the associated Room timeline.'
    if (event.kind === 'room.agent-approval.pending') return 'The bound Agent approval request is pending in the associated Room.'
    if (event.kind === 'room.agent-approval.decision.accepted') return `Chatroom accepted the ${String(detail.decision ?? 'updated')} decision for the Agent approval request.`
    if (event.kind === 'room.agent-approval.terminal') return `The Agent approval request reached ${String(detail.state ?? detail.decision ?? 'a terminal state')}.`
    if (event.kind === 'room.permission.pending') return 'Chatroom projected a pending permission request.'
    if (event.kind === 'room.permission.terminal') return `The Room permission request reached ${String(detail.state ?? 'a terminal state')}.`
    if (event.kind === 'room.delivery.accepted') return 'Chatroom accepted the Room delivery.'
    if (event.kind === 'room.delivery.failed') return `The Room delivery failed${typeof detail.failureCode === 'string' ? `: ${detail.failureCode}` : '.'}`
    if (event.kind === 'room.ack.terminal') return `The Room acknowledgement reached ${String(detail.state ?? 'a terminal state')}.`
    if (event.kind.startsWith('room.permission-decision.')) return `The permission decision is ${String(detail.state ?? detail.decision ?? 'updated')}.`
    if (event.kind === 'room.run.lifecycle') return `Run ${String(detail.status ?? 'state')} · ${String(detail.presence ?? 'presence unavailable')}`
    return event.kind
  }

  private async injectIntroductionEvent(input: { readonly participantId: string; readonly memberId: string; readonly runId: string }): Promise<void> {
    if (input.participantId.trim() === '' || input.memberId.trim() === '' || input.runId.trim() === '') return
    await this.performInjection('member-self-introduction', input, async () => {
      const binding = await this.ensureInjectorBinding()
      const commandId = scenarioCommandId(this.commandScope(), `event-injector:introduction:${this.nextInjectionOrdinal()}`)
      const result = await this.runtime.client.requestMemberSelfIntroduction({
        $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
        contract: 'cordisx.agent-loop-command/v4',
        schemaVersion: 4,
        commandId,
        type: 'request-member-self-introduction',
        binding,
        participantId: input.participantId,
        memberId: input.memberId,
        runId: input.runId,
        intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
      })
      if (result.status !== 'accepted') throw new Error(`member-self-introduction: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
      this.captureRuntimeTrace(binding.task, new Date().toISOString())
      await this.delay()
      this.captureRuntimeTrace(binding.task, new Date().toISOString())
      this.appendSimulatedTrace({
        direction: 'agent-host-to-chatroom',
        type: 'member-self-introduction.accepted',
        summary: 'The structured member self-introduction completed through AgentLoop v4.',
        timestamp: new Date().toISOString(),
        payload: result,
        correlations: { operationId: commandId, turn: result.turn, messageId: result.messageId, ...input },
      })
    })
  }

  private async resolveInjectorApproval(decision: 'approved' | 'denied' | 'cancelled'): Promise<void> {
    const pending = this.pendingApproval
    if (pending === undefined) return
    const operationId = this.roomBridgeOperationId(`permission-decision:${this.nextInjectionOrdinal()}:${decision}`)
    this.roomBridgeOperationIds.add(operationId)
    await this.performInjection('permission-decision', { approvalId: pending.approvalId, turn: pending.turn, decision }, async () => {
      const client = await this.requireRoomBridge(pending.binding)
      const result = await client.decidePermission(
        pending.binding,
        operationId,
        pending.approvalId,
        decision === 'approved' ? 'allow' : decision === 'denied' ? 'deny' : 'cancel',
      )
      const receipt = this.requireRoomBridgeReceipt(result, 'permission decision')
      if (receipt.phase === 'rejected' || receipt.phase === 'failed') throw new Error(this.receiptFailure('permission decision', receipt))
      this.pendingApproval = undefined
      this.appendSimulatedTrace({
        direction: 'simulator-to-chatroom',
        type: 'permission-decision.accepted',
        summary: `Chatroom accepted the ${decision} permission decision.`,
        timestamp: new Date().toISOString(),
        payload: receipt,
        correlations: { operationId, turn: receipt.turnId ?? pending.turn, runId: receipt.runId ?? pending.binding.runId },
      })
      await this.refreshRoomBridgeSnapshot(client, pending.binding)
    }, {
      direction: 'simulator-to-chatroom',
      summary: 'Send a decision to the pending Chatroom permission request.',
      correlations: { operationId, turn: pending.turn, runId: pending.binding.runId },
    })
  }

  private async executeNext(resumePhase: 'running' | 'paused'): Promise<void> {
    const step = stepsFor(this.selectedScenarioId)[this.cursor]
    if (step === undefined) {
      this.phase = 'completed'
      this.publish()
      return
    }
    const generation = this.generation
    const runtime = this.runtime
    const bindings = this.bindings
    this.append('operation', step.id)
    try {
      await step.execute({
        client: runtime.client,
        bindings,
        append: (kind, message) => {
          if (this.current(generation, runtime, bindings)) this.append(kind, message)
        },
        create: (alias, definition) => this.create(generation, runtime, bindings, alias, definition),
        send: (alias, ordinal, text) => this.send(generation, runtime, bindings, alias, ordinal, text),
        decide: (alias, ordinal, decision) => this.decide(generation, runtime, bindings, alias, ordinal, decision),
      })
      if (!this.current(generation, runtime, bindings)) return
      this.cursor += 1
      this.phase = this.cursor >= stepsFor(this.selectedScenarioId).length ? 'completed' : resumePhase
      this.publish()
    } catch (cause) {
      if (!this.current(generation, runtime, bindings)) return
      this.error = cause instanceof Error ? cause.message : String(cause)
      this.phase = 'failed'
      this.append('result', `failed: ${this.error}`)
    }
  }

  private async create(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    definition: AgentDefinition,
    flowId: string = this.selectedScenarioId,
  ): Promise<void> {
    const sourceDefinition = alias === 'a'
      ? this.sourceTask.catalog.find(candidate => candidate.identity.agentId === this.sourceTask.identity.agentId
        && candidate.identity.revision === this.sourceTask.identity.revision)
      : undefined
    const selectedDefinition = sourceDefinition ?? definition
    const definitions = sourceDefinition === undefined ? [selectedDefinition] : this.sourceTask.catalog
    const result = await runtime.client.createOrBind(createCommand(
      flowId,
      this.commandScope(),
      alias,
      selectedDefinition,
      definitions,
    ))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') throw new Error(`create ${alias}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    bindings.set(alias, result.binding)
    this.definitions.set(alias, selectedDefinition)
    // A disposable generation is inspected in the source task workbench. Its
    // shell must not navigate to the isolated runtime's coincidentally numbered
    // mock task URL.
    this.detailsUrls.set(alias, this.commandScope() === '' ? result.detailsUrl : this.sourceTask.detailsUrl)
    this.append('result', `create ${alias}: ${result.delivery.disposition}`)
  }

  private async send(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    ordinal: number,
    text: string,
    flowId: string = this.selectedScenarioId,
  ): Promise<void> {
    const binding = bindings.get(alias)
    if (binding === undefined) throw new Error(`binding ${alias} is unavailable`)
    const operationId = scenarioCommandId(this.commandScope(), `${flowId}:send:${alias}:${ordinal}`)
    this.appendConversationMessage({
      itemId: `user-${alias}-${ordinal}`,
      messageId: `user-message-${alias}-${ordinal}`,
      authorId: 'scenario-human',
      body: [text],
      deliveryState: 'pending',
      runState: 'running',
      ariaLive: 'off',
      actions: [],
      reactions: [{
        reactionId: `reaction-${alias}-${ordinal}`,
        actorParticipantId: `scenario-agent-${alias}`,
        value: { kind: 'emoji', emoji: '✓' },
        state: 'pending',
      }],
      semantic: { purpose: 'conversation', causation: { operationId } },
    })
    const result = await runtime.client.send(sendCommand(flowId, this.commandScope(), alias, ordinal, binding, text))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') {
      this.updateUserDelivery(alias, ordinal, 'failed')
      throw new Error(`send ${alias}/${ordinal}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    }
    if (flowId === 'event-injector') this.latestInjectedSend = {
      binding,
      ordinal,
      turn: result.turn,
      messageId: result.messageId,
    }
    this.updateUserDelivery(alias, ordinal, 'delivered')
    const definition = this.definitions.get(alias)
    const task = runtime.host.snapshot().tasks.find(candidate => definition !== undefined
      && candidate.identity.agentId === definition.identity.agentId
      && candidate.identity.revision === definition.identity.revision)
    const output = task?.execution?.result.status === 'ok'
      ? task.execution.result.stdout ?? 'Completed successfully.'
      : task?.execution?.result.error?.message ?? 'The deterministic scenario operation failed.'
    this.appendConversationMessage({
      itemId: `agent-${alias}-${ordinal}`,
      messageId: result.messageId,
      authorId: `scenario-agent-${alias}`,
      body: [output],
      deliveryState: 'delivered',
      runState: task?.status === 'error' ? 'failed' : 'idle',
      ariaLive: 'polite',
      actions: [],
      source: 'agent-loop',
      semantic: { purpose: 'conversation', causation: { operationId } },
    })
    if (/\[approval\]/iu.test(text)) this.appendApproval(alias, ordinal, binding, result.turn)
    this.append('result', `send ${alias}/${ordinal}: ${result.delivery.disposition}`)
  }

  private async decide(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
    alias: string,
    ordinal: number,
    decision: 'approved' | 'denied' | 'cancelled',
    flowId: string = this.selectedScenarioId,
  ): Promise<void> {
    const binding = bindings.get(alias)
    if (binding === undefined) throw new Error(`binding ${alias} is unavailable`)
    const result = await runtime.client.decideApproval(approvalCommand(
      flowId,
      this.commandScope(),
      alias,
      ordinal,
      binding,
      decision,
    ))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') throw new Error(`approval ${alias}/${ordinal}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    this.resolveApproval(alias, ordinal, result.decision)
    this.append('result', `approval ${alias}/${ordinal}: ${result.decision}/${result.delivery.disposition}`)
  }

  private current(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV4>,
  ): boolean {
    return generation === this.generation && runtime === this.runtime && bindings === this.bindings
  }

  private commandScope(): string {
    if (this.sourceTask.debugTaskId === 'Standalone Scenario Task') return ''
    return stableLocalTaskScope(this.sourceTask.taskRef)
  }

  private append(kind: PlaygroundScenarioActivity['kind'], message: string): void {
    this.activities = [...this.activities, { sequence: this.activities.length + 1, kind, message }]
    this.publish()
  }

  private appendConversationMessage(
    input: Omit<AgentConversationMessage, 'kind' | 'sequence' | 'timestamp'>,
  ): void {
    const sequence = ++this.conversationSequence
    this.conversationEntries = [...this.conversationEntries, {
      ...input,
      kind: 'message',
      sequence,
      timestamp: new Date(Date.UTC(2026, 7, 31, 0, 0, sequence)).toISOString(),
    }]
    this.publish()
  }

  private updateUserDelivery(alias: string, ordinal: number, deliveryState: 'delivered' | 'failed'): void {
    const itemId = `user-${alias}-${ordinal}`
    this.conversationEntries = this.conversationEntries.map(entry => {
      if (entry.kind !== 'message' || entry.itemId !== itemId) return entry
      const reactions = entry.reactions?.map(reaction => ({
        ...reaction,
        state: deliveryState === 'failed' ? 'failed' as const : 'completed' as const,
      }))
      return {
        ...entry,
        deliveryState,
        runState: deliveryState === 'failed' ? 'failed' : 'idle',
        ...(reactions === undefined ? {} : { reactions }),
      }
    })
    this.publish()
  }

  private appendApproval(alias: string, ordinal: number, binding: AgentLoopTaskBindingV4, turn: string): void {
    const sequence = ++this.conversationSequence
    const item: AgentConversationApproval = {
      kind: 'approval',
      itemId: `approval-${alias}-${ordinal}`,
      sequence,
      participantId: `scenario-agent-${alias}`,
      memberId: `scenario-member-${alias}`,
      runId: `scenario-run-${alias}`,
      binding: binding.binding,
      turn,
      approvalId: `simulated-approval-${turn}`,
      approvalKind: 'command',
      state: 'pending',
      actions: [
        { decision: 'approve', command: { id: `scenario.approval.${alias}.${ordinal}.approve` } },
        { decision: 'deny', command: { id: `scenario.approval.${alias}.${ordinal}.deny` } },
        { decision: 'cancel', command: { id: `scenario.approval.${alias}.${ordinal}.cancel` } },
      ],
      rationale: `Agent ${alias.toUpperCase()} requests deterministic command approval ${ordinal}.`,
    }
    this.conversationEntries = [...this.conversationEntries, item]
    this.publish()
  }

  private resolveApproval(alias: string, ordinal: number, decision: 'approved' | 'denied' | 'cancelled'): void {
    const itemId = `approval-${alias}-${ordinal}`
    this.conversationEntries = this.conversationEntries.map(entry => entry.kind === 'approval' && entry.itemId === itemId
      ? { ...entry, state: decision, actions: [] }
      : entry)
    this.publish()
  }

  private conversation(): AgentConversationModel {
    const selected = this.selectedScenarioId
    const scope = this.commandScope()
    const participatingAliases = aliases.filter(alias => this.definitions.has(alias))
    const participants = [{ id: 'scenario-human', role: 'human' as const, name: 'You' }, ...participatingAliases.map(alias => {
      const definition = this.definitions.get(alias)!
      return {
        id: `scenario-agent-${alias}`,
        role: 'agent' as const,
        name: definition.name ?? labelFor(alias),
        agentIdentity: definition.identity,
        avatar: createGeneratedAgentAvatarRef({ namespace: 'agent-definition', agentId: definition.identity.agentId }),
      }
    })]
    const activeRuns = participatingAliases.flatMap(alias => {
      const detailsUrl = this.detailsUrls.get(alias)
      return detailsUrl === undefined ? [] : [{
        participantId: `scenario-agent-${alias}`,
        memberId: `scenario-member-${alias}`,
        runId: `scenario-run-${alias}`,
        lifecycle: { phase: 'active' as const },
        detailsUrl,
      }]
    })
    return createAgentConversationModel({
      ownerId: scope === '' ? 'host-playground-scenario-lab' : `host-playground-simulator-task-${scope}`,
      shell: 'agent-desktop',
      binding: { bindingId: scope === '' ? 'scenario-shell' : `scenario-shell-${scope}`, ownerGeneration: `scenario-generation-${this.generation}` },
      generation: `scenario-snapshot-${this.generation}`,
      snapshotSequence: this.conversationSequence,
      selection: {
        kind: 'room', roomId: scope === '' ? `scenario-${selected}` : `scenario-${scope}-${selected}`,
        title: scope === ''
          ? PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === selected)!.title.en
          : `${this.sourceTask.agentLabel} · ${PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === selected)!.title.en}`,
        description: { state: 'present', text: scope === ''
          ? 'Developer-only disposable Conversation Shell preview.'
          : `Disposable generation for ${this.sourceTask.debugTaskId}; the source task snapshot is unchanged.` },
        multiParticipant: participants.length > 1,
        participantPresentation: participants.length > 1 ? 'host-initials' : 'none',
        participants,
        activeRuns,
      },
      entries: this.conversationEntries,
      composer: {
        availability: 'unavailable', placeholder: 'Use Run or Next to drive this disposable scenario.', disabled: true,
        disabledReason: 'Scenario controls own this deterministic preview.', submit: { id: 'scenario.submit' },
      },
      headerActions: [],
    })
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
