import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bindChannelPluginContext,
  ChannelGenerationFencedError,
  ChannelIntegrityError,
  ChannelRuntime,
  CordisXChannelService,
  type ChannelInboundEnvelope,
  type ChannelPluginIdentity,
  type ChannelThreadRef,
  type ChannelUserInput,
} from '../packages/channel-runtime/src/index.js'
import {
  ManualChannelClock,
  SIMULATOR_ADAPTER_IDENTITY,
  SIMULATOR_CONSUMER_IDENTITY,
  SimulatedChannelAdapter,
  SimulatedPermissionBroker,
  SimulatedTaskGateway,
  simulatedInput,
} from '../packages/channel-runtime/src/simulator.js'

const temporaryRoots: string[] = []

async function storePath(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-runtime-'))
  temporaryRoots.push(root)
  return path.join(root, 'channel-store.json')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function envelope(
  eventId: string,
  operation: ChannelInboundEnvelope['operation'],
  text = `${operation.kind} from simulator`,
): ChannelInboundEnvelope {
  return { routeId: 'default', input: simulatedInput(eventId, text), operation }
}

function createEnvelope(eventId: string): ChannelInboundEnvelope {
  return envelope(eventId, {
    kind: 'create',
    provider: { id: 'codex' },
    model: { useDefault: true },
    profile: { id: 'work' },
    workspace: { alias: 'cordisx' },
  })
}

function target(input: ChannelUserInput): ChannelThreadRef {
  const event = input.source.event
  return {
    adapterId: event.adapterId,
    accountId: event.accountId,
    tenantId: event.tenantId,
    conversationId: event.conversationId,
    kind: event.kind,
    threadId: event.threadId,
    semantics: event.semantics,
  }
}

async function fixture(options: { sendFailures?: number } = {}) {
  const clock = new ManualChannelClock()
  const gateway = new SimulatedTaskGateway()
  const permissions = new SimulatedPermissionBroker()
  const runtime = await ChannelRuntime.open({
    gateway,
    permissions,
    storePath: await storePath(),
    clock,
    retryBaseMs: 1_000,
  })
  const adapter = new SimulatedChannelAdapter(options)
  const handle = await runtime.activate(adapter, SIMULATOR_ADAPTER_IDENTITY)
  return { adapter, clock, gateway, handle, permissions, runtime }
}

describe('launcher-side Channel runtime and simulator', () => {
  it('creates one composite binding and returns the durable result for duplicate events', async () => {
    const { gateway, handle, runtime } = await fixture()
    const message = createEnvelope('create-1')

    await expect(handle.receive(message)).resolves.toMatchObject({ duplicate: false, status: 'queued' })
    await expect(handle.receive(message)).resolves.toMatchObject({ duplicate: true, status: 'queued' })
    await expect(handle.drainInbound()).resolves.toBe(1)
    await expect(handle.receive(message)).resolves.toMatchObject({ duplicate: true, status: 'applied' })
    await expect(handle.drainInbound()).resolves.toBe(0)

    expect(gateway.callCount('create')).toBe(1)
    expect(gateway.calls[0]?.context.input.role).toBe('user')
    expect(gateway.calls[0]?.context.input.source.event.eventId).toBe('create-1')
    expect(runtime.snapshot().bindings).toEqual([
      expect.objectContaining({
        routeId: 'default',
        revision: 1,
        state: 'active',
        session: { providerId: 'codex', remoteSessionId: 'sim-session-1' },
      }),
    ])
    await runtime.dispose()
  })

  it('routes query, open, continue, Agent controls, archive, and restore through one gateway', async () => {
    const { gateway, handle, runtime } = await fixture()
    await handle.receive(createEnvelope('create-all'))
    await handle.drainInbound()

    const operations: ChannelInboundEnvelope['operation'][] = [
      { kind: 'status' },
      { kind: 'read' },
      { kind: 'open' },
      { kind: 'followup' },
      { kind: 'steer' },
      { kind: 'interrupt' },
      { kind: 'archive' },
      { kind: 'restore' },
      { kind: 'continue' },
      { kind: 'list', searchTerm: 'sim' },
    ]
    for (const [index, operation] of operations.entries()) {
      await handle.receive(envelope(`operation-${index}`, operation))
      await handle.drainInbound()
    }

    expect(gateway.calls.map(call => call.operation.kind)).toEqual([
      'create', 'status', 'read', 'open', 'followup', 'steer', 'interrupt',
      'archive', 'restore', 'continue', 'list',
    ])
    for (const call of gateway.calls.filter(call => !['create', 'list'].includes(call.operation.kind))) {
      expect('session' in call.operation ? call.operation.session : undefined).toEqual({
        providerId: 'codex',
        remoteSessionId: 'sim-session-1',
      })
    }
    expect(runtime.snapshot().bindings[0]?.state).toBe('active')
    await runtime.dispose()
  })

  it('recovers a queued event after restart without a real platform account', async () => {
    const file = await storePath()
    const clock = new ManualChannelClock()
    const permissions = new SimulatedPermissionBroker()
    const firstGateway = new SimulatedTaskGateway()
    const firstRuntime = await ChannelRuntime.open({ gateway: firstGateway, permissions, storePath: file, clock })
    const firstAdapter = new SimulatedChannelAdapter({ configurationRevision: 1 })
    const firstHandle = await firstRuntime.activate(firstAdapter, SIMULATOR_ADAPTER_IDENTITY)
    await firstHandle.receive(createEnvelope('restart-create'))
    await firstRuntime.dispose()

    const secondGateway = new SimulatedTaskGateway()
    const secondRuntime = await ChannelRuntime.open({ gateway: secondGateway, permissions, storePath: file, clock })
    const secondAdapter = new SimulatedChannelAdapter({ configurationRevision: 2 })
    const secondHandle = await secondRuntime.activate(secondAdapter, SIMULATOR_ADAPTER_IDENTITY)
    await expect(secondHandle.drainInbound()).resolves.toBe(1)

    expect(firstGateway.callCount()).toBe(0)
    expect(secondGateway.callCount('create')).toBe(1)
    expect(secondRuntime.snapshot().accounts[0]).toMatchObject({ generation: 2, lastGoodRevision: 2 })
    expect(secondRuntime.snapshot().bindings).toHaveLength(1)
    await secondRuntime.dispose()
  })

  it('retries task operations and outbound notifications with bounded backoff', async () => {
    const { adapter, clock, gateway, handle, runtime } = await fixture({ sendFailures: 1 })
    gateway.failNext('create')
    await handle.receive(createEnvelope('retry-create'))
    await expect(handle.drainInbound()).resolves.toBe(1)
    expect(runtime.snapshot().accounts[0]?.inbound.retrying).toBe(1)
    clock.advance(1_000)
    await expect(handle.drainInbound()).resolves.toBe(1)
    expect(gateway.callCount('create')).toBe(2)
    expect(runtime.snapshot().bindings).toHaveLength(1)

    const notification = await runtime.notify({
      target: target(simulatedInput('notification-target', 'target')),
      kind: 'completion',
      text: 'Task completed.',
    }, SIMULATOR_CONSUMER_IDENTITY)
    await expect(handle.drainOutbound()).resolves.toBe(1)
    expect(runtime.snapshot().accounts[0]?.outbound.retrying).toBe(1)
    clock.advance(1_000)
    await expect(handle.drainOutbound()).resolves.toBe(1)
    expect(adapter.sent).toHaveLength(1)
    expect(adapter.sent[0]?.deliveryId).toBe(notification.deliveryId)
    await expect(notification.cancel()).resolves.toBe('irreversible')
    expect(runtime.auditSnapshot().some(item => item.outcome === 'sent-irreversible')).toBe(true)
    await runtime.dispose()
  })

  it('records permission denial without invoking the task gateway', async () => {
    const { gateway, handle, permissions, runtime } = await fixture()
    permissions.set(SIMULATOR_ADAPTER_IDENTITY, 'tasks.create', 'deny')
    const message = createEnvelope('denied-create')
    await handle.receive(message)
    await expect(handle.drainInbound()).resolves.toBe(1)

    expect(gateway.callCount()).toBe(0)
    await expect(handle.receive(message)).resolves.toMatchObject({ duplicate: true, status: 'denied' })
    expect(runtime.auditSnapshot()).toContainEqual(expect.objectContaining({
      source: SIMULATOR_ADAPTER_IDENTITY.source,
      pluginId: SIMULATOR_ADAPTER_IDENTITY.pluginId,
      capability: 'tasks.create',
      outcome: 'deny',
    }))
    await runtime.dispose()
  })

  it('rejects role escalation and attachment path injection before durable acceptance', async () => {
    const { gateway, handle, runtime } = await fixture()
    const unsafe = createEnvelope('unsafe-input') as unknown as {
      routeId: string
      operation: ChannelInboundEnvelope['operation']
      input: Record<string, unknown>
    }
    unsafe.input.role = 'system'
    unsafe.input.content = [{
      type: 'attachment',
      handle: 'quarantine:fixture',
      mediaType: 'text/plain',
      size: 12,
      localPath: '/tmp/secret',
    }]

    await expect(handle.receive(unsafe as unknown as ChannelInboundEnvelope)).rejects.toBeInstanceOf(ChannelIntegrityError)
    expect(gateway.callCount()).toBe(0)
    expect(runtime.snapshot().accounts[0]?.inbound.pending).toBe(0)
    await runtime.dispose()
  })

  it('sanitizes adapter descriptors so secret values never enter store or manager snapshots', async () => {
    const file = await storePath()
    const runtime = await ChannelRuntime.open({
      gateway: new SimulatedTaskGateway(),
      permissions: new SimulatedPermissionBroker(),
      storePath: file,
    })
    const adapter = new SimulatedChannelAdapter()
    const unsafeDefinition = {
      descriptor: { ...adapter.descriptor, secretValue: 'must-not-persist' },
      start: adapter.start.bind(adapter),
    }
    await runtime.activate(unsafeDefinition, SIMULATOR_ADAPTER_IDENTITY)

    expect(await readFile(file, 'utf8')).not.toContain('must-not-persist')
    expect(JSON.stringify(runtime.snapshot())).not.toContain('secretValue')
    await runtime.dispose()
  })

  it('fences replaced generations, disposes effects, and retains last-good on failed activation', async () => {
    const { handle: firstHandle, runtime } = await fixture()
    const firstAdapter = new SimulatedChannelAdapter({ configurationRevision: 1 })
    const replacement = await runtime.activate(firstAdapter, SIMULATOR_ADAPTER_IDENTITY)
    await expect(firstHandle.receive(createEnvelope('stale-generation'))).rejects.toBeInstanceOf(ChannelGenerationFencedError)

    const failed = new SimulatedChannelAdapter({ configurationRevision: 3, failStart: true })
    await expect(runtime.activate(failed, SIMULATOR_ADAPTER_IDENTITY)).rejects.toThrow('start failure')
    expect(runtime.snapshot().accounts[0]).toMatchObject({
      generation: 2,
      lastGoodRevision: 1,
      connectionState: 'ready',
      lastErrorCode: 'ERROR',
    })
    await replacement.receive(createEnvelope('last-good-still-active'))
    await replacement.drainInbound()
    await replacement.dispose()
    expect(firstAdapter.stopReasons).toEqual(['disposed'])
    await expect(replacement.receive(createEnvelope('disposed-generation'))).rejects.toBeInstanceOf(ChannelGenerationFencedError)
    await runtime.dispose()
  })
})

describe('Node Cordis Channel service', () => {
  it('provides source-bound connection list, subscribe, and send effects without exposing raw connections', async () => {
    const clock = new ManualChannelClock()
    const permissions = new SimulatedPermissionBroker()
    const runtime = await ChannelRuntime.open({
      gateway: new SimulatedTaskGateway(),
      permissions,
      storePath: await storePath(),
      clock,
    })
    const root = new Context()
    new CordisXChannelService(root, runtime)
    const adapterContext = bindChannelPluginContext(root, SIMULATOR_ADAPTER_IDENTITY)
    const consumerContext = bindChannelPluginContext(root, SIMULATOR_CONSUMER_IDENTITY)
    const adapter = new SimulatedChannelAdapter()
    const handle = await adapterContext.channel.adapters.register(adapter)

    await expect(consumerContext.channel.connections.list()).resolves.toEqual([
      expect.objectContaining({ ref: adapter.descriptor.ref, connectionState: 'ready' }),
    ])
    expect('connections' in consumerContext.channel).toBe(true)
    expect('messages' in consumerContext.channel).toBe(true)
    expect('connection' in consumerContext.channel).toBe(false)
    expect('runtime' in consumerContext.channel).toBe(false)
    expect('store' in consumerContext.channel).toBe(false)

    const observed: string[] = []
    const disposeSubscription = await consumerContext.channel.messages.subscribe(
      { account: adapter.descriptor.ref, userId: 'alice' },
      event => { observed.push(`${event.delivery}:${event.input.source.event.eventId}`) },
    )
    await adapter.emit(envelope('cross-plugin-event', { kind: 'list' }))
    await vi.waitFor(() => expect(observed).toEqual(['live-experimental:cross-plugin-event']))

    const delivery = await consumerContext.channel.messages.send({
      target: target(simulatedInput('cross-plugin-target', 'target')),
      kind: 'reply',
      text: 'Brokered reply from another plugin.',
    })
    await handle.drainOutbound()
    expect(adapter.sent[0]).toMatchObject({ deliveryId: delivery.deliveryId, kind: 'reply' })
    expect(permissions.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: SIMULATOR_CONSUMER_IDENTITY, capability: 'channel.accounts.read' }),
      expect.objectContaining({ caller: SIMULATOR_CONSUMER_IDENTITY, capability: 'channel.events.subscribe' }),
      expect.objectContaining({ caller: SIMULATOR_CONSUMER_IDENTITY, capability: 'channel.messages.send' }),
    ]))

    disposeSubscription()
    await adapter.emit(envelope('after-subscription-dispose', { kind: 'list' }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(observed).toHaveLength(1)
    await runtime.dispose()
  })

  it('rejects unbound Cordis callers and separately denies subscription authority', async () => {
    const permissions = new SimulatedPermissionBroker()
    const runtime = await ChannelRuntime.open({
      gateway: new SimulatedTaskGateway(),
      permissions,
      storePath: await storePath(),
    })
    const root = new Context()
    new CordisXChannelService(root, runtime)
    const adapterContext = bindChannelPluginContext(root, SIMULATOR_ADAPTER_IDENTITY)
    const adapter = new SimulatedChannelAdapter()
    await adapterContext.channel.adapters.register(adapter)

    await expect(root.channel.connections.list()).rejects.toThrow('launcher-bound Node plugin identity')
    const deniedIdentity: ChannelPluginIdentity = {
      ...SIMULATOR_CONSUMER_IDENTITY,
      generation: 'denied-generation',
    }
    permissions.set(deniedIdentity, 'channel.events.subscribe', 'deny')
    const deniedContext = bindChannelPluginContext(root, deniedIdentity)
    await expect(deniedContext.channel.messages.subscribe(
      { account: adapter.descriptor.ref },
      () => undefined,
    )).rejects.toThrow('channel.events.subscribe is deny')
    await runtime.dispose()
  })
})
