import type { ChannelConversationState, ChannelTaskRequest } from './channel-conversation-store.js'

/** The immutable approval stays attached to its source even after the binding moves. */
export function taskProviderOperation(requestId: string, revision: number): string {
  return 'task-provider:' + requestId + ':' + revision
}

export function taskProviderDestination(
  state: ChannelConversationState,
  request: ChannelTaskRequest,
): string | undefined {
  const relation = state.logicalContinuations?.relations[
    taskProviderOperation(request.id, request.expectedRevision + 1)
  ]
  return relation?.source.sessionId === request.threadId ? relation.destination.sessionId : undefined
}

export function taskProviderRequest(
  state: ChannelConversationState,
  threadId: string,
  revision: number,
): ChannelTaskRequest | undefined {
  return Object.values(state.taskRequests).find(request =>
    ['queued', 'submitted'].includes(request.state) && request.expectedRevision + 1 === revision
    && (request.threadId === threadId || taskProviderDestination(state, request) === threadId)
  )
}
