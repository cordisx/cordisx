import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import type { ChannelCommandAddressing } from './channel-command-users.js'

export interface ChannelMessageContext {
  readonly platform: string
  readonly conversation: { readonly id: string; readonly kind: ChannelEventRef['kind']; readonly name?: string }
  readonly sender: { readonly userId?: string; readonly name?: string }
  readonly mentions: readonly { readonly key: string; readonly userId: string; readonly name?: string }[]
}
export function channelParticipantName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120)
  return name && !/^(?:oc_|ou_)[A-Za-z0-9_]+$/u.test(name) ? name : undefined
}
/** Names are display data. The account-scoped actor ID remains the sole user identity for authorization. */
export function channelMessageContext(
  message: ChannelUserInput,
  addressing?: ChannelCommandAddressing,
  names?: { readonly sender?: string; readonly conversation?: string },
): ChannelMessageContext {
  const event = message.source.event
  const name = channelParticipantName(names?.sender ?? addressing?.senderName)
  const conversation = channelParticipantName(names?.conversation)
  return {
    platform: event.adapterId === 'feishu' ? '飞书' : event.adapterId === 'lark' ? 'Lark' : event.adapterId,
    conversation: { id: event.conversationId, kind: event.kind, ...(conversation ? { name: conversation } : {}) },
    sender: { ...(event.actor ? { userId: event.actor.userId } : {}), ...(name ? { name } : {}) },
    mentions: (addressing?.mentions ?? []).map(mention => {
      const name = channelParticipantName(mention.name)
      return { key: mention.key, userId: mention.userId, ...(name ? { name } : {}) }
    }),
  }
}
