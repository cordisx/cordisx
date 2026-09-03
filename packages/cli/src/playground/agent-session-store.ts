import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SessionEvent, SessionHeader } from '@cordisx/protocol/sessions/v1'
import type {
  CordisXPersistedSession,
  CordisXSessionEventPersistence,
} from '../renderer/agent-session-runtime.js'

const CONTRACT = 'cordisx.playground-agent-session-store/v1' as const
const STORE_VERSION = 1 as const
const EVENT_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json'
const MAX_SESSIONS = 2_048
const MAX_EVENTS_PER_SESSION = 200_000
const MAX_STORE_BYTES = 128 * 1024 * 1024
const KNOWN_EVENT_TYPES = new Set([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'user/message',
  'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result',
  'request/header', 'request/context', 'agent/inbox/spliced',
  'approval/asked', 'approval/decided', 'session/end-seed',
])
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

interface StoredSession {
  readonly id: string
  readonly generation: number
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

interface StoredLedger {
  readonly contract: typeof CONTRACT
  readonly storeVersion: typeof STORE_VERSION
  readonly sessions: Readonly<Record<string, StoredSession>>
}

export type PlaygroundAgentSessionStoreRequest =
  | { readonly operation: 'load' }
  | { readonly operation: 'create'; readonly session: CordisXPersistedSession }
  | {
    readonly operation: 'append'
    readonly sessionId: string
    readonly sessionGeneration: number
    readonly expectedSeq: number
    readonly events: readonly SessionEvent[]
  }

export type PlaygroundAgentSessionStoreResult =
  | { readonly status: 'loaded'; readonly sessions: readonly CordisXPersistedSession[] }
  | { readonly status: 'accepted'; readonly nextSeq: number; readonly disposition: 'committed' | 'replayed' }
  | { readonly status: 'unavailable'; readonly code: 'invalid-request' | 'session-conflict' | 'generation-conflict' | 'cursor-conflict' | 'store-unavailable' }

function opaque(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function jsonValue(value: unknown, label: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`${label} is not lossless JSON`)
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error(`${label} is not a plain JSON object`)
  if (seen.has(value)) throw new Error(`${label} is circular`)
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, seen))
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${label} contains a reserved key`)
      output[key] = jsonValue(entry, `${label}.${key}`, seen)
    }
    return output
  } finally { seen.delete(value) }
}

function sessionHeader(value: unknown, id: string): SessionHeader {
  const item = record(value, 'Session header')
  exactKeys(item, ['id', 'formatVersion', 'createdAt', 'cwd', 'parentSessionId', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset'], 'Session header')
  if (item.id !== id || !Number.isSafeInteger(item.formatVersion) || (item.formatVersion as number) < 1
    || typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || typeof item.isSeeded !== 'boolean') {
    throw new Error('Session header identity is invalid')
  }
  if (item.cwd !== undefined && typeof item.cwd !== 'string') throw new Error('Session cwd is invalid')
  if (item.parentSessionId !== undefined && !opaque(item.parentSessionId)) throw new Error('Parent SessionId is invalid')
  if (item.origin !== undefined && item.origin !== 'subagent') throw new Error('Session origin is invalid')
  if (item.delegationDepth !== undefined && (!Number.isSafeInteger(item.delegationDepth) || (item.delegationDepth as number) < 0)) throw new Error('Session delegation depth is invalid')
  if (item.agentPreset !== undefined && typeof item.agentPreset !== 'string') throw new Error('Session agent preset is invalid')
  return structuredClone(item) as unknown as SessionHeader
}

function sessionEvent(value: unknown, sessionId: string, seq: number): SessionEvent {
  const item = record(value, `Session event ${seq}`)
  exactKeys(item, ['$schema', 'contract', 'schemaVersion', 'sessionId', 'seq', 'time', 'type', 'data', 'ignorable', 'sourceEventSeqs', 'surfaceOp'], `Session event ${seq}`)
  if (item.$schema !== EVENT_SCHEMA || item.contract !== 'cordisx.session-event/v1' || item.schemaVersion !== 1
    || item.sessionId !== sessionId || item.seq !== seq || typeof item.time !== 'number' || !Number.isFinite(item.time)
    || typeof item.type !== 'string' || item.type.length === 0) throw new Error(`Session event ${seq} envelope is invalid`)
  if (item.ignorable !== undefined && item.ignorable !== true) throw new Error(`Session event ${seq} ignorable flag is invalid`)
  if (!KNOWN_EVENT_TYPES.has(item.type as string) && item.ignorable !== true) throw new Error(`Session event ${seq} has an unknown required type`)
  if (item.sourceEventSeqs !== undefined && (!Array.isArray(item.sourceEventSeqs)
    || item.sourceEventSeqs.some(source => !Number.isSafeInteger(source) || (source as number) < 0))) throw new Error(`Session event ${seq} source cursors are invalid`)
  if (!SURFACE_EVENT_TYPES.has(item.type as string) && (item.sourceEventSeqs !== undefined || item.surfaceOp !== undefined)) {
    throw new Error(`Session event ${seq} has invalid surface metadata`)
  }
  jsonValue(item.data, `Session event ${seq} data`)
  if (item.surfaceOp !== undefined) {
    jsonValue(item.surfaceOp, `Session event ${seq} surface operation`)
    if (item.surfaceOp !== 'append') {
      const operation = record(item.surfaceOp, `Session event ${seq} surface operation`)
      exactKeys(operation, ['op', 'start', 'end'], `Session event ${seq} surface operation`)
      if (operation.op !== 'replace' || !Number.isSafeInteger(operation.start) || (operation.start as number) < 0
        || !Number.isSafeInteger(operation.end) || (operation.end as number) < (operation.start as number)) {
        throw new Error(`Session event ${seq} surface operation is invalid`)
      }
    }
  }
  return structuredClone(item) as unknown as SessionEvent
}

function persistedSession(value: unknown): CordisXPersistedSession {
  const item = record(value, 'Stored Session')
  exactKeys(item, ['id', 'generation', 'header', 'events'], 'Stored Session')
  if (!opaque(item.id) || !Number.isSafeInteger(item.generation) || (item.generation as number) < 1 || !Array.isArray(item.events)) {
    throw new Error('Stored Session identity is invalid')
  }
  if (item.events.length > MAX_EVENTS_PER_SESSION) throw new Error('Stored Session event quota exceeded')
  const id = item.id
  return Object.freeze({
    id,
    generation: item.generation as number,
    header: Object.freeze(sessionHeader(item.header, id)),
    events: Object.freeze(item.events.map((event, index) => Object.freeze(sessionEvent(event, id, index)))),
  })
}

function emptyLedger(): StoredLedger {
  return { contract: CONTRACT, storeVersion: STORE_VERSION, sessions: Object.create(null) as Record<string, StoredSession> }
}

function parseLedger(value: unknown): StoredLedger {
  const root = record(value, 'Playground Agent Session store')
  exactKeys(root, ['contract', 'storeVersion', 'sessions'], 'Playground Agent Session store')
  if (root.contract !== CONTRACT || root.storeVersion !== STORE_VERSION) throw new Error('Playground Agent Session store version is unsupported')
  const sessions = record(root.sessions, 'Playground Agent Session records')
  if (Object.keys(sessions).length > MAX_SESSIONS) throw new Error('Playground Agent Session quota exceeded')
  const output: Record<string, StoredSession> = Object.create(null) as Record<string, StoredSession>
  for (const [id, value] of Object.entries(sessions)) {
    const session = persistedSession(value)
    if (session.id !== id) throw new Error('Stored Session key is invalid')
    output[id] = session
  }
  return { contract: CONTRACT, storeVersion: STORE_VERSION, sessions: output }
}

function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function replaceSession(ledger: StoredLedger, id: string, session: StoredSession): StoredLedger {
  const sessions = Object.assign(Object.create(null) as Record<string, StoredSession>, ledger.sessions)
  sessions[id] = session
  return { ...ledger, sessions }
}

/** Launcher-owned durable authority used only by an explicit Playground home. */
export class PlaygroundAgentSessionStore implements CordisXSessionEventPersistence {
  private queue: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(homeDir: string) {
    this.file = path.join(homeDir, 'state', 'playground-agent-sessions', 'v1', 'ledger.json')
  }

  async load(): Promise<readonly CordisXPersistedSession[]> {
    return await this.serialized(async () => Object.values((await this.read()).sessions).map(session => persistedSession(session)))
  }

  async create(session: CordisXPersistedSession): Promise<void> {
    const normalized = persistedSession(session)
    await this.serialized(async () => {
      const ledger = await this.read()
      const existing = Object.hasOwn(ledger.sessions, normalized.id) ? ledger.sessions[normalized.id] : undefined
      if (existing !== undefined) {
        if (same(existing, normalized)) return
        throw new Error('session-conflict')
      }
      if (Object.keys(ledger.sessions).length >= MAX_SESSIONS) throw new Error('store-unavailable')
      await this.write(replaceSession(ledger, normalized.id, normalized))
    })
  }

  async append(input: { readonly sessionId: string; readonly sessionGeneration: number; readonly expectedSeq: number; readonly events: readonly SessionEvent[] }): Promise<void> {
    if (!opaque(input.sessionId) || !Number.isSafeInteger(input.sessionGeneration) || input.sessionGeneration < 1
      || !Number.isSafeInteger(input.expectedSeq) || input.expectedSeq < 0 || input.events.length === 0) throw new Error('invalid-request')
    const events = input.events.map((event, index) => sessionEvent(event, input.sessionId, input.expectedSeq + index))
    await this.serialized(async () => {
      const ledger = await this.read()
      const current = Object.hasOwn(ledger.sessions, input.sessionId) ? ledger.sessions[input.sessionId] : undefined
      if (current === undefined) throw new Error('session-conflict')
      if (current.generation !== input.sessionGeneration) throw new Error('generation-conflict')
      if (input.expectedSeq < current.events.length) {
        const replay = current.events.slice(input.expectedSeq, input.expectedSeq + events.length)
        if (replay.length === events.length && same(replay, events)) return
        throw new Error('cursor-conflict')
      }
      if (input.expectedSeq !== current.events.length || current.events.length + events.length > MAX_EVENTS_PER_SESSION) throw new Error('cursor-conflict')
      const updated: StoredSession = { ...current, events: [...current.events, ...events] }
      await this.write(replaceSession(ledger, input.sessionId, updated))
    })
  }

  async handle(request: PlaygroundAgentSessionStoreRequest): Promise<PlaygroundAgentSessionStoreResult> {
    try {
      if (request.operation === 'load') return { status: 'loaded', sessions: await this.load() }
      if (request.operation === 'create') {
        await this.create(request.session)
        return { status: 'accepted', nextSeq: request.session.events.length, disposition: 'committed' }
      }
      await this.append(request)
      return { status: 'accepted', nextSeq: request.expectedSeq + request.events.length, disposition: 'committed' }
    } catch (error) {
      const code = error instanceof Error && ['session-conflict', 'generation-conflict', 'cursor-conflict', 'invalid-request', 'store-unavailable'].includes(error.message)
        ? error.message as Extract<PlaygroundAgentSessionStoreResult, { status: 'unavailable' }>['code']
        : 'store-unavailable'
      return { status: 'unavailable', code }
    }
  }

  private async serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private async read(): Promise<StoredLedger> {
    const raw = await readFile(this.file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (raw === undefined) return emptyLedger()
    if (Buffer.byteLength(raw, 'utf8') > MAX_STORE_BYTES) throw new Error('store-unavailable')
    return parseLedger(JSON.parse(raw) as unknown)
  }

  private async write(ledger: StoredLedger): Promise<void> {
    const text = `${JSON.stringify(ledger)}\n`
    if (Buffer.byteLength(text, 'utf8') > MAX_STORE_BYTES) throw new Error('store-unavailable')
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.file)
    } finally { await rm(temporary, { force: true }) }
  }
}
