import {
  type ChannelConversationInput,
  type ChannelConversationJob,
  type ChannelConversationState,
  ChannelConversationStore,
} from './channel-conversation-store.js'
import { bindingIdentity, eventThread, sameConversation } from './channel-conversation-refs.js'

export function channelBindingAction(
  store: ChannelConversationStore,
  action: 'archive' | 'restore' | 'unbind',
  id: string,
  isMigrating: (sessionId: string) => boolean,
) {
  return store.mutate(state => {
    const binding = state.bindings[id]
    if (!binding) return false
    if (isMigrating(binding.sessionId) || ChannelConversationStore.logicalSourceFenced(state, binding.sessionId)) {
      throw new Error('CONTINUATION_PENDING')
    }
    if (action === 'unbind') delete state.bindings[id]
    else binding.state = action === 'archive' ? 'archived' : 'active'
    for (const job of Object.values(state.jobs)) {
      if (job.bindingId === id && job.state === 'queued' && action !== 'restore') job.state = 'cancelled'
    }
    return true
  })
}

/** Do not resurrect a removed binding when a native creation is reconciled. */
export function attachCreatedChannelBinding(
  state: ChannelConversationState,
  job: ChannelConversationJob,
  record: ChannelConversationInput,
  sessionId: string,
  profileId: string,
): void {
  if (job.bindingId !== undefined) return
  const channel = eventThread(record.input.source.event)
  const id =
    Object.values(state.bindings).find(binding =>
      binding.sessionId === sessionId && sameConversation(binding.channel, channel)
    )?.id ?? bindingIdentity(profileId, channel, sessionId)
  job.bindingId = id
  state.bindings[id] ??= {
    id,
    channel,
    sessionId,
    hostId: 'local',
    profileId,
    createdAt: new Date().toISOString(),
    fromSequence: record.sequence,
    mode: 'deliver',
    // Profile policy still controls whether automatic replies are allowed.
    autoReply: true,
    state: 'active',
  }
}
