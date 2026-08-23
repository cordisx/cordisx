import { Context, Service, type Disposable } from '@deepseek-ai/cordis'
import {
  CORDISX_AGENT_EVENT_CONTRACT,
  CORDISX_AGENT_EVENT_SCHEMA_VERSION,
  type CordisXAgentEvent,
  type CordisXAgentEventDraft,
  type CordisXAgentEventPage,
  type CordisXAgentEventQuery,
  type CordisXAgentEventRange,
  type CordisXAgentEventStatus,
  type CordisXAgentEventSubscription,
  type CordisXAgentEventType,
  type CordisXAgentEvents,
} from '../agent-contracts.js'
import type { CordisXPlatformResult, CordisXPluginIdentity } from '../platform-contracts.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from './service.js'
import { PermissionBroker } from './platform.js'

const MAX_PAGE_SIZE = 500

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function clone<Value>(value: Value): Value {
  return freeze(structuredClone(value))
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export class AgentEventLedgerError extends Error {
  constructor(readonly code: 'duplicate' | 'gap' | 'out-of-order' | 'invalid' | 'disposed', message: string) {
    super(message)
  }
}

interface LedgerSubscription {
  readonly filter: CordisXAgentEventSubscription
  readonly listener: (range: CordisXAgentEventRange) => void
}

/** Host-owned append-only ledger. Plugins receive only the brokered service below. */
export class CordisXAgentEventLedger {
  private readonly sessions = new Map<string, CordisXAgentEvent[]>()
  private readonly eventIds = new Set<string>()
  private readonly chunkIndices = new Map<string, number>()
  private readonly subscriptions = new Set<LedgerSubscription>()
  private disposed = false

  constructor(private readonly now: () => number = () => Date.now()) {}

  commit<Type extends CordisXAgentEventType>(draft: CordisXAgentEventDraft<Type>): CordisXAgentEvent<Type> {
    return this.commitBatch([draft])[0] as CordisXAgentEvent<Type>
  }

  commitBatch(drafts: readonly CordisXAgentEventDraft[]): readonly CordisXAgentEvent[] {
    this.assertLive()
    if (drafts.length === 0) return []
    const committed: CordisXAgentEvent[] = []
    const ranges = new Map<string, { fromSeq: number; toSeq: number }>()
    const chunkSnapshot = new Map(this.chunkIndices)
    try {
      for (const draft of drafts) {
        if (!validId(draft.sessionId)) throw new AgentEventLedgerError('invalid', 'sessionId must be a non-empty opaque id')
        const seq = this.sessions.get(draft.sessionId)?.length ?? 0
        const event = {
          contract: CORDISX_AGENT_EVENT_CONTRACT,
          schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
          ...draft,
          eventId: this.eventId(draft.sessionId, seq),
          seq,
          time: draft.time ?? this.now(),
        } as CordisXAgentEvent
        this.appendInternal(event)
        committed.push(event)
        const range = ranges.get(event.sessionId)
        ranges.set(event.sessionId, range === undefined
          ? { fromSeq: event.seq, toSeq: event.seq }
          : { fromSeq: range.fromSeq, toSeq: event.seq })
      }
    } catch (error) {
      for (const event of [...committed].reverse()) {
        this.sessions.get(event.sessionId)?.pop()
        this.eventIds.delete(event.eventId)
      }
      this.chunkIndices.clear()
      for (const [key, index] of chunkSnapshot) this.chunkIndices.set(key, index)
      throw error
    }
    for (const [sessionId, range] of ranges) this.publish({ sessionId, ...range })
    return clone(committed)
  }

  /** Controlled adapter/test ingestion path with strict externally supplied sequence validation. */
  append(event: CordisXAgentEvent): void {
    this.assertLive()
    this.appendInternal(event)
    this.publish({ sessionId: event.sessionId, fromSeq: event.seq, toSeq: event.seq })
  }

  query(input: CordisXAgentEventQuery): CordisXAgentEventPage {
    this.assertLive()
    if (!validId(input.sessionId)) throw new AgentEventLedgerError('invalid', 'sessionId must be a non-empty opaque id')
    const afterSeq = input.afterSeq ?? -1
    const limit = input.limit ?? 100
    if (!Number.isInteger(afterSeq) || afterSeq < -1) throw new AgentEventLedgerError('invalid', 'afterSeq must be an integer at least -1')
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new AgentEventLedgerError('invalid', 'limit must be between 1 and 500')
    const source = this.sessions.get(input.sessionId) ?? []
    const tail = source.length - 1
    const snapshotSeq = input.snapshotSeq ?? tail
    if (!Number.isInteger(snapshotSeq) || snapshotSeq < -1 || snapshotSeq > tail) {
      throw new AgentEventLedgerError('invalid', 'snapshotSeq is outside the committed session range')
    }
    const events = source.filter(item => item.seq > afterSeq && item.seq <= snapshotSeq).slice(0, limit)
    const last = events.at(-1)?.seq
    const more = last !== undefined && source.some(item => item.seq > last && item.seq <= snapshotSeq)
    return clone({
      contract: CORDISX_AGENT_EVENT_CONTRACT,
      schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
      sessionId: input.sessionId,
      snapshotSeq,
      afterSeq,
      limit,
      ...(events.length === 0 ? {} : { fromSeq: events[0]!.seq, toSeq: events.at(-1)!.seq }),
      ...(more && last !== undefined ? { nextAfterSeq: last } : {}),
      events,
    })
  }

  subscribe(filter: CordisXAgentEventSubscription, listener: (range: CordisXAgentEventRange) => void): Disposable<void> {
    this.assertLive()
    const subscription = { filter: clone(filter), listener }
    this.subscriptions.add(subscription)
    return () => { this.subscriptions.delete(subscription) }
  }

  latestEventId(sessionId: string): string | undefined {
    this.assertLive()
    return this.sessions.get(sessionId)?.at(-1)?.eventId
  }

  dispose(): void {
    this.disposed = true
    this.sessions.clear()
    this.eventIds.clear()
    this.chunkIndices.clear()
    this.subscriptions.clear()
  }

  private appendInternal(input: CordisXAgentEvent): void {
    const event = clone(input)
    if (event.contract !== CORDISX_AGENT_EVENT_CONTRACT || event.schemaVersion !== CORDISX_AGENT_EVENT_SCHEMA_VERSION) {
      throw new AgentEventLedgerError('invalid', 'unsupported Agent event contract')
    }
    if (!validId(event.sessionId) || !validId(event.eventId) || !Number.isInteger(event.seq) || event.seq < 0) {
      throw new AgentEventLedgerError('invalid', 'Agent event identity is invalid')
    }
    const session = this.sessions.get(event.sessionId) ?? []
    const expectedSeq = session.length
    if (event.seq > expectedSeq) throw new AgentEventLedgerError('gap', `expected seq ${expectedSeq}, received ${event.seq}`)
    if (event.seq < expectedSeq) throw new AgentEventLedgerError('out-of-order', `expected seq ${expectedSeq}, received ${event.seq}`)
    if (this.eventIds.has(event.eventId)) throw new AgentEventLedgerError('duplicate', `duplicate eventId ${event.eventId}`)
    const expectedId = this.eventId(event.sessionId, event.seq)
    if (event.eventId !== expectedId) throw new AgentEventLedgerError('invalid', `eventId must be ${expectedId}`)
    if (event.causalParentId !== undefined && !session.some(item => item.eventId === event.causalParentId)) {
      throw new AgentEventLedgerError('invalid', 'causalParentId must name an earlier event in the same session')
    }
    if (event.type === 'content.chunk') {
      const data = event.data as { channel: string; index: number; delta?: string; ref?: string }
      if ((data.delta === undefined) === (data.ref === undefined)) throw new AgentEventLedgerError('invalid', 'content chunk requires exactly one of delta or ref')
      const key = JSON.stringify([event.sessionId, event.turnId, event.itemId, data.channel])
      const expectedIndex = this.chunkIndices.get(key) ?? 0
      if (data.index !== expectedIndex) throw new AgentEventLedgerError(data.index < expectedIndex ? 'duplicate' : 'gap', `expected chunk index ${expectedIndex}, received ${data.index}`)
      this.chunkIndices.set(key, expectedIndex + 1)
    }
    session.push(event)
    this.sessions.set(event.sessionId, session)
    this.eventIds.add(event.eventId)
  }

  private publish(range: CordisXAgentEventRange): void {
    for (const subscription of this.subscriptions) {
      if (subscription.filter.sessionId !== undefined && subscription.filter.sessionId !== range.sessionId) continue
      if (range.toSeq <= (subscription.filter.afterSeq ?? -1)) continue
      subscription.listener(clone({
        ...range,
        fromSeq: Math.max(range.fromSeq, (subscription.filter.afterSeq ?? -1) + 1),
      }))
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new AgentEventLedgerError('disposed', 'Agent event ledger generation is disposed')
  }

  private eventId(sessionId: string, seq: number): string {
    const encoded = encodeURIComponent(sessionId)
    const sessionKey = encoded.length <= 480 ? encoded : `h${this.hash(sessionId)}`
    return `cxevt:${sessionKey}:${seq}`
  }

  private hash(value: string): string {
    let left = 0x811c9dc5
    let right = 0x9e3779b9
    for (const character of value) {
      const code = character.codePointAt(0) ?? 0
      left = Math.imul(left ^ code, 0x01000193) >>> 0
      right = Math.imul(right ^ (code + left), 0x85ebca6b) >>> 0
    }
    return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`
  }
}

interface AgentEventServiceOptions {
  readonly ledger: CordisXAgentEventLedger
  readonly broker: PermissionBroker
  readonly status: () => CordisXAgentEventStatus
}

const options = new WeakMap<object, AgentEventServiceOptions>()
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function serviceOptions(service: object): AgentEventServiceOptions {
  const original = (service as { [CORDIS_ORIGINAL]?: object })[CORDIS_ORIGINAL]
  for (const candidate of [original, service]) {
    if (candidate !== undefined) {
      const found = options.get(candidate)
      if (found !== undefined) return found
    }
  }
  throw new Error('CordisX Agent event service is detached from its host binding')
}

function identity(ctx: Context): CordisXPluginIdentity | undefined {
  const scoped = ctx as Context & { [CORDISX_PLUGIN_ID]?: string; [CORDISX_PLUGIN_SOURCE]?: string }
  return scoped[CORDISX_PLUGIN_ID] === undefined || scoped[CORDISX_PLUGIN_SOURCE] === undefined
    ? undefined
    : { id: scoped[CORDISX_PLUGIN_ID], source: scoped[CORDISX_PLUGIN_SOURCE] }
}

function denied(code: 'invalid-request' | 'permission-denied', message: string): CordisXPlatformResult<never> {
  return { ok: false, error: { code, message } }
}

/** Permission-brokered read-only service; no append or adapter handle is exposed. */
export class CordisXAgentEventService extends Service implements CordisXAgentEvents {
  constructor(ctx: Context, input: AgentEventServiceOptions) {
    super(ctx, 'agentEvents')
    options.set(this, input)
  }

  status(): CordisXAgentEventStatus {
    return clone(serviceOptions(this).status())
  }

  async query(input: CordisXAgentEventQuery): Promise<CordisXPlatformResult<CordisXAgentEventPage>> {
    const caller = identity(this.ctx)
    if (caller === undefined) return denied('permission-denied', 'Agent events require a plugin context')
    if (!validId(input.sessionId)) return denied('invalid-request', 'sessionId must be a non-empty opaque id')
    const grant = await serviceOptions(this).broker.authorize(caller, 'agent.events.read', { agentSessionId: input.sessionId })
    if (!grant.ok) return grant
    try {
      return { ok: true, value: serviceOptions(this).ledger.query(input) }
    } catch (error) {
      return denied('invalid-request', error instanceof Error ? error.message : String(error))
    }
  }

  subscribe(input: CordisXAgentEventSubscription, listener: (range: CordisXAgentEventRange) => void): Disposable<void> {
    const caller = identity(this.ctx)
    let dispose: Disposable<void> | undefined
    let active = true
    if (caller !== undefined && (input.sessionId === undefined || validId(input.sessionId))) {
      void serviceOptions(this).broker.authorize(caller, 'agent.events.read', {
        ...(input.sessionId === undefined ? {} : { agentSessionId: input.sessionId }),
      }).then(grant => {
        if (active && grant.ok) dispose = serviceOptions(this).ledger.subscribe(input, listener)
      })
    }
    return () => {
      active = false
      dispose?.()
    }
  }
}
