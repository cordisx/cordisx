import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_AGENT_EVENT_CONTRACT,
  CORDISX_AGENT_EVENT_SCHEMA_VERSION,
  type CordisXAgentAdapterSource,
  type CordisXAgentEvent,
  type CordisXAgentEventDraft,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
} from '../packages/cli/src/contracts.js'
import { AgentEventLedgerError, CordisXAgentEventLedger, CordisXAgentEventService } from '../packages/cli/src/renderer/agent-events.js'
import { MemoryPermissionPolicyStore, PermissionBroker, normalizePluginManifest } from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'

const source: CordisXAgentAdapterSource = {
  kind: 'adapter', adapterId: 'fixture', adapterVersion: '1', hostId: 'host-1',
}

const pluginSource = {
  kind: 'plugin' as const,
  source: 'file:///plugins/audit.ts',
  id: 'audit',
  version: null,
  generation: 'generation-1',
}

function session(phase: 'opened' | 'resumed' = 'opened'): CordisXAgentEventDraft<'session.lifecycle'> {
  return { sessionId: 'session-1', type: 'session.lifecycle', provenance: 'observed', source, data: { phase, history: 'unknown' } }
}

function external(sessionId: string, seq: number, eventId = `cxevt:${encodeURIComponent(sessionId)}:${seq}`): CordisXAgentEvent<'session.lifecycle'> {
  return {
    contract: CORDISX_AGENT_EVENT_CONTRACT,
    schemaVersion: CORDISX_AGENT_EVENT_SCHEMA_VERSION,
    eventId,
    sessionId,
    seq,
    time: seq,
    type: 'session.lifecycle',
    provenance: 'observed',
    source,
    data: { phase: 'opened', history: 'unknown' },
  }
}

