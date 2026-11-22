import { createHash } from 'node:crypto'
import { boundedNativeJson, type LogicalSessionRef } from './logical-continuation-reader.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

interface NativeReader {
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
}
interface TurnCursor {
  readonly source: LogicalSessionRef
  readonly turnId: string
  readonly digest: string
  readonly native?: string
  readonly end: number
  readonly advance?: true
}
const prefix = 'logical-turn-v1:'
const itemPrefix = 'logical-items-v1:'
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const encode = (value: TurnCursor) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url')

/** Return raw, bounded native items so projection can report unsupported and omitted categories. */
export async function logicalNativeHistoryPage(native: NativeReader, source: LogicalSessionRef, cursor?: string) {
  if (!cursor?.startsWith(prefix)) {
    let nativeCursor: string | undefined
    if (cursor !== undefined) {
      try {
        if (!cursor.startsWith(itemPrefix)) throw new Error()
        const saved = object(JSON.parse(Buffer.from(cursor.slice(itemPrefix.length), 'base64url').toString('utf8')))
        if (
          !saved || JSON.stringify(saved.source) !== JSON.stringify(source)
          || typeof saved.native !== 'string' || !saved.native
        ) throw new Error()
        nativeCursor = saved.native
      } catch {
        throw new Error('HISTORY_CURSOR_INVALID')
      }
    }
    try {
      const page = object(
        await native.nativeRequest('thread/items/list', {
          threadId: source.sessionId,
          limit: 32,
          sortDirection: 'desc',
          ...(nativeCursor ? { cursor: nativeCursor } : {}),
        }),
      )
      if (!page || !Array.isArray(page.data) || page.data.length > 32) throw new Error('HISTORY_PAGE_UNAVAILABLE')
      const items = page.data.map(entry => object(entry)?.item)
      const turnIds = page.data.map(entry => {
        const id = object(entry)?.turnId
        return typeof id === 'string' ? id : undefined
      })
      if (items.some(item => !object(item))) throw new Error('HISTORY_PAGE_UNAVAILABLE')
      const next = page.nextCursor
      if (next != null && (typeof next !== 'string' || !next || next === nativeCursor || !items.length)) {
        throw new Error('HISTORY_PAGE_UNAVAILABLE')
      }
      boundedNativeJson(items)
      return {
        items: items.reverse(),
        turnIds: turnIds.reverse(),
        pagination: 'native-items' as const,
        ...(typeof next === 'string'
          ? { nextCursor: itemPrefix + Buffer.from(JSON.stringify({ source, native: next })).toString('base64url') }
          : {}),
      }
    } catch (error) {
      if (cursor !== undefined || object(error)?.rpcCode !== -32601) throw error
    }
  }
  let saved: TurnCursor | undefined
  if (cursor !== undefined) {
    try {
      const raw = object(JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8')))
      if (
        !raw || JSON.stringify(raw.source) !== JSON.stringify(source) || typeof raw.turnId !== 'string'
        || typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.digest)
        || !Number.isSafeInteger(raw.end) || Number(raw.end) < 0
        || raw.native !== undefined && (typeof raw.native !== 'string' || !raw.native)
        || raw.advance !== undefined && raw.advance !== true
      ) throw new Error()
      saved = raw as unknown as TurnCursor
    } catch {
      throw new Error('HISTORY_CURSOR_INVALID')
    }
  }
  const read = async (nativeCursor?: string): Promise<{
    items: unknown[]
    id?: string
    digest?: string
    next?: string
  }> => {
    const page = object(
      await native.nativeRequest('thread/turns/list', {
        threadId: source.sessionId,
        limit: 1,
        itemsView: 'full',
        sortDirection: 'desc',
        ...(nativeCursor ? { cursor: nativeCursor } : {}),
      }),
    )
    if (!page || !Array.isArray(page.data) || page.data.length > 1) throw new Error('HISTORY_PAGE_UNAVAILABLE')
    const next = page.nextCursor
    if (next != null && (typeof next !== 'string' || !next || next === nativeCursor || !page.data.length)) {
      throw new Error('HISTORY_PAGE_UNAVAILABLE')
    }
    if (!page.data.length) return { items: [] as unknown[] }
    const turn = object(page.data[0])
    if (!turn || typeof turn.id !== 'string' || !turn.id || !Array.isArray(turn.items)) {
      throw new Error('HISTORY_PAGE_UNAVAILABLE')
    }
    return {
      id: turn.id,
      items: turn.items,
      digest: createHash('sha256').update(boundedNativeJson(turn.items)).digest('hex'),
      ...(typeof next === 'string' ? { next } : {}),
    }
  }
  let nativeCursor = saved?.native
  let turn = await read(nativeCursor)
  if (saved && (turn.id !== saved.turnId || turn.digest !== saved.digest || saved.end > turn.items.length)) {
    throw new Error('HISTORY_CURSOR_INVALID')
  }
  if (saved?.advance) {
    if (!turn.next || saved.end !== 0) throw new Error('HISTORY_CURSOR_INVALID')
    nativeCursor = turn.next
    turn = await read(nativeCursor)
  }
  // Empty turns still consume the native page; do not silently hide a following page.
  if (!turn.items.length && turn.next) throw new Error('HISTORY_PAGE_UNAVAILABLE')
  const end = saved && !saved.advance ? saved.end : turn.items.length
  const start = Math.max(0, end - 32)
  const items = turn.items.slice(start, end)
  const nextCursor = turn.id && turn.digest && (start > 0 || turn.next)
    ? encode({
      source,
      turnId: turn.id,
      digest: turn.digest,
      end: start,
      ...(nativeCursor ? { native: nativeCursor } : {}),
      ...(start === 0 ? { advance: true as const } : {}),
    })
    : undefined
  return {
    items,
    turnIds: items.map(() => turn.id),
    pagination: 'native-turn' as const,
    ...(nextCursor ? { nextCursor } : {}),
  }
}
