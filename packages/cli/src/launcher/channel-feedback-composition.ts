import path from 'node:path'
import { ChannelFeedback } from './channel-feedback.js'
import { readChannelFeedbackSettings } from './channel-feedback-settings.js'
import type { ChannelConversationStore } from './channel-conversation-store.js'
import type { ChannelConversationConsumerInput } from './channel-conversation-consumer-contract.js'

/** Reuse the current profile's native and transport owners without creating another connection. */
export function createChannelFeedback(
  store: ChannelConversationStore,
  input: ChannelConversationConsumerInput & { file: string },
  signal: AbortSignal,
) {
  const directory = path.dirname(input.file)
  return new ChannelFeedback({
    store,
    access: input.access,
    signal,
    settings: () => readChannelFeedbackSettings(directory, path.resolve(directory, '../../../..')),
    turnState: async (session, turn) => input.native()?.liveTurnControl?.().turnState(session, turn) ?? 'unknown',
    ...(input.report ? { report: input.report } : {}),
  })
}
