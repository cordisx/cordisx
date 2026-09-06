import type {
  AgentDefinition,
  AgentLoopCommandV4,
  AgentLoopTaskBindingV4,
  BoundAgentLoopClientV4,
} from '../agent-loop-contracts.js'
import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v3'
import { createGeneratedAgentAvatarRef } from '@cordisx/protocol/agent-avatar/v1'
import type { SessionEvent } from '@cordisx/protocol/sessions/v1'
import { CORDISX_AGENT_DEFINITION_SCHEMA_V1, CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4 } from '../agent-loop-contracts.js'
import { CordisXAgentLoopBrokerV4 } from '../renderer/agent-loop-v4.js'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  PlaygroundMockAgentLoopHost,
  PlaygroundMockAgentLoopV4Transport,
  type PlaygroundMockTaskTrace,
} from '../renderer/playground-mock-agent-loop.js'
import {
  type AgentConversationApproval,
  type AgentConversationEntry,
  type AgentConversationMessage,
  type AgentConversationModel,
  createAgentConversationModel,
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
    description: {
      'zh-CN': '同一 binding 短时间提交四条独立消息，并保持操作与响应顺序。',
      en: 'Submit four independent messages to one binding while preserving operation and response order.',
    },
    availability: { state: 'available' },
  },
  {
    id: 'human-interruption',
    title: { 'zh-CN': '人类消息打断', en: 'Human interruption' },
    description: {
      'zh-CN': '在人类消息前后显示同一 Agent 回复，证明分组边界会被人类消息打断。',
      en: 'Place replies from the same Agent around human input to prove that human messages break grouping.',
    },
    availability: { state: 'available' },
  },
  {
    id: 'approval-decision',
    title: { 'zh-CN': '权限申请', en: 'Approval request' },
    description: {
      'zh-CN': '通过正式 AgentLoop v4 命令分别完成允许、拒绝与取消决策。',
      en: 'Exercise approve, deny, and cancel through formal AgentLoop v4 commands.',
    },
    availability: { state: 'available' },
  },
  {
    id: 'multi-binding',
    title: { 'zh-CN': '多 Agent 并发', en: 'Concurrent agents' },
    description: {
      'zh-CN': '为三个通用 Agent 创建独立 binding，并并发提交互不串流的输入。',
      en: 'Create independent bindings for three generic agents and submit isolated inputs concurrently.',
    },
    availability: { state: 'available' },
  },
  {
    id: 'failure-retry',
    title: { 'zh-CN': '失败与重试', en: 'Failure and retry' },
    description: {
      'zh-CN': '先触发 typed CLI failure，再以新的逻辑操作重试并恢复。',
      en: 'Trigger a typed CLI failure, then retry as a new logical operation and recover.',
    },
    availability: { state: 'available' },
  },
  {
    id: 'plain-text-stress',
    title: { 'zh-CN': '富文本压力', en: 'Rich text stress' },
    description: {
      'zh-CN': '提交长文本、多行、代码和链接，验证纯文本 AgentLoop 内容边界。',
      en: 'Submit long text, multiple lines, code, and links through the text-only AgentLoop boundary.',
    },
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

export type PlaygroundScenarioTaskContext = Readonly<
  Pick<
    PlaygroundMockTaskTrace,
    | 'taskRef'
    | 'sessionId'
    | 'debugTaskId'
    | 'detailsUrl'
    | 'agentLabel'
    | 'status'
    | 'identity'
    | 'catalog'
    | 'input'
    | 'execution'
    | 'events'
    | 'simulationBinding'
  >
>

export type PlaygroundTaskTraceDirection =
  | 'chatroom-to-agent-host'
  | 'agent-host-to-chatroom'
  | 'agent-execution'
  | 'agent-to-tool'
  | 'tool-to-agent'
  | 'injector-to-agent-host'
  | 'simulator-to-chatroom'
  | 'host-lifecycle'

export type PlaygroundTaskTracePresentation =
  | 'user-input'
  | 'assistant-response'
  | 'agent-execution'
  | 'tool-use'
  | 'tool-result'
  | 'approval'
  | 'lifecycle'
  | 'legacy'

export interface PlaygroundTaskTraceEntry {
  readonly id: string
  readonly source: 'original' | 'simulated'
  readonly generation: 'original' | string
  readonly direction: PlaygroundTaskTraceDirection
  readonly presentation?: PlaygroundTaskTracePresentation
  readonly type: string
  readonly summary: string
  readonly timestamp?: string
  readonly rawSessionEvents?: readonly SessionEvent[]
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

export interface ScenarioContext {
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

export interface ScenarioStep {
  readonly id: string
  execute(context: ScenarioContext): Promise<void>
}

export const inherit: AgentDefinition['inherit'] = Object.freeze({
  promptSections: 'append',
  rules: 'append',
  skills: 'append',
  tools: 'merge',
  mcpServers: 'merge',
  runtimeDefaults: 'merge',
})

export const aliases = ['a', 'b', 'c'] as const
export const labelFor = (alias: string): string => `Agent ${alias.toUpperCase()}`

export function stableLocalTaskScope(taskRef: string): string {
  let hash = 2166136261
  for (const character of taskRef) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  const slug = taskRef.toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return `${slug === '' ? 'task' : slug}-${hash.toString(36)}`
}

export function traceDirection(
  event: PlaygroundMockTaskTrace['events'][number],
  source: 'original' | 'simulated',
): PlaygroundTaskTraceDirection {
  if (event.sessionEvent !== undefined) {
    if (event.sessionEvent.type === 'user/message') return 'chatroom-to-agent-host'
    if (
      event.sessionEvent.type === 'assistant/message'
      || event.sessionEvent.type === 'approval/asked' || event.sessionEvent.type === 'approval/decided'
    ) return 'agent-host-to-chatroom'
    if (event.sessionEvent.type === 'tool/call') return 'agent-to-tool'
    if (event.sessionEvent.type === 'tool/result') return 'tool-to-agent'
    if (
      event.sessionEvent.type === 'turn/start' || event.sessionEvent.type === 'turn/end'
      || event.sessionEvent.type === 'step/start' || event.sessionEvent.type === 'step/end'
      || event.sessionEvent.type === 'assistant/chunk' || event.sessionEvent.type === 'request/header'
      || event.sessionEvent.type === 'request/context' || event.sessionEvent.type === 'agent/inbox/spliced'
      || event.sessionEvent.type === 'playground/scenario'
    ) return 'agent-execution'
    return 'host-lifecycle'
  }
  const type = event.type
  if (type === 'task.created' || type === 'task.bound' || type === 'task.closed' || type === 'execution.started') {
    return 'host-lifecycle'
  }
  if (type === 'approval.required') return source === 'simulated' ? 'simulator-to-chatroom' : 'agent-host-to-chatroom'
  if (type === 'execution.completed' || type === 'execution.failed') return 'agent-host-to-chatroom'
  return source === 'simulated' ? 'injector-to-agent-host' : 'chatroom-to-agent-host'
}

export function tracePresentation(event: PlaygroundMockTaskTrace['events'][number]): PlaygroundTaskTracePresentation {
  switch (event.sessionEvent?.type) {
    case 'user/message':
      return 'user-input'
    case 'assistant/message':
      return 'assistant-response'
    case 'assistant/chunk':
    case 'turn/start':
    case 'turn/end':
    case 'step/start':
    case 'step/end':
    case 'request/header':
    case 'request/context':
    case 'agent/inbox/spliced':
      return 'agent-execution'
    case 'playground/scenario':
      return 'agent-execution'
    case 'tool/call':
      return 'tool-use'
    case 'tool/result':
      return 'tool-result'
    case 'approval/asked':
    case 'approval/decided':
      return 'approval'
    case 'session/end-seed':
      return 'lifecycle'
    default:
      return event.sessionEvent === undefined ? 'legacy' : 'lifecycle'
  }
}

export function eventCorrelations(
  event: PlaygroundMockTaskTrace['events'][number],
): PlaygroundTaskTraceEntry['correlations'] {
  return {
    ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
    ...(event.turn === undefined ? {} : { turn: event.turn }),
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    ...(event.participantId === undefined ? {} : { participantId: event.participantId }),
    ...(event.memberId === undefined ? {} : { memberId: event.memberId }),
    ...(event.runId === undefined ? {} : { runId: event.runId }),
  }
}

export function originalTrace(sourceTask: PlaygroundScenarioTaskContext): readonly PlaygroundTaskTraceEntry[] {
  const output: PlaygroundTaskTraceEntry[] = []
  let pendingAssistantChunks: PlaygroundMockTaskTrace['events'][number][] = []
  const append = (
    event: PlaygroundMockTaskTrace['events'][number],
    rawSessionEvents: readonly SessionEvent[] = event.sessionEvent === undefined ? [] : [event.sessionEvent],
    summary = event.detail,
  ) => {
    output.push(Object.freeze({
      id: `original-${event.sequence}`,
      source: 'original' as const,
      generation: 'original' as const,
      direction: traceDirection(event, 'original'),
      presentation: tracePresentation(event),
      type: event.type,
      summary,
      ...(event.sessionEvent === undefined ? {} : { timestamp: new Date(event.sessionEvent.time).toISOString() }),
      ...(rawSessionEvents.length === 0 ? {} : { rawSessionEvents: Object.freeze([...rawSessionEvents]) }),
      payload: Object.freeze({
        event,
        ...(output.length === 0 && sourceTask.simulationBinding !== undefined
          ? { roomSimulationBinding: sourceTask.simulationBinding }
          : {}),
        ...(event.type === 'input.accepted' && sourceTask.input !== undefined
          ? { latestTaskInputSnapshot: sourceTask.input }
          : {}),
        ...((event.type === 'execution.completed' || event.type === 'execution.failed')
            && sourceTask.execution !== undefined
          ? { latestTaskExecutionSnapshot: sourceTask.execution }
          : {}),
      }),
      correlations: eventCorrelations(event),
    }))
  }
  const flushAssistantChunks = () => {
    const first = pendingAssistantChunks[0]
    if (first === undefined) return
    const raw = pendingAssistantChunks.flatMap(event => event.sessionEvent === undefined ? [] : [event.sessionEvent])
    append(first, raw, `Agent response stream · ${raw.length} raw event${raw.length === 1 ? '' : 's'}`)
    pendingAssistantChunks = []
  }
  for (const event of sourceTask.events) {
    if (event.sessionEvent?.type === 'assistant/chunk') {
      pendingAssistantChunks.push(event)
      continue
    }
    const assistantMessage = event.sessionEvent?.type === 'assistant/message'
      ? event.sessionEvent
      : undefined
    const matchingAssistantChunks = assistantMessage !== undefined
      && pendingAssistantChunks.length > 0
      && pendingAssistantChunks.every(chunk =>
        chunk.sessionEvent?.type === 'assistant/chunk'
        && chunk.sessionEvent.data.turn === assistantMessage.data.turn
        && chunk.sessionEvent.data.step === assistantMessage.data.step
      )
    if (matchingAssistantChunks && assistantMessage !== undefined) {
      const raw = [
        ...pendingAssistantChunks.flatMap(chunk => chunk.sessionEvent === undefined ? [] : [chunk.sessionEvent]),
        assistantMessage,
      ]
      pendingAssistantChunks = []
      append(event, raw)
      continue
    }
    flushAssistantChunks()
    append(event)
  }
  flushAssistantChunks()
  return Object.freeze(output)
}

export function agent(alias: 'a' | 'b' | 'c'): AgentDefinition {
  const label = labelFor(alias)
  const definition: AgentDefinition = {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId: `playground.scenario.${alias}`, revision: 'phase-1' },
    name: label,
    inherit,
    promptSections: [
      {
        sectionId: 'introduction',
        kind: 'introduction',
        text: `${label} is a deterministic interaction-scenario participant.`,
      },
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

export function scenarioCommandId(scope: string, suffix: string): string {
  return `host-scenario:${scope === '' ? '' : `${scope}:`}${suffix}`
}

export const SCENARIO_OPERATION_AUTHORITY = Symbol.for('cordisx.playground.scenario-operation-authority/v1')

export function scenarioOperationOrdinals(): Map<string, number> {
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

export function nextScenarioOperationOrdinal(scope: string): number {
  const ordinals = scenarioOperationOrdinals()
  const next = (ordinals.get(scope) ?? 0) + 1
  ordinals.set(scope, next)
  return next
}

export function observeScenarioRoomOperationId(scope: string, operationId: string | undefined): void {
  if (operationId === undefined) return
  const prefix = scenarioCommandId(scope, 'room:')
  if (!operationId.startsWith(prefix)) return
  const [, , ordinalText] = operationId.slice(prefix.length).split(':')
  const ordinal = Number(ordinalText)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return
  const ordinals = scenarioOperationOrdinals()
  if ((ordinals.get(scope) ?? 0) < ordinal) ordinals.set(scope, ordinal)
}

export function createCommand(
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
    definitions: definitions.length === 0
      ? [definition]
      : definitions as readonly [AgentDefinition, ...AgentDefinition[]],
    target: { mode: 'create' },
  }
}

export function sendCommand(
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
    type: 'send',
    binding,
    content: [{ kind: 'text', text }],
  }
}

export function approvalCommand(
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
    contract: 'cordisx.agent-loop-command/v4',
    schemaVersion: 4,
    commandId: scenarioCommandId(scope, `${scenarioId}:approval:${alias}:${ordinal}:${decision}`),
    type: 'approval-decision',
    binding,
    turn,
    approvalId: `simulated-approval-${turn}`,
    decision,
  }
}

export function stepsFor(id: PlaygroundScenarioId): readonly ScenarioStep[] {
  if (id === 'continuous-sends') {
    return [
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
  }
  if (id === 'human-interruption') {
    return [
      { id: 'create-a', execute: context => context.create('a', agent('a')) },
      {
        id: 'send-around-human',
        execute: async context => {
          await context.send('a', 1, 'First human message before the interruption boundary.')
          await context.send('a', 2, 'Second human message interrupts the Agent message group.')
        },
      },
    ]
  }
  if (id === 'multi-binding') {
    return [
      {
        id: 'create-three',
        execute: async context => {
          await Promise.all((['a', 'b', 'c'] as const).map(alias => context.create(alias, agent(alias))))
        },
      },
      {
        id: 'send-three',
        execute: async context => {
          await Promise.all(
            (['a', 'b', 'c'] as const).map((alias, index) =>
              context.send(alias, index + 1, `Independent input for Agent ${alias.toUpperCase()}.`)
            ),
          )
        },
      },
    ]
  }
  if (id === 'approval-decision') {
    return [
      { id: 'create-a', execute: context => context.create('a', agent('a')) },
      {
        id: 'request-three',
        execute: async context => {
          for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
            await context.send('a', ordinal, `Request approval ${ordinal}. [approval]`)
          }
        },
      },
      {
        id: 'decide-three',
        execute: async context => {
          await context.decide('a', 1, 'approved')
          await context.decide('a', 2, 'denied')
          await context.decide('a', 3, 'cancelled')
        },
      },
    ]
  }
  if (id === 'failure-retry') {
    return [
      { id: 'create-a', execute: context => context.create('a', agent('a')) },
      { id: 'fail', execute: context => context.send('a', 1, 'Exercise the typed failure path. [cli-fail]') },
      { id: 'retry', execute: context => context.send('a', 2, 'Retry with a fresh logical operation.') },
    ]
  }
  if (id === 'plain-text-stress') {
    return [
      { id: 'create-a', execute: context => context.create('a', agent('a')) },
      {
        id: 'stress',
        execute: context =>
          context.send(
            'a',
            1,
            [
              'A deliberately long first paragraph verifies wrapping without changing the structured AgentLoop content boundary. '
                .repeat(4),
              '',
              '```ts',
              "const link = new URL('https://example.com/scenario')",
              'console.log(link.href)',
              '```',
              '',
              'Reference: https://example.com/scenario?mode=deterministic',
            ].join('\n'),
          ),
      },
    ]
  }
  return []
}

export type Listener = () => void

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

export function standaloneScenarioTaskContext(): PlaygroundScenarioTaskContext {
  const definition = agent('a')
  return Object.freeze(
    {
      taskRef: 'debug:scenario-lab/standalone',
      debugTaskId: 'Standalone Scenario Task',
      detailsUrl: { url: 'app://-/playground/simulator/tasks/Standalone%20Scenario%20Task', target: 'host' },
      agentLabel: definition.name ?? definition.identity.agentId,
      status: 'created',
      identity: definition.identity,
      catalog: Object.freeze([definition]),
      events: Object.freeze([]),
    } satisfies PlaygroundScenarioTaskContext,
  )
}
