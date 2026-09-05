import type {
  TraceAdapterStatus,
  TraceContractEventType,
  TraceDemoKind,
  TraceDemoRequest,
  TraceEvent,
  TracePermission,
  TracePhase,
  TracePluginAttribution,
  TraceShowcaseStore,
  TraceSnapshot,
} from './types.js'

const RENDERED_LIMIT = 500
const FIXTURE_PAGE_SIZE = 8
const BASE_TIME = Date.parse('2026-08-24T10:24:00+08:00')

export const SHOWCASE_PLUGIN: TracePluginAttribution = Object.freeze({
  source: 'fixture:@cordisx/agent-trace-showcase',
  id: 'agent-trace-showcase',
  version: '0.1.0',
  generation: 'fixture-generation-7',
})

const FIXTURE_STATUS: TraceAdapterStatus = Object.freeze({
  mode: 'fixture',
  completeness: 'complete',
  contractVersion: 'cordisx.agent-events/v2',
  coreHead: '08dcdc11aae38ea9c0e91e4ad17cf31b8c756747',
  diagnostics: Object.freeze([
    'Typed fixture only; no real conversation or model request is modified.',
    'Fixture lifecycle is aligned with the merged v2 protocol control-and-contributions vector.',
    'Model consumption is never inferred from projection.',
  ]),
  supportedOperations: Object.freeze(
    [
      'followup',
      'steer',
      'inject',
      'pre-step',
      'system-prompt-section',
      'system-prompt-context',
    ] satisfies TraceDemoKind[],
  ),
  payloadPolicy: 'inline',
  origins: Object.freeze(['fixture'] as const),
})

const PLUGIN_SOURCE = Object.freeze({
  kind: 'plugin' as const,
  id: SHOWCASE_PLUGIN.id,
  label: 'Agent Trace Showcase',
})
const HOST_SOURCE = Object.freeze({ kind: 'host' as const, id: 'cordisx', label: 'CordisX host' })
const USER_SOURCE = Object.freeze({ kind: 'user' as const, id: 'user', label: 'User' })
const MODEL_SOURCE = Object.freeze({ kind: 'model' as const, id: 'gpt-5.6', label: 'GPT-5.6' })
const TOOL_SOURCE = Object.freeze({ kind: 'tool' as const, id: 'exec_command', label: 'exec_command' })

type FixtureEventInput = Omit<TraceEvent, 'sessionId' | 'origin' | 'modelConsumption' | 'type'> & {
  readonly modelConsumption?: TraceEvent['modelConsumption']
}

function contractTypeForSemantic(semanticType: string): TraceContractEventType {
  if (semanticType === 'user.message') return 'message.observed'
  if (semanticType.startsWith('agent.pre-step') || semanticType.startsWith('system-prompt.')) {
    return 'input.contribution'
  }
  if (semanticType.startsWith('agent.')) return 'message.delivery'
  if (semanticType === 'permission.decision') return 'diagnostic'
  if (semanticType === 'assistant.reasoning.delta') return 'content.chunk'
  if (semanticType === 'model.request.started') return 'step.lifecycle'
  if (semanticType === 'tool.permission') return 'diagnostic'
  return 'item.lifecycle'
}

function fixtureEvent(sessionId: string, input: FixtureEventInput): TraceEvent {
  return Object.freeze({
    ...input,
    type: contractTypeForSemantic(input.semanticType),
    sessionId,
    origin: 'fixture',
    modelConsumption: input.modelConsumption ?? 'not-applicable',
  })
}

function timestamp(seq: number): string {
  return new Date(BASE_TIME + seq * 740).toISOString()
}

function allowed(capability: string): TracePermission {
  return Object.freeze({ capability, policy: 'allow', outcome: 'allowed' })
}

