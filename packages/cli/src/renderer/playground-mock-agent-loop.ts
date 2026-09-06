import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v2'
import type { AgentDetailReference } from '@cordisx/protocol/agents/v1'
import type { SessionEvent } from '@cordisx/protocol/sessions/v1'
import type { AgentDefinition, AgentDefinitionIdentity, AgentLoopContentPart } from '../agent-loop-contracts.js'
import type { CordisXPlatformResult, CordisXPlatformSessionRef } from '../platform-contracts.js'
import type { PlaygroundSessionScenarioEventData } from '../playground/session-scenario-catalog.js'
import type {
  CordisXAgentLoopCreateContext,
  CordisXAgentLoopHost,
  CordisXAgentLoopPrepared,
  CordisXResolvedAgentDefinition,
} from './agent-loop.js'
import {
  clone,
  PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
  redactedClone,
  sanitized,
} from './playground-mock-agent-loop-values.js'
import type { PlaygroundRoomSimulationBinding } from './playground-room-simulation-bridge.js'
import type { CordisXAgentLoopLifecycleEvent } from './provider-binding.js'
export { PlaygroundMockAgentLoopV4Transport } from './playground-mock-agent-loop-transport.js'
export { PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE } from './playground-mock-agent-loop-values.js'

function simulatorTaskScope(seed: string): string {
  if (seed === '') return ''
  let hash = 2166136261
  for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
  return hash.toString(36)
}

export interface PlaygroundMockCliInvocation {
  readonly namespace: typeof PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE
  readonly operation: 'execute' | 'introduce-member'
  readonly identity: AgentDefinitionIdentity
  readonly argv: readonly string[]
  readonly input?: string
  readonly definition?: CordisXResolvedAgentDefinition
  readonly intent?: {
    readonly kind: 'member-self-introduction'
    readonly participantId: string
    readonly memberId: string
    readonly runId: string
  }
}

export interface PlaygroundMockCliResult {
  readonly status: 'ok' | 'error'
  readonly stdout?: string
  readonly error?: { readonly code: 'SIMULATED_CLI_FAILURE'; readonly message: string }
}

export interface PlaygroundMockCliExecutor {
  execute(invocation: PlaygroundMockCliInvocation): Promise<PlaygroundMockCliResult>
}

export interface PlaygroundMockTraceLayer {
  readonly identity: AgentDefinitionIdentity
  readonly promptSections: AgentDefinition['promptSections']
  readonly rules: AgentDefinition['rules']
  readonly skills: AgentDefinition['skills']
  readonly tools: AgentDefinition['tools']
  readonly mcpServers: AgentDefinition['mcpServers']
  readonly runtimeDefaults: AgentDefinition['runtimeDefaults']
}

export type PlaygroundMockTaskDetailsUrl = AgentLoopTaskDetailsUrl

