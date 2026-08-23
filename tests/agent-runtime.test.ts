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
  async deliver(input: CordisXAgentDeliveryInput) {
    this.deliveries.push(input)
    return { terminal: 'forwarded' as const, claimed: true, projected: true, turnId: 'turn-1', stepId: 'step-1', contextId: 'context-1' }
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
    ctx.agents.get('session-1').inject('inject')
    ctx.agents.get('session-1').steer('steer')
    ctx.agents.get('session-1').followup('followup')
    await runtime.settled()
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
    const terminalAdapter = (terminal: 'expired' | 'cancelled'): CordisXAgentAdapter => ({
      agentStatus: () => ({
        hostId: 'fixture', hostName: 'Fixture', mode: 'read-write', adapterId: 'fixture', adapterVersion: '1',
        experimental: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
      }),
      deliver: vi.fn(async () => ({
        terminal, claimed: true, projected: false,
        diagnostic: { code: terminal === 'expired' ? 'timeout' : 'interrupted', message: terminal },
      })),
    })
    for (const terminal of ['expired', 'cancelled'] as const) {
      const { runtime } = allowedRuntime(terminalAdapter(terminal))
      runtime.send(identity, 'session-1', terminal, 'next-step', false)
      await runtime.settled()
      const events = runtime.ledger.query({ sessionId: 'session-1' }).events
      expect(events.map(event => (event.data as { stage: string }).stage)).toEqual(['requested', 'permission', 'queued', 'claimed', terminal])
      await runtime.dispose()
    }
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
      deliver: vi.fn(async () => ({ terminal: 'forwarded', claimed: false, projected: false })),
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
