import type { AgentDefinition, AgentDefinitionIdentity, AgentLoopContentPart } from '../agent-loop-contracts.js'
import type { CordisXPlatformResult, CordisXPlatformSessionRef } from '../platform-contracts.js'
import type {
  CordisXAgentLoopCreateContext,
  CordisXAgentLoopHost,
  CordisXAgentLoopPrepared,
  CordisXResolvedAgentDefinition,
} from './agent-loop.js'
import type { CordisXAgentLoopLifecycleEvent } from './provider-binding.js'

export const PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE = 'debug:agent-loop/mock/v1' as const

export interface PlaygroundMockCliInvocation {
  readonly namespace: typeof PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE
  readonly operation: 'respond' | 'review'
  readonly argv: readonly string[]
  readonly input: string
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

export interface PlaygroundMockTaskDetailsUrl {
  readonly url: string
  readonly target: 'host' | 'external'
}

export interface PlaygroundMockTaskTrace {
  readonly debugTaskId: string
  readonly detailsUrl: PlaygroundMockTaskDetailsUrl
  readonly roomLabel: string
  readonly memberLabel: string
  readonly runLabel: string
  readonly active: boolean
  readonly status: 'created' | 'working' | 'approval' | 'completed' | 'error' | 'closed'
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
    readonly result: PlaygroundMockCliResult
  }
  readonly events: readonly {
    readonly sequence: number
    readonly type: 'task.created' | 'input.accepted' | 'execution.started' | 'approval.required' | 'execution.completed' | 'execution.failed' | 'task.closed'
    readonly detail: string
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
}

interface TaskRecord {
  readonly hostTask: HostTask
  readonly definition: CordisXResolvedAgentDefinition
  readonly context: CordisXAgentLoopCreateContext
  trace: PlaygroundMockTaskTrace
  lifecycle: CordisXAgentLoopLifecycleEvent[]
  nextTurn: number
}

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function clone<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}

function redactedClone<Value>(value: Value): Value {
  const redact = (input: unknown): unknown => {
    if (typeof input === 'string') return sanitized(input)
    if (Array.isArray(input)) return input.map(redact)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, redact(child)]))
  }
  return freeze(redact(value) as Value)
}

