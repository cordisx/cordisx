import type {
  AgentTaskContext,
  AgentTaskCreateRequest,
  AgentTaskCreateResult,
  AgentTaskFailureCode,
  AgentTaskQueryResult,
  AgentTaskResolvedContext,
  AgentTasks,
} from '@cordisx/protocol/agent-task/v1'
import type { Agent, AgentHandle, AgentStatusObservation } from '@cordisx/protocol/agents/v1'
import {
  AgentTaskApprovalCleanupError,
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
  recover?(operationId: string): Promise<{ claimed: boolean; record: AgentTaskRecord }>
}

export interface AgentTaskApprovalInstaller {
  active(): boolean
  install(agent: Agent, request: AgentTaskCreateRequest, record: AgentTaskRecord): Promise<() => Promise<void>>
}

export interface AgentTaskDependencies {
  readonly store: AgentTaskStore
  readonly active: () => boolean
  readonly authorize: (operation: 'create' | 'read' | 'approval', sessionId?: string) => Promise<boolean>
  readonly resolveContext: (context: AgentTaskContext) => Promise<
    { status: 'resolved'; context: AgentTaskResolvedContext } | { status: 'unavailable'; code: AgentTaskFailureCode }
  >
  readonly validateDefinition: (request: AgentTaskCreateRequest) => Promise<boolean>
  readonly validateTool: (commandId: string) => Promise<boolean>
  readonly create: (request: AgentTaskCreateRequest, record: AgentTaskRecord) => Promise<Agent | undefined>
  readonly bind: (commandId: string, sessionId: string, scope: AgentTaskCreateRequest['tool']['scope']) => Promise<void>
  readonly submit: (agent: Agent, messageId: string, text: string) => Promise<boolean>
  readonly observe: (sessionId: string) => Promise<AgentStatusObservation>
  readonly captureApprovals?: (commandId: string) => AgentTaskApprovalInstaller | undefined
  readonly existing?: (sessionId: string) => Promise<Agent | undefined>
  readonly ownership?: (sessionId: string) => Promise<AgentHandle | undefined>
}