/** All development data lives here; views contain no fixture branches or rows. */
function buildFixtureLedger(sessionId: string): TraceEvent[] {
  const base = (seq: number, input: Omit<FixtureEventInput, 'id' | 'seq' | 'recordedAt'>): TraceEvent =>
    fixtureEvent(sessionId, {
      id: `fixture-${sessionId}-${seq}`,
      seq,
      recordedAt: timestamp(seq),
      ...input,
    })
  return [
    base(1, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      itemId: 'user-7-1',
      messageId: 'message-user-7-1',
      lane: 'input',
      semanticType: 'user.message',
      truth: 'observed',
      summary: 'Inspect the failed release and keep every intervention attributable.',
      source: USER_SOURCE,
      payload: { text: 'Inspect the failed release and keep every intervention attributable.' },
    }),
    base(2, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      requestId: 'pre-step-7',
      lane: 'injection',
      semanticType: 'agent.pre-step.append',
      truth: 'cordisx',
      phase: 'evaluated',
      summary: 'Pre-step append evaluated by Agent Trace Showcase.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: {
        messages: [{
          source: SHOWCASE_PLUGIN.source,
          content: '[fixture] Verify the release against the signed artifact.',
        }],
      },
    }),
    base(3, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      parentId: `fixture-${sessionId}-2`,
      requestId: 'pre-step-7',
      lane: 'injection',
      semanticType: 'permission.decision',
      truth: 'cordisx',
      phase: 'permission',
      summary: 'Permission allowed for append-only pre-step contribution.',
      source: HOST_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      permission: allowed('agent.messages.append'),
    }),
    base(4, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      parentId: `fixture-${sessionId}-3`,
      requestId: 'pre-step-7',
      lane: 'injection',
      semanticType: 'agent.pre-step.append',
      truth: 'cordisx',
      phase: 'projected',
      summary: 'One source-bearing plugin message appended after the original user batch.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      modelConsumption: 'unproved',
      payload: { originalMessagesPreserved: true, appendedCount: 1 },
    }),
    base(5, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      requestId: 'prompt-section-7',
      lane: 'injection',
      semanticType: 'system-prompt.section',
      truth: 'cordisx',
      phase: 'registered',
      summary: 'Named release-safety system prompt section registered.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: { section: 'release-safety', persistence: 'generation' },
    }),
    base(6, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      itemId: 'model-request-7-1',
      lane: 'model',
      semanticType: 'model.request.started',
      truth: 'observed',
      phase: 'forwarded',
      summary: 'Model request started; projected inputs are not proof of consumption.',
      source: MODEL_SOURCE,
      modelConsumption: 'unproved',
      timing: { startedAt: timestamp(6), durationMs: 1840 },
      payload: { provider: 'openai', model: 'gpt-5.6', inputProof: 'unavailable' },
    }),
    base(7, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      itemId: 'assistant-reasoning-7-1',
      parentId: `fixture-${sessionId}-6`,
      lane: 'model',
      semanticType: 'assistant.reasoning.delta',
      truth: 'observed',
      summary: 'Compared release metadata with the notarized artifact.',
      source: MODEL_SOURCE,
      timing: { startedAt: timestamp(7), durationMs: 420 },
      payload: { chunks: 4, content: 'summarized in fixture' },
    }),
    base(8, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      itemId: 'tool-7-1',
      parentId: `fixture-${sessionId}-7`,
      lane: 'tools',
      semanticType: 'tool.call',
      truth: 'observed',
      phase: 'requested',
      summary: 'Read release metadata from the workspace.',
      source: TOOL_SOURCE,
      timing: { startedAt: timestamp(8), durationMs: 620 },
      payload: { command: 'npm view cordisx@beta --json' },
    }),
    base(9, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      parentId: `fixture-${sessionId}-8`,
      lane: 'tools',
      semanticType: 'tool.permission',
      truth: 'cordisx',
      phase: 'permission',
      summary: 'Tool permission allowed by the host.',
      source: HOST_SOURCE,
      permission: allowed('tool.execute'),
      payload: { decision: 'allow' },
    }),
    base(10, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      itemId: 'tool-result-7-1',
      parentId: `fixture-${sessionId}-8`,
      lane: 'tools',
      semanticType: 'tool.result',
      truth: 'observed',
      phase: 'forwarded',
      summary: 'Registry returned the beta package metadata.',
      source: TOOL_SOURCE,
      timing: { startedAt: timestamp(8), durationMs: 620 },
      payload: { exitCode: 0, bytes: 1832 },
    }),
    base(11, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-1',
      stepNumber: 1,
      itemId: 'assistant-7-1',
      lane: 'model',
      semanticType: 'assistant.message.completed',
      truth: 'observed',
      phase: 'forwarded',
      summary: 'The package exists, but the installed readback still needs verification.',
      source: MODEL_SOURCE,
      timing: { startedAt: timestamp(6), durationMs: 2310 },
      payload: { inputTokens: 1834, outputTokens: 196 },
    }),
    base(12, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-2',
      stepNumber: 2,
      messageId: 'message-followup-7',
      requestId: 'followup-7',
      lane: 'injection',
      semanticType: 'agent.followup',
      truth: 'cordisx',
      phase: 'requested',
      summary: 'Follow-up requested for the next turn with wakeup.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: {
        target: 'next-turn',
        wakeup: true,
        content: '[fixture] Verify a clean install before reporting success.',
      },
    }),
    base(13, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-2',
      stepNumber: 2,
      messageId: 'message-followup-7',
      parentId: `fixture-${sessionId}-12`,
      requestId: 'followup-7',
      lane: 'injection',
      semanticType: 'agent.followup.permission',
      truth: 'cordisx',
      phase: 'permission',
      summary: 'Follow-up permission allowed.',
      source: HOST_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      permission: allowed('agent.messages.append'),
    }),
    base(14, {
      turnId: 'turn-7',
      turnNumber: 7,
      stepId: 'turn-7-step-2',
      stepNumber: 2,
      messageId: 'message-followup-7',
      parentId: `fixture-${sessionId}-13`,
      requestId: 'followup-7',
      lane: 'injection',
      semanticType: 'agent.followup',
      truth: 'cordisx',
      phase: 'queued',
      summary: 'Follow-up queued for the next turn.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: { target: 'next-turn', wakeup: true },
    }),
    base(15, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-1',
      stepNumber: 1,
      messageId: 'message-followup-7',
      parentId: `fixture-${sessionId}-14`,
      requestId: 'followup-7',
      lane: 'injection',
      semanticType: 'agent.followup',
      truth: 'cordisx',
      phase: 'claimed',
      summary: 'Next turn claimed the queued follow-up.',
      source: HOST_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: { target: 'next-turn', wakeup: true },
    }),
    base(16, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-1',
      stepNumber: 1,
      itemId: 'plugin-input-8-1',
      messageId: 'message-followup-7',
      parentId: `fixture-${sessionId}-15`,
      requestId: 'followup-7',
      lane: 'input',
      semanticType: 'user.message',
      truth: 'observed',
      phase: 'forwarded',
      summary: 'Source-bearing follow-up entered the next turn.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      modelConsumption: 'unproved',
      payload: {
        source: SHOWCASE_PLUGIN.source,
        content: '[fixture] Verify a clean install before reporting success.',
      },
    }),
    base(17, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-1',
      stepNumber: 1,
      itemId: 'model-request-8-1',
      lane: 'model',
      semanticType: 'model.request.started',
      truth: 'observed',
      phase: 'forwarded',
      summary: 'Second model request started.',
      source: MODEL_SOURCE,
      modelConsumption: 'unproved',
      timing: { startedAt: timestamp(17), durationMs: 920 },
      payload: { inputProof: 'unavailable' },
    }),
    base(18, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-1',
      stepNumber: 1,
      itemId: 'tool-8-1',
      lane: 'tools',
      semanticType: 'tool.call',
      truth: 'observed',
      phase: 'requested',
      summary: 'Install package into a clean temporary project.',
      source: TOOL_SOURCE,
      timing: { startedAt: timestamp(18), durationMs: 880 },
      payload: { command: 'npm install cordisx@beta' },
    }),
    base(19, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-1',
      stepNumber: 1,
      itemId: 'tool-result-8-1',
      parentId: `fixture-${sessionId}-18`,
      lane: 'tools',
      semanticType: 'tool.result',
      truth: 'observed',
      phase: 'failed',
      summary: 'Clean install failed because the requested tag was not visible yet.',
      source: TOOL_SOURCE,
      timing: { startedAt: timestamp(18), durationMs: 880 },
      payload: { exitCode: 1, diagnostic: 'ETARGET' },
    }),
    base(20, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-2',
      stepNumber: 2,
      messageId: 'message-steer-8',
      requestId: 'steer-8',
      lane: 'injection',
      semanticType: 'agent.steer',
      truth: 'cordisx',
      phase: 'requested',
      summary: 'Steer requested for the next step with wakeup.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: { target: 'next-step', wakeup: true, content: '[fixture] Stop and report the registry mismatch.' },
    }),
    base(21, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-2',
      stepNumber: 2,
      messageId: 'message-steer-8',
      parentId: `fixture-${sessionId}-20`,
      requestId: 'steer-8',
      lane: 'injection',
      semanticType: 'agent.steer.permission',
      truth: 'cordisx',
      phase: 'permission',
      summary: 'Steer denied by fixture policy.',
      source: HOST_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      permission: {
        capability: 'agent.messages.append',
        policy: 'deny',
        outcome: 'denied',
        reason: 'Fixture denial example',
      },
    }),
    base(22, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-2',
      stepNumber: 2,
      messageId: 'message-steer-8',
      parentId: `fixture-${sessionId}-21`,
      requestId: 'steer-8',
      lane: 'injection',
      semanticType: 'agent.steer',
      truth: 'cordisx',
      phase: 'failed',
      summary: 'Steer was not queued or forwarded.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: { diagnostic: 'permission-denied' },
    }),
    base(23, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-2',
      stepNumber: 2,
      messageId: 'message-inject-8',
      requestId: 'inject-8',
      lane: 'injection',
      semanticType: 'agent.inject',
      truth: 'cordisx',
      phase: 'requested',
      summary: 'Non-waking next-step injection requested.',
      source: PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      payload: { target: 'next-step', wakeup: false, content: '[fixture] Add the package readback as context.' },
    }),
    base(24, {
      turnId: 'turn-8',
      turnNumber: 8,
      stepId: 'turn-8-step-2',
      stepNumber: 2,
      messageId: 'message-inject-8',
      parentId: `fixture-${sessionId}-23`,
      requestId: 'inject-8',
      lane: 'injection',
      semanticType: 'agent.inject.permission',
      truth: 'cordisx',
      phase: 'permission',
      summary: 'Injection is waiting for a host permission answer.',
      source: HOST_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      permission: { capability: 'agent.messages.append', policy: 'ask', outcome: 'ask-pending' },
    }),
  ]
}

