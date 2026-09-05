import type {
  CordisXAgent,
  CordisXAgentDeliveryHandle,
  CordisXAgentEvent,
  CordisXAgentEvents,
  CordisXAgentEventSource,
  CordisXAgents,
  CordisXSystemPrompt,
} from 'cordisx/contracts'
import type {
  TraceAdapterStatus,
  TraceDemoRequest,
  TraceEvent,
  TraceLane,
  TracePermission,
  TracePhase,
  TracePluginAttribution,
  TraceShowcaseStore,
  TraceSnapshot,
  TraceSource,
} from './types.js'

const RENDERED_LIMIT = 500
const PROTOCOL_HEAD = '08dcdc11aae38ea9c0e91e4ad17cf31b8c756747'
const LIVE_OPERATIONS = Object.freeze(
  [
    'followup',
    'steer',
    'inject',
    'pre-step',
    'system-prompt-section',
    'system-prompt-context',
  ] as const,
)

function pluginAttribution(source: CordisXAgentEventSource): TracePluginAttribution | undefined {
  if (source.kind !== 'plugin') return undefined
  return Object.freeze({
    source: source.source,
    id: source.id,
    version: source.version,
    generation: source.generation,
  })
}

function sourceProjection(source: CordisXAgentEventSource): TraceSource {
  if (source.kind === 'plugin') {
    return Object.freeze({ kind: 'plugin', id: source.id, label: source.id })
  }
  if (source.kind === 'cordisx') {
    return Object.freeze({ kind: 'host', id: source.component, label: `CordisX ${source.component}` })
  }
  return Object.freeze({ kind: 'host', id: source.adapterId, label: `${source.adapterId} adapter` })
}

function laneFor(event: CordisXAgentEvent): TraceLane {
  if (event.type === 'message.observed') return 'input'
  if (event.type === 'message.delivery' || event.type === 'input.contribution') return 'injection'
  if (event.type === 'content.chunk') {
    const channel = (event.data as { readonly channel?: string }).channel
    return channel === 'tool' || channel === 'command' || channel === 'file-change' ? 'tools' : 'model'
  }
  if (event.type === 'item.lifecycle') {
    const kind = (event.data as { readonly kind?: string }).kind
    if (kind === 'user-message') return 'input'
    if (kind === 'tool-call' || kind === 'tool-result' || kind === 'command' || kind === 'file-change') return 'tools'
  }
  if (event.type === 'diagnostic' && event.source.kind === 'plugin') return 'injection'
  return 'model'
}

function deliverySemantic(data: { readonly target?: string; readonly wakeup?: boolean }): string {
  if (data.target === 'next-turn' && data.wakeup === true) return 'agent.followup'
  if (data.target === 'next-step' && data.wakeup === true) return 'agent.steer'
  if (data.target === 'next-step' && data.wakeup === false) return 'agent.inject'
  return 'agent.send'
}

function semanticType(event: CordisXAgentEvent): string {
  if (event.type === 'message.observed') return 'user.message'
  if (event.type === 'message.delivery') {
    return deliverySemantic(event.data as { readonly target?: string; readonly wakeup?: boolean })
  }
  if (event.type === 'input.contribution') return (event.data as { readonly kind: string }).kind
  if (event.type === 'item.lifecycle') return `item.${(event.data as { readonly kind?: string }).kind ?? 'other'}`
  if (event.type === 'content.chunk') {
    return `content.${(event.data as { readonly channel?: string }).channel ?? 'other'}`
  }
  if (event.type === 'diagnostic') return `diagnostic.${(event.data as { readonly code?: string }).code ?? 'unknown'}`
  return event.type
}

function textSummary(event: CordisXAgentEvent): string | undefined {
  if (event.type !== 'message.observed') return undefined
  const message = (event.data as {
    readonly message?: { readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }> }
  }).message
  const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join(' ').trim()
  if (text === undefined || text === '') return undefined
  return text.length <= 180 ? text : `${text.slice(0, 177)}…`
}

