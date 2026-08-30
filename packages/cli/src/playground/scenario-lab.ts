import type {
  AgentDefinition,
  AgentLoopCommandV2,
  AgentLoopTaskBindingV2,
  BoundAgentLoopClientV2,
} from '../agent-loop-contracts.js'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2,
} from '../agent-loop-contracts.js'
import { CordisXAgentLoopBrokerV2 } from '../renderer/agent-loop-v2.js'
import {
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  PlaygroundMockAgentLoopHost,
  type PlaygroundMockTaskTrace,
} from '../renderer/playground-mock-agent-loop.js'

export type PlaygroundScenarioId =
  | 'continuous-sends'
  | 'approval-decision'
  | 'multi-binding'
  | 'failure-retry'
  | 'plain-text-stress'

export interface PlaygroundScenarioCatalogEntry {
  readonly id: PlaygroundScenarioId
  readonly title: { readonly 'zh-CN': string; readonly en: string }
  readonly description: { readonly 'zh-CN': string; readonly en: string }
  readonly availability:
    | { readonly state: 'available' }
    | { readonly state: 'unavailable'; readonly code: 'approval-decision-api-unavailable'; readonly needApi: string }
}

export const PLAYGROUND_SCENARIO_CATALOG: readonly PlaygroundScenarioCatalogEntry[] = Object.freeze([
  {
    id: 'continuous-sends',
    title: { 'zh-CN': '连续发送', en: 'Continuous sends' },
    description: { 'zh-CN': '同一 binding 短时间提交四条独立消息，并保持操作与响应顺序。', en: 'Submit four independent messages to one binding while preserving operation and response order.' },
    availability: { state: 'available' },
  },
  {
    id: 'approval-decision',
    title: { 'zh-CN': '权限申请', en: 'Approval request' },
    description: { 'zh-CN': '正式 approval decision API 尚未提供；本场景只显示 typed unavailable。', en: 'The formal approval decision API is not available; this scenario reports typed unavailable only.' },
    availability: {
      state: 'unavailable',
      code: 'approval-decision-api-unavailable',
      needApi: 'NEED_API: AgentLoop approval decision command with allow, deny, and cancel outcomes.',
    },
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
  readonly kind: 'operation' | 'result' | 'unavailable'
  readonly message: string
}

export interface PlaygroundScenarioLabSnapshot {
  readonly owner: 'host-playground-scenario-lab'
  readonly selectedScenarioId: PlaygroundScenarioId
  readonly phase: 'idle' | 'running' | 'paused' | 'completed' | 'unavailable' | 'failed'
  readonly cursor: number
  readonly stepCount: number
  readonly activities: readonly PlaygroundScenarioActivity[]
  readonly tasks: readonly PlaygroundMockTaskTrace[]
  readonly error?: string
}

interface ScenarioContext {
  readonly client: BoundAgentLoopClientV2
  readonly bindings: Map<string, AgentLoopTaskBindingV2>
  append(kind: PlaygroundScenarioActivity['kind'], message: string): void
  create(alias: string, definition: AgentDefinition): Promise<void>
  send(alias: string, ordinal: number, text: string): Promise<void>
}

export interface PlaygroundScenarioLabRuntime {
  readonly host: PlaygroundMockAgentLoopHost
  readonly broker: CordisXAgentLoopBrokerV2
  readonly client: BoundAgentLoopClientV2
}

export type PlaygroundScenarioLabRuntimeFactory = () => PlaygroundScenarioLabRuntime

interface ScenarioStep {
  readonly id: string
  execute(context: ScenarioContext): Promise<void>
}

const inherit: AgentDefinition['inherit'] = Object.freeze({
  promptSections: 'append', rules: 'append', skills: 'append', tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge',
})

function agent(alias: 'a' | 'b' | 'c'): AgentDefinition {
  const label = `Agent ${alias.toUpperCase()}`
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

function createCommand(scenarioId: PlaygroundScenarioId, alias: string, definition: AgentDefinition): Extract<AgentLoopCommandV2, { type: 'create-or-bind' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2,
    contract: 'cordisx.agent-loop-command/v2',
    schemaVersion: 2,
    commandId: `host-scenario:${scenarioId}:create:${alias}`,
    type: 'create-or-bind',
    definition: definition.identity,
    definitions: [definition],
    target: { mode: 'create' },
  }
}

function sendCommand(
  scenarioId: PlaygroundScenarioId,
  alias: string,
  ordinal: number,
  binding: AgentLoopTaskBindingV2,
  text: string,
): Extract<AgentLoopCommandV2, { type: 'send' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2,
    contract: 'cordisx.agent-loop-command/v2',
    schemaVersion: 2,
    commandId: `host-scenario:${scenarioId}:send:${alias}:${ordinal}`,
    type: 'send', binding, content: [{ kind: 'text', text }],
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
  let ledger: string | undefined
  const host = new PlaygroundMockAgentLoopHost()
  const broker = new CordisXAgentLoopBrokerV2(
    host,
    () => new Date('2026-08-31T00:00:00.000Z'),
    {
      providerKey: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
      read: () => ledger,
      write: value => { ledger = value },
    },
  )
  const client = broker.bind({
    ownerKey: 'host-playground-scenario-lab',
    active: () => true,
    authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
  })
  return Object.freeze({ host, broker, client })
}

export class PlaygroundScenarioLabController {
  private runtime!: PlaygroundScenarioLabRuntime
  private readonly listeners = new Set<Listener>()
  private selectedScenarioId: PlaygroundScenarioId = 'continuous-sends'
  private phase: PlaygroundScenarioLabSnapshot['phase'] = 'idle'
  private cursor = 0
  private activities: PlaygroundScenarioActivity[] = []
  private bindings = new Map<string, AgentLoopTaskBindingV2>()
  private generation = 0
  private running: Promise<void> | undefined
  private error: string | undefined

  constructor(
    private readonly delay: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 160)),
    private readonly runtimeFactory: PlaygroundScenarioLabRuntimeFactory = createPlaygroundScenarioLabRuntime,
  ) {
    this.replaceRuntime()
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): PlaygroundScenarioLabSnapshot => {
    const availability = this.catalogEntry().availability
    return Object.freeze({
      owner: 'host-playground-scenario-lab',
      selectedScenarioId: this.selectedScenarioId,
      phase: availability.state === 'unavailable' ? 'unavailable' : this.phase,
      cursor: this.cursor,
      stepCount: stepsFor(this.selectedScenarioId).length,
      activities: Object.freeze([...this.activities]),
      tasks: this.runtime.host.snapshot().tasks,
      ...(this.error === undefined ? {} : { error: this.error }),
    })
  }

  select(id: PlaygroundScenarioId): void {
    if (this.selectedScenarioId === id) return
    this.selectedScenarioId = id
    this.reset()
  }

  next(): Promise<void> {
    if (this.catalogEntry().availability.state === 'unavailable') {
      this.publishUnavailable()
      return Promise.resolve()
    }
    if (this.phase === 'running') return this.running ?? Promise.resolve()
    return this.executeNext('paused')
  }

  run(): Promise<void> {
    if (this.catalogEntry().availability.state === 'unavailable') {
      this.publishUnavailable()
      return Promise.resolve()
    }
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

  reset(): void {
    this.generation += 1
    this.runtime.client.dispose()
    this.runtime.broker.dispose()
    this.cursor = 0
    this.activities = []
    this.bindings = new Map()
    this.error = undefined
    this.phase = 'idle'
    this.running = undefined
    this.replaceRuntime()
    this.publish()
  }

  dispose(): void {
    this.generation += 1
    this.runtime.client.dispose()
    this.runtime.broker.dispose()
    this.listeners.clear()
  }

  private replaceRuntime(): void {
    this.runtime = this.runtimeFactory()
  }

  private catalogEntry(): PlaygroundScenarioCatalogEntry {
    return PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === this.selectedScenarioId)!
  }

  private publishUnavailable(): void {
    const availability = this.catalogEntry().availability
    if (availability.state !== 'unavailable') return
    this.phase = 'unavailable'
    if (!this.activities.some(activity => activity.kind === 'unavailable')) {
      this.append('unavailable', `${availability.code}: ${availability.needApi}`)
    } else {
      this.publish()
    }
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
    bindings: Map<string, AgentLoopTaskBindingV2>,
    alias: string,
    definition: AgentDefinition,
  ): Promise<void> {
    const scenarioId = this.selectedScenarioId
    const result = await runtime.client.createOrBind(createCommand(scenarioId, alias, definition))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') throw new Error(`create ${alias}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    bindings.set(alias, result.binding)
    this.append('result', `create ${alias}: ${result.delivery.disposition}`)
  }

  private async send(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV2>,
    alias: string,
    ordinal: number,
    text: string,
  ): Promise<void> {
    const scenarioId = this.selectedScenarioId
    const binding = bindings.get(alias)
    if (binding === undefined) throw new Error(`binding ${alias} is unavailable`)
    const result = await runtime.client.send(sendCommand(scenarioId, alias, ordinal, binding, text))
    if (!this.current(generation, runtime, bindings)) return
    if (result.status !== 'accepted') throw new Error(`send ${alias}/${ordinal}: ${result.status}${'code' in result ? `/${result.code}` : ''}`)
    this.append('result', `send ${alias}/${ordinal}: ${result.delivery.disposition}`)
  }

  private current(
    generation: number,
    runtime: PlaygroundScenarioLabRuntime,
    bindings: Map<string, AgentLoopTaskBindingV2>,
  ): boolean {
    return generation === this.generation && runtime === this.runtime && bindings === this.bindings
  }

  private append(kind: PlaygroundScenarioActivity['kind'], message: string): void {
    this.activities = [...this.activities, { sequence: this.activities.length + 1, kind, message }]
    this.publish()
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