/** One owner-bound generation; durable evidence is held outside this service lifetime. */
export class HostAgentTasks implements AgentTasks {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<AgentTaskCreateResult> }>()
  constructor(private readonly deps: AgentTaskDependencies) {}

  async createAndSubmit(
    input: AgentTaskCreateRequest,
    bindingPolicy: 'none' | 'required' = 'none',
  ): Promise<AgentTaskCreateResult> {
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
      return (pending.fingerprint === `${bindingPolicy}:${fingerprint}`
          || (bindingPolicy === 'none' && pending.fingerprint === `required:${fingerprint}`))
        ? await this.joinPending(operationId, pending.promise)
        : unavailable('operation-conflict')
    }
    const promise = this.execute(request, fingerprint, bindingPolicy).catch(() => unavailable('host-unavailable'))
    this.pending.set(operationId, { fingerprint: `${bindingPolicy}:${fingerprint}`, promise })
    try {
      return structuredClone(await promise)
    } finally {
      if (this.pending.get(operationId)?.promise === promise) this.pending.delete(operationId)
    }
  }

  private async joinPending(
    operationId: string,
    pending: Promise<AgentTaskCreateResult>,
  ): Promise<AgentTaskCreateResult> {
    const unavailable = (code: AgentTaskFailureCode): AgentTaskCreateResult => ({
      status: 'unavailable',
      operationId,
      code,
    })
    try {
      const result = await pending
      if (!this.deps.active()) return unavailable('host-unavailable')
      const sessionId = result.status === 'accepted' ? result.task.sessionId : result.sessionId
        ?? (await this.deps.store.load(operationId))?.sessionId
      if (!await this.deps.authorize('create', sessionId)) return unavailable('permission-denied')
      return this.deps.active() ? structuredClone(result) : unavailable('host-unavailable')
    } catch {
      return unavailable('host-unavailable')
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
      ...(['created', 'binding', 'approval-installing', 'approval-install-failed', 'submitting', 'finished'].includes(
          record.phase,
        )
        ? { sessionId: record.sessionId }
        : {}),
    }
  }

  private async execute(
    request: AgentTaskCreateRequest,
    fingerprint: string,
    bindingPolicy: 'none' | 'required',
  ): Promise<AgentTaskCreateResult> {
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
      return existing.fingerprint === fingerprint
          && (bindingPolicy === 'none' || (existing.bindingPolicy ?? 'none') === bindingPolicy)
        ? this.retained(existing)
        : fail('operation-conflict')
    }
    const approvals = bindingPolicy === 'required' ? this.deps.captureApprovals?.(request.tool.commandId) : undefined
    if (bindingPolicy === 'required' && (approvals === undefined || !approvals.active())) {
      return fail('tool-unavailable')
    }
    if (request.context === undefined) return fail('context-required')
    const context = await this.deps.resolveContext(request.context)
    if (context.status !== 'resolved') return fail(context.code)
    if (!await this.deps.validateDefinition(request)) return fail('definition-unavailable')
    if (!await this.deps.validateTool(request.tool.commandId)) return fail('tool-unavailable')
    let record: AgentTaskRecord = {
      operationId,
      fingerprint,
      bindingPolicy,
      context: structuredClone(context.context),
      phase: 'intent',
      sessionId: `cx-session.${crypto.randomUUID()}`,
      messageId: `cx-message.${crypto.randomUUID()}`,
    }
    if (!this.deps.active() || !await this.deps.authorize('create', record.sessionId)) return fail('permission-denied')
    if (bindingPolicy === 'required' && !await this.deps.authorize('approval', record.sessionId)) {
      return fail('permission-denied')
    }
    if (!this.deps.active() || approvals?.active() === false) return fail('permission-denied')
    const claim = await this.deps.store.claim(record)
    if (!claim.claimed) {
      if (!await this.deps.authorize('create', claim.record.sessionId) || !this.deps.active()) {
        return fail('permission-denied')
      }
      return claim.record.fingerprint === fingerprint
          && (bindingPolicy === 'none' || (claim.record.bindingPolicy ?? 'none') === bindingPolicy)
        ? this.retained(claim.record)
        : fail('operation-conflict')
    }
    const checkpoint = async (phase: AgentTaskRecord['phase'], result?: AgentTaskCreateResult): Promise<void> => {
      record = { ...record, phase, ...(result === undefined ? {} : { result }) }
      await this.deps.store.save(record)
    }
    let known = false
    try {
      await checkpoint('creating')
      if (
        !this.deps.active() || !await this.deps.authorize('create', record.sessionId)
        || (bindingPolicy === 'required' && !await this.deps.authorize('approval', record.sessionId))
      ) {
        const result = fail('permission-denied')
        await checkpoint('finished', result)
        return result
      }
      if (!this.deps.active() || approvals?.active() === false) {
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
      return await this.finish(request, agent, record, approvals)
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

  private async finish(
    request: AgentTaskCreateRequest,
    agent: Agent,
    initial: AgentTaskRecord,
    approvals?: AgentTaskApprovalInstaller,
  ): Promise<AgentTaskCreateResult> {
    let record = initial
    let cleanup: (() => Promise<void>) | undefined
    const fail = (code: AgentTaskFailureCode): AgentTaskCreateResult => ({
      status: 'unavailable',
      operationId: record.operationId,
      code,
      sessionId: record.sessionId,
    })
    const checkpoint = async (phase: AgentTaskRecord['phase'], result?: AgentTaskCreateResult): Promise<void> => {
      const { result: _previous, ...rest } = record
      record = { ...rest, phase, ...(result === undefined ? {} : { result }) }
      await this.deps.store.save(record)
    }
    try {
      if (record.phase !== 'approval-installing') await checkpoint('binding')
      if (!this.deps.active() || !await this.deps.authorize('create', record.sessionId)) {
        const result = fail('permission-denied')
        await checkpoint('finished', result)
        return result
      }
      try {
        await this.deps.bind(request.tool.commandId, record.sessionId, structuredClone(request.tool.scope))
      } catch {
        const result = fail('tool-unavailable')
        await checkpoint(record.phase === 'approval-installing' ? 'approval-install-failed' : 'finished', result)
        return result
      }
      if (record.bindingPolicy === 'required') {
        await checkpoint('approval-installing')
        try {
          if (approvals === undefined || !approvals.active()) throw new Error('Task approval registration replaced')
          cleanup = await approvals.install(agent, request, record)
          if (!approvals.active()) throw new Error('Task approval registration replaced')
        } catch (error) {
          await cleanup?.()
          if (error instanceof AgentTaskApprovalCleanupError) {
            const result = fail('reconciliation-required')
            await checkpoint('finished', result)
            return result
          }
          const result = fail('submit-failed')
          await checkpoint('approval-install-failed', result)
          return result
        }
      }
      if (
        !this.deps.active() || !await this.deps.authorize('create', record.sessionId) || approvals?.active() === false
        || (record.bindingPolicy === 'required' && !await this.deps.authorize('approval', record.sessionId))
      ) {
        await cleanup?.()
        const result = fail('permission-denied')
        await checkpoint(record.bindingPolicy === 'required' ? 'approval-install-failed' : 'finished', result)
        return result
      }
      await checkpoint('submitting')
      if (
        !this.deps.active() || !await this.deps.authorize('create', record.sessionId) || approvals?.active() === false
        || (record.bindingPolicy === 'required' && !await this.deps.authorize('approval', record.sessionId))
      ) {
        await cleanup?.()
        const result = fail('permission-denied')
        await checkpoint('finished', result)
        return result
      }
      if (!this.deps.active() || approvals?.active() === false) {
        await cleanup?.()
        const result = fail('permission-denied')
        await checkpoint('finished', result)
        return result
      }
      const accepted = await this.deps.submit(agent, record.messageId, request.text)
      const result: AgentTaskCreateResult = accepted && agent.detail !== undefined
        ? {
          status: 'accepted',
          operationId: record.operationId,
          disposition: 'created',
          task: {
            sessionId: record.sessionId,
            messageId: record.messageId,
            context: record.context,
            detail: agent.detail,
          },
        }
        : fail('reconciliation-required')
      await checkpoint('finished', result)
      return result
    } catch {
      if (record.phase !== 'submitting' && record.phase !== 'finished') await cleanup?.().catch(() => undefined)
      return fail('reconciliation-required')
    }
  }

  private readonly recovering = new Map<string, Promise<AgentTaskCreateResult>>()
  async recover(request: { operationId: string }): Promise<AgentTaskCreateResult> {
    request = { operationId: request.operationId }
    if (!this.deps.active() || !await this.deps.authorize('create')) {
      return { status: 'unavailable', operationId: request.operationId, code: 'permission-denied' }
    }
    const pending = this.recovering.get(request.operationId)
    if (pending !== undefined) return await this.joinPending(request.operationId, pending)
    const operation = this.recoverOperation(request)
    this.recovering.set(request.operationId, operation)
    try {
      return structuredClone(await operation)
    } finally {
      if (this.recovering.get(request.operationId) === operation) this.recovering.delete(request.operationId)
    }
  }
  private async recoverOperation(request: { operationId: string }): Promise<AgentTaskCreateResult> {
    const fail = (code: AgentTaskFailureCode): AgentTaskCreateResult => ({
      status: 'unavailable',
      operationId: request.operationId,
      code,
    })
    if (!this.deps.active() || !await this.deps.authorize('create')) return fail('permission-denied')
    try {
      const record = await this.deps.store.load(request.operationId)
      if (record === undefined) return fail('host-unavailable')
      if (record.bindingPolicy !== 'required') return fail('operation-conflict')
      if (!await this.deps.authorize('create', record.sessionId)) return fail('permission-denied')
      if (record.phase !== 'approval-install-failed') return this.retained(record)
      const input = JSON.parse(record.fingerprint) as AgentTaskCreateRequest
      const approvals = this.deps.captureApprovals?.(input.tool.commandId)
      const agent = await this.deps.existing?.(record.sessionId)
      if (
        agent === undefined || approvals === undefined || !approvals.active() || this.deps.store.recover === undefined
      ) {
        return {
          status: 'unavailable',
          operationId: request.operationId,
          code: 'host-unavailable',
          sessionId: record.sessionId,
        }
      }
      const claimed = await this.deps.store.recover(request.operationId)
      if (!claimed.claimed) {
        if (!await this.deps.authorize('create', claimed.record.sessionId) || !this.deps.active()) {
          return fail('permission-denied')
        }
        return this.retained(claimed.record)
      }
      return await this.finish(input, agent, claimed.record, approvals)
    } catch {
      return fail('host-unavailable')
    }
  }

  async acquireOwnership(request: { operationId: string }): Promise<
    | { status: 'acquired'; handle: AgentHandle }
    | {
      status: 'unavailable'
      code: 'permission-denied' | 'not-found' | 'not-accepted' | 'host-unavailable' | 'unsupported'
    }
  > {
    request = { operationId: request.operationId }
    if (!this.deps.active()) return { status: 'unavailable', code: 'host-unavailable' }
    if (!await this.deps.authorize('read')) return { status: 'unavailable', code: 'permission-denied' }
    try {
      const record = await this.deps.store.load(request.operationId)
      if (record === undefined) return { status: 'unavailable', code: 'not-found' }
      if (!await this.deps.authorize('create', record.sessionId)) {
        return { status: 'unavailable', code: 'permission-denied' }
      }
      if (record.result?.status !== 'accepted') return { status: 'unavailable', code: 'not-accepted' }
      const handle = await this.deps.ownership?.(record.sessionId)
      return handle === undefined ? { status: 'unavailable', code: 'host-unavailable' } : { status: 'acquired', handle }
    } catch {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
  }

  async query(request: { operationId: string }): Promise<AgentTaskQueryResult> {
    request = { operationId: request.operationId }
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
