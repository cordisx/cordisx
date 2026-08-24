import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import {
  CORDISX_AGENT_DELIVERY_CONTRACT,
  CORDISX_AGENT_DELIVERY_SCHEMA_VERSION,
  type CordisXAgent,
  type CordisXAgentContentBlock,
  type CordisXAgentDeliveryCancelResult,
  type CordisXAgentDeliveryClearResult,
  type CordisXAgentDeliveryHandle,
  type CordisXAgentDeliverySnapshot,
  type CordisXAgentEventSource,
  type CordisXAgentEventStatus,
  type CordisXAgentMessageInput,
  type CordisXAgentPluginSource,
  type CordisXAgentTarget,
  type CordisXAgents,
  type CordisXInputContributionKind,
  type CordisXInputContributionReleaseReason,
  type CordisXMessageDeliveryCancelReason,
  type CordisXMessageDeliveryStage,
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
import type { PluginConsoleAspect, PluginConsolePendingInvocation } from './plugin-console.js'

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
  readonly terminal: 'forwarded' | 'failed' | 'expired'
  readonly turnId?: string
  readonly stepId?: string
  readonly contextId?: string
  readonly diagnostic?: CordisXPlatformDiagnostic
}

export interface CordisXAgentDeliveryIdentity {
  readonly turnId?: string
  readonly stepId?: string
  readonly contextId?: string
}

export interface CordisXAgentDeliveryControl {
  claim(identity?: CordisXAgentDeliveryIdentity): boolean
  projected(identity?: CordisXAgentDeliveryIdentity): void
}

/** Private host boundary. Implementations never cross the public services. */
export interface CordisXAgentAdapter {
  agentStatus(): CordisXAgentEventStatus
  deliver(input: CordisXAgentDeliveryInput, control: CordisXAgentDeliveryControl): Promise<CordisXAgentDeliveryOutcome>
}

interface PreStepRecord {
  readonly order: number
  readonly contributionId: string
  readonly identity: CordisXPluginIdentity
  readonly source: CordisXAgentPluginSource
  readonly handler: CordisXPreStepHandler
}

interface PromptRecord {
  readonly kind: 'section' | 'context'
  readonly identity: CordisXPluginIdentity
  readonly source: CordisXAgentPluginSource
  readonly contribution: CordisXPromptContribution
  readonly contributionId: string
  active: boolean
  disposed: boolean
  registrationEventId?: string
}

interface DeliveryRecord {
  readonly identity: CordisXPluginIdentity
  readonly owner: CordisXAgentPluginSource
  readonly deliveryId: string
  readonly sessionId: string
  readonly message: CordisXUserMessage
  readonly target: CordisXAgentTarget
  readonly wakeup: boolean
  stage: CordisXMessageDeliveryStage
  stageEventId: string
  valid: boolean
  turnId?: string
  stepId?: string
  contextId?: string
  diagnostic?: CordisXPlatformDiagnostic
  readonly consoleTrace?: PluginConsolePendingInvocation
}

interface ContributionEvaluation {
  readonly contributionId: string
  readonly evaluationId: string
  readonly kind: CordisXInputContributionKind
  readonly source: CordisXAgentPluginSource
  readonly messageIds?: readonly string[]
  eventId: string
}

export interface CordisXPromptProjection {
  readonly sections: readonly (CordisXPromptContribution & { readonly source: CordisXAgentPluginSource })[]
  readonly contexts: readonly (CordisXPromptContribution & { readonly source: CordisXAgentPluginSource })[]
}

