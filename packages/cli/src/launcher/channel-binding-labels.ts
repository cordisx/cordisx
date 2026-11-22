import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelChatBinding } from './channel-conversation-store.js'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'

/** Display labels never supply routing or permission identity. */
export async function channelBindingLabels(
  bindings: readonly ChannelChatBinding[],
  access: ChannelConversationAccess | undefined,
  native: ChannelNativeSessions | undefined,
  ids?: readonly string[],
) {
  return Promise.all(
    bindings.filter(binding => ids === undefined || ids.includes(binding.id)).map(async binding => {
      const event: ChannelEventRef = { ...binding.channel, eventId: 'display' }
      const conversationName = await access?.name?.(event).catch(() => undefined)
      return {
        bindingId: binding.id,
        sessionName: await native?.label(binding.sessionId).catch(() => undefined) ?? 'Codex 对话',
        conversationName: conversationName ?? (binding.channel.kind === 'direct' ? '私聊' : '群聊'),
      }
    }),
  )
}
