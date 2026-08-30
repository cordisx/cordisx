import type { Disposable } from '@deepseek-ai/cordis'
import type { BoundAgentLoopClient as BoundAgentLoopClientV1 } from '@cordisx/protocol/agent-loop/v1'
import type {
  AgentLoopAuthorizationOutcome,
  AgentLoopContentPart,
  AgentLoopCreateOrBindResult,
  AgentLoopEvent,
  AgentLoopEventPage,
  AgentLoopEventSubscription,
  AgentLoopSendResult,
  AgentLoopSubscribeRuntimeResult,
  AgentLoopSubscription,
  AgentLoopTaskBinding,
  AgentLoopTaskDetailsUrl,
  BoundAgentLoopClient,
} from '@cordisx/protocol/agent-loop/v2'
import {
  CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V2,
  CORDISX_AGENT_LOOP_EVENT_SCHEMA_V2,
  CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V2,
  CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2,
  CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V2,
  CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V2,
  type CompatibleBoundAgentLoopClient,
} from '../agent-loop-contracts.js'
import {
  resolveAgentDefinition,
  type CordisXAgentLoopAuthorizationRequest,
  type CordisXAgentLoopHost,
  type CordisXBoundAgentLoopClientOptions,
  type CordisXResolvedAgentDefinition,
  type HostTask,
} from './agent-loop.js'
import type { CordisXAgentLoopLifecycleEvent } from './provider-binding.js'
import { validateAgentLoopTaskDetailsUrl } from './host-ui/AgentTaskDetailsNavigator.js'

type CreateCommand = Parameters<BoundAgentLoopClient['createOrBind']>[0]
type SendCommand = Parameters<BoundAgentLoopClient['send']>[0]
type Command = CreateCommand | SendCommand
type RefusedAuthorization = Exclude<AgentLoopAuthorizationOutcome, { state: 'allowed' }>
type AllowedCreateAuthorization = Extract<AgentLoopCreateOrBindResult, { status: 'accepted' }>['authorization']
type AllowedSendAuthorization = Extract<AgentLoopSendResult, { status: 'accepted' }>['authorization']
type EventPayload = AgentLoopEvent extends infer Event
  ? Event extends AgentLoopEvent
    ? Omit<Event, '$schema' | 'contract' | 'schemaVersion' | 'eventId' | 'binding' | 'sequence' | 'occurredAt'>
    : never
  : never

interface RecordState {
  readonly ownerKey: string
  readonly definition: CordisXResolvedAgentDefinition
  readonly task: HostTask
  readonly detailsUrl: AgentLoopTaskDetailsUrl
  binding: AgentLoopTaskBinding
  readonly events: AgentLoopEvent[]
  readonly listeners: Set<() => void>
  readonly subscriptions: Set<AgentLoopSubscription>
  readonly turnOperations: Map<string, string>
  lifecycleCursor: number
  polling: boolean
  poll: ReturnType<typeof setTimeout> | undefined
  promptDisposers: readonly Disposable<void>[]
}

interface LedgerEntry<Result extends AgentLoopCreateOrBindResult | AgentLoopSendResult = AgentLoopCreateOrBindResult | AgentLoopSendResult> {
  readonly ownerKey: string
  readonly fingerprint: string
  readonly firstObservedAt: string
  readonly result: Promise<Result>
  settledResult?: Result
  task?: HostTask
  definition?: CordisXResolvedAgentDefinition
  providerId?: string
  bindingGeneration?: number
  closedAt?: string
}

export interface CordisXAgentLoopBrokerV2Persistence {
  /** Stable Host-private provider affinity for this ledger snapshot. */
  readonly providerKey: string
  read(): string | undefined
  write(value: string): void
}

interface PersistedLedgerEntry {
  readonly key: string
  readonly ownerKey: string
  readonly fingerprint: string
  readonly firstObservedAt: string
  readonly result: AgentLoopCreateOrBindResult | AgentLoopSendResult
  readonly task?: HostTask
  readonly definition?: CordisXResolvedAgentDefinition
  readonly providerId?: string
  readonly bindingGeneration?: number
  readonly closedAt?: string
}

interface PersistedBrokerState {
  readonly version: 1
  readonly providerKey: string
  readonly nextBinding: number
  readonly taskGenerations: readonly (readonly [string, number])[]
  readonly ledger: readonly PersistedLedgerEntry[]
}

