import { logicalSourceSnapshotVersion } from './logical-continuation-snapshot.js'
import { channelHistoryContextTokens } from './channel-logical-history-projection.js'
import type { LogicalSessionRef } from './logical-continuation-reader.js'

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