function capabilityFor(kind: TraceDemoKind): string {
  if (kind === 'pre-step') return 'agent.messages.append'
  if (kind === 'system-prompt-section') return 'agent.prompt.section'
  if (kind === 'system-prompt-context') return 'agent.prompt.context'
  return 'agent.messages.append'
}

function demoKindForSemanticType(semanticType: string): TraceDemoKind | undefined {
  switch (semanticType) {
    case 'agent.followup':
      return 'followup'
    case 'agent.steer':
      return 'steer'
    case 'agent.inject':
      return 'inject'
    case 'agent.pre-step.append':
      return 'pre-step'
    case 'system-prompt.section':
      return 'system-prompt-section'
    case 'system-prompt.context':
      return 'system-prompt-context'
    default:
      return undefined
  }
}

function demoSemantics(kind: TraceDemoKind): Readonly<Record<string, unknown>> {
  switch (kind) {
    case 'followup':
      return { target: 'next-turn', wakeup: true }
    case 'steer':
      return { target: 'next-step', wakeup: true }
    case 'inject':
      return { target: 'next-step', wakeup: false }
    case 'pre-step':
      return { mode: 'append-only', sourcePreserved: true }
    case 'system-prompt-section':
      return { section: 'showcase.demo', persistence: 'generation' }
    case 'system-prompt-context':
      return { context: 'showcase.demo', persistence: 'next-step' }
  }
}

