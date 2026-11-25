import type { ChannelConversationStore } from './channel-conversation-store.js'
import { channelExact, channelRecord, channelText } from './channel-conversation-policy.js'
import { type ChannelReplyMode, channelReplyMode, channelReplyTarget } from './channel-reply-routing.js'
import { channelTerminalOwner } from './channel-terminal-delivery.js'

/** Select a route without sending; a steered input has the original turn's final-delivery owner. */
export async function selectChannelReplyMode(
  store: ChannelConversationStore,
  signal: AbortSignal,
  value: unknown,
  sessionId: string,
  turnId?: string,
) {
  const args = channelRecord(value)
  channelExact(args, ['operationId', 'mode'])
  const operationId = channelText(args.operationId, 128)
  const mode = channelReplyMode(args.mode) as ChannelReplyMode
  // Wait for the reserved dispatch if a native tool arrives before start() returns; never retry it.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = store.snapshot().jobs[operationId]
    if (!job || job.state !== 'dispatching' || signal.aborted) break
    if (job.sessionId !== undefined && job.sessionId !== sessionId) throw new Error('REPLY_OPERATION_NOT_FOUND')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  if (signal.aborted) throw new Error('CHANNEL_UNAVAILABLE')
  return store.mutate(state => {
    const job = state.jobs[operationId]
    if (!job || job.sessionId !== sessionId || turnId !== undefined && job.turnId !== turnId) {
      throw new Error('REPLY_OPERATION_NOT_FOUND')
    }
    if (job.state !== 'running' || job.replyTarget !== undefined) throw new Error('REPLY_ALREADY_RESERVED')
    if (job.terminalDelivery) throw new Error('TERMINAL_DELIVERY_PENDING')
    const record = state.inputs[job.recordId]
    if (!record) throw new Error('REPLY_OPERATION_NOT_FOUND')
    if (job.steeredInto) {
      const parent = channelTerminalOwner(state, job.id)
      if (!parent) throw new Error('REPLY_OPERATION_NOT_FOUND')
      if (parent.state !== 'running' || parent.replyTarget !== undefined) throw new Error('REPLY_ALREADY_RESERVED')
      if (parent.terminalDelivery) throw new Error('TERMINAL_DELIVERY_PENDING')
      // Other routes are anchored to an incoming message, so only the owner can choose them.
      if (mode !== 'none') throw new Error('REPLY_MODE_CHANGE_REQUIRES_OWNER')
      parent.replyMode = 'none'
    }
    if (mode !== 'none') channelReplyTarget(record.input.source.event, mode)
    job.replyMode = mode
    return { operationId, mode, sendsMessage: false }
  })
}
