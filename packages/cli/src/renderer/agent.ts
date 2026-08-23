import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import {
  type CordisXAgent,
  type CordisXAgentContentBlock,
  type CordisXAgentEventSource,
  type CordisXAgentEventStatus,
  type CordisXAgentMessageInput,
  type CordisXAgentPluginSource,
  type CordisXAgentTarget,
  type CordisXAgents,
  type CordisXPreStepHandler,
  type CordisXPreStepInput,
  type CordisXPreStepOperation,
  type CordisXPromptContribution,
  type CordisXSystemPrompt,
  type CordisXUserMessage,
} from '../agent-contracts.js'
import type {
  CordisXPlatformDiagnostic,
  CordisXPlatformResult,
  CordisXPluginIdentity,
} from '../platform-contracts.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { CordisXAgentEventLedger } from './agent-events.js'
import { PermissionBroker } from './platform.js'

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function clone<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function content(input: CordisXAgentMessageInput): readonly CordisXAgentContentBlock[] {
  const blocks = typeof input === 'string' ? [{ type: 'text' as const, text: input }] : clone(input)
  if (blocks.length === 0 || blocks.length > 128) throw new Error('Agent message content must contain 1..128 blocks')
  for (const block of blocks) {
    if (block.type === 'text' && (typeof block.text !== 'string' || block.text.length > 1_000_000)) throw new Error('Agent text block is invalid')
    if (block.type === 'reference' && (!validId(block.ref) || block.mediaType.trim() === '')) throw new Error('Agent reference block is invalid')
  }
  return freeze(blocks)
}

export interface CordisXAgentDeliveryInput {
  readonly sessionId: string
  readonly target: CordisXAgentTarget
  readonly wakeup: boolean
  readonly message: CordisXUserMessage
}

export interface CordisXAgentDeliveryOutcome {
  readonly terminal: 'forwarded' | 'failed' | 'expired' | 'cancelled'
  readonly claimed: boolean
  readonly projected: boolean
  readonly turnId?: string
  readonly stepId?: string
  readonly contextId?: string
  readonly diagnostic?: CordisXPlatformDiagnostic
}

/** Private host boundary. Implementations never cross the public services. */
export interface CordisXAgentAdapter {
  agentStatus(): CordisXAgentEventStatus
  deliver(input: CordisXAgentDeliveryInput): Promise<CordisXAgentDeliveryOutcome>
}

interface PreStepRecord {
  readonly order: number
  readonly identity: CordisXPluginIdentity
  readonly source: CordisXAgentPluginSource
  readonly handler: CordisXPreStepHandler
}

interface PromptRecord {
  readonly kind: 'section' | 'context'
  readonly identity: CordisXPluginIdentity
  readonly source: CordisXAgentPluginSource
  readonly contribution: CordisXPromptContribution
  active: boolean
  disposed: boolean
}

export type CordisXPreStepOutcome =
  | { readonly status: 'continued'; readonly messages: readonly CordisXUserMessage[] }
  | { readonly status: 'rejected'; readonly messages: readonly CordisXUserMessage[]; readonly reason: string; readonly source: CordisXAgentPluginSource }
  | { readonly status: 'failed'; readonly messages: readonly CordisXUserMessage[]; readonly error: CordisXPlatformDiagnostic }

export interface CordisXHostAgentRuntimeOptions {
  readonly adapter: CordisXAgentAdapter
  readonly broker: PermissionBroker
  readonly generation: string
  readonly now?: () => number
  readonly ledger?: CordisXAgentEventLedger
}

/** One generation's shared queue, pre-step waterfall, prompt registry and ledger. */
export class CordisXHostAgentRuntime {
  readonly adapter: CordisXAgentAdapter
  readonly broker: PermissionBroker
  readonly generation: string
  readonly ledger: CordisXAgentEventLedger
  private readonly now: () => number
  private readonly preSteps: PreStepRecord[] = []
  private readonly prompts = new Set<PromptRecord>()
  private readonly operations = new Set<Promise<void>>()
  private nextMessage = 0
  private nextRegistration = 0
  private disposed = false

  constructor(options: CordisXHostAgentRuntimeOptions) {
    this.adapter = options.adapter
    this.broker = options.broker
    this.generation = options.generation
    this.now = options.now ?? (() => Date.now())
    this.ledger = options.ledger ?? new CordisXAgentEventLedger(this.now)
  }

  status(): CordisXAgentEventStatus {
    return this.adapter.agentStatus()
  }

