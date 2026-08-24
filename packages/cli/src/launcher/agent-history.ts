import { createHmac, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CordisXAgentEvent,
  CordisXAgentEventDataMap,
  CordisXAgentEventType,
  CordisXAgentHistoryDiagnostic,
  CordisXAgentHistoryPage,
  CordisXAgentHistoryPayloadPolicy,
  CordisXAgentHistoryQuery,
  CordisXAgentHistoryStatus,
  CordisXAgentHistoryTailQuery,
} from '../agent-contracts.js'
import type { CordisXPlatformResult } from '../platform-contracts.js'

export const AGENT_HISTORY_ADAPTER_ID = 'codex-history'
export const AGENT_HISTORY_ADAPTER_VERSION = 'rollout-jsonl-v1'
export const AGENT_HISTORY_HOST_ID = 'codex-desktop'

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/
const MAX_LINE_BYTES = 32 * 1024 * 1024
const DEFAULT_SCAN_BUDGET = 256 * 1024 * 1024
const DEFAULT_SCAN_TIME_MS = 2_500
const READ_CHUNK_BYTES = 1024 * 1024
const CURSOR_TTL_MS = 30 * 60 * 1000
const MAX_SESSION_FILES = 20_000
const MAX_SESSION_META_BYTES = 4 * 1024 * 1024

interface SourceIdentity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

interface IndexedEvent {
  readonly event: CordisXAgentEvent
  readonly nativeKey: string
}

interface SessionIndex {
  filePath: string
  source: SourceIdentity
  snapshotId: string
  offset: number
  lineStart: number
  carry: Buffer
  skippingOversized: boolean
  complete: boolean
  currentTurnId?: string
  readonly events: IndexedEvent[]
  readonly nativeKeys: Set<string>
  corruptLines: number
  oversizedLines: number
  redactedFields: number
  compacted: boolean
  earliestTime?: number
  latestTime?: number
  sourceChanged: number
  tailAvailable: boolean
}

interface CursorBinding {
  readonly kind: 'page' | 'tail'
  readonly sessionId: string
  readonly snapshotId: string
  readonly profileId: string
  readonly ownerKey: string
  readonly generation: string
  readonly policy: CordisXAgentHistoryPayloadPolicy
  readonly limit: number
  readonly eventIndex: number
  readonly expiresAt: number
}

export interface AgentHistoryCaller {
  readonly ownerKey: string
  readonly generation: string
}

export interface CodexAgentHistoryHostOptions {
  readonly codexHome: string
  readonly cacheDir: string
  readonly profileName: string
  readonly secret?: Buffer
  readonly maxScanBytes?: number
  readonly maxScanMs?: number
  readonly now?: () => number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value)
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function phase(value: unknown): CordisXAgentEventDataMap['item.lifecycle']['phase'] {
  const normalized = text(value)?.toLowerCase()
  if (normalized?.includes('fail') === true) return 'failed'
  if (normalized?.includes('cancel') === true || normalized?.includes('interrupt') === true) return 'cancelled'
  if (normalized?.includes('start') === true || normalized === 'in_progress') return 'started'
  if (normalized?.includes('update') === true) return 'updated'
  return 'completed'
}

function itemKind(value: unknown): CordisXAgentEventDataMap['item.lifecycle']['kind'] {
  const normalized = text(value)?.replaceAll(/[^a-z0-9]+/gi, '').toLowerCase() ?? ''
  if (normalized.includes('user') && normalized.includes('message')) return 'user-message'
  if ((normalized.includes('agent') || normalized.includes('assistant')) && normalized.includes('message')) return 'assistant-message'
  if (normalized.includes('reason')) return 'reasoning'
  if (normalized.includes('plan')) return 'plan'
  if (normalized.includes('functioncalloutput') || normalized.includes('toolresult') || normalized.includes('customtoolcalloutput')) return 'tool-result'
  if (normalized.includes('functioncall') || normalized.includes('toolcall') || normalized.includes('dynamictoolcall') || normalized.includes('websearch')) return 'tool-call'
  if (normalized.includes('command') || normalized.includes('exec')) return 'command'
  if (normalized.includes('filechange') || normalized.includes('patch')) return 'file-change'
  if (normalized.includes('compact')) return 'compaction'
  return 'other'
}

