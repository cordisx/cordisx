import { BridgeOperationError } from './agent-bridge-contract.js'
/* ------------------------------------------------------------------------ */
/* Transcript paging                                                         */
/* ------------------------------------------------------------------------ */

export interface TranscriptEntry {
  readonly role: string
  readonly text: string
}

/** The safety net under `limit`: no page carries more text than this. */
export const MAX_TRANSCRIPT_CHARS = 60_000
/** The most message entries one page returns, whatever `limit` asks for. */
export const MAX_TRANSCRIPT_ENTRIES = 200

export interface TranscriptPage {
  /** Oldest first, as the transcript reads. */
  readonly entries: readonly TranscriptEntry[]
  /** Message entries the whole transcript holds. */
  readonly total: number
  /** True when this page is not the whole remaining transcript: older text exists or a message was clipped. */
  readonly truncated: boolean
  /** Pass back as `cursor` to read the next older page. Present whenever text was left out. */
  readonly nextCursor?: string
  /** Characters dropped from the newest message of this page by the character cap. */
  readonly clippedCharacters: number
}

const CURSOR_PREFIX = 'v1'

/** `nextCursor` as `read_session` hands it out: where the next older page starts. */
export function encodeTranscriptCursor(index: number, offset: number): string {
  return `${CURSOR_PREFIX}:${index}:${offset}`
}

/**
 * A cursor names the entry the next older page starts at and how many of its
 * leading characters are still unread: a page that ended mid-message resumes
 * with that message's head instead of dropping it.
 */
export function decodeTranscriptCursor(
  value: unknown,
): { readonly index: number; readonly offset: number } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new BridgeOperationError('cursor-invalid')
  const parts = value.split(':')
  if (parts.length !== 3 || !/^\d+$/u.test(parts[1] ?? '') || !/^\d+$/u.test(parts[2] ?? '')) {
    throw new BridgeOperationError('cursor-invalid')
  }
  const [prefix, index, offset] = parts
  const parsedIndex = Number(index)
  const parsedOffset = Number(offset)
  if (
    prefix !== CURSOR_PREFIX || !Number.isInteger(parsedIndex) || !Number.isInteger(parsedOffset)
    || parsedIndex < 0 || parsedOffset < 0
  ) throw new BridgeOperationError('cursor-invalid')
  return { index: parsedIndex, offset: parsedOffset }
}

/**
 * The newest page of a transcript: `limit` message entries at most, the newest
 * ones first, bounded by a character budget. Whatever is left out — an older
 * entry, or the head of an entry the budget clipped — comes back as a cursor,
 * and `truncated` says so, so nothing is dropped silently.
 */
export function pageTranscript(
  entries: readonly TranscriptEntry[],
  options: { readonly limit?: number; readonly cursor?: unknown; readonly budget?: number } = {},
): TranscriptPage {
  const total = entries.length
  const cursor = decodeTranscriptCursor(options.cursor)
  const limit = options.limit === undefined
    ? MAX_TRANSCRIPT_ENTRIES
    : Math.min(Math.max(options.limit, 1), MAX_TRANSCRIPT_ENTRIES)
  let index = cursor === undefined ? total - 1 : cursor.index
  let offset = cursor?.offset ?? 0
  if (cursor !== undefined && (index >= total || offset > (entries[index]?.text.length ?? 0))) {
    throw new BridgeOperationError('cursor-invalid')
  }
  let budget = Math.max(1, options.budget ?? MAX_TRANSCRIPT_CHARS)
  const kept: TranscriptEntry[] = []
  let clippedCharacters = 0
  while (index >= 0 && kept.length < limit && budget > 0) {
    const entry = entries[index]!
    const text = offset > 0 ? entry.text.slice(0, offset) : entry.text
    if (text.length > budget) {
      kept.push({ role: entry.role, text: `…${text.slice(-budget)}` })
      offset = text.length - budget
      clippedCharacters = offset
      break
    }
    kept.push({ role: entry.role, text })
    budget -= text.length
    index -= 1
    offset = 0
  }
  const truncated = index >= 0
  return {
    entries: kept.reverse(),
    total,
    truncated,
    ...(truncated ? { nextCursor: encodeTranscriptCursor(index, offset) } : {}),
    clippedCharacters,
  }
}
