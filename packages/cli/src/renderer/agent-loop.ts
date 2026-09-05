import type { Disposable } from '@deepseek-ai/cordis'
import { resolveAgentDefinitionAvatar } from '@cordisx/protocol/agent-avatar/v1'
import {
  type AgentDefinition as CordisXAgentDefinition,
  type AgentDefinitionIdentity as CordisXAgentDefinitionIdentity,
  type AgentFilter as CordisXAgentFilter,
  type AgentInheritanceMode as CordisXAgentInheritanceMode,
  type AgentLoopAuthorizationOutcome as CordisXAgentLoopAuthorizationOutcome,
  type AgentLoopAuthorizationOutcomeV4 as CordisXAgentLoopAuthorizationOutcomeV4,
  type AgentLoopContentPart as CordisXAgentLoopContentPart,
  type AgentLoopCreateOrBindResult as CordisXAgentLoopCreateOrBindResult,
  type AgentLoopEvent as CordisXAgentLoopEvent,
  type AgentLoopEventPage as CordisXAgentLoopEventPage,
  type AgentLoopEventSubscription as CordisXAgentLoopEventSubscription,
  type AgentLoopSendResult as CordisXAgentLoopSendResult,
  type AgentLoopSubscribeRuntimeResult as CordisXAgentLoopSubscribeRuntimeResult,
  type AgentLoopSubscription as CordisXAgentLoopSubscription,
  type AgentLoopTaskBinding as CordisXAgentLoopTaskBinding,
  type AgentLoopTaskDetailsUrl,
  type BoundAgentLoopClient as CordisXBoundAgentLoopClient,
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V1,
  CORDISX_AGENT_LOOP_EVENT_SCHEMA_V1,
  CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1,
  CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V1,
  CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V1,
} from '../agent-loop-contracts.js'
import type {
  CordisXPlatformCapability,
  CordisXPlatformModelRef,
  CordisXPlatformResult,
  CordisXPlatformSessionRef,
} from '../platform-contracts.js'
import { BindingPlatformAdapter, type CordisXAgentLoopLifecycleEvent } from './provider-binding.js'

type CreateCommand = Parameters<CordisXBoundAgentLoopClient['createOrBind']>[0]
type SendCommand = Parameters<CordisXBoundAgentLoopClient['send']>[0]
type Refused = Exclude<CordisXAgentLoopAuthorizationOutcome, { state: 'allowed' }>
type EventPayload = CordisXAgentLoopEvent extends infer Event
  ? Event extends CordisXAgentLoopEvent
    ? Omit<Event, '$schema' | 'contract' | 'schemaVersion' | 'eventId' | 'binding' | 'sequence' | 'occurredAt'>
  : never
  : never

export interface CordisXResolvedAgentDefinition extends Omit<CordisXAgentDefinition, 'extends' | 'inherit' | 'avatar'> {
  readonly avatar: NonNullable<CordisXAgentDefinition['avatar']>
  readonly sourceDefinitions: readonly CordisXAgentDefinitionIdentity[]
}

export interface CordisXAgentLoopAuthorizationRequest {
  readonly capability: Extract<CordisXPlatformCapability, 'tasks.create' | 'tasks.content.read' | 'turns.submit'>
  readonly model?: CordisXPlatformModelRef
  readonly session?: CordisXPlatformSessionRef
  readonly cwd?: string
  readonly task?: string
}

export interface CordisXAgentLoopAuthorizationRequestV4
  extends Omit<CordisXAgentLoopAuthorizationRequest, 'capability'>
{
  readonly capability: Extract<
    CordisXPlatformCapability,
    'tasks.create' | 'tasks.content.read' | 'turns.submit' | 'turns.introduce' | 'approvals.decide'
  >
}

export interface CordisXBoundAgentLoopClientOptions {
  readonly ownerKey: string
  readonly active: () => boolean
  readonly authorize: (request: CordisXAgentLoopAuthorizationRequest) => Promise<CordisXAgentLoopAuthorizationOutcome>
  readonly authorizeV4?: (
    request: CordisXAgentLoopAuthorizationRequestV4,
  ) => Promise<CordisXAgentLoopAuthorizationOutcomeV4>
  readonly registerPrompt?: (
    sessionId: string,
    definition: CordisXResolvedAgentDefinition,
  ) => readonly Disposable<void>[]
}

export interface HostTask {
  readonly task: string
  readonly session: CordisXPlatformSessionRef
  readonly detailsUrl?: AgentLoopTaskDetailsUrl
}
interface HostSend {
  readonly messageId: string
  readonly turn: string
}

export interface CordisXAgentLoopCreateContext {
  readonly target: CordisXAgentDefinitionIdentity
  readonly definitions: readonly [CordisXAgentDefinition, ...CordisXAgentDefinition[]]
}

