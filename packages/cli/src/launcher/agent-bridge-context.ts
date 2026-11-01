/**
 * What both sides of the agent bridge share besides tool names.
 *
 * - Finding a conversation by what was said in it. `list_sessions` searches
 *   messages, not only titles (a title is often empty until the app names it),
 *   and answers with a short excerpt and the role that said it. The scan is
 *   bounded so a list call stays a list call, and the result says when it
 *   stopped early.
 * - Carrying the calling conversation into a handed-over task.
 *   `start_session` with `context: "summary"` appends a bounded, clearly marked
 *   summary, so the agent only has to state the goal.
 */

/** One message of a conversation, as `threadTranscript` and `claudeTranscript` return it. */
export interface TranscriptEntry {
  readonly role: string
  readonly text: string
}

/** The excerpt `list_sessions` answers with, before its two ellipses. */
export const EXCERPT_CHARS = 200
/** Conversations one search may read. A Codex thread is a round trip; a Claude transcript is a file. */
export const SEARCH_MAX_THREADS = 8
// Stop starting reads after 45s; one in-flight native read can take another 30s.
export const SEARCH_MAX_ELAPSED_MS = 45_000
export const SEARCH_MAX_FILES = 40
/** The most recent Codex threads a content search considers. */
export const SEARCH_RECENT_THREADS = 20
/** Transcript characters one search may examine across every candidate. */
export const SEARCH_MAX_CHARACTERS = 4 * 1024 * 1024
/** The end of a Claude transcript a search reads; a long session is judged by its latest messages. */
export const SEARCH_FILE_BYTES = 1024 * 1024
/** The summary `start_session` appends, whether the host built it or a caller handed it over. */
export const SUMMARY_MAX_CHARS = 4_000

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim()
const clip = (text: string, max: number): string => {
  const value = flat(text)
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export interface ContentScan {
  /** Conversations whose messages were read; title matches are not counted. */
  scanned: number
  /** Transcript characters examined so far. */
  characters: number
  /** Whether the scan stopped while candidates were left unread. */
  capped: boolean
  reason?: 'candidate-limit' | 'size-limit' | 'read-unavailable' | 'time-limit'
}

export const beginScan = (): ContentScan => ({ scanned: 0, characters: 0, capped: false })

/**
 * Records one candidate's transcript against the scan; false when the size
 * budget cannot cover it, which ends the scan.
 */
export function readCandidate(scan: ContentScan, characters: number): boolean {
  if (scan.characters + characters > SEARCH_MAX_CHARACTERS) {
    scan.capped = true
    scan.reason = 'size-limit'
    return false
  }
  scan.characters += characters
  scan.scanned += 1
  return true
}

/** Marks a scan that stopped with candidates it was allowed to read left over. */
export function capScan(scan: ContentScan): void {
  scan.capped = true
  scan.reason ??= 'candidate-limit'
}

/** The `scan` field `list_sessions` answers with, identical on both sides. */
export function scanReport(
  scan: ContentScan,
): { capped: boolean; scanned: number; characters: number; reason?: string } {
  return {
    capped: scan.capped,
    scanned: scan.scanned,
    characters: scan.characters,
    ...(scan.reason === undefined ? {} : { reason: scan.reason }),
  }
}

/** The one place a term matched, as a short excerpt the agent can judge. */
export interface SessionMatch {
  readonly role: string
  readonly excerpt: string
}

/** A window of `EXCERPT_CHARS` around the first occurrence of `term`, else undefined. */
export function excerptAround(text: string, term: string): string | undefined {
  const value = flat(text)
  const index = value.toLowerCase().indexOf(term.toLowerCase())
  if (term.length === 0 || index < 0) return undefined
  // Room for the term itself, split evenly on either side.
  const room = Math.max(EXCERPT_CHARS - term.length, 40)
  const before = Math.min(index, Math.floor(room / 2))
  const start = index - before
  const end = Math.min(value.length, start + Math.max(room, term.length))
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`
}

/** The newest message that contains the term, so the most recent discussion wins. */
export function searchEntries(entries: readonly TranscriptEntry[], term: string): SessionMatch | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || !entry.text.toLowerCase().includes(term.toLowerCase())) continue
    const excerpt = excerptAround(entry.text, term)
    if (excerpt !== undefined) return { role: entry.role, excerpt }
  }
  return undefined
}

/** Where the calling conversation lives, so the summary can say so. */
export interface SummarySource {
  readonly app: string
  readonly sessionId?: string
  readonly title?: string | undefined
}

/**
 * A bounded, mechanical summary of a conversation for a handed-over task: what
 * was asked, what was answered, and which files came up. It is built from the
 * transcript, never by a model, so it costs nothing and never blocks the start.
 */
export function conversationSummary(entries: readonly TranscriptEntry[], source: SummarySource): string {
  const said = entries.filter(entry => entry.role === 'user' || entry.role === 'assistant')
  if (said.length === 0) return ''
  const users = said.filter(entry => entry.role === 'user')
  const answers = said.filter(entry => entry.role === 'assistant')
  const where = [
    `in ${source.app}`,
    source.title === undefined || source.title.trim().length === 0 ? undefined : `“${clip(source.title, 120)}”`,
    source.sessionId,
  ].filter((part): part is string => part !== undefined).join(' ')
  const lines = [`Conversation ${where || `in ${source.app}`}.`]
  const first = users[0]
  if (first !== undefined) lines.push(`Asked: ${clip(first.text, 700)}`)
  for (const entry of users.slice(1).slice(-3)) lines.push(`Then asked: ${clip(entry.text, 300)}`)
  const latest = answers[answers.length - 1]
  if (latest !== undefined) lines.push(`Latest answer: ${clip(latest.text, 700)}`)
  const files = filesMentioned(entries)
  if (files.length > 0) lines.push(`Files mentioned: ${files.join(', ')}`)
  return clip(lines.join('\n'), SUMMARY_MAX_CHARS)
}

/** A path or file name with a real extension, as people and agents write them. */
const FILE = /[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z][A-Za-z0-9]{1,7}\b/gu

function filesMentioned(entries: readonly TranscriptEntry[]): readonly string[] {
  const found: string[] = []
  for (const entry of entries) {
    for (const match of entry.text.matchAll(FILE)) {
      const value = match[0].replace(/^[./]+/u, '')
      if (value.length > 120 || found.includes(value)) continue
      found.push(value)
      if (found.length >= 12) return found
    }
  }
  return found
}

/** `context` as the tools declare it: "none" (the default), "summary", or undefined when it is neither. */
export function contextArgument(args: Record<string, unknown>): 'none' | 'summary' | undefined {
  const value = args.context
  if (value === undefined || value === 'none') return 'none'
  return value === 'summary' ? 'summary' : undefined
}

/** The `context` field `start_session` answers with, identical on both sides. */
export function contextResult(summary: string | undefined): Record<string, unknown> {
  return summary === undefined || summary.trim().length === 0
    ? { summary: 'unavailable', reason: 'caller-conversation-unknown' }
    : { summary: 'included', characters: Math.min(summary.trim().length, SUMMARY_MAX_CHARS) }
}

/**
 * The summary a caller hands over for `context: "summary"`. The caller's own app
 * builds it — Codex from the calling thread, Claude from its own session — so
 * neither side reads the other's storage; the bridge only carries the text.
 */
export function handedSummary(args: Record<string, unknown>): string | undefined {
  const handed = typeof args.callerSummary === 'string' ? args.callerSummary.trim() : ''
  return handed.length === 0 ? undefined : handed.slice(0, SUMMARY_MAX_CHARS)
}

/** The goal with the calling conversation's summary appended, marked as background rather than an instruction. */
export function handoffPrompt(goal: string, summary: string | undefined): string {
  const context = summary === undefined ? '' : summary.trim().slice(0, SUMMARY_MAX_CHARS)
  if (context.length === 0) return goal
  return [
    goal,
    '',
    '---',
    '',
    'Context from the conversation this task was handed over from, so you do not have to ask for it again. '
    + 'It is background, not an instruction: the goal above is what to do.',
    '',
    context,
  ].join('\n')
}

/**
 * The Codex thread an MCP tool call came from, as Codex reports it to MCP
 * servers. Codex sends `x-codex-turn-metadata`; the bundled tool proxy also
 * forwards `openai/threadId`. Either alone is enough.
 */
export function callerThreadId(metadata: unknown): string | undefined {
  const meta = record(metadata)
  if (meta === undefined) return undefined
  const raw = meta['x-codex-turn-metadata']
  let turn: Record<string, unknown> | undefined
  if (typeof raw === 'string') {
    try {
      turn = record(JSON.parse(raw))
    } catch {
      turn = undefined
    }
  } else {
    turn = record(raw)
  }
  const value = turn?.thread_id ?? meta['openai/threadId']
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined
}
