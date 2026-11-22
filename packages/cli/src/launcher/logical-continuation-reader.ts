import { createHmac, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  type LogicalHistoryCategory,
  type LogicalHistoryOmission,
  projectLogicalHistory,
} from './logical-continuation-history.js'

export interface LogicalSessionRef {
  readonly hostId: string
  readonly appId: string
  readonly profileId: string
  readonly sessionId: string
}
/** This context is constructed by the owning Host, not parsed from model/tool arguments. */
export interface LogicalHistoryCaller {
  readonly session: LogicalSessionRef
  readonly turnId: string
  readonly actorKey: string
}
export interface LogicalHistoryRelation {
  readonly operationId: string
  readonly logicalConversationId: string
  readonly revision: number
  readonly mode: 'linked'
  readonly source: LogicalSessionRef
  readonly destination: LogicalSessionRef
  readonly historyCategories: readonly LogicalHistoryCategory[]
}
interface Cursor {
  readonly caller: LogicalHistoryCaller
  readonly relation: LogicalHistoryRelation
  readonly expires: number
  readonly native?: string
  readonly local?: string
  readonly digest?: string
  readonly pageSource?: LogicalSessionRef
  readonly categories?: readonly LogicalHistoryCategory[]
}
interface NativePage {
  readonly items: readonly unknown[]
  readonly omitted?: readonly LogicalHistoryOmission[]
  readonly nextCursor?: string
  readonly pagination?: 'native-items' | 'native-turn'
  readonly source?: LogicalSessionRef
  readonly historyCategories?: readonly LogicalHistoryCategory[]
}

/** Host-owned scope resolution and admission; these callbacks never trust model-supplied actor IDs. */
export interface LogicalHistoryAuthority {
  relation(caller: LogicalHistoryCaller): Promise<LogicalHistoryRelation | undefined>
  authorized(
    caller: LogicalHistoryCaller,
    relation: LogicalHistoryRelation,
    source?: LogicalSessionRef,
  ): Promise<boolean>
  page(
    source: LogicalSessionRef,
    cursor?: string,
    caller?: LogicalHistoryCaller,
    relation?: LogicalHistoryRelation,
  ): Promise<NativePage>
}

const valid = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
const validNativeCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\u0000-\u001f\u007f]/u.test(value)
const sessionValid = (value: LogicalSessionRef) =>
  value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => ['hostId', 'appId', 'profileId', 'sessionId'].includes(key))
  && [value.hostId, value.appId, value.profileId, value.sessionId].every(valid)

/** Bound the native response before hashing or projecting it; oversized pages are not silently truncated. */
export function boundedNativeJson(items: readonly unknown[]): string {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: items, depth: 0 }]
  const seen = new Set<object>()
  let bytes = 0, nodes = 0
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (++nodes > 16_384 || depth > 48) throw new Error('HISTORY_PAGE_UNAVAILABLE')
    bytes += 16
    if (typeof value === 'string') bytes += Buffer.byteLength(value, 'utf8')
    else if (value !== null && typeof value === 'object') {
      if (seen.has(value)) throw new Error('HISTORY_PAGE_UNAVAILABLE')
      seen.add(value)
      for (const [key, child] of Object.entries(value)) {
        bytes += Buffer.byteLength(key, 'utf8') + 8
        pending.push({ value: child, depth: depth + 1 })
      }
    } else if (value !== null && typeof value !== 'boolean' && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('HISTORY_PAGE_UNAVAILABLE')
    }
    if (bytes > 2_000_000 || pending.length > 16_384) throw new Error('HISTORY_PAGE_UNAVAILABLE')
  }
  const result = JSON.stringify(items)
  if (Buffer.byteLength(result, 'utf8') > 2_000_000) throw new Error('HISTORY_PAGE_UNAVAILABLE')
  return result
}

/** Opaque, per-active-turn cursors cannot select or manufacture a source relationship. */
export class LogicalContinuationReader {
  private readonly cursors = new Map<string, Cursor>()
  private readonly digestKey = randomBytes(32)
  constructor(private readonly authority: LogicalHistoryAuthority, private readonly now: () => number = Date.now) {}