export interface CordisXAgentLoopPrepared {
  readonly model?: CordisXPlatformModelRef
  readonly cwd?: string
}

export interface CordisXAgentLoopHost {
  prepare(definition: CordisXResolvedAgentDefinition): Promise<CordisXPlatformResult<CordisXAgentLoopPrepared>>
  create(
    definition: CordisXResolvedAgentDefinition,
    prepared: CordisXAgentLoopPrepared,
    context: CordisXAgentLoopCreateContext,
  ): Promise<CordisXPlatformResult<HostTask>>
  bind(task: string): Promise<CordisXPlatformResult<HostTask>>
  send(
    task: HostTask,
    content: readonly [CordisXAgentLoopContentPart, ...CordisXAgentLoopContentPart[]],
  ): Promise<CordisXPlatformResult<HostSend>>
  lifecycle(
    task: HostTask,
    afterSequence: number,
  ): Promise<{ readonly nextAfterSequence: number; readonly events: readonly CordisXAgentLoopLifecycleEvent[] }>
  /** Optional Host-private release signal; it never changes the public task handle contract. */
  release?(task: HostTask): void
}

function clone<Value>(value: Value): Value {
  const result = typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
  return freeze(result)
}

function commandFingerprint(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input === null || typeof input !== 'object') return input
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map((
        [key, child],
      ) => [key, canonical(child)]),
    )
  }
  return JSON.stringify(canonical(value))
}

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function handle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}
function identityKey(value: CordisXAgentDefinitionIdentity): string {
  return JSON.stringify([value.agentId, value.revision])
}
function sameIdentity(left: CordisXAgentDefinitionIdentity, right: CordisXAgentDefinitionIdentity): boolean {
  return left.agentId === right.agentId && left.revision === right.revision
}

function mergeArray<Value>(
  parent: readonly Value[] | undefined,
  child: readonly Value[] | undefined,
  mode: CordisXAgentInheritanceMode,
  key: (value: Value) => string,
): readonly Value[] | undefined {
  const unique = (values: readonly Value[] | undefined): readonly Value[] | undefined => {
    if (values === undefined) return undefined
    const identities = values.map(key)
    if (new Set(identities).size !== identities.length) {
      throw new Error('Agent definition produces duplicate effective identities')
    }
    return values
  }
  if (mode === 'none') return unique(child)
  if (mode === 'replace') return unique(child ?? parent)
  if (parent === undefined) return unique(child)
  if (child === undefined) return unique(parent)
  const values = mode === 'prepend' ? [...child, ...parent] : [...parent, ...child]
  if (mode === 'append' || mode === 'prepend') return unique(values)
  const output: Value[] = []
  const indices = new Map<string, number>()
  for (const value of values) {
    const id = key(value)
    const index = indices.get(id)
    if (index === undefined) {
      indices.set(id, output.length)
      output.push(value)
    } else output[index] = value
  }
  return output
}

function mergeFilter(
  parent: CordisXAgentFilter | undefined,
  child: CordisXAgentFilter | undefined,
  mode: CordisXAgentInheritanceMode,
): CordisXAgentFilter | undefined {
  if (mode === 'none') return child
  if (mode === 'replace') return child ?? parent
  if (parent === undefined) return child
  if (child === undefined) return parent
  const first = mode === 'prepend' ? child : parent
  const second = mode === 'prepend' ? parent : child
  return {
    ...([...new Set([...(first.include ?? []), ...(second.include ?? [])])].length === 0
      ? {}
      : { include: [...new Set([...(first.include ?? []), ...(second.include ?? [])])] }),
    ...([...new Set([...(first.exclude ?? []), ...(second.exclude ?? [])])].length === 0
      ? {}
      : { exclude: [...new Set([...(first.exclude ?? []), ...(second.exclude ?? [])])] }),
  }
}

function mergeObject<Value extends object>(
  parent: Value | undefined,
  child: Value | undefined,
  mode: CordisXAgentInheritanceMode,
): Value | undefined {
  if (mode === 'none') return child
  if (mode === 'replace') return child ?? parent
  if (parent === undefined) return child
  if (child === undefined) return parent
  return (mode === 'prepend' ? { ...child, ...parent } : { ...parent, ...child }) as Value
}

function assertDefinition(definition: CordisXAgentDefinition): void {
  if (
    definition.$schema !== CORDISX_AGENT_DEFINITION_SCHEMA_V1 || definition.contract !== 'cordisx.agent-definition/v1'
    || definition.schemaVersion !== 1
  ) throw new Error('Agent definition contract is invalid')
  if (!identifier(definition.identity.agentId) || !handle(definition.identity.revision)) {
    throw new Error('Agent definition identity is invalid')
  }
  if (
    definition.promptSections?.some(section => !identifier(section.sectionId) || section.text.trim() === '') === true
  ) throw new Error('Agent prompt section is invalid')
}

