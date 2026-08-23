import type {
  CordisXAgentAdapterSource,
  CordisXAgentContentBlock,
  CordisXAgentEventStatus,
  CordisXUserMessage,
} from '../agent-contracts.js'
import type { CordisXPlatformDiagnostic } from '../platform-contracts.js'
import {
  type CordisXAgentAdapter,
  type CordisXAgentDeliveryControl,
  type CordisXAgentDeliveryInput,
  type CordisXAgentDeliveryOutcome,
} from '../renderer/agent.js'
import { CordisXAgentEventLedger } from '../renderer/agent-events.js'
import { UnavailablePlatformAdapter } from '../renderer/platform.js'

/** Codex 0.145.0 experimental wire type. Never exported from public contracts. */
interface CodexAdditionalContextEntry {
  readonly value: string
  readonly kind: 'untrusted' | 'application'
}

type CodexAdditionalContext = Readonly<Record<string, CodexAdditionalContextEntry>>

interface CodexForwardInput {
  readonly threadId: string
  readonly target: 'next-turn' | 'next-step'
  readonly wakeup: boolean
  readonly additionalContext: CodexAdditionalContext
}

export interface CodexCurrentConnectionAgentClient {
  forward(input: CodexForwardInput): Promise<{
    readonly accepted: boolean
    readonly turnId?: string
    readonly stepId?: string
    readonly contextId?: string
    readonly diagnostic?: CordisXPlatformDiagnostic
  }>
}

function messageText(message: CordisXUserMessage): string {
  return message.content.map((block: CordisXAgentContentBlock) => block.type === 'text'
    ? block.text
    : `[${block.mediaType} reference ${block.ref}]${block.summary === undefined ? '' : ` ${block.summary}`}`).join('\n')
}

function safeKeyPart(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '_').slice(0, 96)
}

/**
 * Private projection preserves all native entries and stamps the least-trusted
 * native kind. Callers cannot choose a key, role, source, or trust class.
 */
export function projectCodexAdditionalContext(
  native: CodexAdditionalContext,
  message: CordisXUserMessage,
  generation: string,
): CodexAdditionalContext {
  const prefix = `cordisx.agent.${safeKeyPart(generation)}.${safeKeyPart(message.id)}`
  let key = prefix
  let suffix = 0
  while (Object.hasOwn(native, key)) key = `${prefix}.${++suffix}`
  return Object.freeze({
    ...native,
    [key]: Object.freeze({ value: messageText(message), kind: 'untrusted' as const }),
  })
}

const CURRENT_CONNECTION_UNAVAILABLE: CordisXPlatformDiagnostic = Object.freeze({
  code: 'current-connection-client-unavailable',
  message: 'The Desktop current-connection Agent client and event feed are not safely available to CordisX',
})