  pluginSource(identity: CordisXPluginIdentity): CordisXAgentPluginSource {
    return freeze({ kind: 'plugin', source: identity.source, id: identity.id, version: null, generation: this.generation })
  }

  send(identity: CordisXPluginIdentity, sessionId: string, input: CordisXAgentMessageInput, target: CordisXAgentTarget, wakeup: boolean): void {
    this.assertLive()
    if (!validId(sessionId)) throw new Error('sessionId must be a non-empty opaque id')
    if (!['next-turn', 'next-step'].includes(target) || typeof wakeup !== 'boolean') throw new Error('Agent delivery target is invalid')
    const source = this.pluginSource(identity)
    const message: CordisXUserMessage = freeze({
      id: `cxmsg:${encodeURIComponent(this.generation)}:${this.nextMessage++}`,
      role: 'user',
      content: content(input),
      source,
    })
    const requested = this.ledger.commit({
      sessionId,
      messageId: message.id,
      type: 'message.delivery',
      provenance: 'cordisx',
      source,
      data: { stage: 'requested', target, wakeup, message },
    })
    const operation = this.deliver(identity, sessionId, message, target, wakeup, requested.eventId)
      .catch(error => {
        if (this.disposed) return
        this.ledger.commit({
          sessionId,
          messageId: message.id,
          type: 'message.delivery',
          provenance: 'cordisx',
          source: this.runtimeSource('agent-runtime'),
          ...this.causal(this.latestEventId(sessionId)),
          data: {
            stage: 'failed', target, wakeup,
            diagnostic: { code: 'adapter-failure', message: error instanceof Error ? error.message : String(error), retryable: false },
          },
        })
      })
      .finally(() => this.operations.delete(operation))
    this.operations.add(operation)
  }

  registerPreStep(identity: CordisXPluginIdentity, handler: CordisXPreStepHandler): Disposable<void> {
    this.assertLive()
    const record = { order: this.nextRegistration++, identity, source: this.pluginSource(identity), handler }
    this.preSteps.push(record)
    return () => {
      const index = this.preSteps.indexOf(record)
      if (index >= 0) this.preSteps.splice(index, 1)
    }
  }

  async runPreStep(input: CordisXPreStepInput): Promise<CordisXPreStepOutcome> {
    this.assertLive()
    let messages = clone(input.messages)
    for (const record of [...this.preSteps].sort((left, right) => left.order - right.order)) {
      const decision = await record.handler(freeze({ ...input, messages }))
      if (decision.kind === 'continue') continue
      const capability = decision.kind === 'append' ? 'agent.messages.append'
        : decision.kind === 'reject' ? 'agent.steps.reject'
          : 'agent.messages.transform'
      const grant = await this.broker.authorize(record.identity, capability, { agentSessionId: input.sessionId })
      if (!grant.ok) return { status: 'failed', messages, error: grant.error }
      if (decision.kind === 'reject') return { status: 'rejected', messages, reason: decision.reason, source: record.source }
      if (decision.kind === 'append') {
        messages = freeze([...messages, ...decision.messages.map(item => this.message(record.source, item))])
        continue
      }
      try {
        messages = this.transform(messages, decision.operations, decision.append ?? [], record.source)
      } catch (error) {
        return {
          status: 'failed',
          messages,
          error: { code: 'invalid-request', message: error instanceof Error ? error.message : String(error) },
        }
      }
    }
    return { status: 'continued', messages }
  }

  registerPrompt(identity: CordisXPluginIdentity, kind: 'section' | 'context', contribution: CordisXPromptContribution): Disposable<void> {
    this.assertLive()
    if (!validId(contribution.sessionId) || !validId(contribution.id) || contribution.content.trim() === '') {
      throw new Error('Prompt contribution requires sessionId, id, and non-empty content')
    }
    const record: PromptRecord = {
      kind,
      identity,
      source: this.pluginSource(identity),
      contribution: clone(contribution),
      active: false,
      disposed: false,
    }
    this.prompts.add(record)
    const capability = kind === 'section' ? 'agent.prompt.section' : 'agent.prompt.context'
    const operation = this.broker.authorize(identity, capability, { agentSessionId: contribution.sessionId })
      .then(grant => { if (grant.ok && !record.disposed && !this.disposed) record.active = true })
      .finally(() => this.operations.delete(operation))
    this.operations.add(operation)
    return () => {
      record.disposed = true
      record.active = false
      this.prompts.delete(record)
    }
  }

