import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-access.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import { outboundCallerScope } from './channel-outbound-rpc.js'
import { channelForwardRpc } from './channel-forward-rpc.js'
import { channelThreadForwardRpc } from './channel-thread-forward-rpc.js'
import { messageOperationCallerScope } from './channel-message-operations-rpc.js'
import { authorizeChannelForward, type ChannelForwardPolicyOperation } from './channel-forward-permissions.js'

export async function authorizedChannelForwardOperation(operation: string, value: Record<string, unknown>, context: {
  current?: ChannelConversationAccess | undefined
  consumer?: ChannelConversationConsumer | undefined
  source?: ChannelEventRef | undefined
  nativeCaller?: string | undefined
  callerSession?: string | undefined
  turnId?: string | undefined
  active(): boolean
}) {
  const { current, consumer, source, nativeCaller } = context
  if (nativeCaller && consumer?.taskSettings.isBound(nativeCaller) && !source) {
    throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  }
  if (!current) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  const request = {
    operation,
    value,
    access: current,
    ...(source ? { source } : {}),
    scope: operation.startsWith('thread-forward')
      ? messageOperationCallerScope(context.callerSession, source)
      : outboundCallerScope({ session: context.callerSession, turnId: context.turnId, source }),
    active: context.active,
    authorize: (event: ChannelEventRef, action: ChannelForwardPolicyOperation) => {
      if (!context.active()) throw new Error('FORWARD_GENERATION_REVOKED')
      if (source && consumer) {
        authorizeChannelForward(consumer.profileLogicalOwner().store.snapshot().policy, event, action)
      }
    },
  }
  return operation.startsWith('thread-forward')
    ? await channelThreadForwardRpc(request)
    : await channelForwardRpc({ ...request, ...(source ? { source } : {}) })
}
