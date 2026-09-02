import { Context, Service } from '@deepseek-ai/cordis'
import type {
  Agent,
  AgentAcquireResult,
  AgentCancelOptions,
  AgentCreateOptions,
  AgentDetailReference,
  AgentDisposeOptions,
  AgentHandle,
  AgentIdleResult,
  AgentLiveEvent,
  AgentLiveEventObserver,
  AgentLiveSubscribeResult,
  AgentMessageDiscardResult,
  AgentMutationResult,
  AgentOptions,
  AgentRegistry,
  AgentResumeOptions,
  AgentRuntimeCapability,
  AgentStatus,
  AgentStatusObservation,
} from '@cordisx/protocol/agents/v1'
import type {
  ApprovalAnswerer,
  ApprovalAnswererHandle,
  ApprovalDecision,
  ApprovalQuestion,
  ApprovalService,
} from '@cordisx/protocol/approval/v1'
import type {
  ApprovalOutcome,
  AgentCancelCause,
  MessageId,
  PluginOwnerIdentity,
  Session,
  SessionEvent,
  SessionEventDataMap,
  SessionEventObserver,
  SessionHeader,
  SessionReadRequest,
  SessionRegistry,
  SessionSnapshotResult,
  SessionSubscribeRequest,
  SessionSubscribeResult,
  SessionSubscription,
  SessionSubscriptionClosed,
  SessionSubscriptionCloseCode,
  UserMessage,
} from '@cordisx/protocol/sessions/v1'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { generationFromContext } from './ownership.js'

const ACQUIRE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-acquire-result.v1.schema.json' as const
const ADMISSION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-admission.v1.schema.json' as const
const MUTATION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-mutation-result.v1.schema.json' as const
const DISCARD_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-message-cancellation-result.v1.schema.json' as const
const SNAPSHOT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-snapshot.v1.schema.json' as const
const PAGE_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event-page.v1.schema.json' as const
const SUBSCRIPTION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-page.v1.schema.json' as const
const QUESTION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-question.v1.schema.json' as const
const DECISION_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/approval-decision.v1.schema.json' as const

const clone = <Value>(value: Value): Value => structuredClone(value)
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const ownerKey = (owner: PluginOwnerIdentity) => `${owner.pluginId}\u0000${owner.generation}`

