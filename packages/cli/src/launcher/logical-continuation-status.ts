import type { ChannelConversationStore } from './channel-conversation-store.js'

/** Local recovery exposes state and destination identity, never history or credentials. */
export function logicalContinuationStatus(
  store: ChannelConversationStore,
  appId: string,
  profileId: string,
  value: unknown,
  isProtected?: (sessionId: string) => boolean,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  const args = value as Record<string, unknown>
  if (
    Object.keys(args).some(key => !['sessionId', 'operationId'].includes(key)) || typeof args.sessionId !== 'string'
    || !args.sessionId || args.sessionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(args.sessionId)
    || args.operationId !== undefined && (typeof args.operationId !== 'string' || !args.operationId
        || args.operationId.length > 512 || /[\u0000-\u001f\u007f]/u.test(args.operationId))
  ) {
    throw new Error('INVALID_REQUEST')
  }
  const intents = Object.values(store.snapshot().logicalContinuations?.intents ?? {})
    .filter(intent =>
      intent.request.source.hostId === 'local' && intent.request.source.appId === appId
      && intent.request.source.profileId === profileId && intent.request.source.sessionId === args.sessionId
      && (args.operationId === undefined || intent.request.operationId === args.operationId)
    )
    .reverse().sort((left, right) =>
      Number(['creating', 'unknown'].includes(right.state))
      - Number(['creating', 'unknown'].includes(left.state))
    )
    .map(intent => ({
      operationId: intent.request.operationId,
      mode: intent.request.mode,
      state: intent.state,
      ...(intent.destination ? { destination: intent.destination.sessionId } : {}),
      ...(intent.orphanDestination ? { orphanDestination: intent.orphanDestination.sessionId } : {}),
      ...(isProtected?.(intent.request.source.sessionId)
          || intent.destination && isProtected?.(intent.destination.sessionId)
        ? { protectionPending: true as const }
        : {}),
      ...(intent.code ? { code: intent.code } : {}),
    }))
  return { status: 'ok', operations: intents.slice(0, 64), ...(intents.length > 64 ? { truncated: true } : {}) }
}