export interface CordisXResolvedAgentDefinitionCatalog {
  readonly target: CordisXResolvedAgentDefinition
  readonly definitions: readonly CordisXResolvedAgentDefinition[]
}

export function resolveAgentDefinitionCatalog(
  command: Pick<CreateCommand, 'definition' | 'definitions'>,
): CordisXResolvedAgentDefinitionCatalog {
  if (command.definitions.length === 0 || command.definitions.length > 64) {
    throw new Error('Agent definition catalog is invalid')
  }
  const catalog = new Map<string, CordisXAgentDefinition>()
  for (const definition of command.definitions) {
    assertDefinition(definition)
    const key = identityKey(definition.identity)
    if (catalog.has(key)) throw new Error(`Duplicate Agent definition ${definition.identity.agentId}`)
    catalog.set(key, clone(definition))
  }
  if (!catalog.has(identityKey(command.definition))) {
    throw new Error('Target Agent definition is missing from the catalog')
  }
  const resolving = new Set<string>()
  const resolved = new Map<string, CordisXResolvedAgentDefinition>()
  const visit = (identity: CordisXAgentDefinitionIdentity): CordisXResolvedAgentDefinition => {
    const key = identityKey(identity)
    const cached = resolved.get(key)
    if (cached !== undefined) return cached
    if (resolving.has(key)) throw new Error('Agent definition inheritance contains a cycle')
    const definition = catalog.get(key)
    if (definition === undefined) throw new Error(`Missing parent Agent definition ${identity.agentId}`)
    resolving.add(key)
    let aggregate: CordisXResolvedAgentDefinition | undefined
    for (const parentIdentity of definition.extends ?? []) {
      if (sameIdentity(parentIdentity, definition.identity)) throw new Error('Agent definition cannot extend itself')
      const parent = visit(parentIdentity)
      aggregate = aggregate === undefined ? parent : mergeResolved(aggregate, parent, MERGE_INHERITANCE)
    }
    const avatar = resolveAgentDefinitionAvatar({
      agentId: definition.identity.agentId,
      ...(definition.avatar === undefined ? {} : { avatar: definition.avatar }),
      inherit: definition.inherit.avatar ?? 'none',
      parentAvatars: (definition.extends ?? []).map(parentIdentity => visit(parentIdentity).avatar),
    })
    const base: CordisXResolvedAgentDefinition = {
      $schema: definition.$schema,
      contract: definition.contract,
      schemaVersion: 1,
      identity: definition.identity,
      ...(definition.name === undefined ? {} : { name: definition.name }),
      ...(definition.description === undefined ? {} : { description: definition.description }),
      avatar,
      ...(definition.promptSections === undefined ? {} : { promptSections: definition.promptSections }),
      ...(definition.rules === undefined ? {} : { rules: definition.rules }),
      ...(definition.skills === undefined ? {} : { skills: definition.skills }),
      ...(definition.tools === undefined ? {} : { tools: definition.tools }),
      ...(definition.mcpServers === undefined ? {} : { mcpServers: definition.mcpServers }),
      ...(definition.runtimeDefaults === undefined ? {} : { runtimeDefaults: definition.runtimeDefaults }),
      sourceDefinitions: [definition.identity],
    }
    const value = aggregate === undefined ? base : mergeResolved(aggregate, base, definition.inherit)
    resolving.delete(key)
    resolved.set(key, clone(value))
    return value
  }
  const value = visit(command.definition)
  if (resolved.size !== catalog.size) throw new Error('Agent definition catalog contains an unreachable definition')
  return Object.freeze({ target: value, definitions: Object.freeze([...resolved.values()].map(clone)) })
}

export function resolveAgentDefinition(
  command: Pick<CreateCommand, 'definition' | 'definitions'>,
): CordisXResolvedAgentDefinition {
  return resolveAgentDefinitionCatalog(command).target
}

const MERGE_INHERITANCE: CordisXAgentDefinition['inherit'] = Object.freeze({
  promptSections: 'merge',
  rules: 'merge',
  skills: 'merge',
  tools: 'merge',
  mcpServers: 'merge',
  runtimeDefaults: 'merge',
})