export type CordisXDriverSessionEvent = {
  [K in 'turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'assistant/chunk' | 'assistant/message' | 'tool/call' | 'tool/result']:
    { readonly sessionId: string; readonly type: K; readonly data: SessionEventDataMap[K] }
}['turn/start' | 'turn/end' | 'step/start' | 'step/end' | 'assistant/chunk' | 'assistant/message' | 'tool/call' | 'tool/result']

export interface CordisXDriverApprovalRequest {
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
}

export interface CordisXDriverAgentStatus {
  readonly sessionId: string
  readonly status: AgentStatus
}

export interface CordisXPrivateAgentDriver {
  create(input: { readonly sessionId: string; readonly options: AgentOptions; readonly setup?: AgentCreateOptions['setup'] }): Promise<{ readonly status: 'accepted'; readonly detail?: AgentDetailReference } | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }>
  resume(input: { readonly sessionId: string; readonly options: AgentOptions; readonly setup?: AgentResumeOptions['setup'] }): Promise<{ readonly status: 'accepted'; readonly detail?: AgentDetailReference } | { readonly status: 'unavailable'; readonly code: 'host-unavailable' | 'unsupported' }>
  submit(input: { readonly sessionId: string; readonly message: UserMessage; readonly target: 'next-turn' | 'next-step'; readonly wakeup: boolean }): Promise<'accepted' | 'unavailable'>
  discard(input: { readonly sessionId: string; readonly messageId: MessageId }): Promise<'accepted' | 'not-found' | 'already-claimed' | 'unavailable'>
  cancel(input: { readonly sessionId: string; readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted' | 'unavailable'>
  /** Driver observations are appended only by the Host Session authority. */
  onSessionEvent?(listener: (event: CordisXDriverSessionEvent) => void): () => void
  onAgentStatus?(listener: (event: CordisXDriverAgentStatus) => void): () => void
  /** A driver can request a Host-scoped approval without seeing an Agent handle. */
  onApprovalRequest?(listener: (request: CordisXDriverApprovalRequest) => Promise<ApprovalOutcome>): () => void
  onReplacement(listener: () => void): () => void
  dispose(): void
}

export interface CordisXAgentSessionRuntimeOptions {
  readonly driver: CordisXPrivateAgentDriver
  readonly authorize: (owner: PluginOwnerIdentity, capability: AgentRuntimeCapability, sessionId?: string) => Promise<boolean>
  readonly now?: () => number
}

interface SessionRecord {
  readonly id: string
  generation: number
  readonly header: SessionHeader
  readonly events: SessionEvent[]
  readonly subscribers: Set<SessionSubscriber>
  closed?: 'connection-replaced' | 'host-unavailable'
}

interface AgentRecord {
  readonly id: string
  generation: number
  readonly owner: PluginOwnerIdentity
  readonly session: SessionRecord
  readonly options: AgentOptions
  readonly pending: Map<string, UserMessage>
  readonly claimed: Set<string>
  readonly live: Set<AgentSubscriber>
  readonly detail?: AgentDetailReference
  disposed?: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced'
}

interface SessionSubscriber {
  readonly generation: number
  readonly owner: PluginOwnerIdentity
  readonly observer: SessionEventObserver
  lastSeq: number
  closed?: SessionSubscriptionClosed
  resolveClosed: (value: SessionSubscriptionClosed) => void
  delivery: Promise<void>
}

interface AgentSubscriber {
  readonly owner: PluginOwnerIdentity
  readonly observer: AgentLiveEventObserver
  closed?: 'unsubscribed' | 'agent-replaced' | 'plugin-generation-replaced' | 'connection-replaced' | 'permission-revoked'
}

interface AnswererRecord {
  readonly owner: PluginOwnerIdentity
  readonly answerer: ApprovalAnswerer
  closed?: 'disposed' | 'agent-replaced' | 'plugin-generation-replaced' | 'permission-revoked'
}

/**
 * Host-private AgentFactory/session append authority. Public values are only
 * produced through its three Cordis services below; callers never receive a
 * driver, native connection, operation id, or raw native payload.
 */
export class CordisXAgentSessionRuntime {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly agents = new Map<string, AgentRecord>()
  private readonly handles = new WeakMap<object, AgentRecord>()
  private readonly answerers = new Map<string, AnswererRecord>()
  private readonly mutations = new Map<string, { readonly fingerprint: string; readonly result: AgentAcquireResult }>()
  private nextAgentGeneration = 0
  private nextSubscriptionGeneration = 0
  private nextOwnerGeneration = 0
  private readonly ownerGenerations = new Map<string, number>()
  private disposed = false
  private readonly unsubscribeReplacement: () => void
  private readonly unsubscribeDriverEvents: () => void
  private readonly unsubscribeDriverApprovals: () => void
  private readonly unsubscribeDriverStatus: () => void
  private readonly now: () => number

  constructor(private readonly options: CordisXAgentSessionRuntimeOptions) {
    this.now = options.now ?? (() => Date.now())
    this.unsubscribeReplacement = options.driver.onReplacement(() => this.connectionReplaced())
    this.unsubscribeDriverEvents = options.driver.onSessionEvent?.(event => this.appendDriverEvent(event)) ?? (() => {})
    this.unsubscribeDriverApprovals = options.driver.onApprovalRequest?.(async request => await this.requestDriverApproval(request)) ?? (() => {})
    this.unsubscribeDriverStatus = options.driver.onAgentStatus?.(event => this.emitDriverStatus(event)) ?? (() => {})
  }

  ownerFromContext(ctx: Context): PluginOwnerIdentity {
    const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
    const pluginId = scoped[CORDISX_PLUGIN_ID]
    const source = scoped[CORDISX_PLUGIN_SOURCE]
    if (pluginId === undefined || source === undefined) throw new Error('Agent runtime requires a Host-bound plugin context')
    const key = `${source}\u0000${pluginId}\u0000${generationFromContext(ctx) ?? 'host'}`
    let generation = this.ownerGenerations.get(key)
    if (generation === undefined) {
      generation = ++this.nextOwnerGeneration
      this.ownerGenerations.set(key, generation)
    }
    return Object.freeze({ pluginId: `${source}:${pluginId}`, generation })
  }

  async create(owner: PluginOwnerIdentity, input: AgentCreateOptions): Promise<AgentAcquireResult> {
    const sessionId = input.sessionId ?? `cx-session:${crypto.randomUUID()}`
    if (!opaque(sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.create', sessionId)) return this.acquireDenied('create', input.mutationId)
    return await this.acquire(owner, 'create', sessionId, input, input.sessionId === undefined ? 'host' : 'caller')
  }

  async resume(owner: PluginOwnerIdentity, input: AgentResumeOptions): Promise<AgentAcquireResult> {
    if (!opaque(input.sessionId)) throw new Error('Agent SessionId must be a non-empty opaque identifier')
    if (!await this.allowed(owner, 'agents.resume', input.sessionId)) return this.acquireDenied('resume', input.mutationId)
    return await this.acquire(owner, 'resume', input.sessionId, input, 'caller')
  }

  async get(owner: PluginOwnerIdentity, agentId: string): Promise<Agent | undefined> {
    if (!opaque(agentId) || !await this.allowed(owner, 'agents.get', agentId)) return undefined
    const record = this.agents.get(agentId)
    return record === undefined || record.disposed !== undefined ? undefined : this.agent(owner, record)
  }

  async session(owner: PluginOwnerIdentity, sessionId: string): Promise<Session | undefined> {
    if (!opaque(sessionId) || !await this.allowed(owner, 'sessions.get', sessionId)) return undefined
    const record = this.sessions.get(sessionId)
    return record === undefined ? undefined : this.sessionHandle(owner, record)
  }

  async requestApproval(owner: PluginOwnerIdentity, request: Parameters<ApprovalService['request']>[0]): Promise<ApprovalDecision> {
    const record = this.recordForAgent(request.agent)
    if (record === undefined || !await this.allowed(owner, 'approvals.request', request.agent.id)) {
      return this.approvalDecision(request.agent, crypto.randomUUID(), request.toolName, request.callId, 'unavailable')
    }
    const id = `cx-approval:${crypto.randomUUID()}`
    const question = this.approvalQuestion(record, id, request.toolName, request.callId, request.reason)
    this.append(record.session, 'approval/asked', { id, toolName: request.toolName, ...(request.callId === undefined ? {} : { callId: request.callId }), ...(request.reason === undefined ? {} : { reason: request.reason }) })
    const answerer = this.answerers.get(this.answererKey(record))
    let outcome: ApprovalOutcome = 'unavailable'
    if (answerer !== undefined && answerer.closed === undefined && await this.allowed(answerer.owner, 'approvals.answer', record.id)) {
      try {
        const proposed = await answerer.answerer(question)
        if (proposed === 'allowed-once' || proposed === 'rejected' || proposed === 'cancelled' || proposed === 'unavailable') outcome = proposed
      } catch { outcome = 'unavailable' }
    }
    this.append(record.session, 'approval/decided', { id, outcome })
    return this.approvalDecision(record, id, request.toolName, request.callId, outcome)
  }

  async registerAnswerer(owner: PluginOwnerIdentity, agent: Agent, answerer: ApprovalAnswerer): Promise<ApprovalAnswererHandle> {
    const record = this.recordForAgent(agent)
    if (record === undefined || typeof answerer !== 'function' || !await this.allowed(owner, 'approvals.answer', agent.id)) {
      throw new Error('Approval answerer is unavailable')
    }
    const entry: AnswererRecord = { owner: clone(owner), answerer }
    this.answerers.set(this.answererKey(record), entry)
    const handle = Object.freeze({
      agentId: record.id,
      agentGeneration: record.generation,
      dispose: async () => {
        if (entry.closed === undefined) entry.closed = 'disposed'
        this.answerers.delete(this.answererKey(record))
        return { status: 'closed' as const, code: 'disposed' as const }
      },
    })
    return handle as ApprovalAnswererHandle
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeReplacement()
    this.unsubscribeDriverEvents()
    this.unsubscribeDriverApprovals()
    this.unsubscribeDriverStatus()
    for (const agent of this.agents.values()) this.disposeAgent(agent, 'runtime-disposed')
    for (const session of this.sessions.values()) this.closeSession(session, 'host-unavailable')
    this.options.driver.dispose()
  }

  /** Host lifecycle/route/lease fences call this private authority directly. */
  fenceSession(sessionId: string, code: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) this.closeSession(session, code === 'route-replaced' ? 'host-unavailable' : code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable', code)
  }

  /** Route, permission, and plugin-generation authorities fence by Host-bound owner only. */
  fenceOwner(ownerPluginId: string, code: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'>): void {
    for (const agent of this.agents.values()) {
      if (agent.owner.pluginId !== ownerPluginId) continue
      this.disposeAgent(agent, code === 'connection-replaced' ? 'connection-replaced' : 'owner-disposed')
      this.closeSession(agent.session, code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable', code)
    }
  }

  private async acquire(
    owner: PluginOwnerIdentity,
    operation: 'create' | 'resume',
    sessionId: string,
    input: AgentCreateOptions | AgentResumeOptions,
    source: 'host' | 'caller',
  ): Promise<AgentAcquireResult> {
    if (this.disposed) return this.acquireUnavailable(operation, input.mutationId, 'runtime-unavailable')
    const mutationId = input.mutationId
    const mutationKey = mutationId === undefined ? undefined : `${ownerKey(owner)}\u0000${operation}\u0000${mutationId}`
    const fingerprint = JSON.stringify(clone(input))
    const prior = mutationKey === undefined ? undefined : this.mutations.get(mutationKey)
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) return this.acquireConflict(operation, mutationId, 'mutation-conflict')
      const replay = clone(prior.result)
      if (replay.status === 'accepted') return { ...replay, disposition: 'replayed' }
      return replay
    }
    if (operation === 'create' && this.sessions.has(sessionId)) return this.remember(mutationKey, fingerprint, this.acquireConflict(operation, mutationId, 'session-already-exists'))
    const live = this.agents.get(sessionId)
    if (live !== undefined && live.disposed === undefined) return this.remember(mutationKey, fingerprint, this.acquireConflict(operation, mutationId, 'agent-already-live'))
    const existing = this.sessions.get(sessionId)
    if (operation === 'resume' && existing === undefined) return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, 'session-unavailable'))
    const driver = operation === 'create'
      ? await this.options.driver.create({ sessionId, options: input.options ?? {}, ...(input.setup === undefined ? {} : { setup: input.setup }) })
      : await this.options.driver.resume({ sessionId, options: input.options ?? {}, ...(input.setup === undefined ? {} : { setup: input.setup }) })
    if (driver.status !== 'accepted') return this.remember(mutationKey, fingerprint, this.acquireUnavailable(operation, mutationId, driver.code))
    const session = existing ?? this.newSession(sessionId)
    const record: AgentRecord = {
      id: sessionId,
      generation: ++this.nextAgentGeneration,
      owner: clone(owner),
      session,
      options: clone(input.options ?? {}),
      pending: new Map(),
      claimed: new Set(),
      live: new Set(),
      ...(driver.detail === undefined ? {} : { detail: clone(driver.detail) }),
    }
    this.agents.set(sessionId, record)
    this.emitLive(record, 'agent/created', {})
    this.emitLive(record, 'agent/session-start', { source: operation === 'create' ? 'startup' : 'resume' })
    const handle = this.handle(owner, record)
    const accepted = {
      $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1' as const, schemaVersion: 1 as const,
      operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'accepted' as const,
      sessionId, agentGeneration: record.generation, sessionGeneration: session.generation,
      owner: clone(owner), sessionIdSource: source, disposition: operation === 'create' ? 'created' as const : 'resumed' as const, handle,
    }
    return this.remember(mutationKey, fingerprint, accepted)
  }

  private agent(owner: PluginOwnerIdentity, record: AgentRecord): Agent {
    const session = this.sessionHandle(owner, record.session)
    const admission = async (message: UserMessage, target: 'next-turn' | 'next-step', wakeup: boolean) => {
      if (!this.current(record)) return this.admission(message.id, 'unavailable', 'agent-replaced')
      if (!this.sameSource(owner, message.source)) return this.admission(message.id, 'denied', 'source-denied')
      if (!await this.allowed(owner, 'agents.message.submit', record.id)) return this.admission(message.id, 'denied', 'permission-denied')
      const prior = record.pending.get(message.id)
      if (prior !== undefined) return this.admission(message.id, 'accepted')
      const submitted = await this.options.driver.submit({ sessionId: record.id, message: clone(message), target, wakeup })
      if (submitted !== 'accepted') return this.admission(message.id, 'unavailable', 'host-unavailable')
      const stored = clone(message)
      record.pending.set(stored.id, stored)
      this.append(record.session, 'agent/inbox/spliced', { target, start: target === 'next-turn' ? record.pending.size - 1 : 0, inserted: [stored] })
      this.append(record.session, 'user/message', stored)
      this.emitLive(record, 'agent/inbox/inserted', { message: stored })
      return this.admission(stored.id, 'accepted')
    }
    const agent = Object.freeze({
      id: record.id, generation: record.generation, options: clone(record.options), session,
      inbox: Object.freeze({ nextTurn: [...record.pending.values()].map(clone), nextStep: [] }),
      status: this.current(record) ? ({ status: 'unavailable', code: 'whole-agent-idle-unobservable' } satisfies AgentStatusObservation) : { status: 'unavailable', code: 'agent-replaced' },
      ...(record.detail === undefined ? {} : { detail: clone(record.detail) }),
      send: admission,
      followup: async (message: UserMessage) => await admission(message, 'next-turn', true),
      steer: async (message: UserMessage) => await admission(message, 'next-step', true),
      inject: async (message: UserMessage) => await admission(message, 'next-step', false),
      discard: async (messageId: MessageId): Promise<AgentMessageDiscardResult> => {
        if (!this.current(record)) return this.discard(messageId, 'unavailable', 'agent-replaced')
        if (!await this.allowed(owner, 'agents.message.cancel', record.id)) return this.discard(messageId, 'denied', 'permission-denied')
        const driver = await this.options.driver.discard({ sessionId: record.id, messageId })
        if (driver === 'already-claimed' || record.claimed.has(messageId)) return this.discard(messageId, 'conflict', 'already-claimed')
        const message = record.pending.get(messageId)
        if (driver === 'not-found' || message === undefined) return this.discard(messageId, 'not-found')
        if (driver === 'unavailable') return this.discard(messageId, 'unavailable', 'host-unavailable')
        record.pending.delete(messageId)
        this.append(record.session, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' })
        this.emitLive(record, 'agent/inbox/discarded', { message })
        return this.discard(messageId, 'accepted')
      },
      cancel: async (cause: AgentCancelCause, options?: AgentCancelOptions): Promise<AgentMutationResult<'cancel'>> => {
        if (!this.current(record)) return this.mutation('cancel', options?.mutationId, 'unavailable', 'agent-replaced')
        if (!await this.allowed(owner, 'agents.cancel', record.id)) return this.mutation('cancel', options?.mutationId, 'denied', 'permission-denied')
        const result = await this.options.driver.cancel({ sessionId: record.id, cause, keepInbox: options?.keepInbox === true })
        return result === 'accepted' ? this.mutation('cancel', options?.mutationId, 'accepted') : this.mutation('cancel', options?.mutationId, 'unavailable', 'unsupported')
      },
      whenIdle: async (): Promise<AgentIdleResult> => this.current(record)
        ? { status: 'unavailable', code: 'whole-agent-idle-unobservable' }
        : { status: 'unavailable', code: 'agent-replaced' },
      subscribe: async (observer: AgentLiveEventObserver): Promise<AgentLiveSubscribeResult> => {
        if (!this.current(record)) return { status: 'unavailable', code: 'agent-replaced' }
        if (!await this.allowed(owner, 'agents.live.subscribe', record.id)) return { status: 'denied', code: 'permission-denied' }
        const subscriber: AgentSubscriber = { owner: clone(owner), observer }
        record.live.add(subscriber)
        const subscription = Object.freeze({
          agentId: record.id, agentGeneration: record.generation,
          unsubscribe: async () => {
            subscriber.closed = 'unsubscribed'; record.live.delete(subscriber)
            return { status: 'closed' as const, code: 'unsubscribed' as const }
          },
        })
        return { status: 'subscribed', subscription } as AgentLiveSubscribeResult
      },
    })
    return agent as unknown as Agent
  }

  private sessionHandle(owner: PluginOwnerIdentity, record: SessionRecord): Session {
    const session = Object.freeze({
      id: record.id, generation: record.generation, header: clone(record.header),
      snapshot: async (): Promise<SessionSnapshotResult> => {
        if (!this.sessionLive(record)) return { status: 'unavailable', code: record.closed === 'connection-replaced' ? 'session-replaced' : 'host-unavailable' }
        if (!await this.allowed(owner, 'sessions.read', record.id)) return { status: 'unavailable', code: 'permission-revoked' }
        return { status: 'available', snapshot: {
          $schema: SNAPSHOT_SCHEMA, contract: 'cordisx.session-snapshot/v1', schemaVersion: 1,
          sessionId: record.id, sessionGeneration: record.generation, header: clone(record.header), snapshotSeq: record.events.length - 1,
        } }
      },
      read: async (request: SessionReadRequest = {}) => {
        if (!this.sessionLive(record)) return { status: 'unavailable' as const, code: record.closed === 'connection-replaced' ? 'session-replaced' as const : 'host-unavailable' as const }
        if (!await this.allowed(owner, 'sessions.read', record.id)) return { status: 'unavailable' as const, code: 'permission-revoked' as const }
        const afterSeq = request.afterSeq ?? -1
        const snapshotSeq = request.snapshotSeq ?? record.events.length - 1
        const limit = request.limit ?? 100
        if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(snapshotSeq) || snapshotSeq < -1 || snapshotSeq > record.events.length - 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          return { status: 'unavailable' as const, code: 'unsupported' as const }
        }
        const events = record.events.filter(event => event.seq > afterSeq && event.seq <= snapshotSeq).slice(0, limit).map(clone)
        const nextAfterSeq = events.at(-1)?.seq ?? afterSeq
        return { status: 'available' as const, page: {
          $schema: PAGE_SCHEMA, contract: 'cordisx.session-event-page/v1', schemaVersion: 1,
          sessionId: record.id, sessionGeneration: record.generation, afterSeq, snapshotSeq, events,
          nextAfterSeq, hasMore: record.events.some(event => event.seq > nextAfterSeq && event.seq <= snapshotSeq),
        } }
      },
      subscribe: async (request: SessionSubscribeRequest, observer: SessionEventObserver): Promise<SessionSubscribeResult> => {
        if (!this.sessionLive(record)) return { status: 'unavailable', code: record.closed === 'connection-replaced' ? 'session-replaced' : 'host-unavailable' }
        if (!await this.allowed(owner, 'sessions.subscribe', record.id)) return { status: 'unavailable', code: 'permission-revoked' }
        const afterSeq = request.afterSeq ?? -1
        if (!Number.isSafeInteger(afterSeq) || afterSeq < -1 || !Number.isSafeInteger(request.pageSize ?? 100) || (request.pageSize ?? 100) < 1 || (request.pageSize ?? 100) > 500) return { status: 'unavailable', code: 'unsupported' }
        // Register before capturing the watermark. Any later append is live,
        // while the pre-commit range is emitted once as replay.
        let resolveClosed: (value: SessionSubscriptionClosed) => void = () => {}
        const closed = new Promise<SessionSubscriptionClosed>(resolve => { resolveClosed = resolve })
        const subscriber: SessionSubscriber = {
          generation: ++this.nextSubscriptionGeneration,
          owner: clone(owner), observer, lastSeq: afterSeq, resolveClosed, delivery: Promise.resolve(),
        }
        record.subscribers.add(subscriber)
        const replayThrough = record.events.length - 1
        const replay = record.events.filter(event => event.seq > afterSeq && event.seq <= replayThrough).map(clone)
        subscriber.lastSeq = replayThrough
        if (replay.length > 0) await this.deliver(subscriber, { $schema: SUBSCRIPTION_SCHEMA, contract: 'cordisx.session-subscription-page/v1', schemaVersion: 1, sessionId: record.id, sessionGeneration: record.generation, subscriptionGeneration: subscriber.generation, replayThrough, phase: 'replay', events: replay })
        const subscription = Object.freeze({
          sessionId: record.id, sessionGeneration: record.generation, subscriptionGeneration: subscriber.generation, replayThrough,
          closed,
          unsubscribe: async () => this.closeSubscriber(record, subscriber, 'unsubscribed'),
        })
        return { status: 'subscribed', subscription } as SessionSubscribeResult
      },
    })
    return session as Session
  }

  private append<K extends SessionEvent['type']>(session: SessionRecord, type: K, data: Extract<SessionEvent, { readonly type: K }>['data']): void {
    if (!this.sessionLive(session)) return
    const event = Object.freeze({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json' as const,
      contract: 'cordisx.session-event/v1' as const, schemaVersion: 1 as const,
      sessionId: session.id, seq: session.events.length, time: this.now(), type, data: clone(data),
    }) as SessionEvent
    session.events.push(event)
    for (const subscriber of [...session.subscribers]) {
      if (subscriber.closed !== undefined) continue
      if (event.seq <= subscriber.lastSeq) continue
      subscriber.lastSeq = event.seq
      void this.deliver(subscriber, { $schema: SUBSCRIPTION_SCHEMA, contract: 'cordisx.session-subscription-page/v1', schemaVersion: 1, sessionId: session.id, sessionGeneration: session.generation, subscriptionGeneration: subscriber.generation, replayThrough: event.seq - 1, phase: 'live', events: [clone(event)] })
    }
  }

  private appendDriverEvent(event: CordisXDriverSessionEvent): void {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record)) return
    this.append(record.session, event.type, event.data as Extract<SessionEvent, { readonly type: typeof event.type }>['data'])
  }

  private async requestDriverApproval(request: CordisXDriverApprovalRequest): Promise<ApprovalOutcome> {
    const record = this.agents.get(request.sessionId)
    if (record === undefined || !this.current(record)) return 'unavailable'
    const decision = await this.requestApproval(record.owner, {
      agent: this.agent(record.owner, record), toolName: request.toolName,
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
    })
    return decision.outcome
  }

  private emitDriverStatus(event: CordisXDriverAgentStatus): void {
    const record = this.agents.get(event.sessionId)
    if (record === undefined || !this.current(record)) return
    this.emitLive(record, 'agent/status', { status: event.status })
  }

  private newSession(id: string): SessionRecord {
    const record: SessionRecord = { id, generation: 1, header: Object.freeze({ id, formatVersion: 1, createdAt: this.now(), isSeeded: false }), events: [], subscribers: new Set() }
    this.sessions.set(id, record)
    return record
  }

  private handle(owner: PluginOwnerIdentity, record: AgentRecord): AgentHandle {
    const capability = {}
    const handle = Object.freeze({
      agent: this.agent(owner, record), owner: clone(owner),
      dispose: async (options?: AgentDisposeOptions): Promise<AgentMutationResult<'dispose'>> => {
        if (this.handles.get(capability) !== record || !this.current(record)) return this.mutation('dispose', options?.mutationId, 'unavailable', 'agent-replaced')
        if (!this.sameOwner(owner, record.owner)) return this.mutation('dispose', options?.mutationId, 'denied', 'not-owner')
        this.disposeAgent(record, 'owner-disposed')
        return this.mutation('dispose', options?.mutationId, 'accepted')
      },
    })
    this.handles.set(capability, record)
    return handle as AgentHandle
  }

  private disposeAgent(record: AgentRecord, reason: 'owner-disposed' | 'runtime-disposed' | 'connection-replaced'): void {
    if (record.disposed !== undefined) return
    record.disposed = reason
    this.answerers.delete(this.answererKey(record))
    this.emitLive(record, 'agent/disposed', { reason })
    for (const subscriber of record.live) subscriber.closed = reason === 'connection-replaced' ? 'connection-replaced' : 'agent-replaced'
    record.live.clear()
  }

  private closeSession(record: SessionRecord, code: NonNullable<SessionRecord['closed']>, subscriberCode: Exclude<SessionSubscriptionCloseCode, 'unsubscribed' | 'observer-failed'> = code === 'connection-replaced' ? 'connection-replaced' : 'host-unavailable'): void {
    if (record.closed !== undefined) return
    record.closed = code
    for (const subscriber of record.subscribers) this.closeSubscriber(record, subscriber, subscriberCode)
    record.subscribers.clear()
  }

  private connectionReplaced(): void {
    for (const agent of this.agents.values()) this.disposeAgent(agent, 'connection-replaced')
    for (const session of this.sessions.values()) this.closeSession(session, 'connection-replaced')
  }

  private async deliver(subscriber: SessionSubscriber, page: Parameters<SessionEventObserver>[0]): Promise<void> {
    subscriber.delivery = subscriber.delivery.then(async () => {
      if (subscriber.closed !== undefined) return
      try { await subscriber.observer(page) }
      catch { this.closeSubscriberByIdentity(subscriber, 'observer-failed') }
    })
    await subscriber.delivery
  }

  private closeSubscriber(record: SessionRecord, subscriber: SessionSubscriber, code: SessionSubscriptionCloseCode): SessionSubscriptionClosed {
    if (subscriber.closed !== undefined) return subscriber.closed
    const closed: SessionSubscriptionClosed = Object.freeze({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-subscription-close.v1.schema.json',
      contract: 'cordisx.session-subscription-close/v1', schemaVersion: 1,
      sessionId: record.id, sessionGeneration: record.generation, subscriptionGeneration: subscriber.generation,
      status: 'closed', code,
    })
    subscriber.closed = closed
    record.subscribers.delete(subscriber)
    subscriber.resolveClosed(closed)
    return closed
  }

  private closeSubscriberByIdentity(subscriber: SessionSubscriber, code: SessionSubscriptionCloseCode): void {
    for (const session of this.sessions.values()) {
      if (session.subscribers.has(subscriber)) { this.closeSubscriber(session, subscriber, code); return }
    }
  }

  private emitLive<K extends AgentLiveEvent['type']>(record: AgentRecord, type: K, data: Extract<AgentLiveEvent, { readonly type: K }>['data']): void {
    const event = Object.freeze({ type, agentId: record.id, sessionId: record.id, agentGeneration: record.generation, time: this.now(), data: clone(data) }) as AgentLiveEvent
    for (const subscriber of [...record.live]) if (subscriber.closed === undefined) void subscriber.observer(clone(event))
  }

  private recordForAgent(value: Agent): AgentRecord | undefined {
    const record = this.agents.get(value.id)
    return record !== undefined && record.generation === value.generation && this.current(record) ? record : undefined
  }
  private current(record: AgentRecord): boolean { return !this.disposed && record.disposed === undefined && this.agents.get(record.id) === record && this.sessionLive(record.session) }
  private sessionLive(record: SessionRecord): boolean { return !this.disposed && record.closed === undefined && this.sessions.get(record.id) === record }
  private sameOwner(left: PluginOwnerIdentity, right: PluginOwnerIdentity): boolean { return left.pluginId === right.pluginId && left.generation === right.generation }
  private sameSource(owner: PluginOwnerIdentity, source: UserMessage['source']): boolean { return source.kind === 'plugin' && source.pluginId === owner.pluginId && source.generation === owner.generation }
  private async allowed(owner: PluginOwnerIdentity, capability: AgentRuntimeCapability, sessionId?: string): Promise<boolean> { return !this.disposed && await this.options.authorize(owner, capability, sessionId) }
  private answererKey(record: AgentRecord): string { return `${record.id}\u0000${record.generation}` }
  private acquireDenied(operation: 'create' | 'resume', mutationId?: string): AgentAcquireResult { return { $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'denied', code: 'permission-denied' } }
  private acquireUnavailable(operation: 'create' | 'resume', mutationId: string | undefined, code: 'runtime-unavailable' | 'host-unavailable' | 'unsupported' | 'session-unavailable'): AgentAcquireResult { return { $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'unavailable', code: code === 'session-unavailable' ? 'session-unavailable' : code } }
  private acquireConflict(operation: 'create' | 'resume', mutationId: string | undefined, code: 'mutation-conflict' | 'session-already-exists' | 'agent-already-live'): AgentAcquireResult { return { $schema: ACQUIRE_SCHEMA, contract: 'cordisx.agent-acquire-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status: 'conflict', code } }
  private remember(key: string | undefined, fingerprint: string, result: AgentAcquireResult): AgentAcquireResult { if (key !== undefined) this.mutations.set(key, { fingerprint, result }); return result }
  private admission(messageId: string, status: 'accepted' | 'denied' | 'unavailable', code?: 'source-denied' | 'permission-denied' | 'agent-replaced' | 'host-unavailable'): Agent['send'] extends (...args: never[]) => Promise<infer Result> ? Result : never { return Object.freeze({ $schema: ADMISSION_SCHEMA, contract: 'cordisx.agent-admission/v1', schemaVersion: 1, status, messageId, ...(status === 'accepted' ? {} : { code }) }) as never }
  private discard(messageId: string, status: AgentMessageDiscardResult['status'], code?: string): AgentMessageDiscardResult { return Object.freeze({ $schema: DISCARD_SCHEMA, contract: 'cordisx.agent-message-cancellation-result/v1', schemaVersion: 1, status, messageId, ...(code === undefined ? {} : { code }) }) as AgentMessageDiscardResult }
  private mutation(operation: 'cancel' | 'dispose', mutationId: string | undefined, status: 'accepted' | 'denied' | 'unavailable', code?: string): AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'> { return Object.freeze({ $schema: MUTATION_SCHEMA, contract: 'cordisx.agent-mutation-result/v1', schemaVersion: 1, operation, ...(mutationId === undefined ? {} : { mutationId }), status, ...(code === undefined ? {} : { code }) }) as AgentMutationResult<'cancel'> & AgentMutationResult<'dispose'> }
  private approvalQuestion(record: AgentRecord, id: string, toolName: string, callId?: string, reason?: string): ApprovalQuestion { return Object.freeze({ $schema: QUESTION_SCHEMA, contract: 'cordisx.approval-question/v1', schemaVersion: 1, id, agentId: record.id, sessionId: record.id, agentGeneration: record.generation, toolName, ...(callId === undefined ? {} : { callId }), ...(reason === undefined ? {} : { reason }) }) }
  private approvalDecision(record: AgentRecord | Agent, id: string, toolName: string, callId: string | undefined, outcome: ApprovalOutcome): ApprovalDecision { return Object.freeze({ $schema: DECISION_SCHEMA, contract: 'cordisx.approval-decision/v1', schemaVersion: 1, id, agentId: record.id, sessionId: record.session.id, agentGeneration: record.generation, outcome }) }
}

const runtimes = new WeakMap<object, CordisXAgentSessionRuntime>()
function runtimeFor(service: object): CordisXAgentSessionRuntime { const runtime = runtimes.get(service); if (runtime === undefined) throw new Error('Agent Session runtime service is detached'); return runtime }

export class CordisXAgentRegistryServiceV1 extends Service implements AgentRegistry {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) { super(ctx, 'agents'); runtimes.set(this, runtime) }
  async create(options: AgentCreateOptions): Promise<AgentAcquireResult> { const runtime = runtimeFor(this); return await runtime.create(runtime.ownerFromContext(this.ctx), options) }
  async resume(options: AgentResumeOptions): Promise<AgentAcquireResult> { const runtime = runtimeFor(this); return await runtime.resume(runtime.ownerFromContext(this.ctx), options) }
  async get(agentId: string): Promise<Agent | undefined> { const runtime = runtimeFor(this); return await runtime.get(runtime.ownerFromContext(this.ctx), agentId) }
}
export class CordisXSessionRegistryServiceV1 extends Service implements SessionRegistry {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) { super(ctx, 'sessions'); runtimes.set(this, runtime) }
  async get(sessionId: string): Promise<Session | undefined> { const runtime = runtimeFor(this); return await runtime.session(runtime.ownerFromContext(this.ctx), sessionId) }
}
export class CordisXApprovalServiceV1 extends Service implements ApprovalService {
  constructor(ctx: Context, runtime: CordisXAgentSessionRuntime) { super(ctx, 'approvals'); runtimes.set(this, runtime) }
  async request(request: Parameters<ApprovalService['request']>[0]): Promise<ApprovalDecision> { const runtime = runtimeFor(this); return await runtime.requestApproval(runtime.ownerFromContext(this.ctx), request) }
  async registerAnswerer(agent: Agent, answerer: ApprovalAnswerer): Promise<ApprovalAnswererHandle> { const runtime = runtimeFor(this); return await runtime.registerAnswerer(runtime.ownerFromContext(this.ctx), agent, answerer) }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
    sessions: SessionRegistry
    approvals: ApprovalService
  }
}
