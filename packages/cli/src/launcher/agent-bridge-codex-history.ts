import { createHash } from 'node:crypto'
import { BridgeOperationError } from './agent-bridge-contract.js'
import {
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_ENTRIES,
  pageTranscript,
  type TranscriptEntry,
} from './agent-bridge-transcript.js'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

interface NativeHistoryReader {
  nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const ITEM_PAGE_SIZE = 32
const MAX_HISTORY_PAGES = 8
const CURSOR_PREFIX = 'codex-items-v1:'

function itemEntry(value: unknown): TranscriptEntry | undefined {
  const entry = object(value)
  if (entry === undefined) return undefined
  if (entry.type === 'userMessage') {
    const parts = Array.isArray(entry.content) ? entry.content : []
    const said = parts.map(part => object(part)?.text).filter((part): part is string => typeof part === 'string')
    return said.length > 0 ? { role: 'user', text: said.join('\n') } : undefined
  }
  if (entry.type === 'agentMessage' && typeof entry.text === 'string') return { role: 'assistant', text: entry.text }
  if (entry.type === 'plan' && typeof entry.text === 'string') return { role: 'plan', text: entry.text }
  if (entry.type === 'commandExecution' && typeof entry.command === 'string') {
    return {
      role: 'command',
      text: entry.command + (typeof entry.aggregatedOutput === 'string' ? '\n' + entry.aggregatedOutput : ''),
    }
  }
  if (['mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(String(entry.type))) {
    return { role: 'tool', text: JSON.stringify(entry) }
  }
  return undefined
}

/** Compatibility projection for callers that already have an in-memory thread. */
export function threadEntries(value: unknown): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const turn of Array.isArray(object(value)?.turns) ? object(value)!.turns as unknown[] : []) {
    for (const item of Array.isArray(object(turn)?.items) ? object(turn)!.items as unknown[] : []) {
      const entry = itemEntry(item)
      if (entry !== undefined) entries.push(entry)
    }
  }
  return entries
}

export const threadTranscript = (value: unknown, limit?: number): readonly TranscriptEntry[] =>
  pageTranscript(threadEntries(value), limit === undefined ? {} : { limit }).entries

export const transcriptLimit = (value: unknown): number | undefined =>
  Number.isInteger(value) ? Math.min(Math.max(value as number, 1), MAX_TRANSCRIPT_ENTRIES) : undefined

export async function codexThreadMetadata(codex: NativeHistoryReader, threadId: string) {
  return object(object(await codex.nativeRequest('thread/read', { threadId, includeTurns: false }))?.thread)
}

async function items(codex: NativeHistoryReader, threadId: string, limit: number, cursor?: string) {
  const result = object(
    await codex.nativeRequest('thread/items/list', {
      threadId,
      limit,
      sortDirection: 'desc',
      ...(cursor === undefined ? {} : { cursor }),
    }),
  )
  if (!Array.isArray(result?.data)) throw new Error('Native history pagination unavailable')
  const entries = result.data.map(value => itemEntry(object(value)?.item))
    .filter((entry): entry is TranscriptEntry => entry !== undefined).reverse()
  return {
    entries,
    nextCursor: typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined,
  }
}

interface ItemCursor {
  readonly threadId: string
  readonly pageSize: number
  readonly native?: string
  readonly local?: string
  readonly digest?: string
}

function cursorValue(value: unknown, threadId: string): ItemCursor | undefined {
  if (value === undefined || value === null) return undefined
  try {
    if (typeof value !== 'string' || value.length > 16_384 || !value.startsWith(CURSOR_PREFIX)) throw new Error()
    const parsed = object(JSON.parse(Buffer.from(value.slice(CURSOR_PREFIX.length), 'base64url').toString('utf8')))
    if (
      parsed?.threadId !== threadId || !Number.isInteger(parsed.pageSize)
      || (parsed.pageSize as number) < 1 || (parsed.pageSize as number) > ITEM_PAGE_SIZE
      || (parsed.native !== undefined && (typeof parsed.native !== 'string' || parsed.native.length === 0))
      || (parsed.local !== undefined && typeof parsed.local !== 'string')
      || (parsed.digest !== undefined && (typeof parsed.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(parsed.digest)))
      || (parsed.local === undefined) !== (parsed.digest === undefined)
    ) throw new Error()
    return parsed as unknown as ItemCursor
  } catch {
    throw new BridgeOperationError('cursor-invalid')
  }
}