function sanitized(value: string): string {
  return value
    .replace(/\b(token|credential|password|api[-_]?key)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/(?:^|\s)(\/(?:[^\s/]+\/)*[^\s]+)/gu, match => `${match.startsWith(' ') ? ' ' : ''}[path redacted]`)
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

function memberLabel(definition: CordisXResolvedAgentDefinition): 'Leader' | 'Reviewer' {
  return definition.promptSections?.some(section => section.kind === 'role' && /review/iu.test(`${section.sectionId} ${section.text}`)) === true
    ? 'Reviewer'
    : 'Leader'
}

export class DeterministicPlaygroundMockCliExecutor implements PlaygroundMockCliExecutor {
  readonly invocations: PlaygroundMockCliInvocation[] = []

  async execute(input: PlaygroundMockCliInvocation): Promise<PlaygroundMockCliResult> {
    const invocation = clone(input)
    this.invocations.push(invocation)
    if (/\[cli-fail\]/iu.test(invocation.input)) {
      return clone({ status: 'error', error: { code: 'SIMULATED_CLI_FAILURE', message: 'The debug-only deterministic CLI adapter was asked to fail.' } })
    }
    const actor = invocation.operation === 'review' ? 'Reviewer' : 'Leader'
    return clone({ status: 'ok', stdout: `[Mock / Simulator] ${actor} processed: ${invocation.input}` })
  }
}

/**
 * Playground-only deterministic AgentLoop host. It never starts a provider,
 * model, App Server, external process, network request, login flow, or Codex
 * task. Its namespace is deliberately debug-only and not a product contract.
 */
export class PlaygroundMockAgentLoopHost implements CordisXAgentLoopHost {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly memberRuns = new Map<string, number>()
  private nextTask = 1

  constructor(private readonly executor: PlaygroundMockCliExecutor = new DeterministicPlaygroundMockCliExecutor()) {}

  snapshot(): PlaygroundMockAgentLoopSnapshot {
    return redactedClone({
      namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
      label: 'Mock / Simulator',
      tasks: [...this.tasks.values()].map(record => record.trace),
    })
  }

  taskDetails(debugTaskId: string): PlaygroundMockTaskTrace | undefined {
    const trace = [...this.tasks.values()].find(record => record.trace.debugTaskId === debugTaskId)?.trace
    return trace === undefined ? undefined : redactedClone(trace)
  }

  /** Active/waiting/attention Simulator runs only; failed and closed traces stay out. */
  activeTaskPresentations(identity?: AgentDefinitionIdentity): readonly PlaygroundMockTaskTrace[] {
    return clone([...this.tasks.values()]
      .map(record => record.trace)
      .filter(trace => trace.active
        && (identity === undefined || (trace.identity.agentId === identity.agentId && trace.identity.revision === identity.revision))))
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
    const label = memberLabel(definition)
    const run = (this.memberRuns.get(label) ?? 0) + 1
    this.memberRuns.set(label, run)
    const hostTask = clone({
      task: `${PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE}:task:${ordinal}`,
      session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: `simulated-session-${ordinal}` },
    })
    const byIdentity = new Map(context.definitions.map(item => [JSON.stringify([item.identity.agentId, item.identity.revision]), item]))
    const trace = clone({
      debugTaskId: `Simulator Task ${ordinal}`,
      detailsUrl: { url: `app://-/playground/simulator/tasks/${encodeURIComponent(`Simulator Task ${ordinal}`)}`, target: 'host' as const },
      roomLabel: 'Room 1',
      memberLabel: label,
      runLabel: `Run ${run}`,
      status: 'created' as const,
      active: true,
      identity: definition.identity,
      catalog: context.definitions,
      layers: definition.sourceDefinitions.map(identity => effectiveLayer(byIdentity.get(JSON.stringify([identity.agentId, identity.revision]))!)),
      effective: {
        promptSections: definition.promptSections,
        rules: definition.rules,
        skills: definition.skills,
        tools: definition.tools,
        mcpServers: definition.mcpServers,
        runtimeDefaults: definition.runtimeDefaults,
      },
      events: [{ sequence: 0, type: 'task.created' as const, detail: `${label} prompt resolved from ${definition.sourceDefinitions.length} layer(s).` }],
    })
    this.tasks.set(hostTask.task, { hostTask, definition: clone(definition), context: clone(context), trace, lifecycle: [], nextTurn: 1 })
    return { ok: true, value: hostTask }
  }

  async bind(task: string): Promise<CordisXPlatformResult<HostTask>> {
    const record = this.tasks.get(task)
    return record === undefined
      ? { ok: false, error: { code: 'task-not-found', message: 'The simulated task is unavailable.' } }
      : { ok: true, value: clone(record.hostTask) }
  }

  async send(task: HostTask, content: readonly [AgentLoopContentPart, ...AgentLoopContentPart[]]) {
    const record = this.tasks.get(task.task)
    if (record === undefined) return { ok: false as const, error: { code: 'task-not-found' as const, message: 'The simulated task is unavailable.' } }
    if (content.some(part => part.kind === 'image-ref')) {
      return { ok: false as const, error: { code: 'adapter-unavailable' as const, message: 'The Simulator has no image-ref resolver.' } }
    }
    const input = sanitized(content.map(part => part.kind === 'text' ? part.text : '').join('\n').trim())
    if (input === '') return { ok: false as const, error: { code: 'invalid-request' as const, message: 'The simulated input is empty.' } }
    const turnId = `simulated-turn-${record.nextTurn++}`
    const operation = record.trace.memberLabel === 'Reviewer' ? 'review' as const : 'respond' as const
    const invocation = clone({
      namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
      operation,
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
      this.appendLifecycle(record, { turnId, type: 'turn.failed', failure: { code: result.error!.code, retryable: false } })
    } else if (/\[working\]/iu.test(input)) {
      // Explicit deterministic script state: accepted and working, without a
      // fabricated terminal transition.
      this.updateTrace(record, 'working', input, execution, [])
    } else {
      if (/\[approval\]/iu.test(input)) {
        this.updateTrace(record, 'approval', input, execution, [{ type: 'approval.required', detail: 'The Simulator emitted a deterministic approval round-trip.' }])
        this.appendLifecycle(record, { turnId, type: 'approval.required', approval: { approvalId: `simulated-approval-${turnId}`, kind: 'command', state: 'pending' } })
        this.appendLifecycle(record, { turnId, type: 'approval.resolved', approval: { approvalId: `simulated-approval-${turnId}`, kind: 'command', state: 'resolved', outcome: 'approved' } })
      }
      this.updateTrace(record, 'completed', input, execution, [{ type: 'execution.completed', detail: 'The deterministic CLI adapter returned a simulated result.' }])
      this.appendLifecycle(record, { turnId, type: 'turn.completed', output: [{ type: 'text', text: result.stdout! }] })
    }
    return { ok: true as const, value: { messageId: `simulated-message-${turnId}`, turn: turnId } }
  }

  async lifecycle(task: HostTask, afterSequence: number) {
    const events = (this.tasks.get(task.task)?.lifecycle ?? []).filter(event => event.sequence > afterSequence)
    return clone({ nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, events })
  }

  release(task: HostTask): void {
    const record = this.tasks.get(task.task)
    if (record === undefined || record.trace.status === 'closed') return
    const sequence = record.trace.events.length
    record.trace = clone({
      ...record.trace,
      active: false,
      status: record.trace.status === 'error' ? 'error' : 'closed',
      events: [...record.trace.events, { sequence, type: 'task.closed', detail: 'The bound Simulator run was disposed.' }],
    })
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
