import type {
  AgentTaskContext,
  AgentTaskCreateRequest,
  AgentTaskCreateResult,
  AgentTaskFailureCode,
  AgentTaskQueryResult,
  AgentTaskResolvedContext,
  AgentTasks,
} from '@cordisx/protocol/agent-task/v1'
import type { Agent, AgentStatusObservation } from '@cordisx/protocol/agents/v1'
import {
  AgentTaskContextMismatch,
  type AgentTaskRecord,
  canonicalTaskJson,
  validTaskRequest,
} from '../agent-task-record.js'

export interface AgentTaskStore {
  load(operationId: string): Promise<AgentTaskRecord | undefined>
  /** Atomic absent-only intent claim across renderer instances and restarts. */
  claim(record: AgentTaskRecord): Promise<{ claimed: boolean; record: AgentTaskRecord }>
  save(record: AgentTaskRecord): Promise<void>
}

export interface AgentTaskDependencies {
  readonly store: AgentTaskStore
  readonly active: () => boolean
  readonly authorize: (operation: 'create' | 'read', sessionId?: string) => Promise<boolean>
  readonly resolveContext: (context: AgentTaskContext) => Promise<
    { status: 'resolved'; context: AgentTaskResolvedContext } | { status: 'unavailable'; code: AgentTaskFailureCode }
  >
  readonly validateDefinition: (request: AgentTaskCreateRequest) => Promise<boolean>
  readonly validateTool: (commandId: string) => Promise<boolean>
  readonly create: (request: AgentTaskCreateRequest, record: AgentTaskRecord) => Promise<Agent | undefined>
  readonly bind: (commandId: string, sessionId: string, scope: AgentTaskCreateRequest['tool']['scope']) => Promise<void>
  readonly submit: (agent: Agent, messageId: string, text: string) => Promise<boolean>
  readonly observe: (sessionId: string) => Promise<AgentStatusObservation>
}

