import type { ChannelEventRef } from '@cordisx/channel-runtime'

/** Only use events authenticated by the owning Channel transport. */
export function channelLogicalActor(event: ChannelEventRef) {
  return {
    principal: event.actor?.userId ?? '',
    scope: JSON.stringify([
      event.adapterId,
      event.accountId,
      event.tenantId,
      event.conversationId,
      event.threadId,
      event.kind,
      event.semantics,
    ]),
  }
}
