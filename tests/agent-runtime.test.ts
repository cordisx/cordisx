import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXCapabilityDeclaration,
  type CordisXPluginIdentity,
  type CordisXPluginManifestV1,
  type CordisXUserMessage,
} from '../packages/cli/src/contracts.js'
import {
  CordisXAgentService,
  CordisXHostAgentRuntime,
  CordisXSystemPromptService,
  type CordisXAgentAdapter,
  type CordisXAgentDeliveryControl,
  type CordisXAgentDeliveryInput,
} from '../packages/cli/src/renderer/agent.js'
import { MemoryPermissionPolicyStore, PermissionBroker, normalizePluginManifest } from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/service.js'
import { UnavailableCodexHostAdapter } from '../packages/cli/src/adapters/codex-agent.js'

const identity: CordisXPluginIdentity = { source: 'file:///plugins/audit.ts', id: 'audit' }

function capability(name: CordisXCapabilityDeclaration['name']): CordisXCapabilityDeclaration {
  return { name, required: false, reason: { key: `permission.${name}`, fallback: name }, scope: { sessionIds: ['session-1'] } }
}

function manifest(names: readonly CordisXCapabilityDeclaration['name'][]): CordisXPluginManifestV1 {
  return normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id: identity.id,
    capabilities: names.map(capability),
  }, identity.id)
}

class RecordingAdapter implements CordisXAgentAdapter {
  readonly deliveries: CordisXAgentDeliveryInput[] = []
  agentStatus() {
    return {
      hostId: 'fixture', hostName: 'Fixture', mode: 'read-write' as const, adapterId: 'fixture', adapterVersion: '1',
      experimental: [], diagnostics: [], secondConnectionCreated: false as const, rawBridgeExposed: false as const,
    }
  }
  async deliver(input: CordisXAgentDeliveryInput, control: CordisXAgentDeliveryControl) {
    this.deliveries.push(input)
    control.claim({ turnId: 'turn-1', stepId: 'step-1' })
    control.projected({ contextId: 'context-1' })
    return { terminal: 'forwarded' as const, turnId: 'turn-1', stepId: 'step-1', contextId: 'context-1' }
  }
}

function allowedRuntime(adapter: CordisXAgentAdapter = new RecordingAdapter(), names: readonly CordisXCapabilityDeclaration['name'][] = ['agent.messages.append']) {
  const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: vi.fn(async () => 'allow' as const) })
  broker.register(identity, manifest(names))
  for (const name of names) broker.setPolicy(identity, name, 'allow')
  return { broker, runtime: new CordisXHostAgentRuntime({ adapter, broker, generation: 'generation-1', now: () => 1000 }) }
}

function observed(id: string, text: string): CordisXUserMessage {
  return Object.freeze({
    id, role: 'user', content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({ kind: 'adapter', adapterId: 'fixture', adapterVersion: '1', hostId: 'fixture' }),
  })
}