function clone<Value>(value: Value): Value {
  const output = typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
  return freeze(output)
}

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
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

function sameDefinition(left: AgentLoopTaskBinding['definition'], right: AgentLoopTaskBinding['definition']): boolean {
  return left.agentId === right.agentId && left.revision === right.revision
}

export function canonicalAgentLoopTaskDetailsUrl(value: AgentLoopTaskDetailsUrl | undefined): AgentLoopTaskDetailsUrl | undefined {
  if (value === undefined) return undefined
  try { return validateAgentLoopTaskDetailsUrl(value) } catch { return undefined }
}

export function combineAgentLoopClients(
  v1: BoundAgentLoopClientV1,
  v2: BoundAgentLoopClient,
): CompatibleBoundAgentLoopClient {
  let disposed = false
  const client = {
    $schema: CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V2,
    contract: 'cordisx.bound-agent-loop-client/v2',
    schemaVersion: 2,
    durableLedger: v2.durableLedger,
    createOrBind: (command: Parameters<BoundAgentLoopClientV1['createOrBind']>[0] | CreateCommand) => command.schemaVersion === 2
      ? v2.createOrBind(command)
      : v1.createOrBind(command),
    send: (command: Parameters<BoundAgentLoopClientV1['send']>[0] | SendCommand) => command.schemaVersion === 2
      ? v2.send(command)
      : v1.send(command),
    subscribe: (binding: Parameters<BoundAgentLoopClientV1['subscribe']>[0] | AgentLoopTaskBinding, afterSequence: number) => binding.schemaVersion === 2
      ? v2.subscribe(binding, afterSequence)
      : v1.subscribe(binding, afterSequence),
    dispose: () => {
      if (disposed) return
      disposed = true
      v1.dispose()
      v2.dispose()
    },
  }
  return Object.freeze(client) as unknown as CompatibleBoundAgentLoopClient
}

/**
 * Durable AgentLoop v2 broker. Its operation ledger is broker-owned rather than
 * client-owned, so exact commands survive client dispose and can reconcile a
 * current binding without executing a second provider side effect.
 */
export class CordisXAgentLoopBrokerV2 {
  private readonly records = new Map<string, RecordState>()
  private readonly boundTasks = new Map<string, RecordState>()
  private readonly ledger = new Map<string, LedgerEntry>()
  private readonly taskGenerations = new Map<string, number>()
  private nextBinding = 0
  private nextSubscription = 0
  private disposed = false

  constructor(
    private readonly host: CordisXAgentLoopHost,
    private readonly now: () => Date = () => new Date(),
    private readonly persistence?: CordisXAgentLoopBrokerV2Persistence,
  ) { this.restore() }

  definitionPresentation(identity: { readonly agentId: string; readonly revision: string }): {
    readonly identity: { readonly agentId: string; readonly revision: string }
    readonly name: string
    readonly introduction: string
  } | undefined {
    const definition = [...this.records.values()].map(record => record.definition).find(item => sameDefinition(item.identity, identity))
      ?? [...this.ledger.values()].map(entry => entry.definition).find(item => item !== undefined && sameDefinition(item.identity, identity))
    if (definition === undefined) return undefined
    return clone({
      identity: definition.identity,
      name: definition.name ?? definition.identity.agentId,
      introduction: (definition.promptSections ?? [])
        .filter(section => section.kind === 'introduction')
        .map(section => section.text.trim())
        .filter(Boolean)
        .join('\n\n'),
    })
  }

