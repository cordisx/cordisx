import { isDeepStrictEqual } from 'node:util'
import type { ChannelEventRef, ChannelPluginIdentity, ChannelThreadRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type {
  ChannelConversationJob,
  ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'
import { channelDispatchAllowed } from './channel-group-access.js'
import { channelPolicyAllows } from './channel-conversation-policy.js'
import { identity, sameConversation, thread } from './channel-conversation-refs.js'
import { outboundCallerScope } from './channel-outbound-rpc.js'
import { sameChannelPrincipal } from './channel-source-principal.js'

type Intent = NonNullable<ChannelConversationJob['terminalDelivery']>
const callerFor = (generation: string): ChannelPluginIdentity => ({
  source: 'cordisx:native-channel',
  pluginId: 'host-channel-tools',
  generation,
})

/** V3 fences older Hosts while a terminal delivery or a steered final remains unresolved. */
export function channelTerminalSchema(state: ChannelConversationState): void {
  state.schemaVersion =
    Object.values(state.jobs).some(job => job.terminalDelivery || job.code === 'CHANNEL_STEER_FINAL_UNRESOLVED')
      ? 3
      : state.logicalContinuations
      ? 2
      : 1
}

function allowedTarget(source: ChannelEventRef, target: ChannelThreadRef): boolean {
  if (!sameConversation(source, target) || source.kind !== target.kind) return false
  if (target.semantics === 'conversation') return target.threadId === source.conversationId
  if (target.semantics === 'reply-chain') return !!source.messageId && target.threadId === source.messageId
  return target.semantics === 'topic' && (target.threadId === source.threadId || target.threadId === source.messageId)
}

export function channelTerminalOwner(
  state: ChannelConversationState,
  inputId: string,
): ChannelConversationJob | undefined {
  const job = state.jobs[inputId]
  if (!job) return undefined
  if (!job.steeredInto) return job
  const parent = job.steerParent && state.jobs[job.steerParent]
  const ownEvent = state.inputs[job.recordId]?.input.source.event
  const parentEvent = parent && state.inputs[parent.recordId]?.input.source.event
  if (
    !parent || parent.steeredInto || !ownEvent || !parentEvent || parent.sessionId !== job.sessionId
    || parent.bindingId !== job.bindingId || parent.turnId !== job.turnId || job.steeredInto !== job.turnId
    || !sameChannelPrincipal(parentEvent, ownEvent)
  ) return undefined
  return parent
}

/** A final readback is stale if a follow-up was claimed or settled during the read. */
export function channelTurnSteerFence(state: ChannelConversationState, owner: ChannelConversationJob) {
  const children = Object.values(state.jobs)
    .filter(job => job.steerParent === owner.id && job.steeredInto === owner.turnId)
    .sort((a, b) => a.id.localeCompare(b.id))
  return {
    dispatching: children.some(job => job.state === 'dispatching'),
    uncertain: children.some(job => job.state === 'reconciliation-required'),
    signature: JSON.stringify(children.map(job => [job.id, job.state])),
  }
}

export function validateChannelTerminalDeliveries(state: ChannelConversationState): void {
  const owners = Object.values(state.jobs).filter(job => job.terminalDelivery)
  const unresolved = Object.values(state.jobs).filter(job => job.code === 'CHANNEL_STEER_FINAL_UNRESOLVED')
  if ((owners.length > 0 || unresolved.length > 0) !== (state.schemaVersion === 3)) {
    throw new Error('INVALID_TERMINAL_DELIVERY_STORE')
  }
  if (unresolved.some(job => job.state !== 'reconciliation-required' || !job.sessionId || !job.turnId)) {
    throw new Error('INVALID_TERMINAL_DELIVERY_STORE')
  }
  for (const owner of owners) {
    const intent = owner.terminalDelivery!, input = state.jobs[intent.inputOperationId]
    const record = input && state.inputs[input.recordId]
    const event = record?.input.source.event
    const keys = [
      'inputOperationId',
      'sendOperationId',
      'deliveryId',
      'callerGeneration',
      'fingerprint',
      'target',
      'outcome',
    ]
    if (
      !intent || typeof intent !== 'object' || Object.keys(intent).some(key => !keys.includes(key))
      || !input || channelTerminalOwner(state, input.id)?.id !== owner.id || !record?.accepted || !record.routed
      || !event || !event.actor || event.actor.adapterId !== event.adapterId
      || event.actor.accountId !== event.accountId
      || event.actor.tenantId !== event.tenantId || !owner.sessionId || !owner.turnId
      || !['running', 'reconciliation-required'].includes(owner.state) || owner.replyTarget !== undefined
      || input.sessionId !== owner.sessionId || input.turnId !== owner.turnId
      || typeof intent.inputOperationId !== 'string' || typeof intent.sendOperationId !== 'string'
      || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(intent.inputOperationId)
      || !intent.sendOperationId.trim() || intent.sendOperationId.length > 128
      || /[\0\r\n]/u.test(intent.sendOperationId)
      || !/^delivery:[a-f0-9]{64}$/u.test(intent.deliveryId)
      || !/^[a-f0-9]{64}$/u.test(intent.fingerprint) || !/^[a-f0-9]{64}$/u.test(intent.callerGeneration)
      || !isDeepStrictEqual(thread(intent.target), intent.target) || !allowedTarget(event, intent.target)
      || intent.callerGeneration
        !== outboundCallerScope({ session: owner.sessionId, turnId: owner.turnId, source: event })
      || intent.deliveryId !== terminalDeliveryId(intent.callerGeneration, event, intent.sendOperationId)
      || intent.outcome !== undefined && (
          !intent.outcome || !['completed', 'failed'].includes(intent.outcome.state)
          || Object.keys(intent.outcome).some(key => !['state', 'code'].includes(key))
          || intent.outcome.code !== undefined && (intent.outcome.state !== 'failed'
              || typeof intent.outcome.code !== 'string' || !/^[A-Z0-9_]{1,128}$/u.test(intent.outcome.code))
        )
    ) throw new Error('INVALID_TERMINAL_DELIVERY_STORE')
  }
}

export function terminalDeliveryId(generation: string, event: ChannelEventRef, operationId: string): string {
  const account = { adapterId: event.adapterId, accountId: event.accountId, tenantId: event.tenantId }
  return 'delivery:' + identity([callerFor(generation), account, operationId])
}

/** Reserve before enqueueing. A repeated request may inspect its receipt but must not enqueue again. */
export async function reserveChannelTerminalDelivery(
  store: ChannelConversationStore,
  args: {
    inputOperationId: string
    sendOperationId: string
    sessionId: string
    turnId: string
    source: ChannelEventRef
    target: ChannelThreadRef
    generation: string
    fingerprint: string
    deliveryId: string
  },
): Promise<{ created: boolean; deliveryId: string }> {
  return store.mutate(state => {
    const job = state.jobs[args.inputOperationId], owner = channelTerminalOwner(state, args.inputOperationId)
    const record = job && state.inputs[job.recordId], binding = job?.bindingId && state.bindings[job.bindingId]
    const event = record?.input.source.event
    const takeover = state.liveTakeovers[args.sessionId]
    if (
      !job || !owner || !record?.accepted || !record.routed || !event || job.state !== 'running'
      || job.sessionId !== args.sessionId || job.turnId !== args.turnId || owner.sessionId !== args.sessionId
      || owner.turnId !== args.turnId || event.eventId !== args.source.eventId
      || event.messageId !== args.source.messageId || !sameChannelPrincipal(event, args.source)
      || !event.actor || event.actor.adapterId !== event.adapterId || event.actor.accountId !== event.accountId
      || event.actor.tenantId !== event.tenantId
      || !binding || binding.state !== 'active' || binding.mode !== 'deliver' || binding.sessionId !== args.sessionId
      || takeover && !['finished', 'abandoned'].includes(takeover.state)
      || Object.values(state.logicalContinuations?.intents ?? {}).some(intent =>
        intent.request.source.sessionId === args.sessionId && ['creating', 'unknown'].includes(intent.state)
      )
      || !state.policy.enabled || !channelDispatchAllowed(state, event)
      || !channelPolicyAllows(state.policy, 'send', event)
      || !channelPolicyAllows(state.policy, 'send', { ...args.target, eventId: event.eventId, actor: event.actor })
      || !allowedTarget(event, args.target)
      || args.generation !== outboundCallerScope({ session: args.sessionId, turnId: args.turnId, source: event })
    ) throw new Error('TERMINAL_CONTEXT_UNAVAILABLE')
    const deliveryId = terminalDeliveryId(args.generation, event, args.sendOperationId)
    if (deliveryId !== args.deliveryId) throw new Error('TERMINAL_CONTEXT_UNAVAILABLE')
    const intent: Intent = {
      inputOperationId: job.id,
      sendOperationId: args.sendOperationId,
      deliveryId,
      callerGeneration: args.generation,
      fingerprint: args.fingerprint,
      target: args.target,
    }
    if (owner.terminalDelivery) {
      const { outcome: _outcome, ...existing } = owner.terminalDelivery
      if (!isDeepStrictEqual(existing, intent)) throw new Error('TERMINAL_DELIVERY_CONFLICT')
      return { created: false, deliveryId }
    }
    const steerFence = channelTurnSteerFence(state, owner)
    if (steerFence.dispatching || steerFence.uncertain) throw new Error('TERMINAL_STEER_IN_FLIGHT')
    if (
      Object.values(state.jobs).some(other =>
        other.steerParent === owner.id && other.steeredInto === owner.turnId && other.state === 'running'
        && (state.inputs[other.recordId]?.sequence ?? -1) > record.sequence
      )
    ) throw new Error('TERMINAL_INPUT_SUPERSEDED')
    if (owner.state !== 'running' || owner.replyTarget !== undefined) throw new Error('REPLY_ALREADY_RESERVED')
    owner.terminalDelivery = intent
    channelTerminalSchema(state)
    return { created: true, deliveryId }
  })
}

/** Record the exact native outcome and resolve only a positive receipt; all other states stay fenced. */
export async function reconcileChannelTerminalDelivery(
  store: ChannelConversationStore,
  access: ChannelConversationAccess | undefined,
  ownerId: string,
  outcome?: { state: 'completed' | 'failed'; code?: string },
): Promise<boolean> {
  const intent = store.snapshot().jobs[ownerId]?.terminalDelivery
  if (!intent) return false
  const receipt = access?.runtime.deliverySnapshot(intent.deliveryId, callerFor(intent.callerGeneration))
  return store.mutate(state => {
    const job = state.jobs[ownerId], current = job?.terminalDelivery
    if (!job || !current || current.deliveryId !== intent.deliveryId) return false
    if (outcome && !current.outcome) {
      current.outcome = outcome.state === 'failed' && outcome.code && /^[A-Z0-9_]{1,128}$/u.test(outcome.code)
        ? { state: 'failed', code: outcome.code }
        : { state: outcome.state }
    }
    if (!current.outcome) return true
    if (receipt?.state === 'sent' && receipt.externalMessageId && isDeepStrictEqual(receipt.target, current.target)) {
      job.state = current.outcome.state
      if (current.outcome.state === 'failed') {
        job.code = current.outcome.code ?? 'NATIVE_TURN_FAILED'
        job.failureNotice ??= 'pending'
      } else delete job.code
      delete job.terminalDelivery
      channelTerminalSchema(state)
    } else {
      job.state = 'reconciliation-required'
      job.code = 'CHANNEL_TERMINAL_DELIVERY_UNRESOLVED'
    }
    return true
  })
}
