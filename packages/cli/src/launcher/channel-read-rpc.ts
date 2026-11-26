import type { ChannelTenantRef } from '@cordisx/channel-runtime'
import { channelMessageSearchRpc } from './channel-message-search-rpc.js'
import { channelThreadHistoryRpc } from './channel-thread-history-rpc.js'
import { channelHistoricalResourcesRpc } from './channel-historical-resources-rpc.js'

export function channelReadRpc(
  operation: string,
  input: Record<string, unknown>,
  ref: ChannelTenantRef,
  context: Parameters<typeof channelMessageSearchRpc>[2] & { caller: string },
) {
  if (operation === 'message-search') return channelMessageSearchRpc(input, ref, context)
  if (operation === 'thread-history') return channelThreadHistoryRpc(input, ref, context)
  if (operation === 'resource-refetch' || operation === 'resource-status' || operation === 'resource-read') {
    return channelHistoricalResourcesRpc(input, ref, context, operation)
  }
  throw new Error('INVALID_REQUEST')
}
