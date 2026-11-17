import { createHash } from 'node:crypto'
import { BridgeOperationError } from './agent-bridge-contract.js'
import { threadEntries } from './agent-bridge-codex-history.js'
import { pageTranscript, type TranscriptEntry } from './agent-bridge-transcript.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

interface NativeReader {
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
}
interface Cursor {
  readonly threadId: string
  readonly turnId: string
  readonly digest: string
  readonly native?: string
  readonly local?: string
  readonly advance?: true
}
const prefix = 'codex-turn-v1:'
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const digest = (entries: readonly TranscriptEntry[]) =>
  createHash('sha256').update(JSON.stringify(entries)).digest('hex')
const encode = (value: Cursor) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url')

export const isTurnHistoryCursor = (value: unknown) => typeof value === 'string' && value.startsWith(prefix)

function decode(value: unknown, threadId: string): Cursor | undefined {
  if (value === undefined) return undefined
  try {
    if (!isTurnHistoryCursor(value) || (value as string).length > 16_384) throw new Error()
    const row = object(JSON.parse(Buffer.from((value as string).slice(prefix.length), 'base64url').toString('utf8')))
    if (
      row.threadId !== threadId || typeof row.turnId !== 'string' || !row.turnId
      || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(row.digest)
      || row.native !== undefined && (typeof row.native !== 'string' || !row.native)
      || row.local !== undefined && typeof row.local !== 'string'
      || row.advance !== undefined && row.advance !== true
      || row.advance === true && row.local !== undefined
    ) throw new Error()
    return row as unknown as Cursor
  } catch {
    throw new BridgeOperationError('cursor-invalid')
  }
}

/** Native limits the number of turns, not the size or item count of a single turn. */
export async function continuationTurnHistoryPage(
  native: NativeReader,
  threadId: string,
  options: { readonly limit?: number; readonly cursor?: unknown },
) {
  const cursor = decode(options.cursor, threadId)
  const read = async (nativeCursor?: string) => {
    let value: unknown
    try {
      value = await native.nativeRequest('thread/turns/list', {
        threadId,
        limit: 1,
        itemsView: 'full',
        sortDirection: 'desc',
        ...(nativeCursor === undefined ? {} : { cursor: nativeCursor }),
      })
    } catch (error) {
      if (error instanceof Error && error.message === 'RPC line exceeds maximum size') {
        throw new Error('CONTINUATION_HISTORY_PAGE_TOO_LARGE')
      }
      throw error
    }
    const response = object(value)
    if (!Array.isArray(response.data) || response.data.length > 1) throw new Error('CONTINUATION_HISTORY_UNAVAILABLE')
    if (
      typeof response.nextCursor === 'string' && response.nextCursor
      && (!response.data.length || response.nextCursor === nativeCursor)
    ) {
      throw new Error('CONTINUATION_HISTORY_UNAVAILABLE')
    }
    const turn = object(response.data[0])
    if (response.data.length && (typeof turn.id !== 'string' || !Array.isArray(turn.items))) {
      throw new Error('CONTINUATION_HISTORY_UNAVAILABLE')
    }
    return {
      id: typeof turn.id === 'string' ? turn.id : undefined,
      entries: threadEntries({ turns: response.data }),
      next: typeof response.nextCursor === 'string' && response.nextCursor ? response.nextCursor : undefined,
    }
  }
  let nativeCursor = cursor?.native
  let turn = await read(nativeCursor)
  if (cursor && (turn.id !== cursor.turnId || digest(turn.entries) !== cursor.digest)) {
    throw new BridgeOperationError('cursor-invalid')
  }
  if (cursor?.advance) {
    if (!turn.next) throw new BridgeOperationError('cursor-invalid')
    nativeCursor = turn.next
    turn = await read(nativeCursor)
  }
  const page = pageTranscript(turn.entries, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(cursor?.local === undefined ? {} : { cursor: cursor.local }),
  })
  const base = turn.id === undefined ? undefined : {
    threadId,
    turnId: turn.id,
    digest: digest(turn.entries),
    ...(nativeCursor === undefined ? {} : { native: nativeCursor }),
  }
  const nextCursor = base && (page.nextCursor !== undefined
    ? encode({ ...base, local: page.nextCursor })
    : turn.next !== undefined
    ? encode({ ...base, advance: true })
    : undefined)
  return {
    entries: page.entries,
    total: cursor === undefined && nextCursor === undefined ? turn.entries.length : null,
    truncated: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    clippedCharacters: page.clippedCharacters,
    pagination: 'native-turn',
  }
}
