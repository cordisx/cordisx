import { access, open, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  beginScan,
  capScan,
  readCandidate,
  scanReport,
  SEARCH_FILE_BYTES,
  SEARCH_MAX_FILES,
  searchEntries,
} from './agent-bridge-context.js'
import { pageTranscript, type TranscriptEntry } from './agent-bridge-transcript.js'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 512): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined
export const claudeSessionLink = (id: string): string => `claude://resume?session=${id}`
export interface SessionRecord {
  readonly sessionId: string
  readonly cliSessionId: string
  readonly title: string
  readonly cwd?: string
  readonly model?: string
  readonly updatedAt?: number
  readonly archived: boolean
}

export async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return undefined
  }
}

export async function directories(parent: string): Promise<readonly string[]> {
  try {
    return (await readdir(parent, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(parent, entry.name))
  } catch {
    return []
  }
}

/** Every Code session record the profile keeps, newest first. */
export async function readClaudeSessionRecords(dataDir: string): Promise<readonly SessionRecord[]> {
  const records: SessionRecord[] = []
  for (const account of await directories(path.join(dataDir, 'claude-code-sessions'))) {
    for (const organization of await directories(account)) {
      for (const name of await readdir(organization).catch(() => [] as string[])) {
        if (!/^local_.+\.json$/u.test(name)) continue
        const record = await readJson(path.join(organization, name))
        const sessionId = text(record?.sessionId)
        const cliSessionId = text(record?.cliSessionId)
        if (record === undefined || sessionId === undefined || cliSessionId === undefined) continue
        records.push({
          sessionId,
          cliSessionId,
          title: text(record.title, 1024) ?? '',
          ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
          ...(typeof record.model === 'string' ? { model: record.model } : {}),
          ...(typeof record.lastActivityAt === 'number' ? { updatedAt: record.lastActivityAt } : {}),
          archived: record.isArchived === true,
        })
      }
    }
  }
  return records.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
}

/** The CLI transcript of a session, found by id under `~/.claude/projects`. */
export async function findClaudeTranscript(homedir: string, cliSessionId: string): Promise<string | undefined> {
  if (!UUID.test(cliSessionId)) return undefined
  for (const project of await directories(path.join(homedir, '.claude', 'projects'))) {
    const file = path.join(project, `${cliSessionId}.jsonl`)
    try {
      await access(file)
      return file
    } catch { /* next project */ }
  }
  return undefined
}

/**
 * The end of a transcript file, at most `SEARCH_FILE_BYTES`: a long session is
 * judged by what it last discussed. A tail that starts mid-line drops that line.
 */
export async function readTranscriptTail(file: string, maxBytes = SEARCH_FILE_BYTES): Promise<string | undefined> {
  let handle
  try {
    handle = await open(file, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    await handle.read(buffer, 0, buffer.length, start)
    const text = buffer.toString('utf8')
    if (start === 0) return text
    const newline = text.indexOf('\n')
    return newline < 0 ? text : text.slice(newline + 1)
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/**
 * `list_sessions` with a `searchTerm` on Claude: the title first (it costs
 * nothing), then each session's own CLI transcript, of which at most
 * `SEARCH_MAX_FILES` are read and only their last `SEARCH_FILE_BYTES`. The
 * answer says when the scan stopped with candidates left over.
 */
export async function searchClaudeSessions(
  records: readonly SessionRecord[],
  search: string,
  limit: number,
  homedir: string,
): Promise<{ sessions: readonly unknown[]; scan: ReturnType<typeof scanReport> }> {
  const scan = beginScan()
  const term = search.toLowerCase()
  const matched: unknown[] = []
  let unread = 0
  for (const record of records) {
    if (matched.length >= limit) {
      unread += 1
      continue
    }
    const base = { ...record, link: claudeSessionLink(record.cliSessionId) }
    if (record.title.toLowerCase().includes(term)) {
      matched.push({ ...base, matchedIn: 'title' })
      continue
    }
    if (scan.scanned >= SEARCH_MAX_FILES) {
      unread += 1
      continue
    }
    const file = await findClaudeTranscript(homedir, record.cliSessionId)
    // A session whose transcript is gone has nothing left to match.
    if (file === undefined) continue
    const tail = await readTranscriptTail(file)
    if (tail === undefined) continue
    if (!readCandidate(scan, tail.length)) {
      unread += 1
      break
    }
    const found = searchEntries(claudeTranscript(tail), search)
    if (found !== undefined) matched.push({ ...base, match: found, matchedIn: 'messages' })
  }
  if (unread > 0) capScan(scan)
  return { sessions: matched, scan: scanReport(scan) }
}

/** The user and assistant text of a CLI transcript, oldest first. */
export function claudeTranscriptEntries(jsonl: string): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of jsonl.split('\n')) {
    let entry: Record<string, unknown> | undefined
    try {
      entry = object(JSON.parse(line))
    } catch {
      continue
    }
    if (entry?.type !== 'user' && entry?.type !== 'assistant') continue
    const content = object(entry.message)?.content
    const said = typeof content === 'string'
      ? content
      : (Array.isArray(content) ? content : [])
        .map(part => object(part)?.type === 'text' ? object(part)?.text : undefined)
        .filter((part): part is string => typeof part === 'string')
        .join('\n')
    if (said.trim().length > 0) entries.push({ role: entry.type, text: said })
  }
  return entries
}

/** The newest page of a CLI transcript; `limit` bounds entries, and the page says what it left out. */
export function claudeTranscript(jsonl: string, limit?: number): readonly TranscriptEntry[] {
  return pageTranscript(claudeTranscriptEntries(jsonl), limit === undefined ? {} : { limit }).entries
}
