import type { ChannelChatBinding, ChannelConversationState } from './channel-conversation-store.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { parseChannelConversationPolicy } from './channel-conversation-policy.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'

export async function channelPolicySet(store: ChannelConversationStore, value: unknown, expectedRevision: number) {
  const policy = parseChannelConversationPolicy(value)
  await store.mutate(state => {
    if (state.policyRevision !== expectedRevision) throw new Error('REVISION_CONFLICT')
    state.policy = policy
    state.policyRevision += 1
  })
  const state = store.snapshot()
  return { revision: state.policyRevision, policy: state.policy }
}
export function channelPolicyReadback(state: ChannelConversationState) {
  return { revision: state.policyRevision, policy: state.policy }
}

export function channelManagementReadback(state: ChannelConversationState) {
  return {
    revision: state.revision,
    bindings: Object.values(state.bindings),
    senders: Object.values(state.inputs).flatMap(record =>
      record.addressing?.senderName ? [{ event: record.input.source.event, name: record.addressing.senderName }] : []
    ),
    deliveries: Object.values(state.jobs).flatMap(job =>
      job.deliveryId && job.sessionId && state.inputs[job.recordId]
        ? [{
          deliveryId: job.deliveryId,
          sessionId: job.sessionId,
          event: state.inputs[job.recordId]!.input.source.event,
        }]
        : []
    ),
  }
}
export async function channelBindingNavigation(
  bindings: () => readonly ChannelChatBinding[],
  native: ChannelNativeSessions | undefined,
  signal: AbortSignal,
  id: string,
) {
  const binding = bindings().find(item => item.id === id)
  if (!binding || !native || signal.aborted || !await native.exists(binding.sessionId)) return undefined
  if (signal.aborted || bindings().find(item => item.id === id)?.sessionId !== binding.sessionId) return undefined
  return binding.sessionId
}