function statusText(value: unknown): string | undefined {
  const valueText = text(value)
  return valueText === undefined ? undefined : valueText.slice(0, 128)
}

function safeSessionId(value: string): boolean {
  return value.length <= 128 && SESSION_ID.test(value)
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function failure(code: 'invalid-request' | 'adapter-unavailable' | 'permission-scope-denied', message: string): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message } }
}

async function persistentSecret(cacheDir: string): Promise<Buffer> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 })
  await chmod(cacheDir, 0o700)
  const secretPath = path.join(cacheDir, 'history.key')
  try {
    const value = await readFile(secretPath)
    if (value.byteLength === 32) return value
  } catch {
    // Create the key below.
  }
  const value = randomBytes(32)
  try {
    await writeFile(secretPath, value, { flag: 'wx', mode: 0o600 })
  } catch {
    const raced = await readFile(secretPath)
    if (raced.byteLength !== 32) throw new Error('Agent history key is invalid')
    return raced
  }
  await chmod(secretPath, 0o600)
  return value
}

/** Node-owned exact-session Codex rollout importer. No path enters or leaves its public methods. */
export class CodexAgentHistoryHost {
  private readonly indexes = new Map<string, SessionIndex>()
  private readonly cursors = new Map<string, CursorBinding>()
  private readonly now: () => number
  private readonly maxScanBytes: number
  private readonly maxScanMs: number
  private readonly secretPromise: Promise<Buffer>
  private readonly roots: readonly string[]
  private readonly profileIdPromise: Promise<string>

  constructor(private readonly options: CodexAgentHistoryHostOptions) {
    this.now = options.now ?? Date.now
    this.maxScanBytes = options.maxScanBytes ?? DEFAULT_SCAN_BUDGET
    this.maxScanMs = options.maxScanMs ?? DEFAULT_SCAN_TIME_MS
    this.secretPromise = options.secret === undefined
      ? persistentSecret(options.cacheDir)
      : Promise.resolve(Buffer.from(options.secret))
    this.roots = [path.join(options.codexHome, 'sessions'), path.join(options.codexHome, 'archived_sessions')]
    this.profileIdPromise = this.secretPromise.then(secret => this.digest(secret, `profile\0${options.profileName}\0${path.resolve(options.codexHome)}`))
  }

  async status(): Promise<CordisXAgentHistoryStatus> {
    const profileId = await this.profileIdPromise
    const available = (await Promise.all(this.roots.map(async root => await stat(root).then(value => value.isDirectory()).catch(() => false))))
      .some(Boolean)
    return {
      hostId: AGENT_HISTORY_HOST_ID,
      hostName: 'Codex Desktop history',
      mode: available ? 'available' : 'unavailable',
      adapterId: AGENT_HISTORY_ADAPTER_ID,
      adapterVersion: AGENT_HISTORY_ADAPTER_VERSION,
      profileId,
      defaultPayloadPolicy: 'referenced',
      diagnostics: available ? [] : [{ code: 'history-unavailable', severity: 'warning', count: 1 }],
      filesystemExposed: false,
      rawBridgeExposed: false,
    }
  }

