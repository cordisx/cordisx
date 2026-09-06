import type { AgentDefinitionIdentity } from '../agent-loop-contracts.js'
import type { AgentLoopV4Transport } from './agent-loop-v4.js'
import { resolveAgentDefinition } from './agent-loop.js'
import { simulatorBindingId } from './playground-mock-agent-loop-values.js'

import { clone, fingerprint, PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE } from './playground-mock-agent-loop-values.js'
import type { PlaygroundMockAgentLoopHost, PlaygroundMockAgentLoopPersistence } from './playground-mock-agent-loop.js'
interface PlaygroundMockV4PersistedState {
  readonly version: 2
  readonly results: readonly { readonly key: string; readonly fingerprint: string; readonly result: unknown }[]
  readonly bindings: readonly {
    readonly key: string
    readonly task: string
    readonly bindingId: string
    readonly generation: number
    readonly definition: AgentDefinitionIdentity
  }[]
  readonly introductions: readonly {
    readonly key: string
    readonly value: {
      readonly task: string
      readonly turn: string
      readonly messageId: string
      readonly participantId: string
      readonly memberId: string
      readonly runId: string
      readonly state: 'pending' | 'completed' | 'cancelled' | 'failed'
    }
  }[]
  readonly resources: readonly { readonly key: string; readonly operationId: string }[]
}

export class PlaygroundMockAgentLoopV4Transport implements AgentLoopV4Transport {
  readonly debugMock = true as const
  private readonly results = new Map<string, { readonly fingerprint: string; readonly result: unknown }>()
  private readonly pending = new Map<string, { readonly fingerprint: string; readonly result: Promise<unknown> }>()
  private readonly introductions = new Map<
    string,
    {
      readonly task: string
      readonly turn: string
      readonly messageId: string
      readonly participantId: string
      readonly memberId: string
      readonly runId: string
      readonly state: 'pending' | 'completed' | 'cancelled' | 'failed'
    }
  >()
  private readonly resourceOperations = new Map<string, string>()
  private readonly bindings = new Map<
    string,
    {
      readonly task: string
      readonly bindingId: string
      readonly generation: number
      readonly definition: AgentDefinitionIdentity
    }
  >()
  private resetGeneration = 0

  constructor(
    private readonly host: PlaygroundMockAgentLoopHost,
    private readonly persistence?: PlaygroundMockAgentLoopPersistence,
  ) {
    this.restore()
  }

  /** Clears the private mock transport ledger without changing the public AgentLoop contract. */
  resetPlaygroundState(): void {
    this.resetGeneration += 1
    this.results.clear()
    this.pending.clear()
    this.introductions.clear()
    this.resourceOperations.clear()
    this.bindings.clear()
    this.persist()
  }

  private scopeKey(scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope']): string {
    return JSON.stringify([scope.profileId, scope.ownerKey, PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE])
  }

  private bindingKey(scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope'], task: string): string {
    return `${this.scopeKey(scope)}\0${task}`
  }

  private bindingFor(
    input: {
      readonly scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope']
      readonly task: string
      readonly binding: { readonly bindingId: string; readonly generation: number }
      readonly definition: AgentDefinitionIdentity
    },
  ): boolean {
    const current = this.bindings.get(this.bindingKey(input.scope, input.task))
    return current !== undefined && current.bindingId === input.binding.bindingId
      && current.generation === input.binding.generation
      && current.definition.agentId === input.definition.agentId
      && current.definition.revision === input.definition.revision
  }