  promptSnapshot(sessionId: string): readonly Readonly<PromptRecord>[] {
    return clone([...this.prompts]
      .filter(item => item.active && item.contribution.sessionId === sessionId)
      .sort((left, right) => (left.contribution.order ?? 0) - (right.contribution.order ?? 0)))
  }

  async settled(): Promise<void> {
    while (this.operations.size > 0) await Promise.all([...this.operations])
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.settled()
    this.preSteps.length = 0
    this.prompts.clear()
    this.ledger.dispose()
  }

  private async deliver(
    identity: CordisXPluginIdentity,
    sessionId: string,
    message: CordisXUserMessage,
    target: CordisXAgentTarget,
    wakeup: boolean,
    parentId: string,
  ): Promise<void> {
    const policy = this.broker.policy(identity, 'agent.messages.append')
    const grant = await this.broker.authorize(identity, 'agent.messages.append', { agentSessionId: sessionId })
    const permission = this.ledger.commit({
      sessionId,
      messageId: message.id,
      type: 'message.delivery',
      provenance: 'cordisx',
      source: this.runtimeSource('permission-broker'),
      causalParentId: parentId,
      data: {
        stage: 'permission', target, wakeup,
        capability: 'agent.messages.append',
        policy,
        decision: grant.ok ? 'allow' : grant.error.code === 'timeout' ? 'timeout' : 'deny',
        ...(!grant.ok ? { diagnostic: grant.error } : {}),
      },
    })
    if (!grant.ok) {
      this.terminal(sessionId, message.id, target, wakeup, 'failed', permission.eventId, grant.error)
      return
    }
    const queued = this.ledger.commit({
      sessionId,
      messageId: message.id,
      type: 'message.delivery',
      provenance: 'cordisx',
      source: this.runtimeSource('agent-runtime'),
      causalParentId: permission.eventId,
      data: { stage: 'queued', target, wakeup },
    })
    const outcome = await this.adapter.deliver({ sessionId, target, wakeup, message })
    let causalParentId = queued.eventId
    if (outcome.claimed) {
      causalParentId = this.ledger.commit({
        sessionId,
        ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
        ...(outcome.stepId === undefined ? {} : { stepId: outcome.stepId }),
        ...(outcome.contextId === undefined ? {} : { contextId: outcome.contextId }),
        messageId: message.id,
        type: 'message.delivery', provenance: 'cordisx', source: this.runtimeSource('agent-runtime'), causalParentId,
        data: { stage: 'claimed', target, wakeup },
      }).eventId
    }
    if (outcome.projected) {
      causalParentId = this.ledger.commit({
        sessionId,
        ...(outcome.turnId === undefined ? {} : { turnId: outcome.turnId }),
        ...(outcome.stepId === undefined ? {} : { stepId: outcome.stepId }),
        ...(outcome.contextId === undefined ? {} : { contextId: outcome.contextId }),
        messageId: message.id,
        type: 'message.delivery', provenance: 'cordisx', source: this.runtimeSource('adapter-boundary'), causalParentId,
        data: { stage: 'projected', target, wakeup },
      }).eventId
    }
    this.terminal(sessionId, message.id, target, wakeup, outcome.terminal, causalParentId, outcome.diagnostic, outcome)
  }

  private terminal(
    sessionId: string,
    messageId: string,
    target: CordisXAgentTarget,
    wakeup: boolean,
    terminal: CordisXAgentDeliveryOutcome['terminal'],
    causalParentId: string,
    diagnostic?: CordisXPlatformDiagnostic,
    identities: Pick<CordisXAgentDeliveryOutcome, 'turnId' | 'stepId' | 'contextId'> = {},
  ): void {
    this.ledger.commit({
      sessionId,
      ...(identities.turnId === undefined ? {} : { turnId: identities.turnId }),
      ...(identities.stepId === undefined ? {} : { stepId: identities.stepId }),
      ...(identities.contextId === undefined ? {} : { contextId: identities.contextId }),
      messageId,
      type: 'message.delivery',
      provenance: 'cordisx',
      source: this.runtimeSource('adapter-boundary'),
      causalParentId,
      data: { stage: terminal, target, wakeup, ...(diagnostic === undefined ? {} : { diagnostic }) },
    })
  }

  private message(source: CordisXAgentPluginSource, input: CordisXAgentMessageInput): CordisXUserMessage {
    return freeze({ id: `cxmsg:${encodeURIComponent(this.generation)}:${this.nextMessage++}`, role: 'user', content: content(input), source })
  }