function summary(event: CordisXAgentEvent): string {
  const text = textSummary(event)
  if (text !== undefined) return text
  if (event.type === 'message.delivery') {
    const data = event.data as { readonly stage?: string; readonly target?: string; readonly wakeup?: boolean }
    return `Delivery ${data.stage ?? 'updated'} for ${data.target ?? 'unknown target'}${
      data.wakeup === true ? ' with wakeup' : ''
    }.`
  }
  if (event.type === 'input.contribution') {
    const data = event.data as {
      readonly kind?: string
      readonly stage?: string
      readonly diagnostic?: { readonly message?: string }
    }
    return data.diagnostic?.message ?? `${data.kind ?? 'Input contribution'} ${data.stage ?? 'updated'}.`
  }
  if (event.type === 'content.chunk') {
    const data = event.data as { readonly channel?: string; readonly index?: number; readonly final?: boolean }
    return `${data.channel ?? 'Content'} chunk ${data.index ?? 0}${data.final === true ? ' completed' : ' observed'}.`
  }
  if (event.type === 'diagnostic') return (event.data as { readonly message?: string }).message ?? 'Agent diagnostic.'
  const data = event.data as { readonly phase?: string; readonly kind?: string }
  if (event.type === 'item.lifecycle') return `${data.kind ?? 'Item'} ${data.phase ?? 'updated'}.`
  return `${event.type.replace('.', ' ')} ${data.phase ?? 'observed'}.`
}

function phase(event: CordisXAgentEvent): TracePhase | undefined {
  const value = (event.data as { readonly stage?: string; readonly phase?: string }).stage
    ?? (event.data as { readonly phase?: string }).phase
  return value === 'requested' || value === 'permission' || value === 'queued' || value === 'claimed'
      || value === 'registered' || value === 'evaluated' || value === 'projected'
      || value === 'forwarded' || value === 'released' || value === 'failed'
      || value === 'expired' || value === 'cancelled'
    ? value
    : undefined
}

function permission(event: CordisXAgentEvent): TracePermission | undefined {
  if (event.type !== 'message.delivery') return undefined
  const data = event.data as {
    readonly stage?: string
    readonly capability?: string
    readonly policy?: 'ask' | 'deny' | 'allow'
    readonly decision?: 'allow' | 'deny' | 'timeout'
    readonly diagnostic?: { readonly message?: string }
  }
  if (data.stage !== 'permission' || data.capability === undefined || data.policy === undefined) return undefined
  return Object.freeze({
    capability: data.capability,
    policy: data.policy,
    outcome: data.decision === 'allow' ? 'allowed' : data.decision === undefined ? 'ask-pending' : 'denied',
    ...(data.diagnostic?.message === undefined ? {} : { reason: data.diagnostic.message }),
  })
}

/** Projects only the public v2 envelope; it does not infer adapter-private state. */
export function projectAgentEvent(event: CordisXAgentEvent, origin: TraceEvent['origin'] = 'live'): TraceEvent {
  const projectedPhase = phase(event)
  const lane = laneFor(event)
  const plugin = pluginAttribution(event.source)
  const projectedPermission = permission(event)
  return Object.freeze({
    id: event.eventId,
    sessionId: event.sessionId,
    seq: event.seq,
    recordedAt: new Date(event.time).toISOString(),
    origin,
    ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
    ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
    ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
    ...(event.contextId === undefined ? {} : { contextId: event.contextId }),
    ...(event.causalParentId === undefined ? {} : { parentId: event.causalParentId }),
    ...(event.deliveryId === undefined && event.contributionId === undefined
      ? {}
      : { requestId: event.deliveryId ?? event.contributionId }),
    lane,
    type: event.type,
    semanticType: semanticType(event),
    truth: event.provenance,
    ...(projectedPhase === undefined ? {} : { phase: projectedPhase }),
    summary: summary(event),
    source: sourceProjection(event.source),
    ...(plugin === undefined ? {} : { plugin }),
    ...(projectedPermission === undefined ? {} : { permission: projectedPermission }),
    payload: event.data as unknown as Readonly<Record<string, unknown>>,
    modelConsumption: (event.type === 'message.delivery' || event.type === 'input.contribution')
        && (projectedPhase === 'projected' || projectedPhase === 'forwarded')
      ? 'unproved'
      : 'not-applicable',
  })
}