describe('Agent runtime', () => {
  it('implements send plus DSH followup/steer/inject and records the full delivery chain', async () => {
    const adapter = new RecordingAdapter()
    const { runtime } = allowedRuntime(adapter)
    const root = new Context()
    const fiber = root.plugin(CordisXAgentService, runtime)
    await fiber
    const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    const inject = ctx.agents.get('session-1').inject('inject')
    ctx.agents.get('session-1').steer('steer')
    ctx.agents.get('session-1').followup('followup')
    expect(inject.snapshot()).toMatchObject({
      contract: 'cordisx.agent-delivery/v1', schemaVersion: 1,
      deliveryId: inject.deliveryId, sessionId: 'session-1', stage: 'requested', valid: true,
    })
    await runtime.settled()
    expect(inject.snapshot()).toMatchObject({ stage: 'forwarded', terminal: true, cancellable: false, valid: true })
    expect(adapter.deliveries.map(item => [item.target, item.wakeup])).toEqual([
      ['next-step', false], ['next-step', true], ['next-turn', true],
    ])
    const stages = runtime.ledger.query({ sessionId: 'session-1', limit: 100 }).events
      .filter(event => event.messageId === adapter.deliveries[0]?.message.id)
      .map(event => (event.data as { stage: string }).stage)
    expect(stages).toEqual(['requested', 'permission', 'queued', 'claimed', 'projected', 'forwarded'])
    expect(adapter.deliveries[0]?.message).toMatchObject({
      role: 'user', source: { kind: 'plugin', source: identity.source, id: identity.id, version: null, generation: 'generation-1' },
    })
    await fiber.dispose()
    await runtime.dispose()
  })

  it('fences cancellation at claim, clears only the current owner, and keeps terminal operations idempotent', async () => {
    let releaseQueued!: () => void
    const queuedGate = new Promise<void>(resolve => { releaseQueued = resolve })
    const queuedAdapter: CordisXAgentAdapter = {
      agentStatus: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-write', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
      deliver: vi.fn(async (_input, control) => {
        await queuedGate
        if (!control.claim()) return { terminal: 'failed', diagnostic: { code: 'interrupted', message: 'cancelled before claim' } }
        control.projected()
        return { terminal: 'forwarded' }
      }),
    }
    const other = { source: 'file:///plugins/other.ts', id: 'other' }
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: vi.fn(async () => 'allow' as const) })
    for (const plugin of [identity, other]) {
      broker.register(plugin, normalizePluginManifest({
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: plugin.id,
        capabilities: [capability('agent.messages.append')],
      }, plugin.id))
      broker.setPolicy(plugin, 'agent.messages.append', 'allow')
    }
    const runtime = new CordisXHostAgentRuntime({ adapter: queuedAdapter, broker, generation: 'generation-clear' })
    const owned = runtime.send(identity, 'session-1', 'owned', 'next-step', false)
    const foreign = runtime.send(other, 'session-1', 'foreign', 'next-step', false)
    await vi.waitFor(() => expect(owned.snapshot().stage).toBe('queued'))
    const cleared = runtime.clearPending(identity, 'session-1')
    expect(cleared.cancelled.map(item => item.deliveryId)).toEqual([owned.deliveryId])
    expect(cleared.retained).toEqual([])
    expect(foreign.snapshot()).toMatchObject({ stage: 'queued', valid: true })
    expect(owned.cancel()).toMatchObject({ ok: false, reason: 'terminal', snapshot: { stage: 'cancelled' } })
    releaseQueued()
    await runtime.settled()
    expect(foreign.snapshot().stage).toBe('forwarded')
    expect(runtime.ledger.query({ sessionId: 'session-1' }).events
      .filter(event => event.deliveryId === owned.deliveryId)
      .map(event => (event.data as { stage: string }).stage))
      .toEqual(['requested', 'permission', 'queued', 'cancelled'])
    await runtime.dispose()

    let releaseClaimed!: () => void
    const claimedGate = new Promise<void>(resolve => { releaseClaimed = resolve })
    const claimedAdapter: CordisXAgentAdapter = {
      ...queuedAdapter,
      deliver: vi.fn(async (_input, control) => {
        control.claim({ turnId: 'turn-claim' })
        await claimedGate
        control.projected({ stepId: 'step-claim' })
        return { terminal: 'forwarded' }
      }),
    }
    const { runtime: claimedRuntime } = allowedRuntime(claimedAdapter)
    const claimed = claimedRuntime.send(identity, 'session-1', 'claimed', 'next-step', false)
    await vi.waitFor(() => expect(claimed.snapshot().stage).toBe('claimed'))
    expect(claimed.cancel()).toMatchObject({ ok: false, reason: 'irreversible', snapshot: { stage: 'claimed' } })
    releaseClaimed()
    await claimedRuntime.settled()
    expect(claimed.cancel()).toMatchObject({ ok: false, reason: 'terminal', snapshot: { stage: 'forwarded' } })
    expect(claimedRuntime.ledger.query({ sessionId: 'session-1' }).events
      .filter(event => event.deliveryId === claimed.deliveryId)
      .some(event => (event.data as { stage: string }).stage === 'cancelled')).toBe(false)
    await claimedRuntime.dispose()
  })

  it('invalidates old handles with auditable terminals on owner and generation disposal', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const adapter: CordisXAgentAdapter = {
      agentStatus: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-write', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
      deliver: vi.fn(async (_input, control) => {
        control.claim()
        await gate
        control.projected()
        return { terminal: 'forwarded' }
      }),
    }
    const { runtime } = allowedRuntime(adapter)
    const handle = runtime.send(identity, 'session-1', 'in flight', 'next-step', true)
    await vi.waitFor(() => expect(handle.snapshot().stage).toBe('claimed'))
    runtime.releaseOwner(identity, 'plugin-blocked')
    expect(handle.snapshot()).toMatchObject({ stage: 'claimed', terminal: false, valid: false })
    expect(handle.cancel()).toMatchObject({ ok: false, reason: 'stale-generation' })
    release()
    await runtime.settled()
    expect(handle.snapshot()).toMatchObject({ stage: 'failed', terminal: true, valid: false, diagnostic: { code: 'adapter-failure' } })
    expect(runtime.ledger.query({ sessionId: 'session-1' }).events.at(-1)).toMatchObject({
      type: 'message.delivery', data: { stage: 'failed', diagnostic: { code: 'adapter-failure' } },
    })
    await runtime.dispose()

    let releaseGeneration!: () => void
    const generationGate = new Promise<void>(resolve => { releaseGeneration = resolve })
    const generationAdapter: CordisXAgentAdapter = {
      ...adapter,
      deliver: vi.fn(async (_input, control) => {
        control.claim()
        await generationGate
        control.projected()
        return { terminal: 'forwarded' }
      }),
    }
    const { runtime: oldRuntime } = allowedRuntime(generationAdapter)
    const oldHandle = oldRuntime.send(identity, 'session-1', 'old generation', 'next-step', false)
    await vi.waitFor(() => expect(oldHandle.snapshot().stage).toBe('claimed'))
    const disposing = oldRuntime.dispose()
    await vi.waitFor(() => expect(oldHandle.snapshot()).toMatchObject({ stage: 'claimed', valid: false }))
    releaseGeneration()
    await disposing
    expect(oldHandle.snapshot()).toMatchObject({ stage: 'failed', terminal: true, valid: false })
    expect(oldHandle.cancel()).toMatchObject({ ok: false, reason: 'stale-generation' })
  })

  it('releases only the retiring module generation for the same plugin identity', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const adapter: CordisXAgentAdapter = {
      agentStatus: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-write', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
      deliver: vi.fn(async (_input, control) => {
        await gate
        if (!control.claim()) return { terminal: 'failed', diagnostic: { code: 'interrupted', message: 'retired' } }
        control.projected()
        return { terminal: 'forwarded' }
      }),
    }
    const { runtime } = allowedRuntime(adapter)
    const oldHandle = runtime.send(identity, 'session-1', 'old', 'next-step', false, 'module-old')
    const newHandle = runtime.send(identity, 'session-1', 'new', 'next-step', false, 'module-new')
    await vi.waitFor(() => expect(oldHandle.snapshot().stage).toBe('queued'))
    runtime.releaseOwner(identity, 'generation-replaced', 'module-old')
    expect(oldHandle.snapshot().valid).toBe(false)
    expect(newHandle.snapshot().valid).toBe(true)
    expect(newHandle.snapshot().owner.generation).toBe('module-new')
    release()
    await runtime.settled()
    expect(oldHandle.cancel()).toMatchObject({ ok: false, reason: 'stale-generation' })
    expect(newHandle.snapshot()).toMatchObject({ stage: 'forwarded', valid: true })
    await runtime.dispose()
  })

  it('records permission timeout then failure without adapter dispatch', async () => {
    const adapter = new RecordingAdapter()
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: vi.fn(() => new Promise<'allow'>(() => {})) },
      () => new Date('2026-08-24T00:00:00.000Z'),
      5,
    )
    broker.register(identity, manifest(['agent.messages.append']))
    const runtime = new CordisXHostAgentRuntime({ adapter, broker, generation: 'generation-timeout' })
    runtime.send(identity, 'session-1', 'timeout', 'next-step', false)
    await runtime.settled()
    expect(adapter.deliveries).toHaveLength(0)
    const events = runtime.ledger.query({ sessionId: 'session-1' }).events
    expect(events.map(event => (event.data as { stage: string }).stage)).toEqual(['requested', 'permission', 'failed'])
    expect(events[1]?.data).toMatchObject({ decision: 'timeout', diagnostic: { code: 'timeout' } })
    await runtime.dispose()
  })

  it('fails honestly when the current connection is unavailable', async () => {
    const { runtime } = allowedRuntime(new UnavailableCodexHostAdapter())
    runtime.send(identity, 'session-1', 'queued but unavailable', 'next-step', false)
    await runtime.settled()
    const events = runtime.ledger.query({ sessionId: 'session-1' }).events
    expect(events.map(event => (event.data as { stage: string }).stage)).toEqual(['requested', 'permission', 'queued', 'failed'])
    expect(events.at(-1)?.data).toMatchObject({ diagnostic: { code: 'current-connection-client-unavailable' } })
    expect(runtime.status()).toMatchObject({ mode: 'unavailable', secondConnectionCreated: false, rawBridgeExposed: false })
    await runtime.dispose()
  })

  it('records explicit expired and cancelled terminal paths and enforces session scope', async () => {
    const terminalAdapter: CordisXAgentAdapter = {
      agentStatus: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-write', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
      deliver: vi.fn(async (_input, control) => {
        control.claim()
        return { terminal: 'expired', diagnostic: { code: 'timeout', message: 'expired' } }
      }),
    }
    const { runtime: expiredRuntime } = allowedRuntime(terminalAdapter)
    expiredRuntime.send(identity, 'session-1', 'expired', 'next-step', false)
    await expiredRuntime.settled()
    expect(expiredRuntime.ledger.query({ sessionId: 'session-1' }).events
      .map(event => (event.data as { stage: string }).stage))
      .toEqual(['requested', 'permission', 'queued', 'claimed', 'expired'])
    await expiredRuntime.dispose()

    const { runtime: cancelledRuntime } = allowedRuntime(new RecordingAdapter())
    const cancelled = cancelledRuntime.send(identity, 'session-1', 'cancelled', 'next-step', false)
    expect(cancelled.cancel()).toMatchObject({ ok: true, snapshot: { stage: 'cancelled', terminal: true } })
    await cancelledRuntime.settled()
    expect(cancelledRuntime.ledger.query({ sessionId: 'session-1' }).events
      .map(event => (event.data as { stage: string }).stage))
      .toEqual(['requested', 'cancelled'])
    await cancelledRuntime.dispose()
    const adapter = new RecordingAdapter()
    const { runtime } = allowedRuntime(adapter)
    runtime.send(identity, 'session-outside-scope', 'denied', 'next-step', false)
    await runtime.settled()
    expect(adapter.deliveries).toHaveLength(0)
    expect(runtime.ledger.query({ sessionId: 'session-outside-scope' }).events.at(-1)?.data).toMatchObject({
      stage: 'failed', diagnostic: { code: 'permission-scope-denied' },
    })
    await runtime.dispose()
  })

  it('runs a complete sourced waterfall, preserves originals for append, and separately brokers transforms', async () => {
    const { runtime } = allowedRuntime(new RecordingAdapter(), ['agent.messages.append', 'agent.messages.transform'])
    const original = [observed('user-1', 'first'), observed('user-2', 'second')]
    const seen: string[][] = []
    runtime.registerPreStep(identity, input => {
      seen.push(input.messages.map(message => message.id))
      return { kind: 'append', messages: ['plugin append'] }
    })
    runtime.registerPreStep(identity, input => {
      seen.push(input.messages.map(message => message.id))
      return { kind: 'transform', operations: [{ type: 'move', messageId: 'user-2', beforeMessageId: 'user-1' }] }
    })
    const outcome = await runtime.runPreStep({ sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', messages: original })
    expect(seen[0]).toEqual(['user-1', 'user-2'])
    expect(seen[1]?.slice(0, 2)).toEqual(['user-1', 'user-2'])
    expect(outcome.status).toBe('continued')
    expect(outcome.messages.map(message => message.id).slice(0, 2)).toEqual(['user-2', 'user-1'])
    expect(outcome.messages.at(-1)?.source).toMatchObject({ kind: 'plugin', id: identity.id, generation: 'generation-1' })
    expect(original.map(message => message.id)).toEqual(['user-1', 'user-2'])
    await runtime.dispose()
  })

  it('writes successful pre-step and system-prompt contribution lifecycles into the shared ledger', async () => {
    const { runtime } = allowedRuntime(new RecordingAdapter(), [
      'agent.messages.append', 'agent.prompt.section', 'agent.prompt.context',
    ])
    const section = runtime.registerPrompt(identity, 'section', { sessionId: 'session-1', id: 'policy', content: 'Policy' })
    const context = runtime.registerPrompt(identity, 'context', { sessionId: 'session-1', id: 'facts', content: 'Facts' })
    runtime.registerPreStep(identity, () => ({ kind: 'append', messages: ['plugin append'] }))
    await runtime.settled()
    const outcome = await runtime.runPreStep({
      sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', messages: [observed('user-1', 'first')],
    })
    expect(outcome).toMatchObject({
      status: 'continued',
      prompt: {
        sections: [{ id: 'policy', source: { kind: 'plugin', id: identity.id, generation: 'generation-1' } }],
        contexts: [{ id: 'facts', source: { kind: 'plugin', id: identity.id, generation: 'generation-1' } }],
      },
    })
    section()
    context()
    const contributions = runtime.ledger.query({ sessionId: 'session-1', limit: 100 }).events
      .filter(event => event.type === 'input.contribution')
    const byKind = (kind: string) => contributions
      .filter(event => (event.data as { kind: string }).kind === kind)
      .map(event => (event.data as { stage: string }).stage)
    expect(byKind('pre-step.append')).toEqual(['evaluated', 'projected', 'forwarded'])
    expect(byKind('system-prompt.section')).toEqual(['registered', 'evaluated', 'projected', 'forwarded', 'released'])
    expect(byKind('system-prompt.context')).toEqual(['registered', 'evaluated', 'projected', 'forwarded', 'released'])
    expect(contributions.filter(event => (event.data as { stage: string }).stage !== 'registered')).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: 'turn-1', stepId: 'step-1', source: expect.objectContaining({ id: identity.id, generation: 'generation-1' }) }),
    ]))
    expect(contributions.some(event => JSON.stringify(event).includes('model-consumed'))).toBe(false)
    await runtime.dispose()
  })

  it('records denied prompt and failed pre-step contributions without projecting them', async () => {
    const { runtime } = allowedRuntime(new RecordingAdapter(), ['agent.messages.append'])
    runtime.registerPrompt(identity, 'section', { sessionId: 'session-1', id: 'denied', content: 'Denied' })
    await runtime.settled()
    const promptEvents = runtime.ledger.query({ sessionId: 'session-1' }).events
      .filter(event => event.type === 'input.contribution')
    expect(promptEvents).toEqual([
      expect.objectContaining({ data: expect.objectContaining({
        kind: 'system-prompt.section', stage: 'failed', diagnostic: expect.objectContaining({ code: 'permission-undeclared' }),
      }) }),
    ])
    expect(runtime.promptSnapshot('session-1')).toEqual([])

    runtime.registerPreStep(identity, () => ({ kind: 'append', messages: [] }))
    const outcome = await runtime.runPreStep({
      sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', messages: [observed('user-1', 'first')],
    })
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'invalid-request' } })
    expect(runtime.ledger.query({ sessionId: 'session-1', limit: 100 }).events.at(-1)).toMatchObject({
      type: 'input.contribution', data: { kind: 'pre-step.append', stage: 'failed', diagnostic: { code: 'invalid-request' } },
    })
    await runtime.dispose()
  })

  it('enforces a distinct reject capability and disposes pre-step/prompt registrations with their fiber', async () => {
    const { runtime } = allowedRuntime(new RecordingAdapter(), ['agent.messages.append', 'agent.prompt.section'])
    const root = new Context()
    const agentFiber = root.plugin(CordisXAgentService, runtime)
    const promptFiber = root.plugin(CordisXSystemPromptService, runtime)
    await agentFiber
    await promptFiber
    const ctx = root.extend({ [CORDISX_PLUGIN_ID]: identity.id, [CORDISX_PLUGIN_SOURCE]: identity.source })
    const pluginFiber = ctx.plugin({
      inject: ['agents', 'systemPrompt'],
      apply(pluginCtx: Context) {
        pluginCtx.agents.preStep(() => ({ kind: 'reject', reason: 'blocked' }))
        pluginCtx.systemPrompt.section({ sessionId: 'session-1', id: 'audit', content: 'Audit policy' })
      },
    })
    await pluginFiber
    await runtime.settled()
    expect(runtime.promptSnapshot('session-1')).toHaveLength(1)
    const denied = await runtime.runPreStep({ sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', messages: [observed('user-1', 'first')] })
    expect(denied).toMatchObject({ status: 'failed', error: { code: 'permission-undeclared' } })
    await pluginFiber.dispose()
    expect(runtime.promptSnapshot('session-1')).toHaveLength(0)
    const afterDispose = await runtime.runPreStep({ sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-2', messages: [observed('user-1', 'first')] })
    expect(afterDispose.status).toBe('continued')
    await promptFiber.dispose()
    await agentFiber.dispose()
    await runtime.dispose()
  })

  it('contains pre-step handler failures and invalid adapter forwarding claims', async () => {
    const invalidAdapter: CordisXAgentAdapter = {
      agentStatus: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-write', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
      deliver: vi.fn(async () => ({ terminal: 'forwarded' })),
    }
    const { runtime } = allowedRuntime(invalidAdapter)
    runtime.registerPreStep(identity, () => { throw new Error('plugin failure') })
    const preStep = await runtime.runPreStep({
      sessionId: 'session-1', turnId: 'turn-1', stepId: 'step-1', messages: [observed('user-1', 'first')],
    })
    expect(preStep).toMatchObject({ status: 'failed', error: { code: 'adapter-failure', message: expect.stringContaining('plugin failure') } })
    expect(runtime.ledger.query({ sessionId: 'session-1' }).events.at(-1)).toMatchObject({
      type: 'diagnostic', provenance: 'cordisx', source: { kind: 'plugin', id: identity.id },
    })
    runtime.send(identity, 'session-1', 'invalid adapter', 'next-step', false)
    await runtime.settled()
    const delivery = runtime.ledger.query({ sessionId: 'session-1' }).events.filter(event => event.type === 'message.delivery')
    expect((delivery.at(-1)?.data as { stage: string; diagnostic: { code: string } })).toMatchObject({
      stage: 'failed', diagnostic: { code: 'adapter-failure' },
    })
    expect(delivery.some(event => (event.data as { stage: string }).stage === 'forwarded')).toBe(false)
    await runtime.dispose()
  })
})
