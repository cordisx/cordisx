import type { ChannelContinuationManager } from './channel-continuation-manager.js'
import type { ChannelCreationDefaults } from './channel-creation-defaults.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { chatExecutionOperation } from './chat-execution-operation.js'

export function channelExecutionDispatch(
  continuation: ChannelContinuationManager,
  defaults: ChannelCreationDefaults,
  native: ChannelNativeSessions | undefined,
  operation: string,
  args: Record<string, unknown>,
) {
  if (operation.startsWith('continuation-defaults') || operation.startsWith('continuation-live-policy')) {
    return continuation.defaultsOperation(operation, args)
  }
  if (operation.startsWith('channel-execution-defaults')) return defaults.operation(operation, args)
  return chatExecutionOperation(native, operation, args)
}
