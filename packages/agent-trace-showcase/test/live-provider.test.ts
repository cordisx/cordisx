import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_AGENT_DELIVERY_CONTRACT,
  CORDISX_AGENT_DELIVERY_SCHEMA_VERSION,
  CORDISX_AGENT_EVENT_CONTRACT,
  CORDISX_AGENT_EVENT_SCHEMA_VERSION,
  type CordisXAgent,
  type CordisXAgentDeliveryHandle,
  type CordisXAgentEvent,
  type CordisXAgentEventRange,
  type CordisXAgentEvents,
  type CordisXAgents,
  type CordisXSystemPrompt,
} from 'cordisx/contracts'
import { LiveTraceShowcaseStore, projectAgentEvent } from '../src/live-provider.js'

const owner = Object.freeze({
  kind: 'plugin' as const,
  source: 'file:///agent-trace-showcase/index.ts',
  id: 'agent-trace-showcase',
  version: null,
  generation: 'generation-1',
})

const queued = Object.freeze({
  contract: CORDISX_AGENT_EVENT_CONTRACT,
  schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
  eventId: 'cxevt:session-a:0',
  sessionId: 'session-a',
  messageId: 'message-1',
  deliveryId: 'delivery-1',
  seq: 0,
  time: 1000,
  type: 'message.delivery',
  provenance: 'cordisx',
  source: owner,
  data: {
    stage: 'queued',
    target: 'next-step',
    wakeup: false,
    owner,
  },
}) satisfies CordisXAgentEvent<'message.delivery'>

function service(options: { deny?: boolean } = {}): CordisXAgentEvents & { emit(): void; disposed(): boolean } {
  let listener: ((range: CordisXAgentEventRange) => void) | undefined
  let disposed = false
  return {
    status: () => ({
      hostId: 'codex-desktop',
      hostName: 'Codex Desktop',
      mode: 'unavailable',
      adapterId: 'codex',
      adapterVersion: '0.145.0',
      experimental: [],
      diagnostics: [{ code: 'current-connection-client-unavailable', message: 'Current connection is unavailable.' }],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    }),
    query: vi.fn(async input =>
      options.deny === true
        ? { ok: false as const, error: { code: 'permission-denied' as const, message: 'Denied by fixture broker.' } }
        : {
          ok: true as const,
          value: {
            contract: CORDISX_AGENT_EVENT_CONTRACT,
            schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
            sessionId: input.sessionId,
            snapshotSeq: 0,
            afterSeq: input.afterSeq ?? -1,
            limit: input.limit ?? 100,
            ...(input.afterSeq === undefined || input.afterSeq < 0
              ? { fromSeq: 0, toSeq: 0, events: [queued] }
              : { events: [] }),
          },
        }
    ),
    subscribe: (_input, next) => {
      listener = next
      return () => {
        disposed = true
        listener = undefined
      }
    },
    emit: () => listener?.({ sessionId: 'session-a', fromSeq: 0, toSeq: 0 }),
    disposed: () => disposed,
  }
}

function controls(): {
  agents: CordisXAgents
  systemPrompt: CordisXSystemPrompt
  agent: CordisXAgent
  handle: CordisXAgentDeliveryHandle
  releaseSection: ReturnType<typeof vi.fn>
  releaseContext: ReturnType<typeof vi.fn>
  releasePreStep: ReturnType<typeof vi.fn>
} {
  let cancelled = false
  const snapshot = () => ({
    contract: CORDISX_AGENT_DELIVERY_CONTRACT,
    schemaVersion: CORDISX_AGENT_DELIVERY_SCHEMA_VERSION,
    deliveryId: 'delivery-live-1',
    messageId: 'message-live-1',
    sessionId: 'session-a',
    target: 'next-step' as const,
    wakeup: false,
    owner,
    stage: cancelled ? 'cancelled' as const : 'queued' as const,
    terminal: cancelled,
    cancellable: !cancelled,
    valid: true,
    stageEventId: cancelled ? 'cxevt:session-a:cancelled' : 'cxevt:session-a:queued',
  })
  const handle: CordisXAgentDeliveryHandle = {
    deliveryId: 'delivery-live-1',
    snapshot,
    cancel: () => {
      cancelled = true
      return { ok: true, snapshot: snapshot() }
    },
  }
  const releaseSection = vi.fn()
  const releaseContext = vi.fn()
  const releasePreStep = vi.fn()
  const agent: CordisXAgent = {
    send: vi.fn(() => handle),
    followup: vi.fn(() => handle),
    steer: vi.fn(() => handle),
    inject: vi.fn(() => handle),
    clearPending: vi.fn(() => ({ cancelled: [snapshot()], retained: [] })),
  }
  return {
    agent,
    handle,
    agents: { get: vi.fn(() => agent), preStep: vi.fn(() => releasePreStep) },
    systemPrompt: { section: vi.fn(() => releaseSection), context: vi.fn(() => releaseContext) },
    releaseSection,
    releaseContext,
    releasePreStep,
  }
}

