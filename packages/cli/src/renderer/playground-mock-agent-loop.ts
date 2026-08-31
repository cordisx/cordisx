import type { AgentDefinition, AgentDefinitionIdentity, AgentLoopContentPart } from '../agent-loop-contracts.js'
import type { AgentLoopTaskDetailsUrl } from '@cordisx/protocol/agent-loop/v2'
import type { CordisXPlatformResult, CordisXPlatformSessionRef } from '../platform-contracts.js'
import type {
  CordisXAgentLoopCreateContext,
  CordisXAgentLoopHost,
  CordisXAgentLoopPrepared,
  CordisXResolvedAgentDefinition,
} from './agent-loop.js'
import { resolveAgentDefinition } from './agent-loop.js'
import type { CordisXAgentLoopLifecycleEvent } from './provider-binding.js'
import type { AgentLoopV4Transport } from './agent-loop-v4.js'

export const PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE = 'debug:agent-loop/mock/v1' as const

const simulatorBindingId = (task: string) => `simulated-binding-${task.replace(/[^A-Za-z0-9._~-]/gu, '~')}`

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
  readonly debugTaskId: string
  readonly detailsUrl: PlaygroundMockTaskDetailsUrl
  readonly agentLabel: string
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
    readonly input?: string
    readonly result: PlaygroundMockCliResult
  }
  readonly events: readonly {
    readonly sequence: number
    readonly type: 'task.created' | 'task.bound' | 'input.accepted' | 'execution.started' | 'approval.required' | 'execution.completed' | 'execution.failed' | 'task.closed' | 'semantic.message'
    readonly detail: string
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

interface PlaygroundMockV4PersistedState {
  readonly version: 2
  readonly results: readonly { readonly key: string; readonly fingerprint: string; readonly result: unknown }[]
  readonly bindings: readonly { readonly key: string; readonly task: string; readonly bindingId: string; readonly generation: number; readonly definition: AgentDefinitionIdentity }[]
  readonly introductions: readonly { readonly key: string; readonly value: { readonly task: string; readonly turn: string; readonly messageId: string; readonly participantId: string; readonly memberId: string; readonly runId: string; readonly state: 'pending' | 'completed' | 'cancelled' | 'failed' } }[]
  readonly resources: readonly { readonly key: string; readonly operationId: string }[]
}

interface PlaygroundMockAgentLoopPersistedState {
  readonly version: 2
  readonly nextTask: number
  readonly tasks: readonly { readonly task: string; readonly record: TaskRecord }[]
}

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function clone<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}

function fingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return JSON.stringify(canonical(value))
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

export class DeterministicPlaygroundMockCliExecutor implements PlaygroundMockCliExecutor {
  readonly invocations: PlaygroundMockCliInvocation[] = []

