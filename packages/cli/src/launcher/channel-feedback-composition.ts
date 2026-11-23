import path from 'node:path'
import { ChannelFeedback } from './channel-feedback.js'
import { ChannelProgressReminders } from './channel-progress-reminders.js'
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
  const options = {
    store,
    access: input.access,
    signal,
    settings: () => readChannelFeedbackSettings(directory, path.resolve(directory, '../../../..')),
    turnState: async (session: string, turn: string) =>
      input.native()?.liveTurnControl?.().turnState(session, turn) ?? 'unknown',
    ...(input.report ? { report: input.report } : {}),
  }
  const progress = new ChannelProgressReminders({
    ...options,
    remind: (notice, current) => input.native()?.progressReminder?.(notice, current) ?? Promise.resolve('rejected'),
  })
  return new ChannelFeedback({ ...options, progress })
}