export interface PlaygroundMockTaskTrace {
  readonly taskRef: string
  readonly origin?: 'simulator' | 'host-session' | 'agent-session'
  readonly sessionId?: string
  readonly sessionGeneration?: number
  readonly agentGeneration?: number
  readonly agentDetail?: AgentDetailReference
  readonly debugTaskId: string
  readonly detailsUrl: PlaygroundMockTaskDetailsUrl
  readonly agentLabel: string
  readonly active: boolean
  readonly status: 'created' | 'working' | 'approval' | 'completed' | 'error' | 'closed'
  /** Exact mounted Room correlation captured when this task is opened from a Host active session. */
  readonly simulationBinding?: PlaygroundRoomSimulationBinding
  /** Derived solely from the latest Host-owned scenario SessionEvent. */
  readonly scenario?: PlaygroundSessionScenarioEventData
  readonly identity: AgentDefinitionIdentity
  readonly catalog: readonly AgentDefinition[]
  readonly layers: readonly PlaygroundMockTraceLayer[]
  readonly effective: {
    readonly promptSections: AgentDefinition['promptSections']
    readonly rules: AgentDefinition['rules']
    readonly skills: AgentDefinition['skills']
    readonly tools: AgentDefinition['tools']
    readonly mcpServers: AgentDefinition['mcpServers']
    readonly runtimeDefaults: AgentDefinition['runtimeDefaults']
  }
  readonly input?: string
  readonly execution?: {
    readonly namespace: typeof PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE
    readonly operation: PlaygroundMockCliInvocation['operation']
    readonly argv: readonly string[]
    readonly input?: string
    readonly result: PlaygroundMockCliResult
  }
  readonly events: readonly {
    readonly sequence: number
    readonly type:
      | 'task.created'
      | 'task.bound'
      | 'input.accepted'
      | 'execution.started'
      | 'approval.required'
      | 'execution.completed'
      | 'execution.failed'
      | 'task.closed'
      | 'semantic.message'
      | 'tool.call'
      | 'tool.result'
      | 'session.event'
    readonly detail: string
    /** Exact read-only fact when this row is projected from Agent/Session. */
    readonly sessionEvent?: SessionEvent
    readonly operationId?: string
    readonly purpose?: 'conversation' | 'member-self-introduction'
    readonly turn?: string
    readonly messageId?: string
    readonly participantId?: string
    readonly memberId?: string
    readonly runId?: string
  }[]
}

export interface PlaygroundMockAgentLoopSnapshot {
  readonly namespace: typeof PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE
  readonly label: 'Mock / Simulator'
  readonly tasks: readonly PlaygroundMockTaskTrace[]
}

interface HostTask {
  readonly task: string
  readonly session: CordisXPlatformSessionRef
  readonly detailsUrl?: AgentLoopTaskDetailsUrl
}

interface TaskRecord {
  readonly hostTask: HostTask
  readonly definition: CordisXResolvedAgentDefinition
  readonly context: CordisXAgentLoopCreateContext
  trace: PlaygroundMockTaskTrace
  lifecycle: CordisXAgentLoopLifecycleEvent[]
  nextTurn: number
  activeBindings: number
}

export interface PlaygroundMockAgentLoopPersistence {
  read(): string | undefined
  write(value: string): void
}

interface PlaygroundMockAgentLoopPersistedState {
  readonly version: 2
  readonly nextTask: number
  readonly tasks: readonly { readonly task: string; readonly record: TaskRecord }[]
}

function effectiveLayer(definition: AgentDefinition): PlaygroundMockTraceLayer {
  return clone({
    identity: definition.identity,
    promptSections: definition.promptSections,
    rules: definition.rules,
    skills: definition.skills,
    tools: definition.tools,
    mcpServers: definition.mcpServers,
    runtimeDefaults: definition.runtimeDefaults,
  })
}

export class DeterministicPlaygroundMockCliExecutor implements PlaygroundMockCliExecutor {
  readonly invocations: PlaygroundMockCliInvocation[] = []

  async execute(input: PlaygroundMockCliInvocation): Promise<PlaygroundMockCliResult> {
    const invocation = clone(input)
    this.invocations.push(invocation)
    if (invocation.operation === 'introduce-member') {
      if (invocation.definition === undefined || invocation.intent === undefined) {
        return clone({
          status: 'error',
          error: { code: 'SIMULATED_CLI_FAILURE', message: 'The structured introduction invocation is incomplete.' },
        })
      }
      const encoded = JSON.stringify(invocation.definition)
      let hash = 2166136261
      for (const character of encoded) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
      const focus = [
        'focused analysis',
        'useful collaboration',
        'clear next steps',
        'careful feedback',
        'practical direction',
        'well-structured decisions',
      ][hash % 6]!
      const name = sanitized(invocation.definition.name ?? invocation.definition.identity.agentId)
        .replace(/\b(?:mock|simulator)\b/giu, 'Assistant')
      return clone({
        status: 'ok',
        stdout: `I’m ${name}. I’ll contribute ${focus} and help the conversation move toward a useful outcome.`,
      })
    }
    if (/\[cli-fail\]/iu.test(invocation.input ?? '')) {
      return clone({
        status: 'error',
        error: {
          code: 'SIMULATED_CLI_FAILURE',
          message: 'The debug-only deterministic CLI adapter was asked to fail.',
        },
      })
    }
    return clone({ status: 'ok', stdout: 'Completed successfully.' })
  }
}