/** One owner-bound generation; durable evidence is held outside this service lifetime. */
export class HostAgentTasks implements AgentTasks {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<AgentTaskCreateResult> }>()
  constructor(private readonly deps: AgentTaskDependencies) {}

  async createAndSubmit(input: AgentTaskCreateRequest): Promise<AgentTaskCreateResult> {
    const operationId = typeof input?.operationId === 'string' ? input.operationId : ''
    const unavailable = (code: AgentTaskFailureCode): AgentTaskCreateResult => ({
      status: 'unavailable',
      operationId,
      code,
    })
    let request: AgentTaskCreateRequest
    let fingerprint: string
    try {
      if (!validTaskRequest(input)) return unavailable('invalid-input')
      fingerprint = canonicalTaskJson(input)
      request = JSON.parse(fingerprint) as AgentTaskCreateRequest
    } catch {
      return unavailable('invalid-input')
    }
    if (!this.deps.active()) return unavailable('host-unavailable')
    if (!await this.deps.authorize('create')) return unavailable('permission-denied')
    const pending = this.pending.get(operationId)
    if (pending !== undefined) {
      return pending.fingerprint === fingerprint
        ? structuredClone(await pending.promise)
        : unavailable('operation-conflict')
    }
    const promise = this.execute(request, fingerprint).catch(() => unavailable('host-unavailable'))
    this.pending.set(operationId, { fingerprint, promise })
    try {
      return structuredClone(await promise)
    } finally {
      if (this.pending.get(operationId)?.promise === promise) this.pending.delete(operationId)
    }
  }

  private retained(record: AgentTaskRecord, replay = true): AgentTaskCreateResult {
    if (record.result !== undefined) {
      return structuredClone(
        replay && record.result.status === 'accepted'
          ? { ...record.result, disposition: 'replayed' }
          : record.result,
      )
    }
    return {
      status: 'unavailable',
      operationId: record.operationId,
      code: 'reconciliation-required',
      ...(['created', 'binding', 'submitting', 'finished'].includes(record.phase)
        ? { sessionId: record.sessionId }
        : {}),
    }
  }

  private async execute(request: AgentTaskCreateRequest, fingerprint: string): Promise<AgentTaskCreateResult> {
    const { operationId } = request
    const fail = (code: AgentTaskFailureCode, sessionId?: string): AgentTaskCreateResult => ({
      status: 'unavailable',
      operationId,
      code,
      ...(sessionId === undefined ? {} : { sessionId }),
    })
    const existing = await this.deps.store.load(operationId)
    if (existing !== undefined) {
      if (!await this.deps.authorize('create', existing.sessionId)) return fail('permission-denied')
      return existing.fingerprint === fingerprint ? this.retained(existing) : fail('operation-conflict')
    }
    if (request.context === undefined) return fail('context-required')
    const context = await this.deps.resolveContext(request.context)
    if (context.status !== 'resolved') return fail(context.code)
    if (!await this.deps.validateDefinition(request)) return fail('definition-unavailable')
    if (!await this.deps.validateTool(request.tool.commandId)) return fail('tool-unavailable')
    let record: AgentTaskRecord = {
      operationId,
      fingerprint,
      context: structuredClone(context.context),
      phase: 'intent',
      sessionId: `cx-session.${crypto.randomUUID()}`,
      messageId: `cx-message.${crypto.randomUUID()}`,
    }
    if (!this.deps.active() || !await this.deps.authorize('create', record.sessionId)) return fail('permission-denied')
    const claim = await this.deps.store.claim(record)
    if (!claim.claimed) {
      return claim.record.fingerprint === fingerprint ? this.retained(claim.record) : fail('operation-conflict')
    }
    const checkpoint = async (phase: AgentTaskRecord['phase'], result?: AgentTaskCreateResult): Promise<void> => {
      record = { ...record, phase, ...(result === undefined ? {} : { result }) }
      await this.deps.store.save(record)
    }
    let known = false
    try {
      await checkpoint('creating')
      if (!this.deps.active() || !await this.deps.authorize('create', record.sessionId)) {
        const result = fail('permission-denied')
        await checkpoint('finished', result)
        return result
      }
      const agent = await this.deps.create(request, record)
      if (agent === undefined) {
        const result = fail('reconciliation-required')
        await checkpoint('finished', result)
        return result
      }
      known = true
      await checkpoint('created')
      if (agent.id !== record.sessionId || agent.detail === undefined) {
        throw new Error('Task Session identity unavailable')
      }
      await checkpoint('binding')
      if (!this.deps.active() || !await this.deps.authorize('create', record.sessionId)) {
        const result = fail('permission-denied', record.sessionId)
        await checkpoint('finished', result)
        return result
      }
      try {
        await this.deps.bind(request.tool.commandId, record.sessionId, structuredClone(request.tool.scope))
      } catch {
        const result = fail('tool-unavailable', record.sessionId)
        await checkpoint('finished', result)
        return result
      }
      await checkpoint('submitting')
      if (!this.deps.active() || !await this.deps.authorize('create', record.sessionId)) {
        const result = fail('permission-denied', record.sessionId)
        await checkpoint('finished', result)
        return result
      }
      const accepted = await this.deps.submit(agent, record.messageId, request.text)
      const result: AgentTaskCreateResult = accepted
        ? {
          status: 'accepted',
          operationId,
          disposition: 'created',
          task: {
            sessionId: record.sessionId,
            messageId: record.messageId,
            context: record.context,
            detail: agent.detail,
          },
        }
        : fail('reconciliation-required', record.sessionId)
      await checkpoint('finished', result)
      return result
    } catch (error) {
      if (error instanceof AgentTaskContextMismatch) {
        const result = fail('context-unavailable', error.sessionId)
        await checkpoint('finished', result).catch(() => undefined)
        return result
      }
      // Never replay a native side effect whose durable acknowledgement is unknown.
      return fail('reconciliation-required', known ? record.sessionId : undefined)
    }
  }

  async query(request: { operationId: string }): Promise<AgentTaskQueryResult> {
    if (!this.deps.active()) return { status: 'unavailable', code: 'host-unavailable' }
    if (!await this.deps.authorize('read')) return { status: 'unavailable', code: 'permission-denied' }
    try {
      const record = await this.deps.store.load(request.operationId)
      if (record === undefined) return { status: 'not-found' }
      if (!await this.deps.authorize('read', record.sessionId)) {
        return { status: 'unavailable', code: 'permission-denied' }
      }
      const result = this.retained(record, false)
      return {
        status: 'found',
        result,
        execution: result.status === 'accepted' || result.sessionId !== undefined
          ? await this.deps.observe(record.sessionId)
          : { status: 'unavailable', code: 'host-unavailable' },
      }
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }
}