function mergeResolved(
  parent: CordisXResolvedAgentDefinition,
  child: CordisXResolvedAgentDefinition,
  modes: CordisXAgentDefinition['inherit'],
): CordisXResolvedAgentDefinition {
  const promptSections = mergeArray(
    parent.promptSections,
    child.promptSections,
    modes.promptSections,
    value => value.sectionId,
  )
  const rules = mergeArray(parent.rules, child.rules, modes.rules, value => value)
  const skills = mergeArray(parent.skills, child.skills, modes.skills, value => value)
  const tools = mergeFilter(parent.tools, child.tools, modes.tools)
  const mcpServers = mergeFilter(parent.mcpServers, child.mcpServers, modes.mcpServers)
  const runtimeDefaults = mergeObject(parent.runtimeDefaults, child.runtimeDefaults, modes.runtimeDefaults)
  return {
    ...child,
    ...(child.name === undefined && parent.name !== undefined ? { name: parent.name } : {}),
    ...(child.description === undefined && parent.description !== undefined ? { description: parent.description } : {}),
    ...(promptSections === undefined ? {} : { promptSections }),
    ...(rules === undefined ? {} : { rules }),
    ...(skills === undefined ? {} : { skills }),
    ...(tools === undefined ? {} : { tools }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(runtimeDefaults === undefined ? {} : { runtimeDefaults }),
    sourceDefinitions: [
      ...new Map(
        [...parent.sourceDefinitions, ...child.sourceDefinitions].map(identity => [identityKey(identity), identity]),
      ).values(),
    ],
  }
}

export function renderAgentDeveloperInstructions(definition: CordisXResolvedAgentDefinition): string | undefined {
  const sections = (definition.promptSections ?? []).map(section =>
    `## ${section.kind}:${section.sectionId}\n\n${section.text.trim()}`
  )
  if ((definition.rules?.length ?? 0) > 0) {
    sections.push(`## rules\n\n${definition.rules!.map(item => `- ${item}`).join('\n')}`)
  }
  if ((definition.skills?.length ?? 0) > 0) {
    sections.push(`## skills\n\n${definition.skills!.map(item => `- ${item}`).join('\n')}`)
  }
  if (definition.tools !== undefined) sections.push(`## tool-filter\n\n${JSON.stringify(definition.tools)}`)
  if (definition.mcpServers !== undefined) sections.push(`## mcp-filter\n\n${JSON.stringify(definition.mcpServers)}`)
  const value = sections.join('\n\n').trim()
  return value === '' ? undefined : value
}

export class BindingAgentLoopHost implements CordisXAgentLoopHost {
  private readonly tasks = new Map<string, HostTask>()
  constructor(private readonly platform: BindingPlatformAdapter, private readonly workspaceCwd: string) {}
  async prepare(definition: CordisXResolvedAgentDefinition) {
    const requested = definition.runtimeDefaults?.model
    if (requested !== undefined) {
      return { ok: true as const, value: { model: clone(requested), cwd: this.workspaceCwd } }
    }
    const models = await this.platform.listModels({})
    if (!models.ok) return models
    const model = models.value.models.find(item => item.isDefault === true)?.ref ?? models.value.models[0]?.ref
    return model === undefined
      ? {
        ok: false as const,
        error: { code: 'adapter-unavailable' as const, message: 'AgentLoop has no available model', retryable: true },
      }
      : { ok: true as const, value: { model: clone(model), cwd: this.workspaceCwd } }
  }
  async create(definition: CordisXResolvedAgentDefinition, prepared: CordisXAgentLoopPrepared) {
    if (prepared.model === undefined || prepared.cwd === undefined) {
      return {
        ok: false as const,
        error: { code: 'invalid-request' as const, message: 'Platform AgentLoop preparation is incomplete' },
      }
    }
    const developerInstructions = renderAgentDeveloperInstructions(definition)
    const created = await this.platform.createAgentLoopTask({
      model: prepared.model,
      cwd: prepared.cwd,
      ...(developerInstructions === undefined ? {} : { developerInstructions }),
      ...(definition.runtimeDefaults?.effort === undefined ? {} : { effort: definition.runtimeDefaults.effort }),
    })
    if (!created.ok) return created
    const task = `cxloop-task:${crypto.randomUUID()}`
    const value = clone({
      task,
      session: created.value.ref,
      detailsUrl: {
        url: `codex:task/${encodeURIComponent(created.value.ref.remoteSessionId)}` as const,
        target: 'external' as const,
      },
    })
    this.tasks.set(task, value)
    return { ok: true as const, value }
  }
  async bind(task: string) {
    const value = this.tasks.get(task)
    if (value === undefined) {
      return {
        ok: false as const,
        error: { code: 'task-not-found' as const, message: 'AgentLoop task handle is unavailable' },
      }
    }
    const read = await this.platform.readTask({ session: value.session })
    return read.ok ? { ok: true as const, value: clone(value) } : read
  }
  async send(task: HostTask, content: readonly [CordisXAgentLoopContentPart, ...CordisXAgentLoopContentPart[]]) {
    if (content.some(part => part.kind === 'image-ref')) {
      return {
        ok: false as const,
        error: {
          code: 'adapter-unavailable' as const,
          message: 'No controlled image-ref resolver is available for this provider',
        },
      }
    }
    const message = content.map(part => part.kind === 'text' ? part.text : '').join('\n').trim()
    if (message === '') {
      return {
        ok: false as const,
        error: { code: 'invalid-request' as const, message: 'AgentLoop message has no text content' },
      }
    }
    const turn = await this.platform.submitTurn({ session: task.session, message })
    return turn.ok
      ? { ok: true as const, value: { messageId: `cxloop-message:${crypto.randomUUID()}`, turn: turn.value.turnId } }
      : turn
  }
  async lifecycle(task: HostTask, afterSequence: number) {
    return await this.platform.readAgentLoopLifecycle(task.session, afterSequence)
  }
}

export class UnavailableAgentLoopHost implements CordisXAgentLoopHost {
  async prepare(): Promise<CordisXPlatformResult<CordisXAgentLoopPrepared>> {
    return {
      ok: false,
      error: { code: 'adapter-unavailable', message: 'AgentLoop provider bridge is unavailable', retryable: true },
    }
  }
  async create(): Promise<CordisXPlatformResult<HostTask>> {
    return {
      ok: false,
      error: { code: 'adapter-unavailable', message: 'AgentLoop provider bridge is unavailable', retryable: true },
    }
  }
  async bind(): Promise<CordisXPlatformResult<HostTask>> {
    return {
      ok: false,
      error: { code: 'adapter-unavailable', message: 'AgentLoop provider bridge is unavailable', retryable: true },
    }
  }
  async send(): Promise<CordisXPlatformResult<HostSend>> {
    return {
      ok: false,
      error: { code: 'adapter-unavailable', message: 'AgentLoop provider bridge is unavailable', retryable: true },
    }
  }
  async lifecycle(_task: HostTask, afterSequence: number) {
    return { nextAfterSequence: afterSequence, events: [] }
  }
}

interface BindingRecord {
  readonly ownerKey: string
  readonly definition: CordisXResolvedAgentDefinition
  readonly task: HostTask
  binding: CordisXAgentLoopTaskBinding
  readonly events: CordisXAgentLoopEvent[]
  readonly listeners: Set<(events: readonly CordisXAgentLoopEvent[]) => void>
  readonly subscriptions: Set<CordisXAgentLoopSubscription>
  lifecycleCursor: number
  polling: boolean
  poll: ReturnType<typeof setTimeout> | undefined
  promptDisposers: readonly Disposable<void>[]
}

export class CordisXAgentLoopBroker {
  private readonly records = new Map<string, BindingRecord>()
  private readonly boundTasks = new Map<string, BindingRecord>()
  private nextBinding = 0
  private nextSubscription = 0
  private disposed = false
  constructor(private readonly host: CordisXAgentLoopHost, private readonly now: () => Date = () => new Date()) {}

  bind(options: CordisXBoundAgentLoopClientOptions): CordisXBoundAgentLoopClient {
    const owned = new Set<string>()
    const subscriptions = new Set<CordisXAgentLoopSubscription>()
    const commands = new Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>()
    let disposed = false
    const live = () => !disposed && !this.disposed && options.active()
    const idempotent = <Result>(
      command: CreateCommand | SendCommand,
      conflict: () => Result,
      execute: () => Promise<Result>,
    ): Promise<Result> => {
      const fingerprint = commandFingerprint(command)
      const existing = commands.get(command.commandId)
      if (existing !== undefined) {
        return existing.fingerprint === fingerprint
          ? existing.result as Promise<Result>
          : Promise.resolve(conflict())
      }
      const result = execute()
      commands.set(command.commandId, { fingerprint, result })
      void result.catch(() => {
        if (commands.get(command.commandId)?.result === result) commands.delete(command.commandId)
      })
      return result
    }
    const client: CordisXBoundAgentLoopClient = Object.freeze({
      $schema: CORDISX_BOUND_AGENT_LOOP_CLIENT_SCHEMA_V1,
      contract: 'cordisx.bound-agent-loop-client/v1',
      schemaVersion: 1,
      createOrBind: (command: CreateCommand): Promise<CordisXAgentLoopCreateOrBindResult> =>
        idempotent(
          command,
          () =>
            this.refusal(
              command,
              command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read',
              'unavailable',
              'unsupported',
            ),
          async () => {
            if (!live()) {
              return this.refusal(
                command,
                command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read',
                'unavailable',
                'host-unavailable',
              )
            }
            let definition: CordisXResolvedAgentDefinition
            try {
              definition = resolveAgentDefinition(command)
            } catch {
              return this.refusal(
                command,
                command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read',
                'unavailable',
                'unsupported',
              )
            }
            let task: HostTask
            let capability: 'tasks.create' | 'tasks.content.read'
            if (command.target.mode === 'create') {
              capability = 'tasks.create'
              const prepared = await this.host.prepare(definition)
              if (!prepared.ok) return this.refusal(command, capability, 'unavailable', 'host-unavailable')
              const authorization = await options.authorize({
                capability,
                ...(prepared.value.model === undefined ? {} : { model: prepared.value.model }),
                ...(prepared.value.cwd === undefined ? {} : { cwd: prepared.value.cwd }),
              })
              if (authorization.state !== 'allowed') return this.refusalFrom(command, authorization)
              const created = await this.host.create(
                definition,
                prepared.value,
                clone({ target: command.definition, definitions: command.definitions }),
              )
              if (!created.ok) return this.refusal(command, capability, 'unavailable', 'host-unavailable')
              task = created.value
            } else {
              capability = 'tasks.content.read'
              const existing = this.boundTasks.get(this.taskKey(options.ownerKey, command.target.task))
              if (existing !== undefined && existing.binding.state === 'active') {
                const authorization = await options.authorize({ capability, session: existing.task.session })
                if (authorization.state !== 'allowed') return this.refusalFrom(command, authorization)
                if (!sameIdentity(existing.definition.identity, definition.identity)) {
                  return this.refusal(command, capability, 'unavailable', 'unsupported')
                }
                owned.add(existing.binding.binding.bindingId)
                return this.acceptCreate(command, existing.binding)
              }
              const bound = await this.host.bind(command.target.task)
              if (!bound.ok) {
                return this.refusal(command, capability, 'unavailable', 'task-unavailable')
              }
              const authorization = await options.authorize({ capability, session: bound.value.session })
              if (authorization.state !== 'allowed') {
                this.host.release?.(bound.value)
                return this.refusalFrom(command, authorization)
              }
              task = bound.value
            }
            const binding = clone({
              $schema: CORDISX_AGENT_LOOP_TASK_BINDING_SCHEMA_V1,
              contract: 'cordisx.agent-loop-task-binding/v1' as const,
              schemaVersion: 1 as const,
              binding: { bindingId: `cxloop-binding:${this.nextBinding++}`, generation: 1 },
              definition: definition.identity,
              task: task.task,
              state: 'active' as const,
            })
            const record: BindingRecord = {
              ownerKey: options.ownerKey,
              definition,
              task,
              binding,
              events: [],
              listeners: new Set(),
              subscriptions: new Set(),
              lifecycleCursor: 0,
              polling: false,
              poll: undefined,
              promptDisposers: options.registerPrompt?.(task.session.remoteSessionId, definition) ?? [],
            }
            this.records.set(binding.binding.bindingId, record)
            this.boundTasks.set(this.taskKey(options.ownerKey, task.task), record)
            owned.add(binding.binding.bindingId)
            this.append(record, {
              type: 'lifecycle',
              lifecycle: { phase: command.target.mode === 'create' ? 'binding.created' : 'binding.bound' },
            })
            return this.acceptCreate(command, binding)
          },
        ),
      send: (command: SendCommand): Promise<CordisXAgentLoopSendResult> =>
        idempotent(command, () => this.refusal(command, 'turns.submit', 'unavailable', 'unsupported'), async () => {
          const record = this.owned(options.ownerKey, command.binding)
          if (!live() || record === undefined) {
            return this.refusal(command, 'turns.submit', 'unavailable', 'task-unavailable')
          }
          const authorization = await options.authorize({ capability: 'turns.submit', session: record.task.session })
          if (authorization.state !== 'allowed') return this.refusalFrom(command, authorization)
          const sent = await this.host.send(record.task, command.content)
          if (!sent.ok) {
            return this.refusal(
              command,
              'turns.submit',
              'unavailable',
              sent.error.code === 'adapter-unavailable' ? 'unsupported' : 'host-unavailable',
            )
          }
          this.append(record, {
            type: 'message',
            turn: sent.value.turn,
            message: { messageId: sent.value.messageId, role: 'user', content: command.content },
          })
          this.append(record, { type: 'lifecycle', turn: sent.value.turn, lifecycle: { phase: 'turn.started' } })
          this.startPolling(record)
          return clone({
            $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1,
            contract: 'cordisx.agent-loop-result/v1',
            schemaVersion: 1,
            commandId: command.commandId,
            type: 'send',
            status: 'accepted',
            authorization,
            binding: record.binding,
            messageId: sent.value.messageId,
          })
        }),
      subscribe: async (
        binding: CordisXAgentLoopTaskBinding,
        afterSequence: number,
      ): Promise<CordisXAgentLoopSubscribeRuntimeResult> => {
        const record = this.owned(options.ownerKey, binding)
        if (!live() || record === undefined || !Number.isInteger(afterSequence) || afterSequence < -1) {
          return {
            status: 'unavailable',
            authorization: { capability: 'tasks.content.read', state: 'unavailable', code: 'task-unavailable' },
          }
        }
        const authorization = await options.authorize({
          capability: 'tasks.content.read',
          session: record.task.session,
        })
        const subscriptionAuthorization = { ...authorization, capability: 'tasks.content.read' as const }
        if (subscriptionAuthorization.state !== 'allowed') {
          return {
            status: subscriptionAuthorization.state,
            authorization: subscriptionAuthorization,
          } as CordisXAgentLoopSubscribeRuntimeResult
        }
        const handle = this.subscription(record, afterSequence)
        subscriptions.add(handle)
        this.startPolling(record)
        return { status: 'accepted', authorization: subscriptionAuthorization, handle }
      },
      dispose: () => {
        if (disposed) return
        disposed = true
        for (const bindingId of owned) this.close(this.records.get(bindingId))
        for (const subscription of subscriptions) subscription.unsubscribe()
        commands.clear()
      },
    })
    return client
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.records.values()) this.close(record)
    this.records.clear()
    this.boundTasks.clear()
  }

  private acceptCreate(
    command: CreateCommand,
    binding: CordisXAgentLoopTaskBinding,
  ): CordisXAgentLoopCreateOrBindResult {
    return clone({
      $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1,
      contract: 'cordisx.agent-loop-result/v1',
      schemaVersion: 1,
      commandId: command.commandId,
      type: 'create-or-bind',
      status: 'accepted',
      authorization: {
        capability: command.target.mode === 'create' ? 'tasks.create' : 'tasks.content.read',
        state: 'allowed',
        code: 'allowed',
      },
      binding,
    })
  }
  private refusal<Command extends CreateCommand | SendCommand>(
    command: Command,
    capability: CordisXAgentLoopAuthorizationOutcome['capability'],
    state: 'denied' | 'unavailable',
    code: Refused['code'],
  ): Command extends CreateCommand ? CordisXAgentLoopCreateOrBindResult : CordisXAgentLoopSendResult {
    return clone(
      {
        $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1,
        contract: 'cordisx.agent-loop-result/v1',
        schemaVersion: 1,
        commandId: command.commandId,
        type: command.type,
        status: state,
        authorization: { capability, state, code },
      } as Command extends CreateCommand ? CordisXAgentLoopCreateOrBindResult : CordisXAgentLoopSendResult,
    )
  }
  private refusalFrom<Command extends CreateCommand | SendCommand>(
    command: Command,
    authorization: Refused,
  ): Command extends CreateCommand ? CordisXAgentLoopCreateOrBindResult : CordisXAgentLoopSendResult {
    return clone(
      {
        $schema: CORDISX_AGENT_LOOP_RESULT_SCHEMA_V1,
        contract: 'cordisx.agent-loop-result/v1',
        schemaVersion: 1,
        commandId: command.commandId,
        type: command.type,
        status: authorization.state,
        authorization,
      } as Command extends CreateCommand ? CordisXAgentLoopCreateOrBindResult : CordisXAgentLoopSendResult,
    )
  }
  private owned(ownerKey: string, binding: CordisXAgentLoopTaskBinding): BindingRecord | undefined {
    const record = this.records.get(binding.binding.bindingId)
    return record?.ownerKey === ownerKey && record.binding.state === 'active'
        && record.binding.binding.generation === binding.binding.generation && record.binding.task === binding.task
        && sameIdentity(record.binding.definition, binding.definition)
      ? record
      : undefined
  }
  private taskKey(ownerKey: string, task: string): string {
    return `${ownerKey}\0${task}`
  }

  private append(record: BindingRecord, payload: EventPayload): void {
    const event = clone({
      $schema: CORDISX_AGENT_LOOP_EVENT_SCHEMA_V1,
      contract: 'cordisx.agent-loop-event/v1',
      schemaVersion: 1,
      eventId: `cxloop-event:${record.binding.binding.bindingId}:${record.events.length}`,
      binding: record.binding.binding,
      sequence: record.events.length,
      occurredAt: this.now().toISOString(),
      ...payload,
    } as CordisXAgentLoopEvent)
    record.events.push(event)
    for (const listener of record.listeners) listener([event])
  }

  private startPolling(record: BindingRecord): void {
    if (record.polling || record.poll !== undefined || record.binding.state !== 'active') return
    record.polling = true
    const poll = async () => {
      if (record.binding.state !== 'active' || this.disposed) {
        record.polling = false
        return
      }
      try {
        const range = await this.host.lifecycle(record.task, record.lifecycleCursor)
        if (record.binding.state !== 'active' || this.disposed) return
        record.lifecycleCursor = range.nextAfterSequence
        for (const event of range.events) this.projectLifecycle(record, event)
      } catch {
        /* transient provider gaps remain retryable and do not fabricate events */
      } finally {
        record.polling = false
      }
      if (record.binding.state === 'active' && !this.disposed) {
        record.poll = setTimeout(() => {
          record.poll = undefined
          this.startPolling(record)
        }, 250)
      }
    }
    void poll()
  }

  private projectLifecycle(record: BindingRecord, event: CordisXAgentLoopLifecycleEvent): void {
    if (event.type === 'turn.completed') {
      if ((event.output?.length ?? 0) > 0) {
        this.append(record, {
          type: 'message',
          turn: event.turnId,
          message: {
            messageId: `cxloop-assistant:${event.turnId}`,
            role: 'assistant',
            content: event.output!.map(item => ({ kind: 'text' as const, text: item.text })) as [
              CordisXAgentLoopContentPart,
              ...CordisXAgentLoopContentPart[],
            ],
          },
        })
      }
      this.append(record, { type: 'lifecycle', turn: event.turnId, lifecycle: { phase: 'turn.completed' } })
      return
    }
    if (event.type === 'turn.failed') {
      this.append(record, {
        type: 'lifecycle',
        turn: event.turnId,
        lifecycle: { phase: 'turn.failed', failure: event.failure ?? { code: 'AGENT_LOOP_FAILED', retryable: false } },
      })
      return
    }
    if (event.type === 'turn.started') {
      if (
        !record.events.some(item =>
          item.type === 'lifecycle' && item.turn === event.turnId && item.lifecycle.phase === 'turn.started'
        )
      ) this.append(record, { type: 'lifecycle', turn: event.turnId, lifecycle: { phase: 'turn.started' } })
      return
    }
    if (event.approval === undefined) return
    this.append(record, {
      type: 'approval',
      turn: event.turnId,
      approval: event.approval.state === 'pending'
        ? { approvalId: event.approval.approvalId, kind: event.approval.kind, state: 'pending' }
        : {
          approvalId: event.approval.approvalId,
          kind: event.approval.kind,
          state: 'resolved',
          outcome: event.approval.outcome ?? 'cancelled',
        },
    })
  }

  private subscription(record: BindingRecord, afterSequence: number): CordisXAgentLoopSubscription {
    const snapshotSequence = Math.max(0, record.events.length - 1)
    const descriptor: CordisXAgentLoopEventSubscription = clone({
      $schema: CORDISX_AGENT_LOOP_EVENT_SUBSCRIPTION_SCHEMA_V1,
      contract: 'cordisx.agent-loop-event-subscription/v1',
      schemaVersion: 1,
      subscriptionId: `cxloop-subscription:${this.nextSubscription++}`,
      binding: record.binding.binding,
      afterSequence,
      snapshotSequence,
    })
    const pageSize = 64
    const waiters: ((result: IteratorResult<CordisXAgentLoopEventPage>) => void)[] = []
    let closed = false
    let cursor = afterSequence
    const nextPage = (): CordisXAgentLoopEventPage | undefined => {
      const phase = cursor < snapshotSequence ? 'replay' : 'live'
      const endSequence = phase === 'replay' ? snapshotSequence : record.events.length - 1
      const selected = record.events.filter(event => event.sequence > cursor && event.sequence <= endSequence).slice(
        0,
        pageSize,
      )
      if (selected.length === 0) return undefined
      const page: CordisXAgentLoopEventPage = clone({
        $schema: CORDISX_AGENT_LOOP_EVENT_PAGE_SCHEMA_V1,
        contract: 'cordisx.agent-loop-event-page/v1',
        schemaVersion: 1,
        subscription: descriptor,
        afterSequence: cursor,
        phase,
        events: selected,
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
    const handle: CordisXAgentLoopSubscription = {
      subscription: descriptor,
      pages: {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            const page = nextPage()
            if (page !== undefined) return { value: page, done: false }
            if (closed) return { value: undefined, done: true }
            return await new Promise(resolve => waiters.push(resolve))
          },
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

  private close(record: BindingRecord | undefined): void {
    if (record === undefined || record.binding.state === 'closed') return
    this.append(record, { type: 'lifecycle', lifecycle: { phase: 'binding.closed' } })
    record.binding = clone({ ...record.binding, state: 'closed' })
    if (record.poll !== undefined) clearTimeout(record.poll)
    record.poll = undefined
    for (const dispose of record.promptDisposers) dispose()
    this.host.release?.(record.task)
    for (const subscription of [...record.subscriptions]) subscription.unsubscribe()
    record.listeners.clear()
    const key = this.taskKey(record.ownerKey, record.task.task)
    if (this.boundTasks.get(key) === record) this.boundTasks.delete(key)
  }
}
