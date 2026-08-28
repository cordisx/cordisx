import { describe, expect, it, vi } from 'vitest'
import { UnavailableCodexHostAdapter } from '../packages/cli/src/adapters/codex-agent.js'
import { createCodexAgentConnector } from '../packages/cli/src/adapters/codex-agent-connector.js'
import {
  CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1,
  CORDISX_CONNECTOR_COMMAND_SCHEMA_V1,
  CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1,
  CordisXConnectorBroker,
  type CordisXConnectorCommand,
  type CordisXHostConnector,
} from '../packages/cli/src/renderer/connectors.js'

const descriptor = Object.freeze({
  $schema: CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1,
  contract: 'cordisx.connector-service-descriptor/v1' as const,
  schemaVersion: 1 as const,
  connectorId: 'fixture.connector',
  protocolVersion: 1 as const,
  capabilities: Object.freeze([
    'conversation.open', 'conversation.continue', 'message.send', 'events.receive',
    'run.stop', 'conversation.close', 'lifecycle.dispose',
  ] as const),
})

function command<Value extends Omit<CordisXConnectorCommand, '$schema' | 'contract' | 'schemaVersion' | 'commandId'>>(
  registration: CordisXConnectorCommand['registration'],
  commandId: string,
  value: Value,
): CordisXConnectorCommand {
  return {
    $schema: CORDISX_CONNECTOR_COMMAND_SCHEMA_V1,
    contract: 'cordisx.connector-command/v1',
    schemaVersion: 1,
    commandId,
    registration,
    ...value,
  } as CordisXConnectorCommand
}

function connector(): CordisXHostConnector {
  return {
    descriptor,
    execute: vi.fn(async value => {
      if (value.type === 'conversation.open') return { ok: true as const, value: { kind: 'opened' as const, conversation: 'conversation-opaque', run: 'run-opaque' } }
      if (value.type === 'message.send') return { ok: true as const, value: { kind: 'sent' as const, conversation: value.conversation, run: 'run-after-send' } }
      if (value.type === 'run.stop') return { ok: true as const, value: { kind: 'stopped' as const, conversation: value.conversation, run: value.run } }
      return { ok: true as const, value: { kind: 'closed' as const, conversation: value.conversation } }
    }),
  }
}

