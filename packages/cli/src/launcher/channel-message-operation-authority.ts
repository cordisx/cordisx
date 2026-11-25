import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import { messageOperationCallerScope } from './channel-message-operations-rpc.js'

export async function authorizedChannelMessageOperation(operation: string, input: Record<string, unknown>, context: {
  readonly current: ChannelConversationAccess
  readonly consumer?: ChannelConversationConsumer | undefined
  readonly source?: ChannelEventRef | undefined
  readonly nativeCaller?: string | undefined
  readonly callerSession?: string | undefined
  readonly active: () => boolean
}): Promise<unknown> {
  const { current, consumer, source, nativeCaller } = context
  if (nativeCaller && consumer?.taskSettings.isBound(nativeCaller) && !source) {
    throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  }
  if (!current.messageOperations) return { status: 'unavailable', code: 'CHANNEL_OPERATION_UNAVAILABLE' }
  return current.messageOperations(operation, input, {
    source,
    callerScope: messageOperationCallerScope(context.callerSession, source),
    authorize: (event, write) => {
      if (
        !current.accounts().some(item =>
          item.ref.adapterId === event.adapterId
          && item.ref.accountId === event.accountId && item.ref.tenantId === event.tenantId && item.state === 'ready'
        )
      ) {
        throw new Error('CONNECTION_NOT_READY')
      }
      if (source && consumer && !consumer.commandAllowed(source, write ? 'send' : 'history')) {
        throw new Error('CHANNEL_POLICY_DENIED')
      }
      if (write && consumer && !consumer.sendAllowed(event)) throw new Error('CHANNEL_POLICY_DENIED')
      if (!context.active()) throw new Error('CHANNEL_GENERATION_CHANGED')
    },
  })
}
