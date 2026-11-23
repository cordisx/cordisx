import { channelPersonaTask } from './channel-memory-personas.js'
import type { ChannelConversationConsumerInput } from './channel-conversation-consumer-contract.js'
import type { ChannelConversationInput } from './channel-conversation-store.js'
import type { ChannelMessageContext } from './channel-message-context.js'
import type { createChannelUserMemoryContext } from './channel-user-memory-context.js'

export function channelUserMemoryDispatch(
  context: ReturnType<typeof createChannelUserMemoryContext>,
  native: NonNullable<ReturnType<ChannelConversationConsumerInput['native']>>,
  jobId: string,
) {
  return (record: ChannelConversationInput, sessionId: string | undefined, base: ChannelMessageContext) =>
    context(
      record,
      channelPersonaTask(jobId, sessionId),
      base,
      jobId,
      native.analyzeUserMemory?.bind(native),
      async () => await (sessionId ? native.taskSelection?.(sessionId) : native.creationSelection?.()) ?? {},
    )
}