export interface FixtureProviderOptions {
  readonly sessionId: string
  readonly windowSize?: number
  /** Test-only permission projection; production fixture configuration never exposes broker policy. */
  readonly permissionPolicy?: 'allow' | 'ask' | 'deny'
}

export class FixtureTraceShowcaseStore implements TraceShowcaseStore {
  private readonly listeners = new Set<() => void>()
  private readonly allEvents: TraceEvent[]
  private windowStart: number
  private loadingEarlier = false
  private disposed = false
  private requestCounter = 0

  constructor(private readonly options: FixtureProviderOptions) {
    this.allEvents = buildFixtureLedger(options.sessionId)
    const initialWindow = Math.min(options.windowSize ?? RENDERED_LIMIT, 16)
    this.windowStart = Math.max(0, this.allEvents.length - initialWindow)
  }

  getSnapshot(): TraceSnapshot {
    const events = Object.freeze(this.allEvents.slice(this.windowStart))
    return Object.freeze({
      sessionId: this.options.sessionId,
      status: FIXTURE_STATUS,
      events,
      hasEarlier: this.windowStart > 0,
      loadingEarlier: this.loadingEarlier,
      range: Object.freeze({
        ...(events[0] === undefined ? {} : { firstSeq: events[0].seq }),
        ...(events.at(-1) === undefined ? {} : { lastSeq: events.at(-1)!.seq }),
        loaded: events.length,
        totalAvailable: this.allEvents.length,
        renderedLimit: this.options.windowSize ?? RENDERED_LIMIT,
      }),
    })
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async loadEarlier(): Promise<void> {
    this.assertActive()
    if (this.windowStart === 0 || this.loadingEarlier) return
    this.loadingEarlier = true
    this.notify()
    await Promise.resolve()
    this.windowStart = Math.max(0, this.windowStart - FIXTURE_PAGE_SIZE)
    this.loadingEarlier = false
    this.notify()
  }

  async requestDemo(request: TraceDemoRequest): Promise<string> {
    this.assertActive()
    const policy = this.options.permissionPolicy ?? 'allow'
    const requestId = `fixture-demo-${request.kind}-${++this.requestCounter}`
    const content = request.content ?? `[agent-trace-showcase fixture] Demonstrate ${request.kind}`
    const isContribution = request.kind === 'pre-step'
      || request.kind === 'system-prompt-section'
      || request.kind === 'system-prompt-context'
    if (isContribution) {
      const permission: TracePermission = policy === 'allow'
        ? { capability: capabilityFor(request.kind), policy, outcome: 'allowed' }
        : policy === 'ask'
        ? { capability: capabilityFor(request.kind), policy, outcome: 'ask-pending' }
        : { capability: capabilityFor(request.kind), policy, outcome: 'denied', reason: 'Fixture policy denial' }
      const permissionEvent = this.append(
        requestId,
        request.kind,
        'permission',
        `Fixture permission result: ${permission.outcome}.`,
        {
          decision: permission.outcome,
        },
        undefined,
        permission,
        'permission.decision',
      )
      if (policy === 'allow' && request.kind === 'pre-step') {
        let parentId = permissionEvent.id
        for (const phase of ['evaluated', 'projected', 'forwarded'] as const) {
          const event = this.append(requestId, request.kind, phase, `Append-only pre-step contribution ${phase}.`, {
            ...demoSemantics(request.kind),
            content,
          }, parentId)
          parentId = event.id
        }
      } else if (policy === 'allow') {
        this.append(
          requestId,
          request.kind,
          'registered',
          `${request.kind} contribution registered and remains explicitly releasable.`,
          {
            ...demoSemantics(request.kind),
            content,
          },
          permissionEvent.id,
        )
      } else if (policy === 'deny') {
        this.append(requestId, request.kind, 'failed', `${request.kind} failed without projection.`, {
          diagnostic: 'permission-denied',
        }, permissionEvent.id)
      }
      this.notify()
      return requestId
    }
    const requested = this.append(
      requestId,
      request.kind,
      'requested',
      `${request.kind} demo explicitly requested by the user.`,
      {
        ...demoSemantics(request.kind),
        content,
      },
    )
    const permission: TracePermission = policy === 'allow'
      ? { capability: capabilityFor(request.kind), policy, outcome: 'allowed' }
      : policy === 'ask'
      ? { capability: capabilityFor(request.kind), policy, outcome: 'ask-pending' }
      : { capability: capabilityFor(request.kind), policy, outcome: 'denied', reason: 'Fixture policy denial' }
    this.append(
      requestId,
      request.kind,
      'permission',
      `Fixture permission result: ${permission.outcome}.`,
      {
        decision: permission.outcome,
      },
      requested.id,
      permission,
    )
    if (policy === 'allow') {
      this.append(
        requestId,
        request.kind,
        'queued',
        `${request.kind} contribution is queued and remains cancellable.`,
        {
          ...demoSemantics(request.kind),
          content,
          cancellable: true,
        },
      )
    } else if (policy === 'deny') {
      this.append(requestId, request.kind, 'failed', `${request.kind} was denied and never queued.`, {
        diagnostic: 'permission-denied',
      })
    }
    this.notify()
    return requestId
  }

  async cancelQueued(requestId: string): Promise<boolean> {
    this.assertActive()
    const latest = [...this.allEvents].reverse().find(event => event.requestId === requestId)
    if (latest?.phase !== 'queued') return false
    const kind = demoKindForSemanticType(latest.semanticType)
    if (kind === undefined) return false
    this.append(requestId, kind, 'cancelled', 'Queued fixture contribution cancelled by the user.', {
      cancelledBy: SHOWCASE_PLUGIN.id,
    }, latest.id)
    this.notify()
    return true
  }

  async clearQueued(): Promise<number> {
    this.assertActive()
    const latestByRequest = new Map<string, TraceEvent>()
    for (const event of this.allEvents) if (event.requestId !== undefined) latestByRequest.set(event.requestId, event)
    const queued = [...latestByRequest.values()].filter(event =>
      (event.phase === 'queued' || event.phase === 'registered')
      && event.plugin?.id === SHOWCASE_PLUGIN.id
    )
    for (const event of queued) {
      const kind = demoKindForSemanticType(event.semanticType)
      if (kind === undefined) continue
      const terminal = event.phase === 'registered' ? 'released' : 'cancelled'
      this.append(
        event.requestId!,
        kind,
        terminal,
        terminal === 'released'
          ? 'Registered fixture contribution released by the plugin owner.'
          : 'Queued fixture contribution cleared by the plugin owner.',
        {
          clearedBy: SHOWCASE_PLUGIN.id,
        },
        event.id,
      )
    }
    if (queued.length > 0) this.notify()
    return queued.length
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.allEvents.length = 0
  }

  private append(
    requestId: string,
    kind: TraceDemoKind,
    phase: TracePhase,
    summary: string,
    payload: Readonly<Record<string, unknown>>,
    parentId?: string,
    permission?: TracePermission,
    semanticTypeOverride?: string,
  ): TraceEvent {
    const seq = (this.allEvents.at(-1)?.seq ?? 0) + 1
    const turnNumber = 9
    const semanticType = semanticTypeOverride ?? (kind === 'pre-step'
      ? 'agent.pre-step.append'
      : kind === 'system-prompt-section'
      ? 'system-prompt.section'
      : kind === 'system-prompt-context'
      ? 'system-prompt.context'
      : `agent.${kind}`)
    const event = fixtureEvent(this.options.sessionId, {
      id: `fixture-${this.options.sessionId}-${seq}`,
      seq,
      recordedAt: timestamp(seq),
      turnId: 'turn-9',
      turnNumber,
      stepId: 'turn-9-step-1',
      stepNumber: 1,
      ...(parentId === undefined ? {} : { parentId }),
      requestId,
      ...(semanticType.startsWith('agent.') && !semanticType.startsWith('agent.pre-step')
        ? { messageId: `fixture-message-${requestId}` }
        : {}),
      lane: 'injection',
      semanticType,
      truth: 'cordisx',
      phase,
      summary,
      source: phase === 'permission' ? HOST_SOURCE : PLUGIN_SOURCE,
      plugin: SHOWCASE_PLUGIN,
      ...(permission === undefined ? {} : { permission }),
      payload,
      modelConsumption: phase === 'projected' || phase === 'forwarded' ? 'unproved' : 'not-applicable',
    })
    this.allEvents.push(event)
    return event
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Agent Trace Showcase fixture store is disposed')
  }
}

export class UnavailableTraceShowcaseStore implements TraceShowcaseStore {
  private readonly status: TraceAdapterStatus = Object.freeze({
    mode: 'unavailable',
    completeness: 'unavailable',
    supportedOperations: Object.freeze([]),
    contractVersion: 'cordisx.agent-events/v2',
    coreHead: '08dcdc11aae38ea9c0e91e4ad17cf31b8c756747',
    payloadPolicy: 'referenced',
    diagnostics: Object.freeze([
      'Public Agent protocol is pinned, but the compatible host provider is unavailable.',
      'No raw bridge, private adapter store, DOM session selector, or second app-server fallback is used.',
    ]),
    origins: Object.freeze([]),
  })

  constructor(private readonly sessionId?: string, private readonly windowSize = RENDERED_LIMIT) {}

  getSnapshot(): TraceSnapshot {
    return Object.freeze({
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      status: this.status,
      events: Object.freeze([]),
      hasEarlier: false,
      loadingEarlier: false,
      range: Object.freeze({ loaded: 0, renderedLimit: this.windowSize }),
    })
  }

  subscribe(): () => void {
    return () => {}
  }
  async loadEarlier(): Promise<void> {}
  async requestDemo(): Promise<string> {
    throw new Error('live Agent contract is unavailable')
  }
  async cancelQueued(): Promise<boolean> {
    return false
  }
  async clearQueued(): Promise<number> {
    return 0
  }
  dispose(): void {}
}