/** One product-default adapter instance shared by Platform and Agent services. */
export class UnavailableCodexHostAdapter extends UnavailablePlatformAdapter implements CordisXAgentAdapter {
  agentStatus(): CordisXAgentEventStatus {
    return {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'unavailable',
      adapterId: 'codex',
      adapterVersion: '0.145.0-experimental',
      experimental: ['additional-context'],
      diagnostics: [{ ...CURRENT_CONNECTION_UNAVAILABLE, status: 'unavailable' }],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  async deliver(): Promise<CordisXAgentDeliveryOutcome> {
    return { terminal: 'failed', diagnostic: CURRENT_CONNECTION_UNAVAILABLE }
  }
}

/** Controlled current-connection seat. Product runtime does not construct it. */
export class CodexCurrentConnectionAgentAdapter implements CordisXAgentAdapter {
  private readonly nativeContext = new Map<string, CodexAdditionalContext>()

  constructor(
    private readonly client: CodexCurrentConnectionAgentClient,
    private readonly generation: string,
    private readonly adapterVersion = '0.145.0-experimental',
  ) {}

  agentStatus(): CordisXAgentEventStatus {
    return {
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'read-write',
      adapterId: 'codex',
      adapterVersion: this.adapterVersion,
      experimental: ['additional-context', 'history-visibility', 'compaction-retention'],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }
  }

  setNativeContext(sessionId: string, context: CodexAdditionalContext): void {
    this.nativeContext.set(sessionId, Object.freeze({ ...context }))
  }

  async deliver(input: CordisXAgentDeliveryInput, control: CordisXAgentDeliveryControl): Promise<CordisXAgentDeliveryOutcome> {
    const additionalContext = projectCodexAdditionalContext(
      this.nativeContext.get(input.sessionId) ?? {},
      input.message,
      this.generation,
    )
    if (!control.claim()) {
      return { terminal: 'failed', diagnostic: { code: 'interrupted', message: 'Agent delivery was cancelled before Codex claim' } }
    }
    control.projected()
    try {
      const result = await this.client.forward({
        threadId: input.sessionId,
        target: input.target,
        wakeup: input.wakeup,
        additionalContext,
      })
      if (!result.accepted) {
        return {
          terminal: 'failed',
          ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
          ...(result.stepId === undefined ? {} : { stepId: result.stepId }),
          ...(result.contextId === undefined ? {} : { contextId: result.contextId }),
          diagnostic: result.diagnostic ?? { code: 'adapter-failure', message: 'Codex current connection rejected Agent delivery' },
        }
      }
      return {
        terminal: 'forwarded',
        ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
        ...(result.stepId === undefined ? {} : { stepId: result.stepId }),
        ...(result.contextId === undefined ? {} : { contextId: result.contextId }),
      }
    } catch {
      return {
        terminal: 'failed',
        diagnostic: { code: 'adapter-failure', message: 'Codex current-connection Agent delivery failed', retryable: true },
      }
    }
  }
}

export interface CodexAppServerNotification {
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function itemKind(type: unknown): 'user-message' | 'assistant-message' | 'reasoning' | 'plan' | 'tool-call' | 'tool-result' | 'command' | 'file-change' | 'compaction' | 'other' {
  if (type === 'userMessage') return 'user-message'
  if (type === 'agentMessage') return 'assistant-message'
  if (type === 'reasoning') return 'reasoning'
  if (type === 'plan') return 'plan'
  if (type === 'commandExecution') return 'command'
  if (type === 'fileChange') return 'file-change'
  if (type === 'compaction') return 'compaction'
  if (type === 'mcpToolCall' || type === 'dynamicToolCall' || type === 'webSearch') return 'tool-call'
  return 'other'
}

function deltaChannel(method: string): 'assistant' | 'reasoning' | 'plan' | 'command' | 'file-change' | 'tool' | 'other' {
  if (method.includes('agentMessage')) return 'assistant'
  if (method.includes('reasoning')) return 'reasoning'
  if (method.includes('plan')) return 'plan'
  if (method.includes('command')) return 'command'
  if (method.includes('fileChange')) return 'file-change'
  if (method.includes('tool')) return 'tool'
  return 'other'
}

function causal(eventId: string | undefined): { readonly causalParentId: string } | Record<never, never> {
  return eventId === undefined ? {} : { causalParentId: eventId }
}

/** Version-pinned normalizer for notifications already owned by the host connection. */
export class CodexAgentEventNormalizer {
  private readonly source: CordisXAgentAdapterSource
  private readonly sessions = new Set<string>()
  private readonly turns = new Map<string, string>()
  private readonly items = new Map<string, { sessionId: string; turnId: string; kind: ReturnType<typeof itemKind> }>()
  private readonly chunks = new Map<string, number>()
  private readonly parents = new Map<string, string>()

  constructor(private readonly ledger: CordisXAgentEventLedger, adapterVersion = '0.145.0-experimental') {
    this.source = Object.freeze({ kind: 'adapter', adapterId: 'codex', adapterVersion, hostId: 'codex-desktop' })
  }

  observe(notification: CodexAppServerNotification): void {
    const params = notification.params
    const thread = record(params.thread)
    const turn = record(params.turn)
    const item = record(params.item)
    const sessionId = string(params.threadId) ?? string(thread?.id)
    const turnId = string(params.turnId) ?? string(turn?.id)
    const itemId = string(params.itemId) ?? string(item?.id)

    if (notification.method === 'thread/started' && sessionId !== undefined) {
      if (this.sessions.has(sessionId)) return this.diagnostic(sessionId, 'duplicate-thread-start', `Duplicate thread/started for ${sessionId}`)
      const event = this.ledger.commit({ sessionId, type: 'session.lifecycle', provenance: 'observed', source: this.source, data: { phase: 'opened', history: 'unknown' } })
      this.sessions.add(sessionId)
      this.parents.set(`session:${sessionId}`, event.eventId)
      return
    }
    if (sessionId === undefined) return
    if (!this.sessions.has(sessionId)) {
      this.diagnostic(sessionId, 'missing-thread-start', `${notification.method} arrived before thread/started`)
      const inferred = this.ledger.commit({ sessionId, type: 'session.lifecycle', provenance: 'inferred', source: this.source, data: { phase: 'resumed', history: 'unknown' } })
      this.sessions.add(sessionId)
      this.parents.set(`session:${sessionId}`, inferred.eventId)
    }
    if (notification.method === 'turn/started' && turnId !== undefined) {
      if (this.turns.has(turnId)) return this.diagnostic(sessionId, 'duplicate-turn-start', `Duplicate turn/started for ${turnId}`)
      const event = this.ledger.commit({
        sessionId, turnId, type: 'turn.lifecycle', provenance: 'observed', source: this.source,
        ...causal(this.parents.get(`session:${sessionId}`)), data: { phase: 'started' },
      })
      this.turns.set(turnId, sessionId)
      this.parents.set(`turn:${turnId}`, event.eventId)
      return
    }
    if (notification.method === 'item/started' && turnId !== undefined && itemId !== undefined) {
      if (!this.turns.has(turnId)) this.diagnostic(sessionId, 'missing-turn-start', `item/started arrived before turn/started for ${turnId}`)
      if (this.items.has(itemId)) return this.diagnostic(sessionId, 'duplicate-item-start', `Duplicate item/started for ${itemId}`)
      const kind = itemKind(item?.type)
      const toolCallId = string(item?.callId)
      const event = this.ledger.commit({
        sessionId, turnId, itemId, ...(toolCallId === undefined ? {} : { toolCallId }),
        type: 'item.lifecycle', provenance: 'observed', source: this.source,
        ...causal(this.parents.get(`turn:${turnId}`) ?? this.parents.get(`session:${sessionId}`)),
        data: { phase: 'started', kind },
      })
      this.items.set(itemId, { sessionId, turnId, kind })
      this.parents.set(`item:${itemId}`, event.eventId)
      if (kind === 'user-message') this.observedUserMessage(sessionId, turnId, itemId, item)
      return
    }
    if (notification.method === 'item/completed' && turnId !== undefined && itemId !== undefined) {
      const existing = this.items.get(itemId)
      if (existing === undefined) return this.diagnostic(sessionId, 'missing-item-start', `item/completed arrived before item/started for ${itemId}`)
      const event = this.ledger.commit({
        sessionId, turnId, itemId, type: 'item.lifecycle', provenance: 'observed', source: this.source,
        ...causal(this.parents.get(`item:${itemId}`)), data: { phase: 'completed', kind: existing.kind },
      })
      this.parents.set(`item:${itemId}`, event.eventId)
      return
    }
    if (notification.method === 'turn/completed' && turnId !== undefined) {
      if (!this.turns.has(turnId)) return this.diagnostic(sessionId, 'missing-turn-start', `turn/completed arrived before turn/started for ${turnId}`)
      const status = string(turn?.status)
      const phase = status === 'failed' ? 'failed' : status === 'cancelled' || status === 'interrupted' ? 'cancelled' : 'completed'
      const event = this.ledger.commit({
        sessionId, turnId, type: 'turn.lifecycle', provenance: 'observed', source: this.source,
        ...causal(this.parents.get(`turn:${turnId}`)), data: { phase, ...(status === undefined ? {} : { status }) },
      })
      this.parents.set(`turn:${turnId}`, event.eventId)
      return
    }
    if ((notification.method === 'thread/compacted' || notification.method === 'thread/compaction/completed')) {
      const event = this.ledger.commit({
        sessionId, type: 'session.lifecycle', provenance: 'observed', source: this.source,
        ...causal(this.parents.get(`session:${sessionId}`)), data: { phase: 'compacted', history: 'unknown' },
      })
      this.parents.set(`session:${sessionId}`, event.eventId)
      return
    }
    if (notification.method.includes('/delta') && turnId !== undefined && itemId !== undefined) {
      if (!this.items.has(itemId)) return this.diagnostic(sessionId, 'missing-item-start', `${notification.method} arrived before item/started for ${itemId}`)
      const channel = deltaChannel(notification.method)
      const delta = string(params.delta)
      const ref = string(params.ref)
      if ((delta === undefined) === (ref === undefined)) return this.diagnostic(sessionId, 'invalid-content-delta', `${notification.method} has no unique delta or ref`)
      const key = JSON.stringify([sessionId, turnId, itemId, channel])
      const index = this.chunks.get(key) ?? 0
      const event = this.ledger.commit({
        sessionId, turnId, itemId, type: 'content.chunk', provenance: 'observed', source: this.source,
        ...causal(this.parents.get(`item:${itemId}`)),
        data: { channel, index, ...(delta === undefined ? { ref: ref! } : { delta }), ...(params.final === true ? { final: true } : {}) },
      })
      this.chunks.set(key, index + 1)
      this.parents.set(`item:${itemId}`, event.eventId)
    }
  }

  private observedUserMessage(sessionId: string, turnId: string, itemId: string, item: Readonly<Record<string, unknown>> | undefined): void {
    const blocks = Array.isArray(item?.content) ? item.content.flatMap(value => {
      const block = record(value)
      const text = string(block?.text)
      return text === undefined ? [] : [{ type: 'text' as const, text }]
    }) : []
    if (blocks.length === 0) return
    const messageId = string(item?.clientId) ?? itemId
    const message: CordisXUserMessage = Object.freeze({ id: messageId, role: 'user', content: Object.freeze(blocks), source: this.source })
    const event = this.ledger.commit({
      sessionId, turnId, itemId, messageId, type: 'message.observed', provenance: 'observed', source: this.source,
      ...causal(this.parents.get(`item:${itemId}`)), data: { message },
    })
    this.parents.set(`item:${itemId}`, event.eventId)
  }

  private diagnostic(sessionId: string, code: string, message: string): void {
    this.ledger.commit({
      sessionId, type: 'diagnostic', provenance: 'inferred', source: this.source,
      ...causal(this.parents.get(`session:${sessionId}`)), data: { code, message, status: 'experimental' },
    })
  }
}
