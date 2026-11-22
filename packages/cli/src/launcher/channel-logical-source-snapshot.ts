import { logicalSourceSnapshotVersion } from './logical-continuation-snapshot.js'
import { channelHistoryContextTokens } from './channel-logical-history-projection.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

/** Native provenance must be explicit; missing fields are not proof of a root. */
export async function channelLogicalJointSourceRoot(
  native: { nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown> },
  source: LogicalSessionRef,
) {
  try {
    const result = await native.nativeRequest('thread/read', { threadId: source.sessionId, includeTurns: false })
    const thread = (result as { thread?: Record<string, unknown> })?.thread
    return thread?.id === source.sessionId && thread.forkedFromId === null
      && thread.parentThreadId === null && thread.attachedToThreadId === null
  } catch {
    return false
  }
}

/** Read and redact a stable source while its owner holds the migration fence. */
export async function channelLogicalSourceSnapshot(
  native: Parameters<typeof logicalSourceSnapshotVersion>[0],
  source: LogicalSessionRef,
  idle: (threadId: string) => Promise<boolean>,
) {
  if (!await idle(source.sessionId)) return undefined
  const tokens = new Set<string>()
  const version = await logicalSourceSnapshotVersion(
    native,
    source,
    items => channelHistoryContextTokens(items, tokens),
  )
  if (!await idle(source.sessionId)) return undefined
  return { version, tokens: [...tokens] }
}