/**
 * Playground-only deterministic AgentLoop host. It never starts a provider,
 * model, App Server, external process, network request, login flow, or Codex
 * task. Its namespace is deliberately debug-only and not a product contract.
 */
export class PlaygroundMockAgentLoopHost implements CordisXAgentLoopHost {
  private readonly tasks = new Map<string, TaskRecord>()
  private nextTask = 1

  constructor(
    private readonly executor: PlaygroundMockCliExecutor = new DeterministicPlaygroundMockCliExecutor(),
    private readonly persistence?: PlaygroundMockAgentLoopPersistence,
    taskScopeSeed = '',
  ) {
    this.taskScope = simulatorTaskScope(taskScopeSeed)
    this.restore()
  }

  private readonly taskScope: string

  snapshot(): PlaygroundMockAgentLoopSnapshot {
    return redactedClone({
      namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
      label: 'Mock / Simulator',
      tasks: [...this.tasks.values()].map(record => record.trace),
    })
  }

  /** Clears only the in-memory/durable debug Simulator state for this Playground runtime. */
  resetPlaygroundState(): void {
    this.tasks.clear()
    this.nextTask = 1
    this.persist()
  }

  taskDetails(taskRef: string): PlaygroundMockTaskTrace | undefined {
    const trace = this.tasks.get(taskRef)?.trace
      ?? [...this.tasks.values()].find(record => record.trace.debugTaskId === taskRef)?.trace
    return trace === undefined ? undefined : redactedClone(trace)
  }

  /** Active/waiting/attention Simulator runs only; failed and closed traces stay out. */
  activeTaskPresentations(identity?: AgentDefinitionIdentity): readonly PlaygroundMockTaskTrace[] {
    return clone(
      [...this.tasks.values()]
        .map(record => record.trace)
        .filter(trace =>
          trace.active
          && (identity === undefined
            || (trace.identity.agentId === identity.agentId && trace.identity.revision === identity.revision))
        ),
    )
  }

  async prepare(): Promise<CordisXPlatformResult<CordisXAgentLoopPrepared>> {
    return { ok: true, value: {} }
  }

