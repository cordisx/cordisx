import type { NativeMarkedRequest, NativeSubmissionController } from './native-submission-controller.js'
import type { NativeAgentTaskRouting } from './native-agent-task-routing.js'
import type { DesktopLogicalTurnAuthority } from './desktop-logical-turn-authority.js'
import { desktopLogicalTurnRpc } from './desktop-logical-turn-rpc.js'

/** The control socket has already authenticated the peer and validated the request id and token. */
export async function nativeMarkedRequestRpc(
  value: Record<string, unknown> & { token: string; requestId: string | number },
  controller: NativeSubmissionController,
  tasks: NativeAgentTaskRouting | undefined,
  turns: DesktopLogicalTurnAuthority | undefined,
) {
  const attached = turns?.attached(value.token) === true
  if (turns?.owns(value.token) && !attached) return await desktopLogicalTurnRpc(turns, value)
  if (value.type === 'consume') {
    if (value.method !== 'thread/start' && value.method !== 'turn/start') throw new Error('Invalid native method')
    const request: NativeMarkedRequest = {
      operationToken: value.token,
      method: value.method,
      requestId: value.requestId,
      ...(typeof value.threadId === 'string' ? { threadId: value.threadId } : {}),
    }
    if (attached) {
      const result = await controller.consumeMarkedRequest(request)
      if (
        result.kind !== 'dispatch' || request.method !== 'turn/start'
        || !request.threadId || !await turns!.begin(value.token, request.threadId, request.requestId)
      ) {
        turns!.cancel(value.token)
        if (result.kind === 'dispatch') {
          await controller.completeMarkedRequest({
            operationToken: value.token,
            requestId: value.requestId,
            succeeded: false,
          })
        }
        return { kind: 'reject' as const, reason: 'request-mismatch' as const }
      }
      return { ...result, logicalAttached: true }
    }
    return await tasks?.consume(request) ?? await controller.consumeMarkedRequest(request)
  }
  if (value.type === 'authorize') {
    const authorized = attached
      ? await controller.authorizeMarkedRequest({ operationToken: value.token, requestId: value.requestId })
      : await tasks?.authorize(value.token, value.requestId)
        ?? await controller.authorizeMarkedRequest({ operationToken: value.token, requestId: value.requestId })
    return authorized && (!attached || await turns!.authorize(value.token, value.requestId))
  }
  if (value.type === 'complete' && typeof value.succeeded === 'boolean') {
    const completion = {
      operationToken: value.token,
      requestId: value.requestId,
      succeeded: value.succeeded,
      ...(typeof value.threadId === 'string' ? { boundThreadId: value.threadId } : {}),
      ...(typeof value.providerId === 'string' ? { providerId: value.providerId } : {}),
      ...(typeof value.model === 'string' ? { model: value.model } : {}),
    }
    if (attached) {
      if (value.succeeded && typeof value.threadId === 'string' && typeof value.turnId === 'string') {
        turns!.confirm(value.token, value.threadId, value.turnId, value.requestId)
      } else turns!.cancel(value.token)
    }
    if (attached || !await tasks?.complete(completion)) await controller.completeMarkedRequest(completion)
    return undefined
  }
  throw new Error('Unknown control command')
}