  async query(input: CordisXAgentHistoryQuery, caller: AgentHistoryCaller): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    const normalized = this.normalizeQuery(input)
    if (!normalized.ok) return normalized
    const profileId = await this.profileIdPromise
    const state = await this.index(normalized.value.sessionId, normalized.value.payloadPolicy)
    if (state === undefined) return { ok: true, value: await this.unavailablePage(normalized.value) }
    const binding = input.cursor === undefined
      ? undefined
      : this.consumeCursor(input.cursor, 'page', normalized.value, caller, profileId, state.snapshotId)
    if (input.cursor !== undefined && binding === undefined) return failure('invalid-request', 'Agent history cursor is invalid or stale')
    const end = binding?.eventIndex ?? state.events.length
    const start = Math.max(0, end - normalized.value.limit)
    return {
      ok: true,
      value: await this.page(state, normalized.value, caller, profileId, start, end, start > 0),
    }
  }

  async tail(input: CordisXAgentHistoryTailQuery, caller: AgentHistoryCaller): Promise<CordisXPlatformResult<CordisXAgentHistoryPage>> {
    const normalized = this.normalizeQuery(input)
    if (!normalized.ok) return normalized
    const profileId = await this.profileIdPromise
    const previous = this.consumeCursor(input.tailCursor, 'tail', normalized.value, caller, profileId)
    if (previous === undefined) return failure('invalid-request', 'Agent history tail cursor is invalid or stale')
    const state = await this.index(normalized.value.sessionId, normalized.value.payloadPolicy)
    if (state === undefined) return { ok: true, value: await this.unavailablePage(normalized.value) }
    if (previous.snapshotId !== state.snapshotId && (state.sourceChanged > 0 || previous.eventIndex > state.events.length)) {
      return failure('invalid-request', 'Agent history source changed before the tail cursor')
    }
    const start = Math.min(previous.eventIndex, state.events.length)
    const end = Math.min(state.events.length, start + normalized.value.limit)
    return {
      ok: true,
      value: await this.page(state, normalized.value, caller, profileId, start, end, false),
    }
  }

  dispose(): void {
    this.indexes.clear()
    this.cursors.clear()
  }

  private normalizeQuery(input: CordisXAgentHistoryQuery | CordisXAgentHistoryTailQuery): CordisXPlatformResult<Required<Pick<CordisXAgentHistoryQuery, 'sessionId' | 'limit' | 'payloadPolicy'>>> {
    if (!safeSessionId(input.sessionId)) return failure('invalid-request', 'sessionId is not a valid Codex history identity')
    const limit = input.limit ?? 500
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return failure('invalid-request', 'Agent history limit must be between 1 and 500')
    const payloadPolicy = input.payloadPolicy ?? 'referenced'
    if (!['referenced', 'summarized', 'inline'].includes(payloadPolicy)) return failure('invalid-request', 'Agent history payload policy is invalid')
    return { ok: true, value: { sessionId: input.sessionId, limit, payloadPolicy } }
  }

  private async index(sessionId: string, policy: CordisXAgentHistoryPayloadPolicy): Promise<SessionIndex | undefined> {
    const filePath = await this.resolveSessionFile(sessionId)
    if (filePath === undefined) return undefined
    const metadata = await stat(filePath)
    const source = { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeMs: metadata.mtimeMs }
    let state = this.indexes.get(`${sessionId}\0${policy}`)
    if (state === undefined || state.source.dev !== source.dev || state.source.ino !== source.ino || source.size < state.offset) {
      state = await this.newIndex(filePath, source, sessionId, policy, state === undefined ? 0 : state.sourceChanged + 1)
      this.indexes.set(`${sessionId}\0${policy}`, state)
    } else {
      state.filePath = filePath
      state.tailAvailable = await this.activeFile(filePath)
      state.source = source
      state.snapshotId = await this.sourceSnapshot(source, sessionId, policy)
      if (source.size > state.offset) state.complete = false
    }
    await this.advance(state, sessionId, policy)
    return state
  }

  private async newIndex(filePath: string, source: SourceIdentity, sessionId: string, policy: CordisXAgentHistoryPayloadPolicy, sourceChanged: number): Promise<SessionIndex> {
    return {
      filePath,
      source,
      snapshotId: await this.sourceSnapshot(source, sessionId, policy),
      offset: 0,
      lineStart: 0,
      carry: Buffer.alloc(0),
      skippingOversized: false,
      complete: false,
      events: [],
      nativeKeys: new Set(),
      corruptLines: 0,
      oversizedLines: 0,
      redactedFields: 0,
      compacted: false,
      sourceChanged,
      tailAvailable: await this.activeFile(filePath),
    }
  }

  private async advance(state: SessionIndex, sessionId: string, policy: CordisXAgentHistoryPayloadPolicy): Promise<void> {
    if (state.complete && state.offset >= state.source.size) return
    const handle = await open(state.filePath, 'r')
    let scanned = 0
    const startedAt = this.now()
    try {
      while (state.offset < state.source.size && scanned < this.maxScanBytes && this.now() - startedAt < this.maxScanMs) {
        const length = Math.min(READ_CHUNK_BYTES, state.source.size - state.offset, this.maxScanBytes - scanned)
        const chunk = Buffer.allocUnsafe(length)
        const result = await handle.read(chunk, 0, length, state.offset)
        if (result.bytesRead === 0) break
        const bytes = chunk.subarray(0, result.bytesRead)
        state.offset += result.bytesRead
        scanned += result.bytesRead
        await this.consumeBytes(state, bytes, sessionId, policy)
      }
      if (state.offset >= state.source.size) {
        if (state.carry.length > 0 && !state.skippingOversized) {
          const parsed = this.parseLine(state.carry)
          if (parsed !== undefined) {
            await this.projectRecord(state, parsed, sessionId, policy, state.lineStart)
            state.carry = Buffer.alloc(0)
          }
        }
        state.complete = state.carry.length === 0 && !state.skippingOversized
      }
    } finally {
      await handle.close()
    }
  }

  private async consumeBytes(state: SessionIndex, bytes: Buffer, sessionId: string, policy: CordisXAgentHistoryPayloadPolicy): Promise<void> {
    let cursor = 0
    while (cursor < bytes.length) {
      const newline = bytes.indexOf(0x0a, cursor)
      const end = newline === -1 ? bytes.length : newline
      const segment = bytes.subarray(cursor, end)
      if (!state.skippingOversized) {
        if (state.carry.length + segment.length > MAX_LINE_BYTES) {
          state.carry = Buffer.alloc(0)
          state.skippingOversized = true
          state.oversizedLines += 1
        } else {
          state.carry = Buffer.concat([state.carry, segment])
        }
      }
      if (newline === -1) return
      if (!state.skippingOversized && state.carry.length > 0) {
        const parsed = this.parseLine(state.carry)
        if (parsed === undefined) state.corruptLines += 1
        else await this.projectRecord(state, parsed, sessionId, policy, state.lineStart)
      }
      state.carry = Buffer.alloc(0)
      state.skippingOversized = false
      state.lineStart = state.offset - (bytes.length - newline - 1)
      cursor = newline + 1
    }
  }

  private parseLine(line: Buffer): Record<string, unknown> | undefined {
    try {
      return record(JSON.parse(line.toString('utf8')) as unknown)
    } catch {
      return undefined
    }
  }

  private async projectRecord(state: SessionIndex, envelope: Record<string, unknown>, sessionId: string, policy: CordisXAgentHistoryPayloadPolicy, offset: number): Promise<void> {
    const payload = record(envelope.payload) ?? {}
    const type = text(envelope.type)
    const eventTime = timestamp(envelope.timestamp) ?? timestamp(payload.timestamp) ?? number(payload.completed_at_ms) ?? number(payload.started_at_ms) ?? 0
    const ordinal = Number.isInteger(envelope.ordinal) ? String(envelope.ordinal) : `offset-${offset}`
    if (type === 'session_meta') {
      const nativeSession = text(payload.id) ?? text(payload.session_id)
      if (nativeSession !== undefined && nativeSession !== sessionId) throw new Error('Agent history session identity mismatch')
      await this.addEvent(state, sessionId, eventTime, `session:${ordinal}`, 'session.lifecycle', 'inferred', { phase: 'resumed', history: 'partial' })
      return
    }
    if (type === 'turn_context') {
      const turnId = text(payload.turn_id)
      if (turnId === undefined) return
      state.currentTurnId = turnId
      await this.addEvent(state, sessionId, eventTime, `turn:${turnId}:started`, 'turn.lifecycle', 'observed', { phase: 'started', status: 'history-context' }, { turnId })
      return
    }
    if (type === 'compacted') {
      state.compacted = true
      await this.addEvent(state, sessionId, eventTime, `compaction:${ordinal}`, 'session.lifecycle', 'observed', { phase: 'compacted', history: 'partial' })
      return
    }
    if (type === 'response_item') {
      await this.projectItem(state, sessionId, eventTime, payload, ordinal, policy)
      return
    }
    if (type !== 'event_msg') return
    const eventType = text(payload.type)
    if (eventType === 'item_completed') {
      const item = record(payload.item)
      if (item !== undefined) await this.projectItem(state, sessionId, eventTime, item, ordinal, policy, 'completed')
      return
    }
    const turnId = text(payload.turn_id) ?? state.currentTurnId
    if (eventType === 'task_started' && turnId !== undefined) {
      state.currentTurnId = turnId
      await this.addEvent(state, sessionId, eventTime, `turn:${turnId}:started`, 'turn.lifecycle', 'observed', { phase: 'started', status: 'started' }, { turnId })
      return
    }
    if ((eventType === 'task_complete' || eventType === 'task_completed') && turnId !== undefined) {
      await this.addEvent(state, sessionId, eventTime, `turn:${turnId}:completed`, 'turn.lifecycle', 'observed', { phase: 'completed', status: statusText(payload.status) ?? 'completed' }, { turnId })
      return
    }
    if (eventType === 'context_compacted') {
      state.compacted = true
      await this.addEvent(state, sessionId, eventTime, `compaction:${ordinal}`, 'session.lifecycle', 'observed', { phase: 'compacted', history: 'partial' })
      return
    }
    const legacyKinds: Readonly<Record<string, CordisXAgentEventDataMap['item.lifecycle']['kind']>> = {
      user_message: 'user-message',
      agent_message: 'assistant-message',
      agent_reasoning: 'reasoning',
      patch_apply_end: 'file-change',
      web_search_end: 'tool-call',
    }
    const kind = eventType === undefined ? undefined : legacyKinds[eventType]
    if (kind === undefined) return
    await this.projectItem(state, sessionId, eventTime, { ...payload, type: eventType }, ordinal, policy, 'completed', kind)
  }

  private async projectItem(
    state: SessionIndex,
    sessionId: string,
    eventTime: number,
    item: Record<string, unknown>,
    ordinal: string,
    policy: CordisXAgentHistoryPayloadPolicy,
    forcedStatus?: string,
    forcedKind?: CordisXAgentEventDataMap['item.lifecycle']['kind'],
  ): Promise<void> {
    const itemType = text(item.type) ?? text(item.kind) ?? 'unknown'
    const role = text(item.role)
    const kind = forcedKind ?? (itemType === 'message' && role === 'user'
      ? 'user-message'
      : itemType === 'message' && (role === 'assistant' || role === 'agent')
        ? 'assistant-message'
        : itemKind(itemType))
    const turnId = text(item.turn_id) ?? state.currentTurnId
    if (turnId === undefined) return
    const nativeId = text(item.id) ?? text(item.item_id)
    const callId = text(item.call_id) ?? text(item.tool_call_id)
    const itemId = nativeId ?? await this.fingerprint(`item\0${sessionId}\0${ordinal}\0${kind}`)
    const nativeKey = nativeId === undefined ? `item:${ordinal}:${kind}` : `item:${nativeId}:${kind}`
    const status = forcedStatus ?? statusText(item.status) ?? 'completed'
    await this.addEvent(state, sessionId, eventTime, `${nativeKey}:${phase(status)}`, 'item.lifecycle', 'observed', {
      phase: phase(status),
      kind,
      status,
    }, {
      turnId,
      itemId,
      ...(callId === undefined ? {} : { toolCallId: callId }),
    })

    if (kind !== 'user-message') return
    const rawText = this.itemText(item)
    const messageId = text(item.message_id) ?? nativeId ?? await this.fingerprint(`message\0${sessionId}\0${ordinal}`)
    const ref = await this.fingerprint(`content\0${sessionId}\0${ordinal}\0${messageId}`)
    const content = policy === 'inline' && rawText !== undefined
      ? [{ type: 'text' as const, text: this.redact(rawText, state).slice(0, 4_000) }]
      : [{
          type: 'reference' as const,
          ref,
          mediaType: 'text/plain',
          ...(policy === 'summarized' && rawText !== undefined
            ? { summary: this.redact(rawText, state).replaceAll(/\s+/g, ' ').slice(0, 240) }
            : {}),
        }]
    await this.addEvent(state, sessionId, eventTime, `message:${messageId}:observed`, 'message.observed', 'observed', {
      message: {
        id: messageId,
        role: 'user',
        content,
        source: this.adapterSource(),
      },
    }, { turnId, itemId, messageId })
  }

  private itemText(item: Record<string, unknown>): string | undefined {
    const direct = text(item.text) ?? text(item.message)
    if (direct !== undefined) return direct
    if (!Array.isArray(item.content)) return undefined
    const parts = item.content.flatMap(value => {
      if (typeof value === 'string') return [value]
      const block = record(value)
      const blockText = block === undefined ? undefined : text(block.text)
      return blockText === undefined ? [] : [blockText]
    })
    return parts.length === 0 ? undefined : parts.join('\n')
  }

  private redact(value: string, state: SessionIndex): string {
    let redacted = value
    const rules = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
      /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g,
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*[^\s,;]+/gi,
      /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^\s"']+/g,
    ]
    for (const rule of rules) {
      redacted = redacted.replace(rule, () => {
        state.redactedFields += 1
        return '[REDACTED]'
      })
    }
    return redacted
  }

  private async addEvent<Type extends CordisXAgentEventType>(
    state: SessionIndex,
    sessionId: string,
    eventTime: number,
    nativeKey: string,
    type: Type,
    provenance: 'observed' | 'inferred',
    data: CordisXAgentEventDataMap[Type],
    ids: Pick<CordisXAgentEvent, 'turnId' | 'stepId' | 'itemId' | 'messageId' | 'toolCallId' | 'contextId'> = {},
  ): Promise<void> {
    if (state.nativeKeys.has(nativeKey)) return
    state.nativeKeys.add(nativeKey)
    const seq = state.events.length
    const eventId = `hxevt.${await this.fingerprint(`event\0${sessionId}\0${nativeKey}`)}`
    const event = {
      contract: 'cordisx.agent-events/v2' as const,
      schemaVersion: 2 as const,
      eventId,
      sessionId,
      ...ids,
      seq,
      time: Math.max(0, Math.floor(eventTime)),
      type,
      provenance,
      source: this.adapterSource(),
      data,
    } as CordisXAgentEvent<Type>
    state.events.push({ event, nativeKey })
    state.earliestTime = state.earliestTime === undefined ? event.time : Math.min(state.earliestTime, event.time)
    state.latestTime = state.latestTime === undefined ? event.time : Math.max(state.latestTime, event.time)
  }

  private adapterSource() {
    return { kind: 'adapter' as const, adapterId: AGENT_HISTORY_ADAPTER_ID, adapterVersion: AGENT_HISTORY_ADAPTER_VERSION, hostId: AGENT_HISTORY_HOST_ID }
  }

  private async page(
    state: SessionIndex,
    input: Required<Pick<CordisXAgentHistoryQuery, 'sessionId' | 'limit' | 'payloadPolicy'>>,
    caller: AgentHistoryCaller,
    profileId: string,
    start: number,
    end: number,
    hasEarlier: boolean,
  ): Promise<CordisXAgentHistoryPage> {
    this.pruneCursors()
    const events = state.events.slice(start, end).map(item => item.event)
    const diagnostics: CordisXAgentHistoryDiagnostic[] = []
    if (!state.complete) diagnostics.push({ code: 'history-indexing', severity: 'info', count: 1 })
    if (state.corruptLines > 0) diagnostics.push({ code: 'history-corrupt-line', severity: 'warning', count: state.corruptLines })
    if (state.oversizedLines > 0) diagnostics.push({ code: 'history-oversized-line', severity: 'warning', count: state.oversizedLines })
    if (state.redactedFields > 0) diagnostics.push({ code: 'history-content-redacted', severity: 'info', count: state.redactedFields })
    if (state.sourceChanged > 0) diagnostics.push({ code: 'history-source-changed', severity: 'warning', count: state.sourceChanged })
    const nextCursor = hasEarlier
      ? this.cursor({ kind: 'page', sessionId: input.sessionId, snapshotId: state.snapshotId, profileId, ownerKey: caller.ownerKey, generation: caller.generation, policy: input.payloadPolicy, limit: input.limit, eventIndex: start, expiresAt: this.now() + CURSOR_TTL_MS })
      : undefined
    const tailCursor = state.tailAvailable
      ? this.cursor({ kind: 'tail', sessionId: input.sessionId, snapshotId: state.snapshotId, profileId, ownerKey: caller.ownerKey, generation: caller.generation, policy: input.payloadPolicy, limit: input.limit, eventIndex: end, expiresAt: this.now() + CURSOR_TTL_MS })
      : undefined
    const coverageState = state.complete
      ? diagnostics.some(item => item.severity === 'warning') ? 'partial' : 'complete'
      : state.events.length === 0 ? 'indexing' : 'partial'
    const range = events.length === 0
      ? {}
      : { fromSeq: events[0]!.seq, toSeq: events.at(-1)!.seq }
    return {
      contract: 'cordisx.agent-history/v1',
      schemaVersion: 1,
      sessionId: input.sessionId,
      snapshotId: state.snapshotId,
      limit: input.limit,
      requestedPayloadPolicy: input.payloadPolicy,
      effectivePayloadPolicy: input.payloadPolicy,
      source: { kind: 'historical', adapterId: AGENT_HISTORY_ADAPTER_ID, adapterVersion: AGENT_HISTORY_ADAPTER_VERSION, hostId: AGENT_HISTORY_HOST_ID, profileId },
      coverage: {
        state: coverageState,
        ...(state.earliestTime === undefined ? {} : { earliestTime: state.earliestTime }),
        ...(state.latestTime === undefined ? {} : { latestTime: state.latestTime }),
        compacted: state.compacted,
        corruptLines: state.corruptLines,
        oversizedLines: state.oversizedLines,
        redactedFields: state.redactedFields,
        tailAvailable: state.tailAvailable,
      },
      ...range,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(tailCursor === undefined ? {} : { tailCursor }),
      events,
      ...(diagnostics.length === 0 ? {} : { diagnostics }),
    }
  }

  private async unavailablePage(input: Required<Pick<CordisXAgentHistoryQuery, 'sessionId' | 'limit' | 'payloadPolicy'>>): Promise<CordisXAgentHistoryPage> {
    const profileId = await this.profileIdPromise
    const snapshotId = await this.fingerprint(`unavailable\0${input.sessionId}\0${profileId}`)
    return {
      contract: 'cordisx.agent-history/v1',
      schemaVersion: 1,
      sessionId: input.sessionId,
      snapshotId,
      limit: input.limit,
      requestedPayloadPolicy: input.payloadPolicy,
      effectivePayloadPolicy: 'referenced',
      source: { kind: 'historical', adapterId: AGENT_HISTORY_ADAPTER_ID, adapterVersion: AGENT_HISTORY_ADAPTER_VERSION, hostId: AGENT_HISTORY_HOST_ID, profileId },
      coverage: { state: 'unavailable', compacted: false, corruptLines: 0, oversizedLines: 0, redactedFields: 0, tailAvailable: false },
      events: [],
      diagnostics: [{ code: 'history-unavailable', severity: 'warning', count: 1 }],
    }
  }

  private cursor(binding: CursorBinding): string {
    const token = randomBytes(24).toString('base64url')
    this.cursors.set(token, binding)
    return token
  }

  private consumeCursor(
    token: string,
    kind: CursorBinding['kind'],
    input: Required<Pick<CordisXAgentHistoryQuery, 'sessionId' | 'limit' | 'payloadPolicy'>>,
    caller: AgentHistoryCaller,
    profileId: string,
    snapshotId?: string,
  ): CursorBinding | undefined {
    this.pruneCursors()
    const binding = this.cursors.get(token)
    if (binding === undefined
      || binding.kind !== kind
      || binding.sessionId !== input.sessionId
      || binding.profileId !== profileId
      || binding.ownerKey !== caller.ownerKey
      || binding.generation !== caller.generation
      || binding.policy !== input.payloadPolicy
      || binding.limit !== input.limit
      || (snapshotId !== undefined && binding.snapshotId !== snapshotId)) return undefined
    return binding
  }

  private pruneCursors(): void {
    const now = this.now()
    for (const [token, binding] of this.cursors) if (binding.expiresAt <= now) this.cursors.delete(token)
  }

  private async resolveSessionFile(sessionId: string): Promise<string | undefined> {
    const suffix = `-${sessionId}.jsonl`
    const candidates: string[] = []
    for (const root of this.roots) {
      const rootReal = await realpath(root).catch(() => undefined)
      if (rootReal === undefined) continue
      const queue: { directory: string; depth: number }[] = [{ directory: rootReal, depth: 0 }]
      let visited = 0
      while (queue.length > 0) {
        const current = queue.shift()
        if (current === undefined) break
        const entries = await readdir(current.directory, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          visited += 1
          if (visited > MAX_SESSION_FILES) throw new Error('Agent history file index exceeds its bounded entry limit')
          const candidate = path.join(current.directory, entry.name)
          if (entry.isDirectory() && current.depth < 4) queue.push({ directory: candidate, depth: current.depth + 1 })
          if (!entry.isFile() || !entry.name.endsWith(suffix) || !entry.name.startsWith('rollout-')) continue
          const link = await lstat(candidate)
          if (!link.isFile() || link.isSymbolicLink()) continue
          const candidateReal = await realpath(candidate)
          if (!inside(rootReal, candidateReal)) continue
          if (!await this.sessionIdentityMatches(candidateReal, sessionId)) continue
          candidates.push(candidateReal)
        }
      }
    }
    if (candidates.length === 0) return undefined
    const ranked = await Promise.all(candidates.map(async candidate => ({ candidate, metadata: await stat(candidate) })))
    ranked.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs || right.metadata.size - left.metadata.size || left.candidate.localeCompare(right.candidate))
    return ranked[0]?.candidate
  }

  private async activeFile(filePath: string): Promise<boolean> {
    const root = await realpath(this.roots[0]!).catch(() => undefined)
    return root !== undefined && inside(root, filePath)
  }

  private async sessionIdentityMatches(filePath: string, sessionId: string): Promise<boolean> {
    const handle = await open(filePath, 'r')
    let buffer = Buffer.alloc(0)
    let offset = 0
    try {
      while (buffer.length < MAX_SESSION_META_BYTES) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SESSION_META_BYTES - buffer.length))
        const result = await handle.read(chunk, 0, chunk.length, offset)
        if (result.bytesRead === 0) break
        offset += result.bytesRead
        buffer = Buffer.concat([buffer, chunk.subarray(0, result.bytesRead)])
        const newline = buffer.indexOf(0x0a)
        if (newline !== -1) {
          buffer = buffer.subarray(0, newline)
          break
        }
      }
    } finally {
      await handle.close()
    }
    const envelope = this.parseLine(buffer)
    const payload = envelope === undefined ? undefined : record(envelope.payload)
    return envelope?.type === 'session_meta' && (payload?.id === sessionId || payload?.session_id === sessionId)
  }

  private async sourceSnapshot(source: SourceIdentity, sessionId: string, policy: CordisXAgentHistoryPayloadPolicy): Promise<string> {
    return await this.fingerprint(`snapshot\0${sessionId}\0${source.dev}\0${source.ino}\0${source.size}\0${Math.floor(source.mtimeMs)}\0${policy}\0${AGENT_HISTORY_ADAPTER_VERSION}`)
  }

  private async fingerprint(value: string): Promise<string> {
    return this.digest(await this.secretPromise, value)
  }

  private digest(secret: Buffer, value: string): string {
    return createHmac('sha256', secret).update(value).digest('base64url').slice(0, 43)
  }
}