  async execute(input: PlaygroundMockCliInvocation): Promise<PlaygroundMockCliResult> {
    const invocation = clone(input)
    this.invocations.push(invocation)
    if (invocation.operation === 'introduce-member') {
      if (invocation.definition === undefined || invocation.intent === undefined) {
        return clone({ status: 'error', error: { code: 'SIMULATED_CLI_FAILURE', message: 'The structured introduction invocation is incomplete.' } })
      }
      const encoded = JSON.stringify(invocation.definition)
      let hash = 2166136261
      for (const character of encoded) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0
      const focus = [
        'focused analysis', 'useful collaboration', 'clear next steps',
        'careful feedback', 'practical direction', 'well-structured decisions',
      ][hash % 6]!
      const name = sanitized(invocation.definition.name ?? invocation.definition.identity.agentId)
        .replace(/\b(?:mock|simulator)\b/giu, 'Assistant')
      return clone({ status: 'ok', stdout: `I’m ${name}. I’ll contribute ${focus} and help the conversation move toward a useful outcome.` })
    }
    if (/\[cli-fail\]/iu.test(invocation.input ?? '')) {
      return clone({ status: 'error', error: { code: 'SIMULATED_CLI_FAILURE', message: 'The debug-only deterministic CLI adapter was asked to fail.' } })
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
  ) { this.restore() }

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
    const hostTask = clone({
      task: `${PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE}:task:${ordinal}`,
      session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: `simulated-session-${ordinal}` },
      detailsUrl: {
        url: `app://-/playground/simulator/tasks/${encodeURIComponent(`Simulator Task ${ordinal}`)}` as const,
        target: 'host' as const,
      },
    })
    const byIdentity = new Map(context.definitions.map(item => [JSON.stringify([item.identity.agentId, item.identity.revision]), item]))
    const trace = clone({
      debugTaskId: `Simulator Task ${ordinal}`,
      detailsUrl: hostTask.detailsUrl,
      agentLabel: definition.name ?? definition.identity.agentId,
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
      events: [{ sequence: 0, type: 'task.created' as const, detail: `Agent ${definition.identity.agentId} prompt resolved from ${definition.sourceDefinitions.length} layer(s).` }],
    })
    this.tasks.set(hostTask.task, {
      hostTask, definition: clone(definition), context: clone(context), trace, lifecycle: [], nextTurn: 1, activeBindings: 1,
    })
    this.persist()
    return { ok: true, value: hostTask }
  }

  async bind(task: string): Promise<CordisXPlatformResult<HostTask>> {
    const record = this.tasks.get(task)
    if (record === undefined) return { ok: false, error: { code: 'task-not-found', message: 'The simulated task is unavailable.' } }
    record.activeBindings += 1
    if (!record.trace.active) {
      const sequence = record.trace.events.length
      record.trace = clone({
        ...record.trace,
        active: true,
        events: [...record.trace.events, { sequence, type: 'task.bound', detail: 'The Simulator task was explicitly rebound.' }],
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
    if (record === undefined) return { ok: false as const, error: { code: 'task-not-found' as const, message: 'The simulated task is unavailable.' } }
    if (content.some(part => part.kind === 'image-ref')) {
      return { ok: false as const, error: { code: 'adapter-unavailable' as const, message: 'The Simulator has no image-ref resolver.' } }
    }
    const input = sanitized(content.map(part => part.kind === 'text' ? part.text : '').join('\n').trim())
    if (input === '') return { ok: false as const, error: { code: 'invalid-request' as const, message: 'The simulated input is empty.' } }
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
      this.appendLifecycle(record, { turnId, type: 'turn.failed', failure: { code: result.error!.code, retryable: false } })
    } else if (/\[working\]/iu.test(input)) {
      // Explicit deterministic script state: accepted and working, without a
      // fabricated terminal transition.
      this.updateTrace(record, 'working', input, execution, [])
    } else {
      if (/\[approval\]/iu.test(input)) {
        this.updateTrace(record, 'approval', input, execution, [{ type: 'approval.required', detail: 'The Simulator emitted a deterministic approval round-trip.' }])
        this.appendLifecycle(record, { turnId, type: 'approval.required', approval: { approvalId: `simulated-approval-${turnId}`, kind: 'command', state: 'pending' } })
        if (options.autoResolveApproval !== false) {
          this.appendLifecycle(record, { turnId, type: 'approval.resolved', approval: { approvalId: `simulated-approval-${turnId}`, kind: 'command', state: 'resolved', outcome: 'approved' } })
        }
      }
      this.updateTrace(record, 'completed', input, execution, [{ type: 'execution.completed', detail: 'The deterministic CLI adapter returned a simulated result.' }])
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

  reserveSemanticTurn(task: string, purpose: 'member-self-introduction'): { readonly turn: string; readonly messageId: string } | undefined {
    const record = this.tasks.get(task)
    if (record === undefined) return undefined
    const ordinal = record.nextTurn++
    this.persist()
    const turn = `simulated-${purpose}-turn-${ordinal}`
    return { turn, messageId: `simulated-${purpose}-message-${ordinal}` }
  }

  hasPendingApproval(task: string, turn: string, approvalId: string): boolean {
    const events = this.tasks.get(task)?.lifecycle.filter(event => event.turnId === turn && event.approval?.approvalId === approvalId) ?? []
    return events.at(-1)?.type === 'approval.required'
  }

  async memberSelfIntroduction(task: string, intent: { readonly participantId: string; readonly memberId: string; readonly runId: string }): Promise<{ readonly status: 'ok'; readonly text: string } | { readonly status: 'error'; readonly failure: { readonly code: string; readonly retryable: true } }> {
    const record = this.tasks.get(task)
    if (record === undefined) return { status: 'error', failure: { code: 'SIMULATED_CLI_FAILURE', retryable: true } }
    const input = JSON.stringify({ kind: 'member-self-introduction', ...intent })
    const invocation = clone({
      namespace: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE,
      operation: 'introduce-member',
      identity: record.definition.identity,
      argv: [PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, 'introduce-member', '--format', 'text'],
      input,
      definition: record.definition,
      intent: { kind: 'member-self-introduction', ...intent },
    } as const)
    this.updateTrace(record, 'working', input, undefined, [{ type: 'execution.started', detail: 'The structured member self-introduction CLI executor started.' }])
    const result = await this.executor.execute(invocation)
    const execution = clone({ namespace: invocation.namespace, operation: invocation.operation, argv: invocation.argv, input: invocation.input, result })
    if (result.status === 'error') {
      this.updateTrace(record, 'error', input, execution, [{ type: 'execution.failed', detail: result.error!.message }])
      this.persist()
      return { status: 'error', failure: { code: result.error!.code, retryable: true } }
    }
    this.updateTrace(record, 'completed', input, execution, [{ type: 'execution.completed', detail: 'The structured member self-introduction CLI executor returned a provider-generated result.' }])
    this.persist()
    return { status: 'ok', text: sanitized(result.stdout ?? '') }
  }

  recordSemantic(task: string, event: Omit<PlaygroundMockTaskTrace['events'][number], 'sequence' | 'type' | 'detail'>): void {
    const record = this.tasks.get(task)
    if (record === undefined) return
    record.trace = clone({
      ...record.trace,
      events: [...record.trace.events, { sequence: record.trace.events.length, type: 'semantic.message', detail: 'Redacted semantic message association.', ...event }],
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
      events: [...record.trace.events, { sequence, type: 'task.closed', detail: 'The bound Simulator run was disposed.' }],
    })
    this.persist()
  }

  private restore(): void {
    try {
      const raw = this.persistence?.read()
      if (raw === undefined) return
      const value = JSON.parse(raw) as Partial<PlaygroundMockAgentLoopPersistedState>
      if (value.version !== 2 || !Number.isSafeInteger(value.nextTask) || (value.nextTask ?? 0) < 1 || !Array.isArray(value.tasks)) return
      const restored = new Map<string, TaskRecord>()
      for (const entry of value.tasks) {
        if (entry === null || typeof entry !== 'object' || typeof entry.task !== 'string' || entry.task === '') return
        const record = entry.record as TaskRecord | undefined
        if (record === undefined || record.hostTask?.task !== entry.task || typeof record.trace?.debugTaskId !== 'string'
          || !Number.isSafeInteger(record.nextTurn) || record.nextTurn < 1
          || !Number.isSafeInteger(record.activeBindings) || record.activeBindings < 0
          || !Array.isArray(record.lifecycle) || !Array.isArray(record.trace.events)) return
        restored.set(entry.task, {
          hostTask: clone(record.hostTask),
          definition: clone(record.definition),
          context: clone(record.context),
          trace: clone({ ...record.trace, active: false }),
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
export class PlaygroundMockAgentLoopV4Transport implements AgentLoopV4Transport {
  readonly debugMock = true as const
  private readonly results = new Map<string, { readonly fingerprint: string; readonly result: unknown }>()
  private readonly pending = new Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>()
  private readonly introductions = new Map<string, { readonly task: string; readonly turn: string; readonly messageId: string; readonly participantId: string; readonly memberId: string; readonly runId: string; readonly state: 'pending' | 'completed' | 'cancelled' | 'failed' }>()
  private readonly resourceOperations = new Map<string, string>()
  private readonly bindings = new Map<string, { readonly task: string; readonly bindingId: string; readonly generation: number; readonly definition: AgentDefinitionIdentity }>()

  constructor(
    private readonly host: PlaygroundMockAgentLoopHost,
    private readonly persistence?: PlaygroundMockAgentLoopPersistence,
  ) { this.restore() }

  private scopeKey(scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope']): string {
    return JSON.stringify([scope.profileId, scope.ownerKey, PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE])
  }

  private bindingKey(scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope'], task: string): string {
    return `${this.scopeKey(scope)}\0${task}`
  }

  private bindingFor(input: { readonly scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope']; readonly task: string; readonly binding: { readonly bindingId: string; readonly generation: number }; readonly definition: AgentDefinitionIdentity }): boolean {
    const current = this.bindings.get(this.bindingKey(input.scope, input.task))
    return current !== undefined && current.bindingId === input.binding.bindingId && current.generation === input.binding.generation
      && current.definition.agentId === input.definition.agentId && current.definition.revision === input.definition.revision
  }

  async createAgentLoopV4(input: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]): Promise<unknown> {
    return await this.once(input, async () => {
      const command = input.command as Parameters<typeof resolveAgentDefinition>[0]
      const definition = resolveAgentDefinition(command)
      const created = await this.host.create(definition, {}, { target: command.definition, definitions: command.definitions })
      if (!created.ok) return { status: 'unavailable', code: 'host-unavailable' }
      const locator = { task: created.value.task, definition: command.definition, binding: { bindingId: simulatorBindingId(created.value.task), generation: 1 } }
      this.bindings.set(this.bindingKey(input.scope, created.value.task), { task: created.value.task, ...locator.binding, definition: clone(command.definition) })
      return { status: 'accepted', locator, detailsUrl: created.value.detailsUrl, delivery: 'executed' }
    })
  }

  async bindAgentLoopV4(input: Parameters<AgentLoopV4Transport['bindAgentLoopV4']>[0]): Promise<unknown> {
    return await this.once(input, async () => {
      const bound = await this.host.bind(input.task)
      if (!bound.ok) return { status: 'unavailable', code: 'task-unavailable' }
      const prior = this.bindings.get(this.bindingKey(input.scope, input.task))
      const binding = { bindingId: prior?.bindingId ?? simulatorBindingId(input.task), generation: (prior?.generation ?? 0) + 1 }
      const locator = { task: bound.value.task, definition: input.definition, binding }
      this.bindings.set(this.bindingKey(input.scope, input.task), { task: input.task, ...binding, definition: clone(input.definition) })
      return { status: 'accepted', locator, detailsUrl: bound.value.detailsUrl, delivery: 'executed' }
    })
  }

  async sendAgentLoopV4(input: Parameters<AgentLoopV4Transport['sendAgentLoopV4']>[0]): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    return await this.once(input, async () => {
      const sent = await this.host.send({ task: input.task, session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: input.task } }, [{ kind: 'text', text: input.message }], { autoResolveApproval: false })
      if (!sent.ok) return { status: 'unavailable', code: 'host-unavailable' }
      this.host.recordSemantic(input.task, { operationId: input.operationId, purpose: 'conversation', turn: sent.value.turn, messageId: sent.value.messageId })
      return { status: 'accepted', turn: sent.value.turn, messageId: sent.value.messageId, delivery: 'executed' }
    })
  }

  async decideAgentLoopApprovalV4(input: Parameters<AgentLoopV4Transport['decideAgentLoopApprovalV4']>[0]): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    return await this.once(input, async () => !this.host.hasPendingApproval(input.task, input.turn, input.approvalId)
      ? { status: 'unavailable', code: 'approval-expired' }
      : this.host.appendV4Lifecycle(input.task, {
      turnId: input.turn,
      type: 'approval.resolved',
      approval: { approvalId: input.approvalId, kind: 'command', state: 'resolved', outcome: input.decision },
    }) ? { status: 'accepted', turn: input.turn, approvalId: input.approvalId, decision: input.decision, delivery: 'executed' } : { status: 'unavailable', code: 'approval-unavailable' },
    `approval\0${input.task}\0${input.turn}\0${input.approvalId}`, 'approval-conflict')
  }

  async requestAgentLoopIntroductionV4(input: Parameters<AgentLoopV4Transport['requestAgentLoopIntroductionV4']>[0]): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    return await this.once(input, async () => {
      const reserved = this.host.reserveSemanticTurn(input.task, 'member-self-introduction')
      if (reserved === undefined) return { status: 'unavailable', code: 'introduction-unavailable' }
      const { turn, messageId } = reserved
      if (!this.host.appendV4Lifecycle(input.task, { turnId: turn, type: 'turn.started' })) return { status: 'unavailable', code: 'introduction-unavailable' }
      const key = `${this.scopeKey(input.scope)}\0${input.operationId}`
      this.introductions.set(key, { task: input.task, turn, messageId, participantId: input.participantId, memberId: input.memberId, runId: input.runId, state: 'pending' })
      this.host.recordSemantic(input.task, { operationId: input.operationId, purpose: 'member-self-introduction', turn, messageId, participantId: input.participantId, memberId: input.memberId, runId: input.runId })
      setTimeout(async () => {
        const current = this.introductions.get(key)
        if (current?.state !== 'pending') return
        const introduction = await this.host.memberSelfIntroduction(input.task, { participantId: input.participantId, memberId: input.memberId, runId: input.runId })
        const latest = this.introductions.get(key)
        if (latest?.state !== 'pending') return
        if (introduction.status === 'ok') {
          this.host.appendV4Lifecycle(input.task, { turnId: turn, type: 'turn.completed', output: [{ type: 'text', text: introduction.text }] })
          this.introductions.set(key, { ...latest, state: 'completed' })
        } else {
          this.host.appendV4Lifecycle(input.task, { turnId: turn, type: 'turn.failed', failure: introduction.failure })
          this.introductions.set(key, { ...latest, state: 'failed' })
          const resourceKey = `${this.scopeKey(input.scope)}\0introduction\0${input.task}\0${input.participantId}\0${input.memberId}\0${input.runId}`
          if (this.resourceOperations.get(resourceKey) === input.operationId) this.resourceOperations.delete(resourceKey)
        }
        this.persist()
      }, 0)
      return { status: 'accepted', turn, messageId, delivery: 'executed' }
    }, `introduction\0${input.task}\0${input.participantId}\0${input.memberId}\0${input.runId}`, 'introduction-conflict')
  }

  async cancelAgentLoopIntroductionV4(input: Parameters<AgentLoopV4Transport['cancelAgentLoopIntroductionV4']>[0]): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    const request = this.introductions.get(`${this.scopeKey(input.scope)}\0${input.requestOperationId}`)
    if (request?.state === 'completed') return await this.once(input, async () => ({ status: 'conflict', code: 'introduction-completed' }))
    if (request?.state === 'cancelled') return await this.once(input, async () => ({ status: 'conflict', code: 'introduction-cancelled' }))
    if (request?.state === 'failed') return await this.once(input, async () => ({ status: 'conflict', code: 'introduction-conflict' }))
    return await this.once(input, async () => {
      if (request === undefined || request.task !== input.task) return { status: 'unavailable', code: 'introduction-not-found' }
      if (request.participantId !== input.participantId || request.memberId !== input.memberId) return { status: 'conflict', code: 'member-conflict' }
      if (request.runId !== input.runId) return { status: 'conflict', code: 'run-conflict' }
      this.host.appendV4Lifecycle(input.task, { turnId: request.turn, type: 'turn.cancelled', cancellation: { operationId: input.operationId } })
      this.introductions.set(`${this.scopeKey(input.scope)}\0${input.requestOperationId}`, { ...request, state: 'cancelled' })
      return { status: 'accepted', turn: request.turn, messageId: request.messageId, delivery: 'executed' }
    }, `introduction-cancel\0${input.task}\0${input.requestOperationId}`, 'introduction-conflict')
  }

  async readAgentLoopV4Lifecycle(input: Parameters<AgentLoopV4Transport['readAgentLoopV4Lifecycle']>[0]): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    const range = await this.host.lifecycle({ task: input.task, session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: input.task } }, input.afterSequence)
    const prefix = `${this.scopeKey(input.scope)}\0`
    const introductions = new Map([...this.introductions]
      .filter(([key, value]) => key.startsWith(prefix) && value.task === input.task)
      .map(([key, value]) => [value.turn, {
        operationId: key.slice(prefix.length), messageId: value.messageId, participantId: value.participantId,
        memberId: value.memberId, runId: value.runId,
      }] as const))
    return {
      status: 'accepted', nextAfterSequence: range.nextAfterSequence,
      events: range.events.map(event => ({
        ...event,
        ...(['turn.started', 'turn.completed', 'turn.failed'].includes(event.type) && introductions.has(event.turnId)
          ? { introduction: introductions.get(event.turnId) }
          : {}),
        eventId: `simulated-lifecycle:${event.sequence}`, turnId: event.turnId,
      })),
    }
  }

  private async once(
    input: { readonly scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope']; readonly operationId: string; readonly command: unknown },
    execute: () => Promise<unknown>,
    resourceKey?: string,
    resourceConflictCode: 'approval-conflict' | 'introduction-conflict' = 'introduction-conflict',
  ): Promise<unknown> {
    const owner = this.scopeKey(input.scope)
    const operationKey = `${owner}\0${input.operationId}`
    const commandFingerprint = fingerprint(input.command)
    const prior = this.results.get(operationKey)
    if (prior !== undefined) return prior.fingerprint === commandFingerprint
      ? { ...(clone(prior.result) as Record<string, unknown>), delivery: 'replayed' }
      : { status: 'conflict', code: 'operation-conflict' }
    const inFlight = this.pending.get(operationKey)
    if (inFlight !== undefined) return inFlight.fingerprint === commandFingerprint
      ? { ...(clone(await inFlight.result) as Record<string, unknown>), delivery: 'replayed' }
      : { status: 'conflict', code: 'operation-conflict' }
    const scopedResourceKey = resourceKey === undefined ? undefined : `${owner}\0${resourceKey}`
    if (scopedResourceKey !== undefined && this.resourceOperations.has(scopedResourceKey)) return { status: 'conflict', code: resourceConflictCode }
    if (scopedResourceKey !== undefined) this.resourceOperations.set(scopedResourceKey, input.operationId)
    const execution = execute()
    this.pending.set(operationKey, { fingerprint: commandFingerprint, result: execution })
    try {
      const result = await execution
      this.results.set(operationKey, { fingerprint: commandFingerprint, result: clone(result) })
      if ((result as { status?: unknown } | null)?.status !== 'accepted' && scopedResourceKey !== undefined
        && this.resourceOperations.get(scopedResourceKey) === input.operationId) this.resourceOperations.delete(scopedResourceKey)
      this.persist()
      return result
    } catch (error) {
      if (scopedResourceKey !== undefined && this.resourceOperations.get(scopedResourceKey) === input.operationId) this.resourceOperations.delete(scopedResourceKey)
      throw error
    } finally {
      this.pending.delete(operationKey)
    }
  }

  private restore(): void {
    try {
      const raw = this.persistence?.read()
      if (raw === undefined) return
      const value = JSON.parse(raw) as Partial<PlaygroundMockV4PersistedState>
      if (value.version !== 2 || !Array.isArray(value.results) || !Array.isArray(value.bindings)
        || !Array.isArray(value.introductions) || !Array.isArray(value.resources)) return
      for (const entry of value.results) {
        if (typeof entry?.key !== 'string' || typeof entry.fingerprint !== 'string') return
        this.results.set(entry.key, { fingerprint: entry.fingerprint, result: clone(entry.result) })
      }
      for (const entry of value.bindings) {
        if (typeof entry?.key !== 'string' || typeof entry.task !== 'string' || typeof entry.bindingId !== 'string'
          || !Number.isInteger(entry.generation) || entry.generation < 1 || typeof entry.definition?.agentId !== 'string'
          || typeof entry.definition?.revision !== 'string') return
        this.bindings.set(entry.key, clone({ task: entry.task, bindingId: entry.bindingId, generation: entry.generation, definition: entry.definition }))
      }
      for (const entry of value.introductions) {
        if (typeof entry?.key !== 'string' || typeof entry.value?.task !== 'string'
          || !['pending', 'completed', 'cancelled', 'failed'].includes(entry.value.state)) return
        this.introductions.set(entry.key, clone(entry.value))
      }
      for (const entry of value.resources) {
        if (typeof entry?.key !== 'string' || typeof entry.operationId !== 'string') return
        this.resourceOperations.set(entry.key, entry.operationId)
      }
    } catch {
      // Corrupt Simulator-only durable state fails closed to an empty ledger.
    }
  }

  private persist(): void {
    if (this.persistence === undefined) return
    try {
      const value: PlaygroundMockV4PersistedState = {
        version: 2,
        results: [...this.results].map(([key, entry]) => ({ key, fingerprint: entry.fingerprint, result: entry.result })),
        bindings: [...this.bindings].map(([key, entry]) => ({ key, ...entry })),
        introductions: [...this.introductions].map(([key, value]) => ({ key, value })),
        resources: [...this.resourceOperations].map(([key, operationId]) => ({ key, operationId })),
      }
      this.persistence.write(JSON.stringify(value))
    } catch {
      // The Simulator remains usable when browser storage is unavailable.
    }
  }
}