function initialStatus(service: CordisXAgentEvents): TraceAdapterStatus {
  const status = service.status()
  return Object.freeze({
    mode: status.mode === 'unavailable' ? 'partial' : 'live',
    completeness: 'partial',
    contractVersion: 'cordisx.agent-events/v2',
    coreHead: PROTOCOL_HEAD,
    diagnostics: Object.freeze([
      ...status.diagnostics.map(item => `${item.code}: ${item.message}`),
      status.mode === 'unavailable'
        ? 'The public CordisX ledger is readable, but current-session adapter observations remain unavailable.'
        : 'The public ledger does not claim complete historical coverage unless session lifecycle evidence says so.',
      'Projected or forwarded content is never presented as model-consumed.',
    ]),
    supportedOperations: LIVE_OPERATIONS,
    payloadPolicy: 'inline',
    origins: Object.freeze(['live'] as const),
  })
}

export class LiveTraceShowcaseStore implements TraceShowcaseStore {
  private readonly listeners = new Set<() => void>()
  private readonly events: TraceEvent[] = []
  private status: TraceAdapterStatus
  private operation = Promise.resolve()
  private unsubscribe: () => void
  private disposed = false
  private boundaryReached = false
  private readonly agent: CordisXAgent
  private readonly deliveryHandles = new Map<string, CordisXAgentDeliveryHandle>()
  private readonly contributions = new Map<string, () => void>()
  private demoCounter = 0

  constructor(
    private readonly service: CordisXAgentEvents,
    private readonly agents: CordisXAgents,
    private readonly systemPrompt: CordisXSystemPrompt,
    private readonly sessionId: string,
    private readonly windowSize = RENDERED_LIMIT,
  ) {
    this.status = initialStatus(service)
    this.agent = agents.get(sessionId)
    this.unsubscribe = service.subscribe({ sessionId, afterSeq: -1 }, () => this.scheduleSync())
    this.scheduleSync()
  }