  private transform(
    input: readonly CordisXUserMessage[],
    operations: readonly CordisXPreStepOperation[],
    append: readonly CordisXAgentMessageInput[],
    source: CordisXAgentPluginSource,
  ): readonly CordisXUserMessage[] {
    const messages = [...input]
    for (const operation of operations) {
      const index = messages.findIndex(item => item.id === operation.messageId)
      if (index < 0) throw new Error(`pre-step message ${operation.messageId} does not exist`)
      if (operation.type === 'remove') messages.splice(index, 1)
      if (operation.type === 'replace') messages.splice(index, 1, this.message(source, operation.content))
      if (operation.type === 'move') {
        const [item] = messages.splice(index, 1)
        const before = operation.beforeMessageId === undefined ? messages.length : messages.findIndex(candidate => candidate.id === operation.beforeMessageId)
        if (before < 0) throw new Error(`pre-step target ${operation.beforeMessageId} does not exist`)
        messages.splice(before, 0, item!)
      }
    }
    messages.push(...append.map(item => this.message(source, item)))
    return freeze(messages)
  }

  private runtimeSource(component: string): CordisXAgentEventSource {
    return freeze({ kind: 'cordisx', component, generation: this.generation })
  }

  private latestEventId(sessionId: string): string | undefined {
    return this.ledger.latestEventId(sessionId)
  }

  private causal(eventId: string | undefined): { readonly causalParentId: string } | Record<never, never> {
    return eventId === undefined ? {} : { causalParentId: eventId }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Agent runtime generation is disposed')
  }
}

const runtimes = new WeakMap<object, CordisXHostAgentRuntime>()
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function runtimeFor(service: object): CordisXHostAgentRuntime {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  for (const candidate of [original, service]) {
    if (candidate !== undefined) {
      const runtime = runtimes.get(candidate)
      if (runtime !== undefined) return runtime
    }
  }
  throw new Error('CordisX Agent service is detached from its HostRuntime')
}

function caller(ctx: Context): CordisXPluginIdentity {
  const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  if (scoped[CORDISX_PLUGIN_ID] === undefined || scoped[CORDISX_PLUGIN_SOURCE] === undefined) {
    throw new Error('Agent capabilities require a plugin context')
  }
  return { id: scoped[CORDISX_PLUGIN_ID], source: scoped[CORDISX_PLUGIN_SOURCE] }
}

export class CordisXAgentService extends Service implements CordisXAgents {
  constructor(ctx: Context, runtime: CordisXHostAgentRuntime) {
    super(ctx, 'agents')
    runtimes.set(this, runtime)
  }

  get(sessionId: string): CordisXAgent {
    if (!validId(sessionId)) throw new Error('sessionId must be a non-empty opaque id')
    const identity = caller(this.ctx)
    const runtime = runtimeFor(this)
    return Object.freeze({
      send: (message: CordisXAgentMessageInput, target: CordisXAgentTarget, wakeup: boolean) => runtime.send(identity, sessionId, message, target, wakeup),
      followup: (message: CordisXAgentMessageInput) => runtime.send(identity, sessionId, message, 'next-turn', true),
      steer: (message: CordisXAgentMessageInput) => runtime.send(identity, sessionId, message, 'next-step', true),
      inject: (message: CordisXAgentMessageInput) => runtime.send(identity, sessionId, message, 'next-step', false),
    })
  }

  preStep(handler: CordisXPreStepHandler): Disposable<void> {
    if (typeof handler !== 'function') throw new Error('preStep handler must be a function')
    return this.ctx.effect(
      () => runtimeFor(this).registerPreStep(caller(this.ctx), handler),
      'agents.preStep',
    ) as Disposable<void>
  }
}

export class CordisXSystemPromptService extends Service implements CordisXSystemPrompt {
  constructor(ctx: Context, runtime: CordisXHostAgentRuntime) {
    super(ctx, 'systemPrompt')
    runtimes.set(this, runtime)
  }

  section(contribution: CordisXPromptContribution): Disposable<void> {
    return this.register('section', contribution)
  }

  context(contribution: CordisXPromptContribution): Disposable<void> {
    return this.register('context', contribution)
  }

  private register(kind: 'section' | 'context', contribution: CordisXPromptContribution): Disposable<void> {
    return this.ctx.effect(
      () => runtimeFor(this).registerPrompt(caller(this.ctx), kind, contribution),
      `systemPrompt.${kind}(${JSON.stringify(contribution.id)})`,
    ) as Disposable<void>
  }
}
