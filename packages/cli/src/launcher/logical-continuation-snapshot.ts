import { createHash } from 'node:crypto'
import { logicalNativeHistoryPage } from './logical-continuation-native-page.js'
import { boundedNativeJson, type LogicalSessionRef } from './logical-continuation-reader.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

interface NativeSnapshotSource {
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
}

/**
 * Compare two bounded complete scans while the owner holds its source-operation fence.
 * This detects changes observed by the native reader; it is not a native cross-process lock.
 */
async function snapshot(
  native: NativeSnapshotSource,
  source: LogicalSessionRef,
  bindSource: boolean,
  observe?: (items: readonly unknown[]) => void,
) {
  const scan = async () => {
    const hash = createHash('sha256')
    if (bindSource) hash.update(JSON.stringify(source))
    const cursors = new Set<string>()
    let cursor: string | undefined, bytes = 0
    for (let count = 0; count < 256; count++) {
      const page = await logicalNativeHistoryPage(native, source, cursor)
      observe?.(page.items)
      const data = boundedNativeJson(page.items)
      bytes += Buffer.byteLength(data, 'utf8')
      if (bytes > 32_000_000) throw new Error('SOURCE_SNAPSHOT_LIMIT')
      hash.update(String(Buffer.byteLength(data, 'utf8'))).update(':').update(data)
      if (!page.nextCursor) return hash.digest('hex')
      if (cursors.has(page.nextCursor)) throw new Error('SOURCE_SNAPSHOT_CURSOR_CYCLE')
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    throw new Error('SOURCE_SNAPSHOT_LIMIT')
  }
  const first = await scan(), second = await scan()
  if (first !== second) throw new Error('SOURCE_SNAPSHOT_CHANGED')
  return `sha256:${first}`
}
export function logicalSourceSnapshotVersion(
  native: NativeSnapshotSource,
  source: LogicalSessionRef,
  observe?: (items: readonly unknown[]) => void,
) {
  return snapshot(native, source, true, observe)
}
/** Used only for comparing all bounded source and fork items; no session identity is included. */
export function logicalHistoryContentVersion(native: NativeSnapshotSource, source: LogicalSessionRef) {
  return snapshot(native, source, false)
}