  bind(options: CordisXBoundAgentLoopClientOptions): BoundAgentLoopClient {
    const owned = new Set<string>()
    const subscriptions = new Set<AgentLoopSubscription>()
    let disposed = false
    const live = () => !disposed && !this.disposed && options.active()

    const client = Object.freeze({
      $schema: CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V2,
      contract: 'cordisx.bound-agent-loop-client/v2' as const,
      schemaVersion: 2 as const,
      durableLedger: Object.freeze({
        operationId: 'commandId' as const,
        scope: 'owner-provider' as const,
        providerAffinity: 'generation-fenced' as const,
        survivesClientDispose: true as const,
        payloadMatch: 'structural-exact' as const,
        retention: Object.freeze({ active: 'logical-task-lifetime' as const, recoveryDays: 30 as const }),
      }),
      createOrBind: (command: CreateCommand) => {
        if (!live()) return Promise.resolve(this.refusal(command, command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read', 'unavailable', 'host-unavailable'))
        return this.executeDurable<AgentLoopCreateOrBindResult>(options, command,
          () => this.unavailable(command, command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read', 'operation-conflict'),
          async () => await this.createOrBind(options, owned, command, live)).then(result => {
            if (result.status === 'accepted') owned.add(result.binding.binding.bindingId)
            return result
          })
      },
      send: (command: SendCommand) => {
        if (!live()) return Promise.resolve(this.refusal(command, 'turns.submit', 'unavailable', 'host-unavailable'))
        return this.executeDurable<AgentLoopSendResult>(options, command,
          () => this.unavailable(command, 'turns.submit', 'operation-conflict'),
          async () => await this.send(options, command, live))
      },
      subscribe: async (binding: AgentLoopTaskBinding, afterSequence: number) => {
        const record = this.owned(options.ownerKey, binding)
        if (!live() || record === undefined || !Number.isInteger(afterSequence) || afterSequence < -1) {
          return { status: 'unavailable', authorization: { capability: 'tasks.content.read', state: 'unavailable', code: 'task-unavailable' } }
        }
        const authorization = await options.authorize({ capability: 'tasks.content.read', session: record.task.session })
        const scoped = { ...authorization, capability: 'tasks.content.read' as const }
        if (scoped.state !== 'allowed') return { status: scoped.state, authorization: scoped } as AgentLoopSubscribeRuntimeResult
        const handle = this.subscription(record, afterSequence)
        subscriptions.add(handle)
        this.startPolling(record)
        return { status: 'accepted', authorization: scoped, handle }
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const bindingId of owned) this.close(this.records.get(bindingId))
        for (const subscription of subscriptions) subscription.unsubscribe()
      },
    }) as BoundAgentLoopClient
    return client
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) this.close(record)
    this.records.clear()
    this.boundTasks.clear()
    this.persist()
  }

  private executeDurable<Result extends AgentLoopCreateOrBindResult | AgentLoopSendResult>(
    options: CordisXBoundAgentLoopClientOptions,
    command: Command,
    conflict: () => Result,
    execute: () => Promise<Result>,
  ): Promise<Result> {
    const key = JSON.stringify([options.ownerKey, command.commandId])
    const structural = fingerprint(command)
    const existing = this.ledger.get(key) as LedgerEntry<Result> | undefined
    if (existing !== undefined) {
      if (existing.fingerprint !== structural) return Promise.resolve(conflict())
      if (command.type === 'create-or-bind') return this.replayCreate(options, command, existing as LedgerEntry<AgentLoopCreateOrBindResult>) as Promise<Result>
      return existing.result.then(result => result.status === 'accepted'
        ? clone({ ...result, delivery: { disposition: 'replayed' as const } })
        : result) as Promise<Result>
    }
    const result = execute().catch(() => this.unavailable(
      command,
      command.type === 'send' ? 'turns.submit' : command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read',
      'reconciliation-required',
    ) as Result)
    const entry: LedgerEntry<Result> = { ownerKey: options.ownerKey, fingerprint: structural, firstObservedAt: this.now().toISOString(), result }
    this.ledger.set(key, entry)
    void result.then(value => {
      const current = this.ledger.get(key)
      if (current === undefined) return
      current.settledResult = clone(value)
      if (value.status === 'accepted') {
        const record = this.records.get(value.binding.binding.bindingId)
        if (record !== undefined) {
          current.task = clone(record.task)
          current.definition = clone(record.definition)
          current.providerId = record.task.session.providerId
          current.bindingGeneration = record.binding.binding.generation
        }
      }
      this.persist()
    })
    return result
  }

  private async replayCreate(
    options: CordisXBoundAgentLoopClientOptions,
    command: CreateCommand,
    entry: LedgerEntry<AgentLoopCreateOrBindResult>,
  ): Promise<AgentLoopCreateOrBindResult> {
    const previous = await entry.result
    if (previous.status !== 'accepted') return previous
    const active = this.records.get(previous.binding.binding.bindingId)
    if (active !== undefined && active.binding.state === 'active') {
      return clone({ ...previous, binding: active.binding, detailsUrl: active.detailsUrl, delivery: { disposition: 'replayed' } })
    }
    if (entry.task === undefined || entry.definition === undefined) {
      return this.unavailable(command, command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read', 'reconciliation-required')
    }
    const current = this.boundTasks.get(this.taskKey(options.ownerKey, entry.task.task))
    if (current !== undefined && current.binding.state === 'active') {
      if (!sameDefinition(current.definition.identity, entry.definition.identity)) {
        return this.unavailable(command, 'tasks.content.read', 'operation-conflict')
      }
      if (entry.providerId !== undefined && current.task.session.providerId !== entry.providerId) {
        return this.unavailable(command, 'tasks.content.read', 'provider-replaced')
      }
      const currentAuthorization = await options.authorize({ capability: 'tasks.content.read', session: current.task.session })
      if (currentAuthorization.state !== 'allowed') return this.refusalFrom(command, currentAuthorization)
      return clone({
        ...previous,
        authorization: { capability: 'tasks.content.read', state: 'allowed', code: 'allowed' },
        binding: current.binding,
        detailsUrl: current.detailsUrl,
        delivery: { disposition: 'reconciled' as const },
      })
    }
    const capability = 'tasks.content.read' as const
    const bound = await this.host.bind(entry.task.task)
    if (!bound.ok) return this.unavailable(command, capability, 'reconciliation-required')
    if (entry.providerId !== undefined && bound.value.session.providerId !== entry.providerId) {
      this.host.release?.(bound.value)
      return this.unavailable(command, capability, 'provider-replaced')
    }
    const authorization = await options.authorize({ capability, session: bound.value.session })
    if (authorization.state !== 'allowed') { this.host.release?.(bound.value); return this.refusalFrom(command, authorization) }
    const detailsUrl = canonicalAgentLoopTaskDetailsUrl(bound.value.detailsUrl ?? entry.task.detailsUrl)
    if (detailsUrl === undefined) { this.host.release?.(bound.value); return this.unavailable(command, capability, 'details-unavailable') }
    const record = this.record(options, entry.definition, { ...bound.value, detailsUrl }, detailsUrl,
      this.nextTaskGeneration(options.ownerKey, bound.value.task, (entry.bindingGeneration ?? 0) + 1),
      command.commandId, 'binding.bound')
    entry.task = clone(record.task)
    entry.providerId = record.task.session.providerId
    entry.bindingGeneration = record.binding.binding.generation
    const acceptedAuthorization: AllowedCreateAuthorization = { capability, state: 'allowed', code: 'allowed' }
    const result = clone({
      ...previous,
      authorization: acceptedAuthorization,
      binding: record.binding,
      detailsUrl,
      delivery: { disposition: 'reconciled' as const },
    })
    entry.settledResult = result
    this.persist()
    return result
  }

  private async createOrBind(
    options: CordisXBoundAgentLoopClientOptions,
    owned: Set<string>,
    command: CreateCommand,
    live: () => boolean,
  ): Promise<AgentLoopCreateOrBindResult> {
    const capability = command.target.mode === 'create' ? 'tasks.create' as const : 'tasks.content.read' as const
    if (!live()) return this.refusal(command, capability, 'unavailable', 'host-unavailable')
    let definition: CordisXResolvedAgentDefinition
    try { definition = resolveAgentDefinition(command as unknown as Parameters<typeof resolveAgentDefinition>[0]) } catch { return this.refusal(command, capability, 'unavailable', 'unsupported') }
    let task: HostTask
    let authorization: AllowedCreateAuthorization
    if (command.target.mode === 'create') {
      const prepared = await this.host.prepare(definition)
      if (!prepared.ok) return this.refusal(command, capability, 'unavailable', 'host-unavailable')
      const outcome = await options.authorize({ capability, ...(prepared.value.model === undefined ? {} : { model: prepared.value.model }), ...(prepared.value.cwd === undefined ? {} : { cwd: prepared.value.cwd }) })
      if (outcome.state !== 'allowed') return this.refusalFrom(command, outcome)
      authorization = { capability, state: 'allowed', code: 'allowed' }
      const created = await this.host.create(definition, prepared.value, clone({ target: command.definition, definitions: command.definitions }))
      if (!created.ok) return this.refusal(command, capability, 'unavailable', 'host-unavailable')
      task = created.value
    } else {
      const current = this.boundTasks.get(this.taskKey(options.ownerKey, command.target.task))
      if (current !== undefined && current.binding.state === 'active') {
        const outcome = await options.authorize({ capability, session: current.task.session })
        if (outcome.state !== 'allowed') return this.refusalFrom(command, outcome)
        if (!sameDefinition(current.definition.identity, definition.identity)) return this.refusal(command, capability, 'unavailable', 'unsupported')
        owned.add(current.binding.binding.bindingId)
        return this.acceptCreate(command, { capability, state: 'allowed', code: 'allowed' }, current, 'executed')
      }
      const bound = await this.host.bind(command.target.task)
      if (!bound.ok) return this.refusal(command, capability, 'unavailable', 'task-unavailable')
      const outcome = await options.authorize({ capability, session: bound.value.session })
      if (outcome.state !== 'allowed') { this.host.release?.(bound.value); return this.refusalFrom(command, outcome) }
      authorization = { capability, state: 'allowed', code: 'allowed' }
      task = bound.value
    }
    const detailsUrl = canonicalAgentLoopTaskDetailsUrl(task.detailsUrl)
    if (detailsUrl === undefined) { this.host.release?.(task); return this.unavailable(command, capability, 'details-unavailable') }
    const record = this.record(options, definition, { ...task, detailsUrl }, detailsUrl,
      this.nextTaskGeneration(options.ownerKey, task.task, 1),
      command.commandId, command.target.mode === 'create' ? 'binding.created' : 'binding.bound')
    owned.add(record.binding.binding.bindingId)
    return this.acceptCreate(command, authorization, record, 'executed')
  }

  private async send(options: CordisXBoundAgentLoopClientOptions, command: SendCommand, live: () => boolean): Promise<AgentLoopSendResult> {
    const record = this.owned(options.ownerKey, command.binding)
    if (!live() || record === undefined) return this.refusal(command, 'turns.submit', 'unavailable', 'task-unavailable')
    const authorization = await options.authorize({ capability: 'turns.submit', session: record.task.session })
    if (authorization.state !== 'allowed') return this.refusalFrom(command, authorization)
    const acceptedAuthorization: AllowedSendAuthorization = { capability: 'turns.submit', state: 'allowed', code: 'allowed' }
    let sent: Awaited<ReturnType<CordisXAgentLoopHost['send']>>
    try { sent = await this.host.send(record.task, command.content) } catch { return this.unavailable(command, 'turns.submit', 'reconciliation-required') }
    if (!sent.ok) return this.refusal(command, 'turns.submit', 'unavailable', sent.error.code === 'adapter-unavailable' ? 'unsupported' : 'host-unavailable')
    record.turnOperations.set(sent.value.turn, command.commandId)
    this.append(record, { type: 'message', causation: { operationId: command.commandId }, turn: sent.value.turn, message: { messageId: sent.value.messageId, role: 'user', content: command.content } })
    this.append(record, { type: 'lifecycle', causation: { operationId: command.commandId }, turn: sent.value.turn, lifecycle: { phase: 'turn.started' } })
    this.startPolling(record)
    return clone({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2,
      contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2, commandId: command.commandId,
      type: 'send', status: 'accepted', authorization: acceptedAuthorization, binding: record.binding,
      messageId: sent.value.messageId, turn: sent.value.turn, delivery: { disposition: 'executed' },
    })
  }

  private record(
    options: CordisXBoundAgentLoopClientOptions,
    definition: CordisXResolvedAgentDefinition,
    task: HostTask,
    detailsUrl: AgentLoopTaskDetailsUrl,
    generation: number,
    operationId: string,
    phase: 'binding.created' | 'binding.bound',
  ): RecordState {
    const binding = clone({
      $schema: CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V2,
      contract: 'cordisx.agent-loop-task-binding/v2' as const,
      schemaVersion: 2 as const,
      binding: { bindingId: `cxloop-v2-binding:${this.nextBinding++}`, generation },
      definition: definition.identity,
      task: task.task,
      state: 'active' as const,
    })
    const record: RecordState = {
      ownerKey: options.ownerKey, definition: clone(definition), task: clone(task), detailsUrl: clone(detailsUrl), binding,
      events: [], listeners: new Set(), subscriptions: new Set(), turnOperations: new Map(), lifecycleCursor: 0,
      polling: false, poll: undefined,
      promptDisposers: options.registerPrompt?.(task.session.remoteSessionId, definition) ?? [],
    }
    this.records.set(binding.binding.bindingId, record)
    this.boundTasks.set(this.taskKey(options.ownerKey, task.task), record)
    this.append(record, { type: 'lifecycle', causation: { operationId }, lifecycle: { phase } })
    return record
  }

  private acceptCreate(
    command: CreateCommand,
    authorization: AllowedCreateAuthorization,
    record: RecordState,
    disposition: 'executed' | 'replayed' | 'reconciled',
  ): AgentLoopCreateOrBindResult {
    return clone({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2,
      contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2, commandId: command.commandId,
      type: 'create-or-bind', status: 'accepted', authorization,
      binding: record.binding, detailsUrl: record.detailsUrl, delivery: { disposition },
    })
  }

  private refusal<CommandType extends Command>(
    command: CommandType,
    capability: AgentLoopAuthorizationOutcome['capability'],
    state: 'denied' | 'unavailable',
    code: RefusedAuthorization['code'],
  ): CommandType extends CreateCommand ? AgentLoopCreateOrBindResult : AgentLoopSendResult {
    return clone({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2,
      contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2, commandId: command.commandId,
      type: command.type, status: state, authorization: { capability, state, code },
    } as CommandType extends CreateCommand ? AgentLoopCreateOrBindResult : AgentLoopSendResult)
  }

  private refusalFrom<CommandType extends Command>(command: CommandType, authorization: RefusedAuthorization): CommandType extends CreateCommand ? AgentLoopCreateOrBindResult : AgentLoopSendResult {
    return clone({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2,
      contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2, commandId: command.commandId,
      type: command.type, status: authorization.state, authorization,
    } as CommandType extends CreateCommand ? AgentLoopCreateOrBindResult : AgentLoopSendResult)
  }

  private unavailable<CommandType extends Command>(
    command: CommandType,
    capability: CordisXAgentLoopAuthorizationRequest['capability'],
    code: 'details-unavailable' | 'operation-conflict' | 'reconciliation-required' | 'operation-expired' | 'provider-replaced',
  ): CommandType extends CreateCommand ? AgentLoopCreateOrBindResult : AgentLoopSendResult {
    return clone({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V2,
      contract: 'cordisx.agent-loop-result/v2', schemaVersion: 2, commandId: command.commandId,
      type: command.type, status: 'unavailable',
      authorization: { capability, state: 'allowed', code: 'allowed' }, code,
    } as CommandType extends CreateCommand ? AgentLoopCreateOrBindResult : AgentLoopSendResult)
  }

  private owned(ownerKey: string, binding: AgentLoopTaskBinding): RecordState | undefined {
    const record = this.records.get(binding.binding.bindingId)
    return record?.ownerKey === ownerKey
      && record.binding.state === 'active'
      && record.binding.binding.generation === binding.binding.generation
      && record.binding.task === binding.task
      && sameDefinition(record.binding.definition, binding.definition)
      ? record : undefined
  }

  private taskKey(ownerKey: string, task: string): string { return `${ownerKey}\0${task}` }

  private nextTaskGeneration(ownerKey: string, task: string, minimum: number): number {
    const key = this.taskKey(ownerKey, task)
    const generation = Math.max((this.taskGenerations.get(key) ?? 0) + 1, minimum)
    this.taskGenerations.set(key, generation)
    return generation
  }

  private append(record: RecordState, payload: EventPayload): void {
    const event = clone({
      $schema: CORDISX_AGENT_LOOP_EVENT_SCHEMA_V2,
      contract: 'cordisx.agent-loop-event/v2', schemaVersion: 2,
      eventId: `cxloop-v2-event:${record.binding.binding.bindingId}:${record.events.length}`,
      binding: record.binding.binding, sequence: record.events.length, occurredAt: this.now().toISOString(), ...payload,
    } as AgentLoopEvent)
    record.events.push(event)
    for (const listener of record.listeners) listener()
  }

  private startPolling(record: RecordState): void {
    if (record.polling || record.poll !== undefined || record.binding.state !== 'active') return
    record.polling = true
    const poll = async () => {
      if (record.binding.state !== 'active' || this.disposed) { record.polling = false; return }
      try {
        const range = await this.host.lifecycle(record.task, record.lifecycleCursor)
        if (record.binding.state !== 'active' || this.disposed) return
        record.lifecycleCursor = range.nextAfterSequence
        for (const event of range.events) this.projectLifecycle(record, event)
      } catch { /* transient provider gaps remain retryable */ }
      finally { record.polling = false }
      if (record.binding.state === 'active' && !this.disposed) {
        record.poll = setTimeout(() => { record.poll = undefined; this.startPolling(record) }, 250)
      }
    }
    void poll()
  }

  private projectLifecycle(record: RecordState, event: CordisXAgentLoopLifecycleEvent): void {
    const operationId = record.turnOperations.get(event.turnId)
    const causation = operationId === undefined ? {} : { causation: { operationId } }
    if (event.type === 'turn.completed') {
      if ((event.output?.length ?? 0) > 0) this.append(record, { type: 'message', ...causation, turn: event.turnId, message: { messageId: `cxloop-assistant:${event.turnId}`, role: 'assistant', content: event.output!.map(item => ({ kind: 'text' as const, text: item.text })) as [AgentLoopContentPart, ...AgentLoopContentPart[]] } })
      this.append(record, { type: 'lifecycle', ...causation, turn: event.turnId, lifecycle: { phase: 'turn.completed' } })
      return
    }
    if (event.type === 'turn.failed') { this.append(record, { type: 'lifecycle', ...causation, turn: event.turnId, lifecycle: { phase: 'turn.failed', failure: event.failure ?? { code: 'AGENT_LOOP_FAILED', retryable: false } } }); return }
    if (event.type === 'turn.started') {
      if (!record.events.some(item => item.type === 'lifecycle' && item.turn === event.turnId && item.lifecycle.phase === 'turn.started')) this.append(record, { type: 'lifecycle', ...causation, turn: event.turnId, lifecycle: { phase: 'turn.started' } })
      return
    }
    if (event.approval === undefined) return
    this.append(record, { type: 'approval', ...causation, turn: event.turnId, approval: event.approval.state === 'pending'
      ? { approvalId: event.approval.approvalId, kind: event.approval.kind, state: 'pending' }
      : { approvalId: event.approval.approvalId, kind: event.approval.kind, state: 'resolved', outcome: event.approval.outcome ?? 'cancelled' } })
  }

  private subscription(record: RecordState, afterSequence: number): AgentLoopSubscription {
    const snapshotSequence = Math.max(0, record.events.length - 1)
    const descriptor: AgentLoopEventSubscription = clone({
      $schema: CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V2,
      contract: 'cordisx.agent-loop-event-subscription/v2', schemaVersion: 2,
      subscriptionId: `cxloop-v2-subscription:${this.nextSubscription++}`,
      binding: record.binding.binding, afterSequence, snapshotSequence,
    })
    const waiters: ((result: IteratorResult<AgentLoopEventPage>) => void)[] = []
    let closed = false
    let cursor = afterSequence
    const nextPage = (): AgentLoopEventPage | undefined => {
      const phase: AgentLoopEventPage['phase'] = cursor < snapshotSequence ? 'replay' : 'live'
      const endSequence = phase === 'replay' ? snapshotSequence : record.events.length - 1
      const selected = record.events.filter(event => event.sequence > cursor && event.sequence <= endSequence).slice(0, 64)
      if (selected.length === 0) return undefined
      const page = clone({
        $schema: CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V2,
        contract: 'cordisx.agent-loop-event-page/v2' as const, schemaVersion: 2 as const,
        subscription: descriptor, afterSequence: cursor, phase, events: selected,
        nextAfterSequence: selected.at(-1)!.sequence,
        hasMore: selected.at(-1)!.sequence < record.events.length - 1,
      })
      cursor = page.nextAfterSequence
      return page
    }
    const drain = () => {
      while (waiters.length > 0) {
        const page = nextPage()
        if (page !== undefined) waiters.shift()!({ value: page, done: false })
        else if (closed) waiters.shift()!({ value: undefined, done: true })
        else break
      }
    }
    const listener = () => drain()
    record.listeners.add(listener)
    const handle: AgentLoopSubscription = {
      subscription: descriptor,
      pages: {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const page = nextPage()
            if (page !== undefined) return Promise.resolve({ value: page, done: false as const })
            if (closed) return Promise.resolve({ value: undefined, done: true as const })
            return new Promise(resolve => { waiters.push(resolve) })
          },
          return: () => { handle.unsubscribe(); return Promise.resolve({ value: undefined, done: true as const }) },
        }),
      },
      unsubscribe: () => {
        if (closed) return
        closed = true
        record.listeners.delete(listener)
        record.subscriptions.delete(handle)
        drain()
      },
    }
    record.subscriptions.add(handle)
    return handle
  }

  private close(record: RecordState | undefined): void {
    if (record === undefined || record.binding.state === 'closed') return
    if (record.poll !== undefined) clearTimeout(record.poll)
    record.poll = undefined
    record.polling = false
    this.append(record, { type: 'lifecycle', lifecycle: { phase: 'binding.closed' } })
    record.binding = clone({ ...record.binding, state: 'closed' as const })
    for (const subscription of [...record.subscriptions]) subscription.unsubscribe()
    for (const dispose of record.promptDisposers) dispose()
    record.promptDisposers = []
    this.host.release?.(record.task)
    this.boundTasks.delete(this.taskKey(record.ownerKey, record.task.task))
    for (const entry of this.ledger.values()) {
      if (entry.task?.task === record.task.task && entry.ownerKey === record.ownerKey) entry.closedAt = this.now().toISOString()
    }
    this.persist()
  }

  private restore(): void {
    try {
      const raw = this.persistence?.read()
      if (raw === undefined) return
      const state = JSON.parse(raw) as Partial<PersistedBrokerState>
      if (state.version !== 1 || state.providerKey !== this.persistence?.providerKey
        || !Number.isSafeInteger(state.nextBinding) || (state.nextBinding ?? -1) < 0
        || !Array.isArray(state.taskGenerations) || !Array.isArray(state.ledger)) return
      const generations = new Map<string, number>()
      for (const pair of state.taskGenerations) {
        if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string'
          || !Number.isSafeInteger(pair[1]) || pair[1] < 1) return
        generations.set(pair[0], pair[1])
      }
      const ledger = new Map<string, LedgerEntry>()
      for (const persisted of state.ledger) {
        if (persisted === null || typeof persisted !== 'object'
          || typeof persisted.key !== 'string' || typeof persisted.ownerKey !== 'string'
          || typeof persisted.fingerprint !== 'string' || typeof persisted.firstObservedAt !== 'string'
          || persisted.result === null || typeof persisted.result !== 'object') return
        const result = clone(persisted.result)
        ledger.set(persisted.key, {
          ownerKey: persisted.ownerKey,
          fingerprint: persisted.fingerprint,
          firstObservedAt: persisted.firstObservedAt,
          result: Promise.resolve(result),
          settledResult: result,
          ...(persisted.task === undefined ? {} : { task: clone(persisted.task) }),
          ...(persisted.definition === undefined ? {} : { definition: clone(persisted.definition) }),
          ...(persisted.providerId === undefined ? {} : { providerId: persisted.providerId }),
          ...(persisted.bindingGeneration === undefined ? {} : { bindingGeneration: persisted.bindingGeneration }),
          ...(persisted.closedAt === undefined ? {} : { closedAt: persisted.closedAt }),
        })
      }
      this.nextBinding = state.nextBinding as number
      for (const [key, value] of generations) this.taskGenerations.set(key, value)
      for (const [key, value] of ledger) this.ledger.set(key, value)
    } catch {
      // Corrupt Host-private recovery data fails closed to a fresh ledger.
    }
  }

  private persist(): void {
    if (this.persistence === undefined) return
    try {
      const ledger: PersistedLedgerEntry[] = []
      for (const [key, entry] of this.ledger) {
        if (entry.settledResult === undefined) continue
        ledger.push({
          key,
          ownerKey: entry.ownerKey,
          fingerprint: entry.fingerprint,
          firstObservedAt: entry.firstObservedAt,
          result: entry.settledResult,
          ...(entry.task === undefined ? {} : { task: entry.task }),
          ...(entry.definition === undefined ? {} : { definition: entry.definition }),
          ...(entry.providerId === undefined ? {} : { providerId: entry.providerId }),
          ...(entry.bindingGeneration === undefined ? {} : { bindingGeneration: entry.bindingGeneration }),
          ...(entry.closedAt === undefined ? {} : { closedAt: entry.closedAt }),
        })
      }
      const state: PersistedBrokerState = {
        version: 1,
        providerKey: this.persistence.providerKey,
        nextBinding: this.nextBinding,
        taskGenerations: [...this.taskGenerations],
        ledger,
      }
      this.persistence.write(JSON.stringify(state))
    } catch {
      // Runtime operation semantics remain available when Host recovery storage is unavailable.
    }
  }
}