  getSnapshot(): TraceSnapshot {
    const events = Object.freeze([...this.events])
    const lastSeq = events.at(-1)?.seq
    return Object.freeze({
      sessionId: this.sessionId,
      status: this.status,
      events,
      hasEarlier: false,
      loadingEarlier: false,
      range: Object.freeze({
        ...(events[0] === undefined ? {} : { firstSeq: events[0].seq }),
        ...(lastSeq === undefined ? {} : { lastSeq }),
        loaded: events.length,
        ...(lastSeq === undefined ? {} : { totalAvailable: lastSeq + 1 }),
        renderedLimit: this.windowSize,
      }),
    })
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async loadEarlier(): Promise<void> {
    await this.operation
  }

  async requestDemo(request: TraceDemoRequest): Promise<string> {
    if (this.disposed) throw new Error('Agent Trace live provider is disposed')
    const id = `agent-trace-showcase-${request.kind}-${++this.demoCounter}`
    const content = request.content
      ?? `[Agent Trace Showcase demo:${request.kind}] Explicitly requested for ${this.sessionId}.`
    if (request.kind === 'pre-step') {
      const dispose = this.systemPreStep(id, content)
      this.contributions.set(id, dispose)
      return id
    }
    if (request.kind === 'system-prompt-section' || request.kind === 'system-prompt-context') {
      const contribution = { sessionId: this.sessionId, id, content }
      const dispose = request.kind === 'system-prompt-section'
        ? this.systemPrompt.section(contribution)
        : this.systemPrompt.context(contribution)
      this.contributions.set(id, dispose)
      return id
    }
    const handle = request.kind === 'followup'
      ? this.agent.followup(content)
      : request.kind === 'steer'
      ? this.agent.steer(content)
      : this.agent.inject(content)
    this.deliveryHandles.set(handle.deliveryId, handle)
    this.scheduleSync()
    return handle.deliveryId
  }

  async cancelQueued(requestId: string): Promise<boolean> {
    if (this.disposed) return false
    const handle = this.deliveryHandles.get(requestId)
    if (handle === undefined) return false
    const result = handle.cancel()
    this.scheduleSync()
    return result.ok
  }

  async clearQueued(): Promise<number> {
    if (this.disposed) return 0
    const result = this.agent.clearPending()
    let cleared = result.cancelled.length
    for (const dispose of this.contributions.values()) {
      dispose()
      cleared += 1
    }
    this.contributions.clear()
    this.scheduleSync()
    return cleared
  }

  async settled(): Promise<void> {
    await this.operation
  }

  dispose(): void {
    if (this.disposed) return
    this.agent.clearPending()
    for (const dispose of this.contributions.values()) dispose()
    this.contributions.clear()
    this.deliveryHandles.clear()
    this.disposed = true
    this.unsubscribe()
    this.listeners.clear()
    this.events.length = 0
  }

  private systemPreStep(id: string, content: string): () => void {
    let used = false
    let dispose = (): void => {}
    const release = (): void => {
      dispose()
      this.contributions.delete(id)
    }
    dispose = this.agents.preStep(input => {
      if (used || input.sessionId !== this.sessionId) return { kind: 'continue' }
      used = true
      queueMicrotask(release)
      return { kind: 'append', messages: [content] }
    })
    return release
  }

  private scheduleSync(): void {
    if (this.disposed || this.boundaryReached) return
    this.operation = this.operation.then(() => this.sync()).catch(error => this.fail(error))
  }

  private async sync(): Promise<void> {
    if (this.disposed) return
    const remaining = this.windowSize - this.events.length
    if (remaining <= 0) {
      this.boundaryReached = true
      this.withDiagnostic(
        `The live projection reached its configured ${this.windowSize}-event window; later events are not loaded.`,
      )
      return
    }
    const afterSeq = this.events.at(-1)?.seq ?? -1
    const result = await this.service.query({ sessionId: this.sessionId, afterSeq, limit: remaining })
    if (this.disposed) return
    if (!result.ok) {
      this.status = Object.freeze({
        ...this.status,
        mode: 'unavailable',
        completeness: 'unavailable',
        supportedOperations: Object.freeze([]),
        diagnostics: Object.freeze([...this.status.diagnostics, `${result.error.code}: ${result.error.message}`]),
      })
      this.notify()
      return
    }
    const additions = result.value.events
      .filter(event => event.seq > afterSeq)
      .map(event => projectAgentEvent(event))
    this.events.push(...additions)
    if (result.value.nextAfterSeq !== undefined || this.events.length >= this.windowSize) {
      this.boundaryReached = true
      this.withDiagnostic(
        `The live projection reached its configured ${this.windowSize}-event window; later events are not loaded.`,
      )
    }
    this.notify()
  }

  private fail(error: unknown): void {
    if (this.disposed) return
    this.status = Object.freeze({
      ...this.status,
      mode: 'unavailable',
      completeness: 'unavailable',
      supportedOperations: Object.freeze([]),
      diagnostics: Object.freeze([
        ...this.status.diagnostics,
        `ledger-query-failed: ${error instanceof Error ? error.message : String(error)}`,
      ]),
    })
    this.notify()
  }

  private withDiagnostic(message: string): void {
    if (this.status.diagnostics.includes(message)) return
    this.status = Object.freeze({
      ...this.status,
      diagnostics: Object.freeze([...this.status.diagnostics, message]),
    })
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}
