import { channelDispatchAllowed } from './channel-group-access.js'
import { sameChannelPrincipal } from './channel-source-principal.js'
import { channelMessageContext } from './channel-message-context.js'
import { channelReplyDefaults } from './channel-reply-routing.js'
import { attachCreatedChannelBinding } from './channel-binding-action.js'
import type { ChannelConversationConsumerInput } from './channel-conversation-consumer-contract.js'
import {
  type ChannelConversationInput,
  type ChannelConversationJob,
  type ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'

type Native = NonNullable<ReturnType<ChannelConversationConsumerInput['native']>>

/** Select only the next input from the same sender and exact Channel conversation. */
export function channelSteerParent(state: ChannelConversationState, jobId: string) {
  const job = state.jobs[jobId], sessionId = job?.sessionId
  const record = job && state.inputs[job.recordId]
  const binding = job?.bindingId ? state.bindings[job.bindingId] : undefined
  const event = record?.input.source.event
  if (
    !job || job.state !== 'queued' || !sessionId || !record?.accepted || !record.routed || !event?.actor?.userId
    || !state.policy.enabled || !channelDispatchAllowed(state, event)
    || !binding || binding.state !== 'active' || binding.mode !== 'deliver' || binding.sessionId !== sessionId
    || ChannelConversationStore.logicalSourceFenced(state, sessionId)
    || ['dispatching', 'unknown'].includes(state.continuations[sessionId]?.intent?.state ?? '')
  ) return undefined
  const takeover = state.liveTakeovers[sessionId]
  if (takeover && !['finished', 'abandoned'].includes(takeover.state)) return undefined
  const siblings = Object.values(state.jobs).filter(other => other.sessionId === sessionId && other.id !== jobId)
  if (siblings.some(other => other.state === 'dispatching' || other.state === 'reconciliation-required')) {
    return undefined
  }
  const earlier = siblings.some(other =>
    other.state === 'queued' && state.inputs[other.recordId]
    && (state.inputs[other.recordId]!.sequence < record.sequence
      || state.inputs[other.recordId]!.sequence === record.sequence && other.id < jobId)
  )
  if (earlier) return undefined
  const active = siblings.filter(other => other.state === 'running' && !other.steeredInto && !!other.turnId)
  if (active.length !== 1 || siblings.some(other => other.state === 'replying')) return undefined
  const parent = active[0]!, original = state.inputs[parent.recordId]?.input.source.event
  if (job.steerRejectedTurn === parent.turnId) return undefined
  if (
    !original || !sameChannelPrincipal(original, event)
  ) return undefined
  return parent
}

/** Persist before submitting; crash recovery must never resubmit an uncertain steer. */
export function claimChannelSteer(state: ChannelConversationState, jobId: string): ChannelConversationJob | undefined {
  const parent = channelSteerParent(state, jobId), job = state.jobs[jobId]
  if (!parent?.turnId || !job) return undefined
  job.state = 'dispatching'
  job.turnId = parent.turnId
  job.steeredInto = parent.turnId
  job.steerParent = parent.id
  delete job.steerRejectedTurn
  job.finalDeliveryEnabled = false
  job.replyDefaults ??= channelReplyDefaults(
    state.policy,
    state.inputs[job.recordId]!.input.source.event,
    state.bindings[job.bindingId!],
  )
  return structuredClone(parent)
}

export function channelJobBlocks(state: ChannelConversationState, job: ChannelConversationJob): boolean {
  if (!['dispatching', 'running', 'replying', 'reconciliation-required'].includes(job.state)) return false
  return !(job.steeredInto && job.state === 'reconciliation-required' && job.steerParent
    && ['completed', 'failed', 'cancelled'].includes(state.jobs[job.steerParent]?.state ?? ''))
}

export async function reconcileChannelJob(
  store: ChannelConversationStore,
  native: Native,
  job: ChannelConversationJob,
  record: ChannelConversationInput,
  profileId: string,
): Promise<void> {
  if (job.steeredInto) {
    const reserved = job.sessionId && native.steerObserved && await store.mutate(state => {
      const current = state.jobs[job.id]
      if (
        current?.state !== 'reconciliation-required' || current.steeredInto !== job.steeredInto
        || current.steerReadbackAt !== undefined && Date.now() - current.steerReadbackAt < 30_000
      ) return false
      current.steerReadbackAt = Date.now()
      return true
    })
    if (reserved && await native.steerObserved!(job.id, job.sessionId!, job.steeredInto)) {
      await store.mutate(state => {
        const current = state.jobs[job.id]
        if (
          current?.state === 'reconciliation-required' && current.steeredInto === job.steeredInto
          && current.sessionId === job.sessionId && current.steerParent === job.steerParent
        ) {
          current.state = 'running'
          delete current.code
        }
      })
    }
    return
  }
  if (
    job.code === 'CONTINUATION_EFFECT_UNCERTAIN' || job.code === 'CONTINUATION_BUSINESS_TURN_PENDING'
    || job.sessionId && store.snapshot().continuations[job.sessionId]?.intent?.state === 'unknown'
  ) return
  if (job.turnId && job.sessionId) {
    await store.mutate(state => {
      state.jobs[job.id]!.state = 'running'
    })
  } else if (job.code !== 'NATIVE_OPERATION_UNAVAILABLE_AFTER_RESTART') {
    const recovered = await native.reconcile(job.id)
    await store.mutate(state => {
      const current = state.jobs[job.id]!
      current.state = recovered.state
      if (recovered.sessionId) current.sessionId = recovered.sessionId
      if (recovered.turnId) current.turnId = recovered.turnId
      if (recovered.code) current.code = recovered.code
      if (job.autoCreate && recovered.sessionId) {
        attachCreatedChannelBinding(state, current, record, recovered.sessionId, profileId)
      }
    })
  }
}

export async function steerChannelQueued(
  owner: {
    store: ChannelConversationStore
    access: ChannelConversationConsumerInput['access']
    signal: AbortSignal
    claims: Set<string>
    ready(sessionId: string): boolean
    memoryContext?(
      record: ChannelConversationInput,
      sessionId: string,
      context: ReturnType<typeof channelMessageContext>,
    ): Promise<ReturnType<typeof channelMessageContext>>
  },
  job: ChannelConversationJob,
  record: ChannelConversationInput,
  native: Native,
): Promise<void> {
  const sessionId = job.sessionId
  if (!sessionId || !native.steer || owner.claims.has(sessionId) || !owner.ready(sessionId)) return
  owner.claims.add(sessionId)
  try {
    const message = record.input, event = message.source.event
    const baseContext = await owner.access()?.messageContext?.(message, record.addressing)
      .catch(() => undefined) ?? channelMessageContext(message, record.addressing)
    const parent = await owner.store.mutate(state => claimChannelSteer(state, job.id))
    if (!parent?.turnId) return
    const context = await owner.memoryContext?.(record, sessionId, baseContext) ?? baseContext
    const targetTurn = parent.turnId
    const captured = owner.store.snapshot(), binding = job.bindingId ? captured.bindings[job.bindingId] : undefined
    const defaults = channelReplyDefaults(captured.policy, event, binding)
    const result = await native.steer(job.id, message, sessionId, targetTurn, owner.signal, {
      ...defaults,
      enabled: parent.finalDeliveryEnabled === true && captured.policy.enabled && captured.policy.autoReply
        && binding?.state === 'active' && binding.autoReply,
    }, context)
    await owner.store.mutate(state => {
      const current = state.jobs[job.id]
      if (!current || current.state !== 'dispatching' || current.steeredInto !== targetTurn) return
      if (result.state === 'rejected') {
        current.state = 'queued'
        current.steerRejectedTurn = targetTurn
        delete current.turnId
        delete current.steeredInto
        delete current.steerParent
        delete current.finalDeliveryEnabled
        delete current.code
      } else {
        current.state = result.state === 'accepted' ? 'running' : result.state
        if (result.state === 'failed' || result.state === 'reconciliation-required') current.failureNotice ??= 'pending'
        if (result.code) current.code = result.code
        else delete current.code
      }
    })
  } finally {
    owner.claims.delete(sessionId)
  }
}
