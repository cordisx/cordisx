import type { ChannelRuntime, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelRemoteHistoryRequest } from './channel-remote-history.js'
import type { ChannelMessageReadResult } from './channel-message-read.js'
import type { ChannelDirectoryReadback } from './channel-live-directory.js'
import type { ChannelCommandUserReadback } from './channel-command-users.js'
import type { ChannelReplyCapabilities } from './channel-reply-routing.js'
import type { ChannelOutboundRpc } from './channel-outbound-rpc.js'

export interface ChannelConversationAccess {
  readonly threadForward?: ReturnType<
    typeof import('./channel-thread-forward-service.js').createChannelThreadForwardService
  >
  readonly forward?: ReturnType<typeof import('./channel-forward-service.js').createChannelForwardService>
  messageOperations?(operation: string, input: Record<string, unknown>, context: {
    source?: import('@cordisx/channel-runtime').ChannelEventRef | undefined
    callerScope: string
    authorize: (event: import('@cordisx/channel-runtime').ChannelEventRef, write: boolean) => void
  }): Promise<unknown>
  readonly outbound?: ChannelOutboundRpc
  feedbackReact?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    emoji: string,
  ): Promise<import('./channel-feedback.js').ChannelReactionReceipt>
  feedbackRemove?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    reactionId: string,
  ): Promise<import('./channel-feedback.js').ChannelReactionReceipt>
  feedbackWait?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    target: import('@cordisx/channel-runtime').ChannelThreadRef,
    text: string,
    recordId: string,
  ): Promise<void>
  readonly generation: string
  readonly runtime: ChannelRuntime
  accounts(): readonly { ref: ChannelTenantRef; name?: string; state: string }[]
  conversations(ref: ChannelTenantRef): Promise<ChannelDirectoryReadback>
  remoteHistory?(ref: ChannelTenantRef, request: ChannelRemoteHistoryRequest): Promise<unknown>
  messageSearch?(
    ref: ChannelTenantRef,
    request: import('./channel-message-search.js').ChannelMessageSearchRequest,
    authorize: () => void,
  ): Promise<unknown>
  threadHistory?(
    ref: ChannelTenantRef,
    request: import('./channel-thread-history.js').ChannelThreadHistoryRequest,
    authorize: () => void,
  ): Promise<unknown>
  readMessage?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
    messageId: string,
  ): Promise<ChannelMessageReadResult>
  /** Display-only cache-first directory. Never use for permissions or command target resolution. */
  displayConversations?(ref: ChannelTenantRef): Promise<ChannelDirectoryReadback>
  conversationDisplay?(
    ref: import('@cordisx/channel-runtime').ChannelConversationRef,
  ): import('./channel-conversation-directory.js').ChannelConversationIdentity
  /** Launcher-only identity/capability lookups; no new plugin or Agent authority. */
  users?(event: import('@cordisx/channel-runtime').ChannelEventRef): Promise<ChannelCommandUserReadback>
  senderName?(event: import('@cordisx/channel-runtime').ChannelEventRef): string | undefined
  messageContext?(
    message: import('@cordisx/channel-runtime').ChannelUserInput,
    addressing?: import('./channel-command-users.js').ChannelCommandAddressing,
  ): Promise<import('./channel-message-context.js').ChannelMessageContext>
  replyCapabilities?(event: import('@cordisx/channel-runtime').ChannelEventRef): ChannelReplyCapabilities
  name?(event: import('@cordisx/channel-runtime').ChannelEventRef): Promise<string | undefined>
  conversationIdentity?(
    event: import('@cordisx/channel-runtime').ChannelEventRef,
  ): Promise<import('./channel-conversation-directory.js').ChannelConversationIdentity>
  sendCard?(event: import('@cordisx/channel-runtime').ChannelEventRef, card: object): Promise<string>
  updateCard?(event: import('@cordisx/channel-runtime').ChannelEventRef, messageId: string, card: object): Promise<void>
  drain(ref: ChannelTenantRef): Promise<void>
}