export type CordisXPreStepOutcome =
  | { readonly status: 'continued'; readonly messages: readonly CordisXUserMessage[]; readonly prompt: CordisXPromptProjection }
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
  private readonly deliveries = new Map<string, DeliveryRecord>()
  private readonly operations = new Set<Promise<void>>()
  private nextDelivery = 0
  private nextMessage = 0
  private nextRegistration = 0
  private nextContribution = 0
  private nextEvaluation = 0
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

  send(
    identity: CordisXPluginIdentity,
    sessionId: string,
    input: CordisXAgentMessageInput,
    target: CordisXAgentTarget,
    wakeup: boolean,
    consoleTrace?: PluginConsolePendingInvocation,
  ): CordisXAgentDeliveryHandle {
    this.assertLive()
    if (!validId(sessionId)) throw new Error('sessionId must be a non-empty opaque id')
    if (!['next-turn', 'next-step'].includes(target) || typeof wakeup !== 'boolean') throw new Error('Agent delivery target is invalid')
    const owner = this.pluginSource(identity)
    const deliveryId = `cxdelivery:${encodeURIComponent(this.generation)}:${this.nextDelivery++}`
    const message: CordisXUserMessage = freeze({
      id: `cxmsg:${encodeURIComponent(this.generation)}:${this.nextMessage++}`,
      role: 'user',
      content: content(input),
      source: owner,
    })
    const requested = this.ledger.commit({
      sessionId,
      messageId: message.id,
      deliveryId,
      type: 'message.delivery',
      provenance: 'cordisx',
      source: owner,
      data: { stage: 'requested', target, wakeup, owner, message },
    })
    const record: DeliveryRecord = {
      identity: clone(identity), owner, deliveryId, sessionId, message, target, wakeup,
      stage: 'requested', stageEventId: requested.eventId, valid: true,
      ...(consoleTrace === undefined ? {} : { consoleTrace }),
    }
    this.deliveries.set(deliveryId, record)
    const operation = this.deliver(record)
      .catch(error => console.error('CordisX Agent delivery ledger failed', error))
      .finally(() => this.operations.delete(operation))
    this.operations.add(operation)
    return this.deliveryHandle(identity, record)
  }

  clearPending(identity: CordisXPluginIdentity, sessionId: string): CordisXAgentDeliveryClearResult {
    this.assertLive()
    const cancelled: CordisXAgentDeliverySnapshot[] = []
    const retained: CordisXAgentDeliverySnapshot[] = []
    for (const record of this.deliveries.values()) {
      if (record.sessionId !== sessionId || !this.sameOwner(record.identity, identity) || record.owner.generation !== this.generation) continue
      if (this.terminalStage(record.stage)) continue
      const result = this.cancelDelivery(identity, record.deliveryId, 'clear-pending')
      if (result.ok) cancelled.push(result.snapshot)
      else retained.push(result.snapshot)
    }
    return clone({ cancelled, retained })
  }

  releaseOwner(identity: CordisXPluginIdentity, reason: Exclude<CordisXMessageDeliveryCancelReason, 'requested' | 'clear-pending'>): void {
    for (const record of this.deliveries.values()) {
      if (!this.sameOwner(record.identity, identity)) continue
      this.invalidateDelivery(record, reason)
    }
    for (const prompt of [...this.prompts]) {
      if (this.sameOwner(prompt.identity, identity)) this.releasePrompt(prompt, reason)
    }
  }

  registerPreStep(identity: CordisXPluginIdentity, handler: CordisXPreStepHandler): Disposable<void> {
    this.assertLive()
    const record = {
      order: this.nextRegistration++,
      contributionId: `cxcontribution:${encodeURIComponent(this.generation)}:${this.nextContribution++}`,
      identity,
      source: this.pluginSource(identity),
      handler,
    }
    this.preSteps.push(record)
    return () => {
      const index = this.preSteps.indexOf(record)
      if (index >= 0) this.preSteps.splice(index, 1)
    }
  }

  async runPreStep(input: CordisXPreStepInput): Promise<CordisXPreStepOutcome> {
    this.assertLive()
    if (!validId(input.sessionId) || !validId(input.turnId) || !validId(input.stepId)) {
      throw new Error('pre-step session, turn, and step ids must be non-empty opaque ids')
    }
    let messages = clone(input.messages)
    const evaluations: ContributionEvaluation[] = []
    const prompt = this.beginPromptProjection(input, evaluations)
    for (const record of [...this.preSteps].sort((left, right) => left.order - right.order)) {
      let decision
      try {
        decision = await record.handler(freeze({ ...input, messages }))
      } catch (error) {
        const diagnostic = { code: 'adapter-failure' as const, message: `agent/pre-step handler failed: ${error instanceof Error ? error.message : String(error)}` }
        this.preStepDiagnostic(input, record.source, diagnostic.code, diagnostic.message)
        this.failContributions(input, evaluations, diagnostic)
        return { status: 'failed', messages, error: diagnostic }
      }
      if (decision === null || typeof decision !== 'object' || !['continue', 'append', 'reject', 'transform'].includes(decision.kind)) {
        const error = { code: 'invalid-request' as const, message: 'agent/pre-step handler returned an invalid decision' }
        this.preStepDiagnostic(input, record.source, error.code, error.message)
        this.failContributions(input, evaluations, error)
        return { status: 'failed', messages, error }
      }
      if (decision.kind === 'continue') continue
      const capability = decision.kind === 'append' ? 'agent.messages.append'
        : decision.kind === 'reject' ? 'agent.steps.reject'
          : 'agent.messages.transform'
      const grant = await this.broker.authorize(record.identity, capability, { agentSessionId: input.sessionId })
      if (!grant.ok) {
        this.preStepDiagnostic(input, record.source, grant.error.code, grant.error.message)
        if (decision.kind === 'append') this.contributionFailure(input, record, 'pre-step.append', grant.error, capability)
        this.failContributions(input, evaluations, grant.error)
        return { status: 'failed', messages, error: grant.error }
      }
      if (decision.kind === 'reject') {
        this.preStepDiagnostic(input, record.source, 'invalid-request', decision.reason)
        this.failContributions(input, evaluations, { code: 'invalid-request', message: decision.reason })
        return { status: 'rejected', messages, reason: decision.reason, source: record.source }
      }
      if (decision.kind === 'append') {
        let appended: readonly CordisXUserMessage[]
        try {
          if (decision.messages.length === 0) throw new Error('pre-step append requires at least one message')
          appended = freeze(decision.messages.map(item => this.message(record.source, item)))
        } catch (error) {
          const diagnostic = { code: 'invalid-request' as const, message: error instanceof Error ? error.message : String(error) }
          this.contributionFailure(input, record, 'pre-step.append', diagnostic, capability)
          this.failContributions(input, evaluations, diagnostic)
          return { status: 'failed', messages, error: diagnostic }
        }
        const evaluation = this.beginContributionEvaluation(
          input,
          record.contributionId,
          'pre-step.append',
          record.source,
          appended.map(message => message.id),
        )
        messages = freeze([...messages, ...appended])
        evaluation.eventId = this.contributionStage(input, evaluation, 'projected')
        evaluations.push(evaluation)
        continue
      }
      try {
        messages = this.transform(messages, decision.operations, decision.append ?? [], record.source)
      } catch (error) {
        const diagnostic = { code: 'invalid-request' as const, message: error instanceof Error ? error.message : String(error) }
        this.failContributions(input, evaluations, diagnostic)
        return {
          status: 'failed',
          messages,
          error: diagnostic,
        }
      }
    }
    for (const evaluation of evaluations) evaluation.eventId = this.contributionStage(input, evaluation, 'forwarded')
    return { status: 'continued', messages, prompt }
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
      contributionId: `cxcontribution:${encodeURIComponent(this.generation)}:${this.nextContribution++}`,
      active: false,
      disposed: false,
    }
    if ([...this.prompts].some(item => item.kind === kind
      && item.identity.source === identity.source
      && item.identity.id === identity.id
      && item.contribution.sessionId === contribution.sessionId
      && item.contribution.id === contribution.id)) {
      throw new Error(`Duplicate systemPrompt.${kind} contribution ${contribution.id}`)
    }
    this.prompts.add(record)
    const capability = kind === 'section' ? 'agent.prompt.section' : 'agent.prompt.context'
    const operation = this.broker.authorize(identity, capability, { agentSessionId: contribution.sessionId })
      .then(grant => {
        if (grant.ok && !record.disposed && !this.disposed) {
          record.active = true
          record.registrationEventId = this.ledger.commit({
            sessionId: contribution.sessionId,
            contributionId: record.contributionId,
            type: 'input.contribution',
            provenance: 'cordisx',
            source: record.source,
            ...this.causal(this.latestEventId(contribution.sessionId)),
            data: {
              kind: kind === 'section' ? 'system-prompt.section' : 'system-prompt.context',
              stage: 'registered',
              capability,
            },
          }).eventId
          return
        }
        if (!grant.ok && !record.disposed && !this.disposed) {
          this.ledger.commit({
            sessionId: contribution.sessionId,
            contributionId: record.contributionId,
            type: 'input.contribution',
            provenance: 'cordisx',
            source: record.source,
            ...this.causal(this.latestEventId(contribution.sessionId)),
            data: {
              kind: kind === 'section' ? 'system-prompt.section' : 'system-prompt.context',
              stage: 'failed',
              capability,
              diagnostic: grant.error,
            },
          })
        }
      })
      .finally(() => this.operations.delete(operation))
    this.operations.add(operation)
    return () => this.releasePrompt(record, 'explicit')
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
    for (const record of this.deliveries.values()) {
      this.invalidateDelivery(record, 'generation-replaced')
    }
    for (const prompt of [...this.prompts]) this.releasePrompt(prompt, 'generation-replaced')
    this.disposed = true
    await this.settled()
    this.preSteps.length = 0
    this.prompts.clear()
    this.ledger.dispose()
  }

  private async deliver(record: DeliveryRecord): Promise<void> {
    const policy = this.broker.policy(record.identity, 'agent.messages.append')
    if (policy === 'ask') record.consoleTrace?.permission('agent.messages.append', 'ask', 'Agent message append requires a decision')
    const grant = await this.broker.authorize(record.identity, 'agent.messages.append', { agentSessionId: record.sessionId })
    record.consoleTrace?.permission('agent.messages.append', grant.ok ? 'allow' : 'deny', grant.ok ? 'Agent message append allowed' : grant.error.message)
    if (this.terminalStage(record.stage)) return
    this.deliveryStage(record, 'permission', this.runtimeSource('permission-broker'), {
      capability: 'agent.messages.append',
      policy,
      decision: grant.ok ? 'allow' : grant.error.code === 'timeout' ? 'timeout' : 'deny',
      ...(!grant.ok ? { diagnostic: grant.error } : {}),
    })
    if (!grant.ok) {
      this.deliveryTerminal(record, 'failed', grant.error)
      return
    }
    if (this.terminalStage(record.stage)) return
    this.deliveryStage(record, 'queued', this.runtimeSource('agent-runtime'))
    if (this.terminalStage(record.stage)) return

    const control: CordisXAgentDeliveryControl = {
      claim: identity => {
        if (!record.valid || this.terminalStage(record.stage) || record.stage !== 'queued') return false
        this.assignDeliveryIdentity(record, identity)
        this.deliveryStage(record, 'claimed', this.runtimeSource('agent-runtime'))
        return true
      },
      projected: identity => {
        if (!record.valid || record.stage !== 'claimed') throw new Error('Agent delivery must be claimed before projection')
        this.assignDeliveryIdentity(record, identity)
        this.deliveryStage(record, 'projected', this.runtimeSource('adapter-boundary'))
      },
    }

    let outcome: CordisXAgentDeliveryOutcome
    try {
      record.consoleTrace?.dispatch('Dispatched to Agent adapter')
      outcome = await this.adapter.deliver({
        sessionId: record.sessionId,
        target: record.target,
        wakeup: record.wakeup,
        message: record.message,
      }, control)
    } catch {
      if (!this.terminalStage(record.stage)) {
        this.deliveryTerminal(record, 'failed', {
          code: 'adapter-failure', message: 'Agent adapter delivery failed', retryable: true,
        })
      }
      return
    }
    if (this.terminalStage(record.stage)) return
    this.assignDeliveryIdentity(record, outcome)
    if (outcome.terminal === 'forwarded' && record.stage !== 'projected') {
      this.deliveryTerminal(record, 'failed', {
        code: 'adapter-failure', message: 'Agent adapter reported forwarded before claim and projection', retryable: false,
      })
      return
    }
    this.deliveryTerminal(record, outcome.terminal, outcome.diagnostic)
  }

  private deliveryStage(
    record: DeliveryRecord,
    stage: Exclude<CordisXMessageDeliveryStage, 'requested' | 'forwarded' | 'failed' | 'expired' | 'cancelled'>,
    source: CordisXAgentEventSource,
    details: Partial<{
      capability: string
      policy: 'ask' | 'deny' | 'allow'
      decision: 'allow' | 'deny' | 'timeout'
      diagnostic: CordisXPlatformDiagnostic
    }> = {},
  ): void {
    const event = this.ledger.commit({
      sessionId: record.sessionId,
      ...this.deliveryIdentity(record),
      messageId: record.message.id,
      deliveryId: record.deliveryId,
      type: 'message.delivery',
      provenance: 'cordisx',
      source,
      causalParentId: record.stageEventId,
      data: { stage, target: record.target, wakeup: record.wakeup, owner: record.owner, ...details },
    })
    record.stage = stage
    record.stageEventId = event.eventId
    if (details.diagnostic !== undefined) record.diagnostic = details.diagnostic
  }

  private deliveryTerminal(
    record: DeliveryRecord,
    terminal: 'forwarded' | 'failed' | 'expired',
    diagnostic?: CordisXPlatformDiagnostic,
  ): void {
    if (this.terminalStage(record.stage)) return
    const resolvedDiagnostic = terminal === 'forwarded'
      ? diagnostic
      : diagnostic ?? { code: terminal === 'expired' ? 'timeout' : 'adapter-failure', message: `Agent delivery ${terminal}` }
    const event = this.ledger.commit({
      sessionId: record.sessionId,
      ...this.deliveryIdentity(record),
      messageId: record.message.id,
      deliveryId: record.deliveryId,
      type: 'message.delivery',
      provenance: 'cordisx',
      source: this.runtimeSource('adapter-boundary'),
      causalParentId: record.stageEventId,
      data: {
        stage: terminal,
        target: record.target,
        wakeup: record.wakeup,
        owner: record.owner,
        ...(resolvedDiagnostic === undefined ? {} : { diagnostic: resolvedDiagnostic }),
      },
    })
    record.stage = terminal
    record.stageEventId = event.eventId
    if (resolvedDiagnostic === undefined) delete record.diagnostic
    else record.diagnostic = resolvedDiagnostic
    if (terminal !== 'forwarded') record.consoleTrace?.failure(resolvedDiagnostic)
  }

  private deliveryHandle(identity: CordisXPluginIdentity, record: DeliveryRecord): CordisXAgentDeliveryHandle {
    const owner = clone(identity)
    return Object.freeze({
      deliveryId: record.deliveryId,
      snapshot: () => this.deliverySnapshot(record),
      cancel: () => this.cancelDelivery(owner, record.deliveryId, 'requested'),
    })
  }

  private invalidateDelivery(
    record: DeliveryRecord,
    reason: Exclude<CordisXMessageDeliveryCancelReason, 'requested' | 'clear-pending'>,
  ): void {
    if (!this.terminalStage(record.stage) && this.cancellableStage(record.stage)) {
      this.cancelDelivery(record.identity, record.deliveryId, reason)
    }
    record.valid = false
  }

  private cancelDelivery(
    identity: CordisXPluginIdentity,
    deliveryId: string,
    reason: CordisXMessageDeliveryCancelReason,
  ): CordisXAgentDeliveryCancelResult {
    const record = this.deliveries.get(deliveryId)
    if (record === undefined) throw new Error(`Unknown Agent delivery ${deliveryId}`)
    if (!this.sameOwner(record.identity, identity)) {
      return clone({ ok: false, reason: 'owner-mismatch', snapshot: this.deliverySnapshot(record) })
    }
    if (!record.valid) return clone({ ok: false, reason: 'stale-generation', snapshot: this.deliverySnapshot(record) })
    if (this.terminalStage(record.stage)) return clone({ ok: false, reason: 'terminal', snapshot: this.deliverySnapshot(record) })
    if (!this.cancellableStage(record.stage)) return clone({ ok: false, reason: 'irreversible', snapshot: this.deliverySnapshot(record) })
    const diagnostic: CordisXPlatformDiagnostic = { code: 'interrupted', message: `Agent delivery cancelled: ${reason}`, retryable: false }
    const event = this.ledger.commit({
      sessionId: record.sessionId,
      ...this.deliveryIdentity(record),
      messageId: record.message.id,
      deliveryId: record.deliveryId,
      type: 'message.delivery',
      provenance: 'cordisx',
      source: this.runtimeSource('agent-runtime'),
      causalParentId: record.stageEventId,
      data: {
        stage: 'cancelled',
        target: record.target,
        wakeup: record.wakeup,
        owner: record.owner,
        cancelReason: reason,
        diagnostic,
      },
    })
    record.stage = 'cancelled'
    record.consoleTrace?.cancel(diagnostic)
    record.stageEventId = event.eventId
    record.diagnostic = diagnostic
    return clone({ ok: true, snapshot: this.deliverySnapshot(record) })
  }

  private deliverySnapshot(record: DeliveryRecord): CordisXAgentDeliverySnapshot {
    return clone({
      contract: CORDISX_AGENT_DELIVERY_CONTRACT,
      schemaVersion: CORDISX_AGENT_DELIVERY_SCHEMA_VERSION,
      deliveryId: record.deliveryId,
      messageId: record.message.id,
      sessionId: record.sessionId,
      target: record.target,
      wakeup: record.wakeup,
      owner: record.owner,
      stage: record.stage,
      terminal: this.terminalStage(record.stage),
      cancellable: record.valid && this.cancellableStage(record.stage),
      valid: record.valid,
      stageEventId: record.stageEventId,
      ...this.deliveryIdentity(record),
      ...(record.diagnostic === undefined ? {} : { diagnostic: record.diagnostic }),
    })
  }

  private assignDeliveryIdentity(record: DeliveryRecord, identity: CordisXAgentDeliveryIdentity | undefined): void {
    if (identity === undefined) return
    for (const key of ['turnId', 'stepId', 'contextId'] as const) {
      const value = identity[key]
      if (value === undefined) continue
      if (!validId(value)) throw new Error(`Agent delivery ${key} is invalid`)
      if (record[key] !== undefined && record[key] !== value) throw new Error(`Agent delivery changed ${key}`)
      record[key] = value
    }
  }

  private deliveryIdentity(record: DeliveryRecord): CordisXAgentDeliveryIdentity {
    return {
      ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
      ...(record.stepId === undefined ? {} : { stepId: record.stepId }),
      ...(record.contextId === undefined ? {} : { contextId: record.contextId }),
    }
  }

  private terminalStage(stage: CordisXMessageDeliveryStage): boolean {
    return ['forwarded', 'failed', 'expired', 'cancelled'].includes(stage)
  }

  private cancellableStage(stage: CordisXMessageDeliveryStage): boolean {
    return ['requested', 'permission', 'queued'].includes(stage)
  }

  private sameOwner(left: CordisXPluginIdentity, right: CordisXPluginIdentity): boolean {
    return left.source === right.source && left.id === right.id
  }

  private beginPromptProjection(input: CordisXPreStepInput, evaluations: ContributionEvaluation[]): CordisXPromptProjection {
    const sections: (CordisXPromptContribution & { readonly source: CordisXAgentPluginSource })[] = []
    const contexts: (CordisXPromptContribution & { readonly source: CordisXAgentPluginSource })[] = []
    for (const prompt of [...this.prompts]
      .filter(item => item.active && item.contribution.sessionId === input.sessionId)
      .sort((left, right) => (left.contribution.order ?? 0) - (right.contribution.order ?? 0))) {
      const kind = prompt.kind === 'section' ? 'system-prompt.section' : 'system-prompt.context'
      const evaluation = this.beginContributionEvaluation(input, prompt.contributionId, kind, prompt.source)
      evaluation.eventId = this.contributionStage(input, evaluation, 'projected')
      evaluations.push(evaluation)
      const projected = freeze({ ...prompt.contribution, source: prompt.source })
      if (prompt.kind === 'section') sections.push(projected)
      else contexts.push(projected)
    }
    return freeze({ sections, contexts })
  }

  private beginContributionEvaluation(
    input: CordisXPreStepInput,
    contributionId: string,
    kind: CordisXInputContributionKind,
    source: CordisXAgentPluginSource,
    messageIds?: readonly string[],
  ): ContributionEvaluation {
    const evaluationId = `cxevaluation:${encodeURIComponent(this.generation)}:${this.nextEvaluation++}`
    const event = this.ledger.commit({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      contributionId,
      type: 'input.contribution',
      provenance: 'cordisx',
      source,
      ...this.causal(this.latestEventId(input.sessionId)),
      data: {
        kind,
        stage: 'evaluated',
        evaluationId,
        ...(messageIds === undefined ? {} : { messageIds }),
      },
    })
    return { contributionId, evaluationId, kind, source, ...(messageIds === undefined ? {} : { messageIds }), eventId: event.eventId }
  }

  private contributionStage(
    input: CordisXPreStepInput,
    evaluation: ContributionEvaluation,
    stage: 'projected' | 'forwarded',
  ): string {
    return this.ledger.commit({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      contributionId: evaluation.contributionId,
      type: 'input.contribution',
      provenance: 'cordisx',
      source: evaluation.source,
      causalParentId: evaluation.eventId,
      data: {
        kind: evaluation.kind,
        stage,
        evaluationId: evaluation.evaluationId,
        ...(evaluation.messageIds === undefined ? {} : { messageIds: evaluation.messageIds }),
      },
    }).eventId
  }

  private failContributions(
    input: CordisXPreStepInput,
    evaluations: readonly ContributionEvaluation[],
    diagnostic: CordisXPlatformDiagnostic,
  ): void {
    for (const evaluation of evaluations) {
      evaluation.eventId = this.ledger.commit({
        sessionId: input.sessionId,
        turnId: input.turnId,
        stepId: input.stepId,
        contributionId: evaluation.contributionId,
        type: 'input.contribution',
        provenance: 'cordisx',
        source: evaluation.source,
        causalParentId: evaluation.eventId,
        data: {
          kind: evaluation.kind,
          stage: 'failed',
          evaluationId: evaluation.evaluationId,
          ...(evaluation.messageIds === undefined ? {} : { messageIds: evaluation.messageIds }),
          diagnostic,
        },
      }).eventId
    }
  }

  private contributionFailure(
    input: CordisXPreStepInput,
    record: PreStepRecord,
    kind: CordisXInputContributionKind,
    diagnostic: CordisXPlatformDiagnostic,
    capability: string,
  ): void {
    this.ledger.commit({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      contributionId: record.contributionId,
      type: 'input.contribution',
      provenance: 'cordisx',
      source: record.source,
      ...this.causal(this.latestEventId(input.sessionId)),
      data: { kind, stage: 'failed', capability, diagnostic },
    })
  }

  private releasePrompt(record: PromptRecord, reason: CordisXInputContributionReleaseReason): void {
    if (record.disposed) return
    record.disposed = true
    record.active = false
    this.prompts.delete(record)
    if (record.registrationEventId === undefined) return
    this.ledger.commit({
      sessionId: record.contribution.sessionId,
      contributionId: record.contributionId,
      type: 'input.contribution',
      provenance: 'cordisx',
      source: record.source,
      causalParentId: record.registrationEventId,
      data: {
        kind: record.kind === 'section' ? 'system-prompt.section' : 'system-prompt.context',
        stage: 'released',
        releaseReason: reason,
      },
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

  private preStepDiagnostic(input: CordisXPreStepInput, source: CordisXAgentPluginSource, code: string, message: string): void {
    this.ledger.commit({
      sessionId: input.sessionId,
      turnId: input.turnId,
      stepId: input.stepId,
      type: 'diagnostic',
      provenance: 'cordisx',
      source,
      ...this.causal(this.latestEventId(input.sessionId)),
      data: { code, message },
    })
  }

  private causal(eventId: string | undefined): { readonly causalParentId: string } | Record<never, never> {
    return eventId === undefined ? {} : { causalParentId: eventId }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Agent runtime generation is disposed')
  }
}

const runtimes = new WeakMap<object, CordisXHostAgentRuntime>()
const consoles = new WeakMap<object, PluginConsoleAspect>()
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

function consoleFor(service: object): PluginConsoleAspect | undefined {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  for (const candidate of [original, service]) {
    if (candidate !== undefined) {
      const console = consoles.get(candidate)
      if (console !== undefined) return console
    }
  }
  return undefined
}

function caller(ctx: Context): CordisXPluginIdentity {
  const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  if (scoped[CORDISX_PLUGIN_ID] === undefined || scoped[CORDISX_PLUGIN_SOURCE] === undefined) {
    throw new Error('Agent capabilities require a plugin context')
  }
  return { id: scoped[CORDISX_PLUGIN_ID], source: scoped[CORDISX_PLUGIN_SOURCE] }
}

export class CordisXAgentService extends Service implements CordisXAgents {
  constructor(ctx: Context, input: CordisXHostAgentRuntime | { readonly runtime: CordisXHostAgentRuntime; readonly console: PluginConsoleAspect }) {
    super(ctx, 'agents')
    const runtime = input instanceof CordisXHostAgentRuntime ? input : input.runtime
    runtimes.set(this, runtime)
    if (!(input instanceof CordisXHostAgentRuntime)) consoles.set(this, input.console)
  }

  get(sessionId: string): CordisXAgent {
    if (!validId(sessionId)) throw new Error('sessionId must be a non-empty opaque id')
    const console = consoleFor(this)
    const token = console?.tokenFromContext(this.ctx)
    const identity = token === undefined ? caller(this.ctx) : console!.owner(token)
    const runtime = runtimeFor(this)
    const send = (
      message: CordisXAgentMessageInput,
      target: CordisXAgentTarget,
      wakeup: boolean,
    ): CordisXAgentDeliveryHandle => {
      const trace = token === undefined || console === undefined
        ? undefined
        : console.beginPending(token, 'agents.messages.append', { target, wakeup, message }, { sessionId })
      const handle = runtime.send(identity, sessionId, message, target, wakeup, trace)
      this.ctx.effect(
        () => () => runtime.releaseOwner(identity, 'owner-disposed'),
        `agents.delivery(${JSON.stringify(handle.deliveryId)})`,
      )
      return handle
    }
    return Object.freeze({
      send,
      followup: (message: CordisXAgentMessageInput) => send(message, 'next-turn', true),
      steer: (message: CordisXAgentMessageInput) => send(message, 'next-step', true),
      inject: (message: CordisXAgentMessageInput) => send(message, 'next-step', false),
      clearPending: () => token === undefined || console === undefined
        ? runtime.clearPending(identity, sessionId)
        : console.runSync(token, 'agents.clearPending', { sessionId }, () => runtime.clearPending(identity, sessionId)),
    })
  }

  preStep(handler: CordisXPreStepHandler): Disposable<void> {
    if (typeof handler !== 'function') throw new Error('preStep handler must be a function')
    const console = consoleFor(this)
    const token = console?.tokenFromContext(this.ctx)
    const identity = token === undefined ? caller(this.ctx) : console!.owner(token)
    const scoped = token === undefined || console === undefined ? handler : console.wrapCallback(token, 'agents.preStep', handler)
    const register = (): Disposable<void> => this.ctx.effect(
      () => runtimeFor(this).registerPreStep(identity, scoped),
      'agents.preStep',
    ) as Disposable<void>
    return token === undefined || console === undefined ? register() : console.runSync(token, 'agents.preStep.register', {}, register)
  }
}

export class CordisXSystemPromptService extends Service implements CordisXSystemPrompt {
  constructor(ctx: Context, input: CordisXHostAgentRuntime | { readonly runtime: CordisXHostAgentRuntime; readonly console: PluginConsoleAspect }) {
    super(ctx, 'systemPrompt')
    const runtime = input instanceof CordisXHostAgentRuntime ? input : input.runtime
    runtimes.set(this, runtime)
    if (!(input instanceof CordisXHostAgentRuntime)) consoles.set(this, input.console)
  }

  section(contribution: CordisXPromptContribution): Disposable<void> {
    return this.register('section', contribution)
  }

  context(contribution: CordisXPromptContribution): Disposable<void> {
    return this.register('context', contribution)
  }

  private register(kind: 'section' | 'context', contribution: CordisXPromptContribution): Disposable<void> {
    const console = consoleFor(this)
    const token = console?.tokenFromContext(this.ctx)
    const identity = token === undefined ? caller(this.ctx) : console!.owner(token)
    const register = (): Disposable<void> => this.ctx.effect(
      () => runtimeFor(this).registerPrompt(identity, kind, contribution),
      `systemPrompt.${kind}(${JSON.stringify(contribution.id)})`,
    ) as Disposable<void>
    return token === undefined || console === undefined ? register() : console.runSync(token, `systemPrompt.${kind}.register`, contribution, register)
  }
}