describe('Agent event ledger', () => {
  it('assigns stable per-session ids and publishes one committed range for a batch', () => {
    const ledger = new CordisXAgentEventLedger(() => 1000)
    const listener = vi.fn()
    ledger.subscribe({ sessionId: 'session-1' }, listener)
    const events = ledger.commitBatch([
      session(),
      { sessionId: 'session-1', turnId: 'turn-1', type: 'turn.lifecycle', provenance: 'observed', source, data: { phase: 'started' } },
      { sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1', type: 'content.chunk', provenance: 'observed', source, data: { channel: 'assistant', index: 0, delta: 'hello' } },
    ])
    expect(events.map(event => [event.seq, event.eventId])).toEqual([
      [0, 'cxevt:session-1:0'], [1, 'cxevt:session-1:1'], [2, 'cxevt:session-1:2'],
    ])
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ sessionId: 'session-1', fromSeq: 0, toSeq: 2 })
    expect(Object.isFrozen(events[0])).toBe(true)
  })

  it('keeps pagination snapshot-bounded and enforces the 500-event boundary', () => {
    const ledger = new CordisXAgentEventLedger()
    ledger.commitBatch([session(), ...Array.from({ length: 4 }, (_, index): CordisXAgentEventDraft<'diagnostic'> => ({
      sessionId: 'session-1', type: 'diagnostic', provenance: 'inferred', source,
      data: { code: `fixture-${index}`, message: 'fixture' },
    }))])
    const first = ledger.query({ sessionId: 'session-1', limit: 2 })
    ledger.commit({ sessionId: 'session-1', type: 'diagnostic', provenance: 'inferred', source, data: { code: 'later', message: 'later' } })
    expect(first).toMatchObject({ snapshotSeq: 4, fromSeq: 0, toSeq: 1, nextAfterSeq: 1 })
    const second = ledger.query({ sessionId: 'session-1', afterSeq: first.nextAfterSeq, snapshotSeq: first.snapshotSeq, limit: 500 })
    expect(second.events.map(event => event.seq)).toEqual([2, 3, 4])
    expect(second.nextAfterSeq).toBeUndefined()
    expect(() => ledger.query({ sessionId: 'session-1', limit: 501 })).toThrow(AgentEventLedgerError)
  })

  it('rejects gaps, out-of-order input, duplicate ids, and chunk-index gaps', () => {
    const gap = new CordisXAgentEventLedger()
    expect(() => gap.append(external('session-gap', 1))).toThrowError(expect.objectContaining({ code: 'gap' }))

    const order = new CordisXAgentEventLedger()
    order.append(external('session-order', 0))
    expect(() => order.append(external('session-order', 0))).toThrowError(expect.objectContaining({ code: 'out-of-order' }))

    const duplicate = new CordisXAgentEventLedger()
    duplicate.append(external('session-a', 0))
    expect(() => duplicate.append(external('session-b', 0, 'cxevt:session-a:0'))).toThrowError(expect.objectContaining({ code: 'duplicate' }))

    const chunks = new CordisXAgentEventLedger()
    chunks.commit(session())
    expect(() => chunks.commit({
      sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1', type: 'content.chunk', provenance: 'observed', source,
      data: { channel: 'assistant', index: 1, ref: 'blob-1' },
    })).toThrowError(expect.objectContaining({ code: 'gap' }))

    const atomic = new CordisXAgentEventLedger()
    expect(() => atomic.commitBatch([
      { ...session(), sessionId: 'session-atomic' },
      {
        sessionId: 'session-atomic', turnId: 'turn-1', itemId: 'item-1', type: 'content.chunk', provenance: 'observed', source,
        data: { channel: 'assistant', index: 2, delta: 'gap' },
      },
    ])).toThrowError(expect.objectContaining({ code: 'gap' }))
    expect(atomic.query({ sessionId: 'session-atomic' }).events).toEqual([])
  })

  it('clears subscriptions and rejects access after generation disposal', () => {
    const ledger = new CordisXAgentEventLedger()
    const listener = vi.fn()
    ledger.subscribe({}, listener)
    ledger.dispose()
    expect(() => ledger.commit(session())).toThrowError(expect.objectContaining({ code: 'disposed' }))
    expect(listener).not.toHaveBeenCalled()
  })

  it('enforces owner-stable delivery terminals and prompt contribution ordering', () => {
    const cancelAfterClaim = new CordisXAgentEventLedger()
    const delivery = (stage: string, owner = pluginSource): CordisXAgentEventDraft<'message.delivery'> => ({
      sessionId: 'session-1', messageId: 'message-1', deliveryId: 'delivery-1',
      type: 'message.delivery', provenance: 'cordisx', source: pluginSource,
      data: {
        stage: stage as CordisXAgentEvent<'message.delivery'>['data']['stage'],
        target: 'next-step', wakeup: false, owner,
        ...(stage === 'requested' ? { message: { id: 'message-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: pluginSource } } : {}),
        ...(stage === 'cancelled' ? { cancelReason: 'requested' as const, diagnostic: { code: 'interrupted', message: 'cancelled' } } : {}),
      },
    })
    for (const stage of ['requested', 'permission', 'queued', 'claimed']) cancelAfterClaim.commit(delivery(stage))
    expect(() => cancelAfterClaim.commit(delivery('cancelled'))).toThrowError(expect.objectContaining({ code: 'invalid' }))

    const ownerChange = new CordisXAgentEventLedger()
    ownerChange.commit(delivery('requested'))
    expect(() => ownerChange.commit(delivery('failed', { ...pluginSource, id: 'other' }))).toThrowError(expect.objectContaining({ code: 'invalid' }))

    const terminal = new CordisXAgentEventLedger()
    for (const stage of ['requested', 'permission', 'queued', 'claimed', 'projected', 'forwarded']) terminal.commit(delivery(stage))
    expect(() => terminal.commit(delivery('failed'))).toThrowError(expect.objectContaining({ code: 'invalid' }))

    const prompt = new CordisXAgentEventLedger()
    expect(() => prompt.commit({
      sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', contributionId: 'contribution-1',
      type: 'input.contribution', provenance: 'cordisx', source: pluginSource,
      data: { kind: 'system-prompt.section', stage: 'evaluated', evaluationId: 'evaluation-1' },
    })).toThrowError(expect.objectContaining({ code: 'invalid' }))
    prompt.commit({
      sessionId: 'session-1', contributionId: 'contribution-1',
      type: 'input.contribution', provenance: 'cordisx', source: pluginSource,
      data: { kind: 'system-prompt.section', stage: 'registered', capability: 'agent.prompt.section' },
    })
    prompt.commit({
      sessionId: 'session-1', contributionId: 'contribution-1',
      type: 'input.contribution', provenance: 'cordisx', source: pluginSource,
      data: { kind: 'system-prompt.section', stage: 'released', releaseReason: 'explicit' },
    })
    expect(() => prompt.commit({
      sessionId: 'session-1', contributionId: 'contribution-1',
      type: 'input.contribution', provenance: 'cordisx', source: pluginSource,
      data: { kind: 'system-prompt.section', stage: 'released', releaseReason: 'explicit' },
    })).toThrowError(expect.objectContaining({ code: 'duplicate' }))
  })

  it('brokers read/query and subscription by plugin identity and session scope', async () => {
    const ledger = new CordisXAgentEventLedger()
    ledger.commit(session())
    const identity = { source: 'file:///plugins/reader.ts', id: 'reader' }
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: vi.fn(async () => 'allow' as const) })
    broker.register(identity, normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id: identity.id,
      capabilities: [{
        name: 'agent.events.read', required: false,
        reason: { key: 'permission.agent-events-read', fallback: 'Read Agent events' },
        scope: { sessionIds: ['session-1'] },
      }],
    }, identity.id))
    broker.setPolicy(identity, 'agent.events.read', 'allow')
    const root = new Context()
    const fiber = root.plugin(CordisXAgentEventService, {
      ledger, broker,
      status: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-only', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
    })
    await fiber
    const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    await expect(ctx.agentEvents.query({ sessionId: 'session-1' })).resolves.toMatchObject({ ok: true, value: { events: [{ seq: 0 }] } })
    await expect(ctx.agentEvents.query({ sessionId: 'session-2' })).resolves.toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
    const listener = vi.fn()
    const dispose = ctx.agentEvents.subscribe({ sessionId: 'session-1' }, listener)
    await Promise.resolve()
    ledger.commit({ sessionId: 'session-1', type: 'diagnostic', provenance: 'inferred', source, data: { code: 'new', message: 'new' } })
    expect(listener).toHaveBeenCalledWith({ sessionId: 'session-1', fromSeq: 1, toSeq: 1 })
    const broad = vi.fn()
    ctx.agentEvents.subscribe({}, broad)
    await Promise.resolve()
    ledger.commit({ sessionId: 'session-1', type: 'diagnostic', provenance: 'inferred', source, data: { code: 'scoped', message: 'scoped' } })
    expect(broad).not.toHaveBeenCalled()
    expect(broker.snapshots()[0]).toMatchObject({ denialCount: 2 })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    ledger.subscribe({}, () => { throw new Error('subscriber failure') })
    expect(() => ledger.commit({ sessionId: 'session-1', type: 'diagnostic', provenance: 'inferred', source, data: { code: 'safe', message: 'safe' } })).not.toThrow()
    expect(consoleError).toHaveBeenCalledWith('CordisX Agent event subscriber failed', expect.any(Error))
    consoleError.mockRestore()
    expect(ledger.latestEventId('session-1')).toBe('cxevt:session-1:3')
    expect(ctx.agentEvents.status()).toMatchObject({ secondConnectionCreated: false, rawBridgeExposed: false })
    expect(Object.keys(ctx.agentEvents)).not.toEqual(expect.arrayContaining(['ledger', 'broker', 'adapter']))
    dispose()
    await fiber.dispose()
    broker.dispose()
  })
})