  async createAgentLoopV4(input: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]): Promise<unknown> {
    return await this.once(input, async () => {
      const command = input.command as Parameters<typeof resolveAgentDefinition>[0]
      const definition = resolveAgentDefinition(command)
      const created = await this.host.create(definition, {}, {
        target: command.definition,
        definitions: command.definitions,
      })
      if (!created.ok) return { status: 'unavailable', code: 'host-unavailable' }
      const locator = {
        task: created.value.task,
        definition: command.definition,
        binding: { bindingId: simulatorBindingId(created.value.task), generation: 1 },
      }
      this.bindings.set(this.bindingKey(input.scope, created.value.task), {
        task: created.value.task,
        ...locator.binding,
        definition: clone(command.definition),
      })
      return { status: 'accepted', locator, detailsUrl: created.value.detailsUrl, delivery: 'executed' }
    })
  }

  async bindAgentLoopV4(input: Parameters<AgentLoopV4Transport['bindAgentLoopV4']>[0]): Promise<unknown> {
    return await this.once(input, async () => {
      const bound = await this.host.bind(input.task)
      if (!bound.ok) return { status: 'unavailable', code: 'task-unavailable' }
      const prior = this.bindings.get(this.bindingKey(input.scope, input.task))
      const binding = {
        bindingId: prior?.bindingId ?? simulatorBindingId(input.task),
        generation: (prior?.generation ?? 0) + 1,
      }
      const locator = { task: bound.value.task, definition: input.definition, binding }
      this.bindings.set(this.bindingKey(input.scope, input.task), {
        task: input.task,
        ...binding,
        definition: clone(input.definition),
      })
      return { status: 'accepted', locator, detailsUrl: bound.value.detailsUrl, delivery: 'executed' }
    })
  }

  async sendAgentLoopV4(input: Parameters<AgentLoopV4Transport['sendAgentLoopV4']>[0]): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    return await this.once(input, async () => {
      const sent = await this.host.send(
        {
          task: input.task,
          session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: input.task },
        },
        [{ kind: 'text', text: input.message }],
        { autoResolveApproval: false },
      )
      if (!sent.ok) return { status: 'unavailable', code: 'host-unavailable' }
      this.host.recordSemantic(input.task, {
        operationId: input.operationId,
        purpose: 'conversation',
        turn: sent.value.turn,
        messageId: sent.value.messageId,
      })
      return { status: 'accepted', turn: sent.value.turn, messageId: sent.value.messageId, delivery: 'executed' }
    })
  }

  async decideAgentLoopApprovalV4(
    input: Parameters<AgentLoopV4Transport['decideAgentLoopApprovalV4']>[0],
  ): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    return await this.once(
      input,
      async () =>
        !this.host.hasPendingApproval(input.task, input.turn, input.approvalId)
          ? { status: 'unavailable', code: 'approval-expired' }
          : this.host.appendV4Lifecycle(input.task, {
              turnId: input.turn,
              type: 'approval.resolved',
              approval: { approvalId: input.approvalId, kind: 'command', state: 'resolved', outcome: input.decision },
            })
          ? {
            status: 'accepted',
            turn: input.turn,
            approvalId: input.approvalId,
            decision: input.decision,
            delivery: 'executed',
          }
          : { status: 'unavailable', code: 'approval-unavailable' },
      `approval\0${input.task}\0${input.turn}\0${input.approvalId}`,
      'approval-conflict',
    )
  }

  async requestAgentLoopIntroductionV4(
    input: Parameters<AgentLoopV4Transport['requestAgentLoopIntroductionV4']>[0],
  ): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    return await this.once(
      input,
      async () => {
        const reserved = this.host.reserveSemanticTurn(input.task, 'member-self-introduction')
        if (reserved === undefined) return { status: 'unavailable', code: 'introduction-unavailable' }
        const { turn, messageId } = reserved
        if (!this.host.appendV4Lifecycle(input.task, { turnId: turn, type: 'turn.started' })) {
          return {
            status: 'unavailable',
            code: 'introduction-unavailable',
          }
        }
        const key = `${this.scopeKey(input.scope)}\0${input.operationId}`
        this.introductions.set(key, {
          task: input.task,
          turn,
          messageId,
          participantId: input.participantId,
          memberId: input.memberId,
          runId: input.runId,
          state: 'pending',
        })
        this.host.recordSemantic(input.task, {
          operationId: input.operationId,
          purpose: 'member-self-introduction',
          turn,
          messageId,
          participantId: input.participantId,
          memberId: input.memberId,
          runId: input.runId,
        })
        setTimeout(async () => {
          const current = this.introductions.get(key)
          if (current?.state !== 'pending') return
          const introduction = await this.host.memberSelfIntroduction(input.task, {
            participantId: input.participantId,
            memberId: input.memberId,
            runId: input.runId,
          })
          const latest = this.introductions.get(key)
          if (latest?.state !== 'pending') return
          if (introduction.status === 'ok') {
            this.host.appendV4Lifecycle(input.task, {
              turnId: turn,
              type: 'turn.completed',
              output: [{ type: 'text', text: introduction.text }],
            })
            this.introductions.set(key, { ...latest, state: 'completed' })
          } else {
            this.host.appendV4Lifecycle(input.task, {
              turnId: turn,
              type: 'turn.failed',
              failure: introduction.failure,
            })
            this.introductions.set(key, { ...latest, state: 'failed' })
            const resourceKey = `${
              this.scopeKey(input.scope)
            }\0introduction\0${input.task}\0${input.participantId}\0${input.memberId}\0${input.runId}`
            if (this.resourceOperations.get(resourceKey) === input.operationId) {
              this.resourceOperations.delete(resourceKey)
            }
          }
          this.persist()
        }, 0)
        return { status: 'accepted', turn, messageId, delivery: 'executed' }
      },
      `introduction\0${input.task}\0${input.participantId}\0${input.memberId}\0${input.runId}`,
      'introduction-conflict',
    )
  }

  async cancelAgentLoopIntroductionV4(
    input: Parameters<AgentLoopV4Transport['cancelAgentLoopIntroductionV4']>[0],
  ): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    const request = this.introductions.get(`${this.scopeKey(input.scope)}\0${input.requestOperationId}`)
    if (request?.state === 'completed') {
      return await this.once(input, async () => ({ status: 'conflict', code: 'introduction-completed' }))
    }
    if (request?.state === 'cancelled') {
      return await this.once(input, async () => ({ status: 'conflict', code: 'introduction-cancelled' }))
    }
    if (request?.state === 'failed') {
      return await this.once(input, async () => ({ status: 'conflict', code: 'introduction-conflict' }))
    }
    return await this.once(
      input,
      async () => {
        if (request === undefined || request.task !== input.task) {
          return {
            status: 'unavailable',
            code: 'introduction-not-found',
          }
        }
        if (request.participantId !== input.participantId || request.memberId !== input.memberId) {
          return {
            status: 'conflict',
            code: 'member-conflict',
          }
        }
        if (request.runId !== input.runId) return { status: 'conflict', code: 'run-conflict' }
        this.host.appendV4Lifecycle(input.task, {
          turnId: request.turn,
          type: 'turn.cancelled',
          cancellation: { operationId: input.operationId },
        })
        this.introductions.set(`${this.scopeKey(input.scope)}\0${input.requestOperationId}`, {
          ...request,
          state: 'cancelled',
        })
        return { status: 'accepted', turn: request.turn, messageId: request.messageId, delivery: 'executed' }
      },
      `introduction-cancel\0${input.task}\0${input.requestOperationId}`,
      'introduction-conflict',
    )
  }

  async readAgentLoopV4Lifecycle(
    input: Parameters<AgentLoopV4Transport['readAgentLoopV4Lifecycle']>[0],
  ): Promise<unknown> {
    if (!this.bindingFor(input)) return { status: 'unavailable', code: 'binding-closed' }
    const range = await this.host.lifecycle({
      task: input.task,
      session: { providerId: PLAYGROUND_MOCK_AGENT_LOOP_NAMESPACE, remoteSessionId: input.task },
    }, input.afterSequence)
    const prefix = `${this.scopeKey(input.scope)}\0`
    const introductions = new Map(
      [...this.introductions]
        .filter(([key, value]) => key.startsWith(prefix) && value.task === input.task)
        .map(([key, value]) =>
          [value.turn, {
            operationId: key.slice(prefix.length),
            messageId: value.messageId,
            participantId: value.participantId,
            memberId: value.memberId,
            runId: value.runId,
          }] as const
        ),
    )
    return {
      status: 'accepted',
      nextAfterSequence: range.nextAfterSequence,
      events: range.events.map(event => ({
        ...event,
        ...(['turn.started', 'turn.completed', 'turn.failed'].includes(event.type) && introductions.has(event.turnId)
          ? { introduction: introductions.get(event.turnId) }
          : {}),
        eventId: `simulated-lifecycle:${event.sequence}`,
        turnId: event.turnId,
      })),
    }
  }

  async resolveAgentLoopV4Session(
    input: Parameters<AgentLoopV4Transport['resolveAgentLoopV4Session']>[0],
  ): Promise<unknown> {
    return this.bindingFor(input)
      ? { status: 'resolved', sessionId: input.task }
      : { status: 'unavailable', code: 'binding-closed' }
  }

  private async once(
    input: {
      readonly scope: Parameters<AgentLoopV4Transport['createAgentLoopV4']>[0]['scope']
      readonly operationId: string
      readonly command: unknown
    },
    execute: () => Promise<unknown>,
    resourceKey?: string,
    resourceConflictCode: 'approval-conflict' | 'introduction-conflict' = 'introduction-conflict',
  ): Promise<unknown> {
    const resetGeneration = this.resetGeneration
    const owner = this.scopeKey(input.scope)
    const operationKey = `${owner}\0${input.operationId}`
    const commandFingerprint = fingerprint(input.command)
    const prior = this.results.get(operationKey)
    if (prior !== undefined) {
      return prior.fingerprint === commandFingerprint
        ? { ...(clone(prior.result) as Record<string, unknown>), delivery: 'replayed' }
        : { status: 'conflict', code: 'operation-conflict' }
    }
    const inFlight = this.pending.get(operationKey)
    if (inFlight !== undefined) {
      return inFlight.fingerprint === commandFingerprint
        ? { ...(clone(await inFlight.result) as Record<string, unknown>), delivery: 'replayed' }
        : { status: 'conflict', code: 'operation-conflict' }
    }
    const scopedResourceKey = resourceKey === undefined ? undefined : `${owner}\0${resourceKey}`
    if (scopedResourceKey !== undefined && this.resourceOperations.has(scopedResourceKey)) {
      return { status: 'conflict', code: resourceConflictCode }
    }
    if (scopedResourceKey !== undefined) this.resourceOperations.set(scopedResourceKey, input.operationId)
    const execution = execute()
    this.pending.set(operationKey, { fingerprint: commandFingerprint, result: execution })
    try {
      const result = await execution
      if (resetGeneration !== this.resetGeneration) return { status: 'unavailable', code: 'runtime-reset' }
      this.results.set(operationKey, { fingerprint: commandFingerprint, result: clone(result) })
      if (
        (result as { status?: unknown } | null)?.status !== 'accepted' && scopedResourceKey !== undefined
        && this.resourceOperations.get(scopedResourceKey) === input.operationId
      ) this.resourceOperations.delete(scopedResourceKey)
      this.persist()
      return result
    } catch (error) {
      if (scopedResourceKey !== undefined && this.resourceOperations.get(scopedResourceKey) === input.operationId) {
        this.resourceOperations.delete(scopedResourceKey)
      }
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
      if (
        value.version !== 2 || !Array.isArray(value.results) || !Array.isArray(value.bindings)
        || !Array.isArray(value.introductions) || !Array.isArray(value.resources)
      ) return
      for (const entry of value.results) {
        if (typeof entry?.key !== 'string' || typeof entry.fingerprint !== 'string') return
        this.results.set(entry.key, { fingerprint: entry.fingerprint, result: clone(entry.result) })
      }
      for (const entry of value.bindings) {
        if (
          typeof entry?.key !== 'string' || typeof entry.task !== 'string' || typeof entry.bindingId !== 'string'
          || !Number.isInteger(entry.generation) || entry.generation < 1
          || typeof entry.definition?.agentId !== 'string'
          || typeof entry.definition?.revision !== 'string'
        ) return
        this.bindings.set(
          entry.key,
          clone({
            task: entry.task,
            bindingId: entry.bindingId,
            generation: entry.generation,
            definition: entry.definition,
          }),
        )
      }
      for (const entry of value.introductions) {
        if (
          typeof entry?.key !== 'string' || typeof entry.value?.task !== 'string'
          || !['pending', 'completed', 'cancelled', 'failed'].includes(entry.value.state)
        ) return
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
        results: [...this.results].map(([key, entry]) => ({
          key,
          fingerprint: entry.fingerprint,
          result: entry.result,
        })),
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