describe('Host Connector broker', () => {
  it('Host-stamps registrations, preserves opaque handles, publishes ordered events, and redacts its snapshot', async () => {
    const broker = new CordisXConnectorBroker({
      nonce: () => 'host-issued-registration',
      now: () => new Date('2026-08-28T00:00:00.000Z'),
      authorize: async () => ({ ok: true as const, value: true as const }),
    })
    const registered = broker.register(connector())
    expect(registered).toMatchObject({ ok: true, value: { registration: { registrationId: 'cxconnector:host-issued-registration', connectorId: 'fixture.connector', generation: 1 } } })
    if (!registered.ok) throw new Error('registration failed')
    const registration = registered.value.registration
    const events: unknown[] = []
    const subscription = broker.subscribe(registration, -1, event => { events.push(event) })
    expect(subscription.ok).toBe(true)

    await expect(broker.command(command(registration, 'open', { type: 'conversation.open', open: { mode: 'create' } }))).resolves.toMatchObject({ ok: true, value: { conversation: 'conversation-opaque' } })
    await broker.command(command(registration, 'send', {
      type: 'message.send', conversation: 'conversation-opaque',
      message: { messageId: 'message-opaque', direction: 'outbound', parts: [{ kind: 'text', text: 'hello' }] },
    }))
    await broker.command(command(registration, 'stop', { type: 'run.stop', conversation: 'conversation-opaque', run: 'run-opaque' }))
    await broker.command(command(registration, 'close', { type: 'conversation.close', conversation: 'conversation-opaque' }))

    expect(events).toMatchObject([
      { sequence: 0, type: 'conversation.opened', conversation: 'conversation-opaque' },
      { sequence: 1, type: 'run.started', run: 'run-opaque' },
      { sequence: 2, type: 'message.sent', message: { direction: 'outbound' } },
      { sequence: 3, type: 'run.started', run: 'run-after-send' },
      { sequence: 4, type: 'run.stopped', run: 'run-opaque' },
      { sequence: 5, type: 'conversation.closed', conversation: 'conversation-opaque' },
    ])
    expect(broker.discover()).toEqual([registered.value])
    expect(broker.snapshot()).toMatchObject({ rawBridgeExposed: false, secondConnectionCreated: false, registrations: [{ state: 'active', eventCount: 6 }] })
    expect(JSON.stringify(broker.snapshot())).not.toContain('adapter')
  })

  it('fences replacement/disposal by registration generation and cannot accept raw command fields', async () => {
    const broker = new CordisXConnectorBroker({ nonce: (() => { let value = 0; return () => `host-${++value}` })() })
    const first = broker.register(connector())
    if (!first.ok) throw new Error('first registration failed')
    const observed: unknown[] = []
    broker.subscribe(first.value.registration, -1, event => { observed.push(event) })
    const second = broker.register(connector())
    if (!second.ok) throw new Error('second registration failed')
    expect(observed).toMatchObject([{ type: 'connector.disposed', disposeReason: 'generation-replaced', sequence: 0 }])
    expect(second.value.registration.generation).toBe(2)
    await expect(broker.command(command(first.value.registration, 'old', { type: 'conversation.open', open: { mode: 'create' } }))).resolves.toMatchObject({ ok: false, error: { code: 'registration-disposed' } })
    const raw = { ...command(second.value.registration, 'bad', { type: 'conversation.open', open: { mode: 'create' } }), rawBridge: 'forbidden' } as CordisXConnectorCommand
    await expect(broker.command(raw)).resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } })
  })

  it('applies Host permission before dispatch and keeps every current Agent native operation typed unavailable', async () => {
    const denied = new CordisXConnectorBroker({ authorize: vi.fn(async () => ({ ok: false as const, error: { code: 'permission-denied' as const, message: 'denied' } })) })
    const deniedConnector = connector()
    const deniedRegistration = denied.register(deniedConnector)
    if (!deniedRegistration.ok) throw new Error('registration failed')
    await expect(denied.command(command(deniedRegistration.value.registration, 'denied', { type: 'conversation.open', open: { mode: 'create' } }))).resolves.toMatchObject({ ok: false, error: { code: 'permission-denied' } })
    expect(deniedConnector.execute).not.toHaveBeenCalled()

    const broker = new CordisXConnectorBroker()
    const registered = broker.register(createCodexAgentConnector(new UnavailableCodexHostAdapter()))
    if (!registered.ok) throw new Error('Agent Connector registration failed')
    const registration = registered.value.registration
    const commands: readonly CordisXConnectorCommand[] = [
      command(registration, 'open', { type: 'conversation.open', open: { mode: 'create' } }),
      command(registration, 'send', { type: 'message.send', conversation: 'not-issued', message: { messageId: 'message-1', direction: 'outbound', parts: [{ kind: 'text', text: 'hello' }] } }),
      command(registration, 'stop', { type: 'run.stop', conversation: 'not-issued', run: 'not-issued' }),
      command(registration, 'close', { type: 'conversation.close', conversation: 'not-issued' }),
    ]
    for (const item of commands) await expect(broker.command(item)).resolves.toMatchObject({ ok: false, error: { code: 'current-connection-client-unavailable' } })
  })

  it('injects only a Host-bound public client, returns typed authorization outcomes, and keeps the wire subscription serializable', async () => {
    const broker = new CordisXConnectorBroker({ nonce: (() => { let value = 0; return () => `bound-${++value}` })() })
    const registered = broker.register(connector())
    if (!registered.ok) throw new Error('registration failed')
    const registration = registered.value.registration
    const client = broker.bind({
      active: () => true,
      authorize: async capability => ({ capability, state: 'allowed' as const, code: 'allowed' as const }),
    })

    expect(client).toMatchObject({ $schema: CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1, contract: 'cordisx.bound-connector-client/v1', schemaVersion: 1 })
    expect(Object.keys(client)).not.toEqual(expect.arrayContaining(['caller', 'principal', 'identity', 'bridge', 'transport']))
    const discovery = await client.discover()
    expect(discovery).toMatchObject({ status: 'accepted', type: 'discover', snapshot: { registrations: [{ registration }] } })
    expect(JSON.stringify(discovery)).not.toMatch(/caller|principal|identity|bridge|transport/i)

    const opened = await client.execute(command(registration, 'public-open', { type: 'conversation.open', open: { mode: 'create' } }))
    expect(opened).toMatchObject({ status: 'accepted', execution: { kind: 'conversation.opened', conversation: 'conversation-opaque' } })
    const subscribed = await client.subscribe(registration, -1)
    expect(subscribed.result).toMatchObject({ status: 'accepted', type: 'subscribe', subscription: { registration, afterSequence: -1, snapshotSequence: 1 } })
    expect(JSON.stringify(subscribed.result)).not.toContain('pages')
    if (!('handle' in subscribed)) throw new Error('subscription should be accepted')
    expect(subscribed.handle.pages).toBeDefined()

    const sent = await client.execute(command(registration, 'public-send', {
      type: 'message.send', conversation: 'conversation-opaque',
      message: { messageId: 'public-message', direction: 'outbound', parts: [{ kind: 'text', text: 'public' }] },
    }))
    expect(sent).toMatchObject({ status: 'accepted', execution: { kind: 'message.sent', messageId: 'public-message' } })
    const iterator = subscribed.handle.pages[Symbol.asyncIterator]()
    const pages = await Promise.all([iterator.next(), iterator.next(), iterator.next(), iterator.next()])
    expect(pages.map(page => page.value?.events[0]?.sequence)).toEqual([0, 1, 2, 3])
    expect(pages.map(page => page.value?.phase)).toEqual(['replay', 'replay', 'live', 'live'])

    const denied = broker.bind({
      active: () => true,
      authorize: async capability => ({ capability, state: 'denied' as const, code: 'policy-denied' as const }),
    })
    const deniedResult = await denied.execute(command(registration, 'denied-public', { type: 'conversation.open', open: { mode: 'create' } }))
    expect(deniedResult).toMatchObject({ status: 'denied', authorization: { code: 'policy-denied' } })
  })

  it('fences public runs to their conversation and reports the builtin Codex connector as unavailable without inventing a write path', async () => {
    const broker = new CordisXConnectorBroker()
    const registered = broker.register(createCodexAgentConnector(new UnavailableCodexHostAdapter()))
    if (!registered.ok) throw new Error('Agent Connector registration failed')
    const registration = registered.value.registration
    const client = broker.bind({
      active: () => true,
      authorize: async capability => ({ capability, state: 'allowed' as const, code: 'allowed' as const }),
    })
    await expect(client.discover()).resolves.toMatchObject({
      status: 'accepted', snapshot: { registrations: [{ availability: 'unavailable', unavailableCode: 'unsupported' }] },
    })
    await expect(client.execute(command(registration, 'native-open', { type: 'conversation.open', open: { mode: 'create' } })))
      .resolves.toMatchObject({ status: 'unavailable', authorization: { code: 'unsupported' } })

    const fakeBroker = new CordisXConnectorBroker()
    const fake = fakeBroker.register(connector())
    if (!fake.ok) throw new Error('registration failed')
    const fakeClient = fakeBroker.bind({ active: () => true, authorize: async capability => ({ capability, state: 'allowed' as const, code: 'allowed' as const }) })
    await fakeClient.execute(command(fake.value.registration, 'open-for-run', { type: 'conversation.open', open: { mode: 'create' } }))
    const wrongRun = await fakeClient.execute(command(fake.value.registration, 'wrong-run', { type: 'run.stop', conversation: 'conversation-opaque', run: 'run-after-send' }))
    expect(wrongRun).toMatchObject({ status: 'unavailable', authorization: { code: 'unsupported' } })
  })

  it('serializes replay and live delivery across concurrent and reentrant producers, and fences unsubscribe and replacement', async () => {
    const broker = new CordisXConnectorBroker({ authorize: async () => ({ ok: true as const, value: true as const }) })
    let reenter: (() => Promise<unknown>) | undefined
    let releaseParallel: (() => void) | undefined
    const parallelGate = new Promise<void>(resolve => { releaseParallel = resolve })
    const adversarial: CordisXHostConnector = {
      descriptor,
      execute: async value => {
        if (value.commandId === 'outer') {
          await reenter?.()
          return { ok: true as const, value: { kind: 'opened' as const, conversation: 'outer-conversation' } }
        }
        if (value.commandId === 'parallel') {
          await parallelGate
          return { ok: true as const, value: { kind: 'opened' as const, conversation: 'parallel-conversation' } }
        }
        return { ok: true as const, value: { kind: 'opened' as const, conversation: 'nested-conversation' } }
      },
    }
    const registered = broker.register(adversarial)
    if (!registered.ok) throw new Error('registration failed')
    const registration = registered.value.registration
    await broker.command(command(registration, 'seed', { type: 'conversation.open', open: { mode: 'create' } }))
    const client = broker.bind({ active: () => true, authorize: async capability => ({ capability, state: 'allowed' as const, code: 'allowed' as const }) })
    const subscribed = await client.subscribe(registration, 0)
    if (!('handle' in subscribed)) throw new Error('subscription should be accepted')
    reenter = async () => await broker.command(command(registration, 'nested', { type: 'conversation.open', open: { mode: 'create' } }))
    const outer = broker.command(command(registration, 'outer', { type: 'conversation.open', open: { mode: 'create' } }))
    const parallel = broker.command(command(registration, 'parallel', { type: 'conversation.open', open: { mode: 'create' } }))
    await Promise.resolve()
    releaseParallel?.()
    await Promise.all([outer, parallel])
    const iterator = subscribed.handle.pages[Symbol.asyncIterator]()
    const pages = await Promise.all([iterator.next(), iterator.next(), iterator.next()])
    const sequences = pages.flatMap(page => page.value?.events.map(event => event.sequence) ?? [])
    expect(sequences).toEqual([1, 2, 3])
    expect(new Set(sequences).size).toBe(sequences.length)
    expect(pages.map(page => page.value?.phase)).toEqual(['live', 'live', 'live'])

    const stopped = await client.subscribe(registration, 3)
    if (!('handle' in stopped)) throw new Error('subscription should be accepted')
    stopped.handle.unsubscribe()
    await expect(stopped.handle.pages[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true })

    const replaced = await client.subscribe(registration, 3)
    if (!('handle' in replaced)) throw new Error('subscription should be accepted')
    const replacement = broker.register(connector())
    if (!replacement.ok) throw new Error('replacement failed')
    const terminal = await replaced.handle.pages[Symbol.asyncIterator]().next()
    expect(terminal).toMatchObject({ done: false, value: { events: [{ type: 'connector.disposed', disposeReason: 'generation-replaced', sequence: 4 }] } })
    await expect(replaced.handle.pages[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true })
  })
})