  async create(
    definition: CordisXResolvedAgentDefinition,
    _prepared: CordisXAgentLoopPrepared,
    context: CordisXAgentLoopCreateContext,
  ): Promise<CordisXPlatformResult<HostTask>> {
    const ordinal = this.nextTask++
    const taskRef = this.taskScope === ''
      ? `${PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE}:task:${ordinal}`
      : `${PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE}:scope:${this.taskScope}:task:${ordinal}`
    const hostTask = clone({
      task: taskRef,
      session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: `simulated-session-${ordinal}` },
      detailsUrl: {
        url: `app://-/playground/simulator/tasks/${encodeURIComponent(taskRef)}` as const,
        target: 'host' as const,
      },
    })
    const byIdentity = new Map(
      context.definitions.map(item => [JSON.stringify([item.identity.agentId, item.identity.revision]), item]),
    )
    const trace = clone({
      taskRef,
      origin: 'simulator' as const,
      debugTaskId: `Simulator Task ${ordinal}`,
      detailsUrl: hostTask.detailsUrl,
      agentLabel: definition.name ?? definition.identity.agentId,
      status: 'created' as const,
      active: true,
      identity: definition.identity,
      catalog: context.definitions,
      layers: definition.sourceDefinitions.map(identity =>
        effectiveLayer(byIdentity.get(JSON.stringify([identity.agentId, identity.revision]))!)
      ),
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
        type: 'task.created' as const,
        detail:
          `Agent ${definition.identity.agentId} prompt resolved from ${definition.sourceDefinitions.length} layer(s).`,
      }],
    })
    this.tasks.set(hostTask.task, {
      hostTask,
      definition: clone(definition),
      context: clone(context),
      trace,
      lifecycle: [],
      nextTurn: 1,
      activeBindings: 1,
    })
    this.persist()
    return { ok: true, value: hostTask }
  }

  async bind(task: string): Promise<CordisXPlatformResult<HostTask>> {
    const record = this.tasks.get(task)
    if (record === undefined) {
      return { ok: false, error: { code: 'task-not-found', message: 'The simulated task is unavailable.' } }
    }
    record.activeBindings += 1
    if (!record.trace.active) {
      const sequence = record.trace.events.length
      record.trace = clone({
        ...record.trace,
        active: true,
        events: [...record.trace.events, {
          sequence,
          type: 'task.bound',
          detail: 'The Simulator task was explicitly rebound.',
        }],
      })
    }
    this.persist()
    return { ok: true, value: clone(record.hostTask) }
  }

  async send(
    task: HostTask,
    content: readonly [AgentLoopContentPart, ...AgentLoopContentPart[]],
    options: { readonly autoResolveApproval?: boolean } = {},
  ) {
    const record = this.tasks.get(task.task)
    if (record === undefined) {
      return {
        ok: false as const,
        error: { code: 'task-not-found' as const, message: 'The simulated task is unavailable.' },
      }
    }
    if (content.some(part => part.kind === 'image-ref')) {
      return {
        ok: false as const,
        error: { code: 'adapter-unavailable' as const, message: 'The Simulator has no image-ref resolver.' },
      }
    }
    const input = sanitized(content.map(part => part.kind === 'text' ? part.text : '').join('\n').trim())
    if (input === '') {
      return {
        ok: false as const,
        error: { code: 'invalid-request' as const, message: 'The simulated input is empty.' },
      }
    }
    const turnId = `simulated-turn-${record.nextTurn++}`
    const operation = 'execute' as const
    const invocation = clone({
      namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
      operation,
      identity: record.trace.identity,
      argv: [PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, operation, '--format', 'text'],
      input,
    })
    this.updateTrace(record, 'working', input, undefined, [
      { type: 'input.accepted', detail: 'The Simulator accepted one structured text input.' },
      { type: 'execution.started', detail: `${operation} invoked through the debug-only deterministic CLI adapter.` },
    ])
    const result = await this.executor.execute(invocation)
    const execution = clone({ namespace: invocation.namespace, operation, argv: invocation.argv, result })
    if (result.status === 'error') {
      this.updateTrace(record, 'error', input, execution, [{ type: 'execution.failed', detail: result.error!.message }])
      record.trace = clone({ ...record.trace, active: false })
      this.appendLifecycle(record, {
        turnId,
        type: 'turn.failed',
        failure: { code: result.error!.code, retryable: false },
      })
    } else if (/\[working\]/iu.test(input)) {
      // Explicit deterministic script state: accepted and working, without a
      // fabricated terminal transition.
      this.updateTrace(record, 'working', input, execution, [])
    } else {
      if (/\[approval\]/iu.test(input)) {
        this.updateTrace(record, 'approval', input, execution, [{
          type: 'approval.required',
          detail: 'The Simulator emitted a deterministic approval round-trip.',
        }])
        this.appendLifecycle(record, {
          turnId,
          type: 'approval.required',
          approval: { approvalId: `simulated-approval-${turnId}`, kind: 'command', state: 'pending' },
        })
        if (options.autoResolveApproval !== false) {
          this.appendLifecycle(record, {
            turnId,
            type: 'approval.resolved',
            approval: {
              approvalId: `simulated-approval-${turnId}`,
              kind: 'command',
              state: 'resolved',
              outcome: 'approved',
            },
          })
        }
      }
      this.updateTrace(record, 'completed', input, execution, [{
        type: 'execution.completed',
        detail: 'The deterministic CLI adapter returned a simulated result.',
      }])
      this.appendLifecycle(record, { turnId, type: 'turn.completed', output: [{ type: 'text', text: result.stdout! }] })
    }
    this.persist()
    return { ok: true as const, value: { messageId: `simulated-message-${turnId}`, turn: turnId } }
  }

  async lifecycle(task: HostTask, afterSequence: number) {
    const events = (this.tasks.get(task.task)?.lifecycle ?? []).filter(event => event.sequence > afterSequence)
    return clone({ nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, events })
  }

  appendV4Lifecycle(task: string, event: Omit<CordisXAgentLoopLifecycleEvent, 'sequence' | 'session'>): boolean {
    const record = this.tasks.get(task)
    if (record === undefined) return false
    this.appendLifecycle(record, event)
    this.persist()
    return true
  }

  reserveSemanticTurn(
    task: string,
    purpose: 'member-self-introduction',
  ): { readonly turn: string; readonly messageId: string } | undefined {
    const record = this.tasks.get(task)
    if (record === undefined) return undefined
    const ordinal = record.nextTurn++
    this.persist()
    const turn = `simulated-${purpose}-turn-${ordinal}`
    return { turn, messageId: `simulated-${purpose}-message-${ordinal}` }
  }

  hasPendingApproval(task: string, turn: string, approvalId: string): boolean {
    const events =
      this.tasks.get(task)?.lifecycle.filter(event =>
        event.turnId === turn && event.approval?.approvalId === approvalId
      ) ?? []
    return events.at(-1)?.type === 'approval.required'
  }

  async memberSelfIntroduction(
    task: string,
    intent: { readonly participantId: string; readonly memberId: string; readonly runId: string },
  ): Promise<
    { readonly status: 'ok'; readonly text: string } | {
      readonly status: 'error'
      readonly failure: { readonly code: string; readonly retryable: true }
    }
  > {
    const record = this.tasks.get(task)
    if (record === undefined) return { status: 'error', failure: { code: 'SIMULATED_CLI_FAILURE', retryable: true } }
    const input = JSON.stringify({ kind: 'member-self-introduction', ...intent })
    const invocation = clone(
      {
        namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
        operation: 'introduce-member',
        identity: record.definition.identity,
        argv: [PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, 'introduce-member', '--format', 'text'],
        input,
        definition: record.definition,
        intent: { kind: 'member-self-introduction', ...intent },
      } as const,
    )
    this.updateTrace(record, 'working', input, undefined, [{
      type: 'execution.started',
      detail: 'The structured member self-introduction CLI executor started.',
    }])
    const result = await this.executor.execute(invocation)
    const execution = clone({
      namespace: invocation.namespace,
      operation: invocation.operation,
      argv: invocation.argv,
      input: invocation.input,
      result,
    })
    if (result.status === 'error') {
      this.updateTrace(record, 'error', input, execution, [{ type: 'execution.failed', detail: result.error!.message }])
      this.persist()
      return { status: 'error', failure: { code: result.error!.code, retryable: true } }
    }
    this.updateTrace(record, 'completed', input, execution, [{
      type: 'execution.completed',
      detail: 'The structured member self-introduction CLI executor returned a provider-generated result.',
    }])
    this.persist()
    return { status: 'ok', text: sanitized(result.stdout ?? '') }
  }

  recordSemantic(
    task: string,
    event: Omit<PlaygroundMockTaskTrace['events'][number], 'sequence' | 'type' | 'detail'>,
  ): void {
    const record = this.tasks.get(task)
    if (record === undefined) return
    record.trace = clone({
      ...record.trace,
      events: [...record.trace.events, {
        sequence: record.trace.events.length,
        type: 'semantic.message',
        detail: 'Redacted semantic message association.',
        ...event,
      }],
    })
    this.persist()
  }

  release(task: HostTask): void {
    const record = this.tasks.get(task.task)
    if (record === undefined || record.activeBindings === 0) return
    record.activeBindings -= 1
    if (record.activeBindings > 0) return
    const sequence = record.trace.events.length
    record.trace = clone({
      ...record.trace,
      active: false,
      events: [...record.trace.events, {
        sequence,
        type: 'task.closed',
        detail: 'The bound Simulator run was disposed.',
      }],
    })
    this.persist()
  }

  private restore(): void {
    try {
      const raw = this.persistence?.read()
      if (raw === undefined) return
      const value = JSON.parse(raw) as Partial<PlaygroundMockAgentLoopPersistedState>
      if (
        value.version !== 2 || !Number.isSafeInteger(value.nextTask) || (value.nextTask ?? 0) < 1
        || !Array.isArray(value.tasks)
      ) return
      const restored = new Map<string, TaskRecord>()
      for (const entry of value.tasks) {
        if (entry === null || typeof entry !== 'object' || typeof entry.task !== 'string' || entry.task === '') return
        const record = entry.record as TaskRecord | undefined
        if (
          record === undefined || record.hostTask?.task !== entry.task || typeof record.trace?.debugTaskId !== 'string'
          || !Number.isSafeInteger(record.nextTurn) || record.nextTurn < 1
          || !Number.isSafeInteger(record.activeBindings) || record.activeBindings < 0
          || !Array.isArray(record.lifecycle) || !Array.isArray(record.trace.events)
        ) return
        const detailsUrl = clone({
          url: `app://-/playground/simulator/tasks/${encodeURIComponent(entry.task)}` as const,
          target: 'host' as const,
        })
        restored.set(entry.task, {
          hostTask: clone({ ...record.hostTask, detailsUrl }),
          definition: clone(record.definition),
          context: clone(record.context),
          trace: clone({
            ...record.trace,
            taskRef: entry.task,
            origin: record.trace.origin ?? 'simulator',
            detailsUrl,
            active: false,
          }),
          lifecycle: record.lifecycle.map(event => clone(event)),
          nextTurn: record.nextTurn,
          // A renderer reload ends every prior in-memory binding. The plugin
          // must explicitly bind its durable task again in the new runtime.
          activeBindings: 0,
        })
      }
      this.nextTask = value.nextTask as number
      for (const [task, record] of restored) this.tasks.set(task, record)
    } catch {
      // Corrupt debug-only session state fails closed to a deterministic empty registry.
    }
  }

  private persist(): void {
    if (this.persistence === undefined) return
    try {
      const value: PlaygroundMockAgentLoopPersistedState = {
        version: 2,
        nextTask: this.nextTask,
        tasks: [...this.tasks].map(([task, record]) => ({ task, record })),
      }
      this.persistence.write(JSON.stringify(value))
    } catch {
      // The Simulator remains usable when the browser denies session storage.
    }
  }

  private updateTrace(
    record: TaskRecord,
    status: PlaygroundMockTaskTrace['status'],
    input: string,
    execution: PlaygroundMockTaskTrace['execution'] | undefined,
    events: readonly Omit<PlaygroundMockTaskTrace['events'][number], 'sequence'>[],
  ): void {
    const offset = record.trace.events.length
    record.trace = clone({
      ...record.trace,
      active: status !== 'error' && record.activeBindings > 0,
      status,
      input,
      ...(execution === undefined ? {} : { execution }),
      events: [...record.trace.events, ...events.map((event, index) => ({ ...event, sequence: offset + index }))],
    })
  }

  private appendLifecycle(
    record: TaskRecord,
    event: Omit<CordisXAgentLoopLifecycleEvent, 'sequence' | 'session'>,
  ): void {
    record.lifecycle.push(clone({ ...event, sequence: record.lifecycle.length + 1, session: record.hostTask.session }))
  }
}

/** Playground-only v4 transport. It never claims launcher/provider durability. */
