import { nativeExecutionStart } from '../chat-execution-settings.js'
import { continuationStartMatches } from './channel-continuation-config.js'
import type { LogicalContinuationEvidence, LogicalContinuationRequest } from './logical-continuation-control.js'
import { LOGICAL_CONTINUATION_HISTORY_TOOL } from './logical-continuation-tool.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Creates only a thread, never a business turn. Callers must durably reserve before invoking. */
export async function createLogicalNativeDestination(
  native: { nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown> },
  request: LogicalContinuationRequest,
  evidence: LogicalContinuationEvidence,
  permitFork?: (threadId: string, params: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>,
  sourceProjectId?: string | null,
  allowCrossProviderFork = false,
) {
  if (
    request.mode === 'fresh' || evidence.sourceConfiguration.execution.workMode !== 'default'
    || request.mode === 'fork' && (!permitFork || !allowCrossProviderFork
          && (request.target.providerId !== evidence.sourceConfiguration.providerId
            || request.target.model !== evidence.sourceConfiguration.model))
  ) {
    return { state: 'rejected' as const, code: 'NATIVE_MODE_UNAVAILABLE' }
  }
  const config = evidence.sourceConfiguration
  const settings = nativeExecutionStart(config.execution)
  if (config.permissions) delete settings.sandbox
  const params = {
    ...settings,
    cwd: config.cwd,
    modelProvider: request.target.providerId,
    model: request.target.model,
    ...(config.serviceTier === null && request.mode !== 'fork' ? {} : { serviceTier: config.serviceTier }),
    approvalsReviewer: config.approvalsReviewer,
    ...(config.permissions ? { permissions: config.permissions } : {}),
    ...(request.mode === 'linked' ? { dynamicTools: [LOGICAL_CONTINUATION_HISTORY_TOOL] } : {}),
    ...(request.mode === 'linked' && sourceProjectId ? { projectId: sourceProjectId } : {}),
    // The full history is verified separately. Returning it in the fork receipt
    // can exceed the RPC line limit after the native destination was created.
    ...(request.mode === 'fork' ? { threadId: request.source.sessionId, excludeTurns: true } : {}),
  }
  const response = object(
    await native.nativeRequest(
      request.mode === 'fork' ? 'thread/fork' : 'thread/start',
      request.mode === 'fork' ? permitFork!(request.source.sessionId, params) : params,
    ),
  )
  const thread = object(response.thread), id = thread.id
  if (typeof id !== 'string' || !id) throw new Error('NATIVE_CREATION_UNCONFIRMED')
  return {
    state: 'created' as const,
    destination: { ...request.source, sessionId: id },
    confirmed: id !== request.source.sessionId && continuationStartMatches(response, { ...config, ...request.target })
      && (request.mode !== 'fork' || thread.forkedFromId === request.source.sessionId
          && thread.ephemeral !== true && object(thread.status).type === 'idle'),
  }
}