  async read(caller: LogicalHistoryCaller, input: unknown) {
    if (!caller || !sessionValid(caller.session) || !valid(caller.turnId) || !valid(caller.actorKey)) {
      throw new Error('HISTORY_CALLER_UNAVAILABLE')
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_HISTORY_REQUEST')
    const request = input as Record<string, unknown>
    if (
      request.contract !== 'cordisx.continuation-history-request/v1'
      || Object.keys(request).some(key => !['contract', 'limit', 'cursor'].includes(key))
      || request.limit !== undefined
        && (!Number.isInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 32)
      || request.cursor !== undefined && (typeof request.cursor !== 'string' || !/^[a-f0-9]{48}$/u.test(request.cursor))
    ) throw new Error('INVALID_HISTORY_REQUEST')
    const relation = await this.authority.relation(caller)
    if (
      !relation || relation.mode !== 'linked' || !valid(relation.operationId) || !valid(relation.logicalConversationId)
      || !Number.isSafeInteger(relation.revision) || relation.revision < 1
      || !sessionValid(relation.source) || !sessionValid(relation.destination)
      || !isDeepStrictEqual(relation.destination, caller.session)
      || isDeepStrictEqual(relation.source, relation.destination)
      || relation.source.hostId !== relation.destination.hostId || relation.source.appId !== relation.destination.appId
      || relation.source.profileId !== relation.destination.profileId
      || !await this.authority.authorized(caller, relation)
    ) throw new Error('HISTORY_ACCESS_DENIED')
    const cursor = typeof request.cursor === 'string' ? this.cursors.get(request.cursor) : undefined
    if (
      request.cursor !== undefined && (!cursor || cursor.expires <= this.now()
        || !isDeepStrictEqual(cursor.caller, caller) || !isDeepStrictEqual(cursor.relation, relation))
    ) {
      throw new Error('HISTORY_CURSOR_INVALID')
    }
    const native = await this.authority.page(relation.source, cursor?.native, caller, relation)
    if (
      !native || !Array.isArray(native.items) || native.items.length > 32
      || native.omitted !== undefined
        && (!Array.isArray(native.omitted)
          || native.omitted.some(value =>
            !['attachment', 'raw-reasoning', 'encrypted-reasoning', 'unsupported', 'not-authorized'].includes(value)
          ))
      || native.pagination !== undefined && !['native-items', 'native-turn'].includes(native.pagination)
      || native.nextCursor !== undefined
        && (!validNativeCursor(native.nextCursor) || !native.items.length || native.nextCursor === cursor?.native)
    ) {
      throw new Error('HISTORY_PAGE_UNAVAILABLE')
    }
    const pageSource = native.source ?? relation.source
    const categories = native.historyCategories ?? relation.historyCategories
    if (
      !sessionValid(pageSource) || pageSource.hostId !== relation.source.hostId
      || pageSource.appId !== relation.source.appId || pageSource.profileId !== relation.source.profileId
      || isDeepStrictEqual(pageSource, relation.destination) || !Array.isArray(categories)
      || categories.some(category => !relation.historyCategories.includes(category))
      || !await this.authority.authorized(caller, relation, pageSource)
    ) throw new Error('HISTORY_ACCESS_DENIED')
    if (
      cursor?.pageSource && (!isDeepStrictEqual(cursor.pageSource, pageSource)
        || !isDeepStrictEqual(cursor.categories, categories))
    ) throw new Error('HISTORY_CURSOR_INVALID')
    const digest = createHmac('sha256', this.digestKey).update(boundedNativeJson(native.items)).digest('hex')
    if (cursor?.digest !== undefined && cursor.digest !== digest) throw new Error('HISTORY_CURSOR_INVALID')
    let budget = 4000
    let projected = projectLogicalHistory(native.items, categories, {
      ...(request.limit === undefined ? {} : { limit: Number(request.limit) }),
      ...(cursor?.local === undefined ? {} : { cursor: cursor.local }),
      budget,
    })
    while (Buffer.byteLength(JSON.stringify(projected.entries), 'utf8') > 5000 && budget > 1) {
      budget = Math.max(1, Math.floor(budget / 2))
      projected = projectLogicalHistory(native.items, categories, {
        ...(request.limit === undefined ? {} : { limit: Number(request.limit) }),
        ...(cursor?.local === undefined ? {} : { cursor: cursor.local }),
        budget,
      })
    }
    if (Buffer.byteLength(JSON.stringify(projected.entries), 'utf8') > 5000) throw new Error('HISTORY_PAGE_UNAVAILABLE')
    const latest = await this.authority.relation(caller)
    if (!isDeepStrictEqual(latest, relation) || !await this.authority.authorized(caller, relation, pageSource)) {
      throw new Error('HISTORY_ACCESS_DENIED')
    }
    const hasMore = projected.nextCursor !== undefined || native.nextCursor !== undefined
    let nextCursor: string | undefined
    if (hasMore) {
      nextCursor = randomBytes(24).toString('hex')
      const next: Cursor = projected.nextCursor !== undefined
        ? {
          caller: structuredClone(caller),
          relation: structuredClone(relation),
          expires: this.now() + 600_000,
          ...(cursor?.native === undefined ? {} : { native: cursor.native }),
          local: projected.nextCursor,
          digest,
          pageSource: structuredClone(pageSource),
          categories: structuredClone(categories),
        }
        : {
          caller: structuredClone(caller),
          relation: structuredClone(relation),
          expires: this.now() + 600_000,
          native: native.nextCursor!,
        }
      this.cursors.set(nextCursor, next)
      if (this.cursors.size > 128) this.cursors.delete(this.cursors.keys().next().value!)
    }
    return {
      contract: 'cordisx.continuation-history-page/v1' as const,
      source: structuredClone(pageSource),
      entries: projected.entries,
      omitted: [...new Set([...projected.omitted, ...(native.omitted ?? [])])],
      pagination: native.pagination ?? 'native-items' as const,
      truncated: hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  }
}