describe('Agent Trace live v2 provider', () => {
  it('projects only public ledger fields and keeps unavailable adapter status honest', async () => {
    const input = service()
    const live = controls()
    const store = new LiveTraceShowcaseStore(input, live.agents, live.systemPrompt, 'session-a')
    await store.settled()
    expect(input.query).toHaveBeenCalledWith({ sessionId: 'session-a', afterSeq: -1, limit: 500 })
    expect(store.getSnapshot()).toMatchObject({
      sessionId: 'session-a',
      status: {
        mode: 'partial',
        completeness: 'partial',
        contractVersion: 'cordisx.agent-events/v2',
        supportedOperations: [
          'followup',
          'steer',
          'inject',
          'pre-step',
          'system-prompt-section',
          'system-prompt-context',
        ],
      },
      range: { firstSeq: 0, lastSeq: 0, loaded: 1, totalAvailable: 1, renderedLimit: 500 },
    })
    expect(store.getSnapshot().events[0]).toMatchObject({
      id: queued.eventId,
      lane: 'injection',
      type: 'message.delivery',
      semanticType: 'agent.inject',
      phase: 'queued',
      plugin: { id: 'agent-trace-showcase', version: null, generation: 'generation-1' },
      modelConsumption: 'not-applicable',
    })
    expect(await store.requestDemo({ kind: 'inject' })).toBe('delivery-live-1')
    expect(live.agent.inject).toHaveBeenCalledWith(expect.stringContaining('Agent Trace Showcase demo:inject'))
    expect(await store.cancelQueued('delivery-live-1')).toBe(true)
    store.dispose()
    expect(input.disposed()).toBe(true)
  })

  it('fails closed when the Permission Broker denies the ledger query', async () => {
    const live = controls()
    const store = new LiveTraceShowcaseStore(service({ deny: true }), live.agents, live.systemPrompt, 'session-a')
    await store.settled()
    expect(store.getSnapshot()).toMatchObject({
      events: [],
      status: { mode: 'unavailable', completeness: 'unavailable', supportedOperations: [] },
    })
    expect(store.getSnapshot().status.diagnostics.at(-1)).toContain('permission-denied')
    store.dispose()
  })

  it('uses the configured bounded Timeline window for public ledger queries', async () => {
    const input = service()
    const live = controls()
    const store = new LiveTraceShowcaseStore(input, live.agents, live.systemPrompt, 'session-a', 150)
    await store.settled()
    expect(input.query).toHaveBeenCalledWith({ sessionId: 'session-a', afterSeq: -1, limit: 150 })
    expect(store.getSnapshot().range.renderedLimit).toBe(150)
    store.dispose()
  })

  it('never upgrades projected delivery into model-consumed proof', () => {
    const projected = projectAgentEvent({
      ...queued,
      eventId: 'cxevt:session-a:1',
      seq: 1,
      data: { stage: 'projected', target: 'next-step', wakeup: false, owner },
    })
    expect(projected).toMatchObject({ phase: 'projected', modelConsumption: 'unproved' })
  })

  it('uses only public Agent handles and disposables for clear and lifecycle cleanup', async () => {
    const live = controls()
    const store = new LiveTraceShowcaseStore(service(), live.agents, live.systemPrompt, 'session-a')
    await store.settled()
    const sectionId = await store.requestDemo({ kind: 'system-prompt-section' })
    const contextId = await store.requestDemo({ kind: 'system-prompt-context' })
    const preStepId = await store.requestDemo({ kind: 'pre-step' })
    expect([sectionId, contextId, preStepId]).toEqual([
      'agent-trace-showcase-system-prompt-section-1',
      'agent-trace-showcase-system-prompt-context-2',
      'agent-trace-showcase-pre-step-3',
    ])
    expect(await store.clearQueued()).toBe(4)
    expect(live.agent.clearPending).toHaveBeenCalledTimes(1)
    expect(live.releaseSection).toHaveBeenCalledTimes(1)
    expect(live.releaseContext).toHaveBeenCalledTimes(1)
    expect(live.releasePreStep).toHaveBeenCalledTimes(1)
    store.dispose()
    expect(live.agent.clearPending).toHaveBeenCalledTimes(2)
  })

  it('projects host-committed input contribution identity and lifecycle without a parallel event', () => {
    const contribution = projectAgentEvent({
      contract: CORDISX_AGENT_EVENT_CONTRACT,
      schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
      eventId: 'cxevt:session-a:2',
      sessionId: 'session-a',
      contributionId: 'contribution-1',
      turnId: 'turn-1',
      stepId: 'step-1',
      seq: 2,
      time: 1002,
      type: 'input.contribution',
      provenance: 'cordisx',
      source: owner,
      data: { kind: 'system-prompt.section', stage: 'forwarded', evaluationId: 'evaluation-1' },
    })
    expect(contribution).toMatchObject({
      id: 'cxevt:session-a:2',
      requestId: 'contribution-1',
      type: 'input.contribution',
      semanticType: 'system-prompt.section',
      phase: 'forwarded',
      modelConsumption: 'unproved',
    })
  })
})