const encode = (cursor: ItemCursor): string => CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor)).toString('base64url')
const entriesDigest = (entries: readonly TranscriptEntry[]): string => {
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(JSON.stringify(entry))
  return hash.digest('hex')
}

/** Page native items before projecting text; a display limit never hydrates full history. */
export async function codexTranscriptPage(
  codex: NativeHistoryReader,
  threadId: string,
  options: { readonly limit?: number; readonly cursor?: unknown } = {},
) {
  const cursor = cursorValue(options.cursor, threadId)
  const pageSize = cursor?.pageSize ?? Math.min(options.limit ?? MAX_TRANSCRIPT_ENTRIES, ITEM_PAGE_SIZE)
  const read = await items(codex, threadId, pageSize, cursor?.native)
  if (cursor?.digest !== undefined && entriesDigest(read.entries) !== cursor.digest) {
    throw new BridgeOperationError('cursor-invalid')
  }
  const page = pageTranscript(read.entries, {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(cursor?.local === undefined ? {} : { cursor: cursor.local }),
  })
  const nextCursor = page.nextCursor !== undefined
    ? encode({
      threadId,
      pageSize,
      ...(cursor?.native === undefined ? {} : { native: cursor.native }),
      local: page.nextCursor,
      digest: entriesDigest(read.entries),
    })
    : read.nextCursor === undefined
    ? undefined
    : encode({ threadId, pageSize, native: read.nextCursor })
  return {
    entries: page.entries,
    // Unvisited native pages cannot supply an exact whole-transcript count.
    total: cursor === undefined && read.nextCursor === undefined ? read.entries.length : null,
    truncated: nextCursor !== undefined,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    clippedCharacters: page.clippedCharacters,
  }
}

/** A bounded recent-history scan for discovery and mechanical caller summaries. */
export async function codexRecentEntries(
  codex: NativeHistoryReader,
  threadId: string,
  options: { readonly deadline?: number; readonly maxCharacters?: number } = {},
) {
  const entries: TranscriptEntry[] = []
  let cursor: string | undefined
  for (let index = 0; index < MAX_HISTORY_PAGES; index++) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { entries, capped: true, reason: 'time-limit' as const }
    }
    const read = await items(codex, threadId, ITEM_PAGE_SIZE, cursor)
    entries.unshift(...read.entries)
    if (
      options.maxCharacters !== undefined
      && entries.reduce((total, entry) => total + entry.text.length, 0) > options.maxCharacters
    ) return { entries, capped: true, reason: 'size-limit' as const }
    if (read.nextCursor === undefined) return { entries, capped: false }
    if (read.nextCursor === cursor) throw new Error('Native history cursor did not advance')
    cursor = read.nextCursor
  }
  return { entries, capped: true, reason: 'history-page-limit' as const }
}

export const summaryHistoryCharacters = MAX_TRANSCRIPT_CHARS

/** Read turn metadata without loading any items; only a matching turn can finish an operation. */
export async function codexTurn(codex: NativeHistoryReader, threadId: string, turnId: string) {
  let cursor: string | undefined
  const deadline = Date.now() + 45_000
  for (let index = 0; index < MAX_HISTORY_PAGES && Date.now() < deadline; index++) {
    const result = object(
      await codex.nativeRequest('thread/turns/list', {
        threadId,
        limit: ITEM_PAGE_SIZE,
        itemsView: 'notLoaded',
        sortDirection: 'desc',
        ...(cursor === undefined ? {} : { cursor }),
      }),
    )
    if (!Array.isArray(result?.data)) throw new Error('Native turn pagination unavailable')
    const turn = result.data.map(object).find(turn => turn?.id === turnId)
    if (turn !== undefined) return turn
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length === 0) return undefined
    if (result.nextCursor === cursor) throw new Error('Native history cursor did not advance')
    cursor = result.nextCursor
  }
  return undefined
}
