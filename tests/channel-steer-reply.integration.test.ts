import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime, UncertainChannelSendError } from '../packages/channel-runtime/src/runtime.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { channelLogicalTransactionStore } from '../packages/cli/src/launcher/channel-logical-continuation-store.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'

const account = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
const session = '01a10000-0000-7000-8000-000000000001'
const event = (id: string) => ({
  ...account,
  conversationId: 'oc_fixture',
  threadId: 'oc_fixture',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
  eventId: id,
  messageId: id,
  actor: { ...account, userId: 'user' },
})
const metadata = {
  'cordisx/channelContext': 'a'.repeat(48),
  'x-codex-turn-metadata': { thread_id: session, turn_id: 'turn' },
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-steer-reply-'))
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'outbox.json'),
    permissions: { authorize: async () => 'allow' },
  })
  const send = vi.fn(async (_request: unknown) => ({ externalMessageId: 'sent' }))
  const adapter = await runtime.activate({
    descriptor: {
      ref: account,
      kind: 'feishu',
      implementationStatus: 'experimental',
      configurationRevision: 1,
      secretState: 'ready',
    },
    start: async () => ({ send, stop: async () => {} }),
  }, { source: 'test', pluginId: 'test', generation: 'test' })
  let drainFails = false
  const access = {
    generation: 'test',
    runtime,
    accounts: () => [{ ref: account, state: 'ready' }],
    drain: async () => {
      if (drainFails) {
        drainFails = false
        throw new Error('SYNTHETIC_RECEIPT_UNAVAILABLE')
      }
      await adapter.drainOutbound(10)
    },
  }
  let activeEvent = event('first')
  const completion = vi.fn(async () => ({ state: 'running' as const }))
  const native = {
    contextObservations: () => undefined,
    hasPreparation: () => false,
    isPreparing: () => false,
    exists: async () => true,
    start: async () => ({ state: 'running' as const, sessionId: session, turnId: 'turn' }),
    steer: async () => ({ state: 'accepted' as const }),
    completion,
    sourceFor: () => event('first'),
    contextFor: () => ({ threadId: session, turnId: 'turn', source: activeEvent }),
    reconcile: async () => ({ state: 'reconciliation-required' as const }),
  }
  const openConsumer = () =>
    ChannelConversationConsumer.open({
      appId: 'codex',
      profileId: 'default',
      file: path.join(root, 'consumer.json'),
      access: () => access as never,
      native: () => native as never,
    })
  let consumer = await openConsumer()
  consumer.setNativeExtras(() => native as never)
  let tools = new ChannelConversationTools(() => access as never, consumer)
  cleanups.push(async () => {
    tools.dispose()
    await consumer.dispose()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await consumer.policySet({ enabled: true, autoReply: true }, 0)
  await consumer.bind({
    channel: {
      ...account,
      conversationId: 'oc_fixture',
      threadId: 'oc_fixture',
      kind: 'direct',
      semantics: 'conversation',
    },
    mode: 'deliver',
    autoReply: true,
  }, session)
  const settle = async () => {
    await consumer.pump()
    await consumer.pump()
  }
  const receive = async (id: string) => {
    activeEvent = event(id)
    await consumer.receive(id, {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text: id }],
      source: { kind: 'channel', event: activeEvent },
      receivedAt: new Date().toISOString(),
    }, true)
    await settle()
    return Object.values(consumer.profileLogicalOwner().store.snapshot().jobs).find(job => job.recordId === id)!
  }
  const manual = (terminal?: { contract: string; schemaVersion: number; inputOperationId: string }) =>
    tools.call('send', {
      account,
      target: { id: 'oc_fixture', kind: 'direct', replyMode: 'conversation' },
      operationId: 'manual',
      text: 'manual message',
      ...(terminal ? { terminal } : {}),
    }, metadata)
  const finish = async () => {
    completion.mockResolvedValue({ state: 'completed', text: 'automatic final' } as never)
    await settle()
  }
  return {
    get consumer() {
      return consumer
    },
    get tools() {
      return tools
    },
    access,
    send,
    receive,
    manual,
    finish,
    completion,
    root,
    drain: () => adapter.drainOutbound(10),
    settle,
    reopen: async () => {
      tools.dispose()
      await consumer.dispose()
      consumer = await openConsumer()
      consumer.setNativeExtras(() => native as never)
      tools = new ChannelConversationTools(() => access as never, consumer)
    },
    file: path.join(root, 'consumer.json'),
    failDrain: () => {
      drainFails = true
    },
  }
}

describe('steered replies with a real outbox', () => {
  const terminal = (inputOperationId: string) => ({
    contract: 'cordisx.channel-terminal-intent/v1',
    schemaVersion: 1,
    inputOperationId,
  })
  it.each(['sent', 'unknown'])(
    'routes terminal intent from the CLI through Host RPC and the real outbox: %s',
    async scenario => {
      const f = await fixture()
      await f.receive('first')
      const child = await f.receive('second')
      const configPath = path.join(f.root, 'config.json')
      await ensureHomeConfig(configPath)
      const handler = configuredChannelManagementToolHandler(f.tools)
      const server = await startPluginManagementRpcServer({
        homeDir: f.root,
        appId: 'codex',
        profileId: 'default',
        configPath,
        generation: 'test',
        processStartedAt: (await processStartIdentity(process.pid))!,
        service: {} as never,
        channel: handler.channel,
      })
      try {
        if (scenario === 'unknown') f.failDrain()
        const entry = path.resolve('packages/cli/dist/src/cli.js')
        const request = {
          account,
          target: { id: 'oc_fixture', kind: 'direct', replyMode: 'conversation' },
          operationId: 'cli-terminal',
          text: 'final answer',
          terminal: terminal(child.id),
        }
        const output = await promisify(execFile)(process.execPath, [
          entry,
          'channel',
          'send',
          '--profile',
          'default',
          '--context',
          'a'.repeat(48),
          '--input',
          JSON.stringify(request),
        ], { env: { ...process.env, CORDISX_HOME: f.root, CODEX_THREAD_ID: session }, timeout: 10_000 })
          .catch((error: { stdout: string }) => ({ stdout: error.stdout }))
        expect(JSON.parse(output.stdout)).toMatchObject({ deliveryState: scenario })
        await f.finish()
        if (scenario === 'unknown') {
          expect(f.send).not.toHaveBeenCalled()
          await f.drain()
          await f.settle()
        }
        expect(f.send).toHaveBeenCalledTimes(1)
      } finally {
        await server.close()
      }
    },
  )
  it.skipIf(!process.env.CORDISX_TEST_LEGACY_PACKAGE)('older Host rejects terminal intent before sending', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    const root = process.env.CORDISX_TEST_LEGACY_PACKAGE!
    const legacy = await import(
      /* @vite-ignore */ pathToFileURL(path.join(root, 'dist/src/launcher/channel-conversation-tools.js')).href
    )
    const tools = new legacy.ChannelConversationTools(() => f.access, f.consumer)
    try {
      expect(
        await tools.call('send', {
          account,
          target: { id: 'oc_fixture', kind: 'direct', replyMode: 'conversation' },
          operationId: 'legacy-send',
          text: 'message',
          terminal: terminal(child.id),
        }, metadata),
      ).toMatchObject({ status: 'rejected', code: 'INVALID_REQUEST' })
      expect(f.send).not.toHaveBeenCalled()
    } finally {
      tools.dispose()
    }
  })
  it('resolves a confirmed terminal delivery without requiring a separate none selection', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    expect(await f.manual(terminal(child.id))).toMatchObject({ deliveryState: 'sent' })
    expect(f.consumer.profileLogicalOwner().store.snapshot().schemaVersion).toBe(3)
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.consumer.profileLogicalOwner().store.snapshot().schemaVersion).toBe(1)
    expect(f.consumer.status(session).jobs.every(job => job.state === 'completed')).toBe(true)
  })
  it('keeps an unknown terminal send fenced across continuation updates and a Host restart', async () => {
    const f = await fixture()
    const parent = await f.receive('first')
    const child = await f.receive('second')
    f.failDrain()
    expect(await f.manual(terminal(child.id))).toMatchObject({ deliveryState: 'unknown' })
    const duplicate = await f.manual(terminal(child.id))
    expect(duplicate).not.toMatchObject({ deliveryState: 'sent' })
    expect(f.send).not.toHaveBeenCalled()
    await f.finish()
    expect(f.consumer.status(session).jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: parent.id,
        state: 'reconciliation-required',
        code: 'CHANNEL_TERMINAL_DELIVERY_UNRESOLVED',
        terminalDelivery: expect.objectContaining({ operationId: 'manual' }),
      }),
    ]))
    await channelLogicalTransactionStore(f.consumer.profileLogicalOwner().store).mutate(state => {
      state.logicalContinuations!.revision += 1
    })
    const saved = JSON.parse(await readFile(f.file, 'utf8'))
    expect(saved.schemaVersion).toBe(3)
    expect([1, 2]).not.toContain(saved.schemaVersion) // The previous Host's open gate rejects this version.
    const legacyRoot = process.env.CORDISX_TEST_LEGACY_PACKAGE
    const legacy = legacyRoot
      ? await import(
        /* @vite-ignore */ pathToFileURL(path.join(legacyRoot, 'dist/src/launcher/channel-conversation-store.js')).href
      )
      : undefined
    if (legacy) await expect(legacy.ChannelConversationStore.open(f.file)).rejects.toThrow('INVALID_CONVERSATION_STORE')
    await f.reopen()
    expect(f.consumer.profileLogicalOwner().store.snapshot().schemaVersion).toBe(3)
    await f.drain()
    await f.settle()
    const after = f.consumer.profileLogicalOwner().store.snapshot()
    expect(after.schemaVersion).toBe(2)
    expect(after.jobs[parent.id]!.state).toBe('completed')
    expect(f.send).toHaveBeenCalledTimes(1)
    if (legacy) {
      await f.consumer.dispose()
      const oldStore = await legacy.ChannelConversationStore.open(f.file)
      expect(oldStore.snapshot().schemaVersion).toBe(2)
      await oldStore.close()
    }
  })
  it('never replays a terminal send with an ambiguous platform receipt', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    f.send.mockRejectedValueOnce(new UncertainChannelSendError('SYNTHETIC_UNCERTAIN'))
    expect(await f.manual(terminal(child.id))).toMatchObject({ deliveryState: 'unknown' })
    await f.finish()
    await f.drain()
    await f.settle()
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(f.consumer.profileLogicalOwner().store.snapshot().schemaVersion).toBe(3)
  })
  it('does not treat an earlier progress receipt as a terminal receipt', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    expect(await f.manual()).toMatchObject({ deliveryState: 'sent' })
    expect(await f.manual(terminal(child.id))).toMatchObject({
      status: 'rejected',
      code: 'TERMINAL_SEND_ID_ALREADY_USED',
    })
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('serializes a progress send against a terminal claim for the same delivery id', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    f.send.mockImplementationOnce(async () => {
      started()
      await gate
      return { externalMessageId: 'sent' }
    })
    const progress = f.manual()
    try {
      await entered
      expect(await f.manual(terminal(child.id))).toMatchObject({ status: 'rejected', code: 'CHANNEL_DELIVERY_BUSY' })
    } finally {
      release()
    }
    expect(await progress).toMatchObject({ deliveryState: 'sent' })
    expect(await f.manual(terminal(child.id))).toMatchObject({
      status: 'rejected',
      code: 'TERMINAL_SEND_ID_ALREADY_USED',
    })
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('does not auto-reply while an explicitly terminal send is in flight', async () => {
    const f = await fixture()
    const parent = await f.receive('first')
    const child = await f.receive('second')
    let release!: () => void, started!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    f.send.mockImplementationOnce(async () => {
      started()
      await gate
      return { externalMessageId: 'sent' }
    })
    const terminalSend = f.manual(terminal(child.id))
    try {
      await entered
      await f.finish()
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.consumer.profileLogicalOwner().store.snapshot().jobs[parent.id]).toMatchObject({
        state: 'reconciliation-required',
        code: 'CHANNEL_TERMINAL_DELIVERY_UNRESOLVED',
      })
    } finally {
      release()
    }
    expect(await terminalSend).toMatchObject({ deliveryState: 'sent' })
    await f.settle()
    expect(f.consumer.profileLogicalOwner().store.snapshot().jobs[parent.id]!.state).toBe('completed')
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('allows later independent input while an earlier terminal receipt remains unknown', async () => {
    const f = await fixture()
    const parent = await f.receive('first')
    const child = await f.receive('second')
    f.send.mockRejectedValueOnce(new UncertainChannelSendError('SYNTHETIC_UNCERTAIN'))
    expect(await f.manual(terminal(child.id))).toMatchObject({ deliveryState: 'unknown' })
    await f.finish()
    const next = await f.receive('third')
    expect(f.consumer.profileLogicalOwner().store.snapshot().jobs[parent.id]!.state).toBe('reconciliation-required')
    expect(f.consumer.profileLogicalOwner().store.snapshot().jobs[next.id]!.state).toBe('completed')
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('rejects another target and a changed retry before sending', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    const request = {
      account,
      operationId: 'manual',
      text: 'manual message',
      terminal: terminal(child.id),
      target: { id: 'oc_other', kind: 'direct', replyMode: 'conversation' },
    }
    expect(await f.tools.call('send', request, metadata)).toMatchObject({
      status: 'rejected',
      code: 'TERMINAL_CONTEXT_UNAVAILABLE',
    })
    f.failDrain()
    expect(await f.manual(terminal(child.id))).toMatchObject({ deliveryState: 'unknown' })
    expect(
      await f.tools.call('send', {
        ...request,
        target: { ...request.target, id: 'oc_fixture' },
        text: 'different',
      }, metadata),
    ).toMatchObject({ status: 'rejected', code: 'TERMINAL_DELIVERY_CONFLICT' })
    expect(f.send).not.toHaveBeenCalled()
  })
  it('rejects terminal intent for a different incoming context', async () => {
    const f = await fixture()
    const parent = await f.receive('first')
    await f.receive('second')
    expect(await f.manual(terminal(parent.id))).toMatchObject({
      status: 'rejected',
      code: 'TERMINAL_CONTEXT_UNAVAILABLE',
    })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.consumer.profileLogicalOwner().store.snapshot().schemaVersion).toBe(1)
  })
  it.each([1, 2])(
    'suppresses the one automatic final after a confirmed manual final and %i follow-ups',
    async count => {
      const f = await fixture()
      await f.receive('first')
      let child = await f.receive('second')
      if (count === 2) child = await f.receive('third')
      expect(child).toMatchObject({ steeredInto: 'turn', finalDeliveryEnabled: false })
      expect(await f.manual()).toMatchObject({ deliveryState: 'sent' })
      expect(await f.tools.call('receipt', { account, operationId: 'manual' }, metadata)).toMatchObject({
        deliveryState: 'sent',
      })
      expect(await f.tools.call('reply-mode', { operationId: child.id, mode: 'none' }, metadata)).toMatchObject({
        status: 'ok',
      })
      await f.finish()
      expect(f.send).toHaveBeenCalledTimes(1)
      expect(f.consumer.status(session).jobs.every(job => job.state === 'completed')).toBe(true)
    },
  )
  it('keeps the automatic final after a progress message', async () => {
    const f = await fixture()
    await f.receive('first')
    await f.receive('second')
    expect(await f.manual()).toMatchObject({ deliveryState: 'sent' })
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('does not infer a terminal reply from an uncertain receipt', async () => {
    const f = await fixture()
    await f.receive('first')
    await f.receive('second')
    f.failDrain()
    expect(await f.manual()).toMatchObject({ deliveryState: 'unknown' })
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('can explicitly suppress automatic delivery while an uncertain terminal receipt is checked', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    f.failDrain()
    expect(await f.manual()).toMatchObject({ deliveryState: 'unknown' })
    expect(await f.tools.call('reply-mode', { operationId: child.id, mode: 'none' }, metadata)).toMatchObject({
      status: 'ok',
    })
    await f.finish()
    // The queued send may be delivered later, but the consumer has not added another send.
    expect(f.send).not.toHaveBeenCalled()
  })
  it('rechecks the selection after a concurrent completion read', async () => {
    const f = await fixture()
    await f.receive('first')
    const child = await f.receive('second')
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => {
      started = resolve
    })
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    f.completion.mockImplementationOnce(async () => {
      started()
      await gate
      return { state: 'completed', text: 'automatic final' } as never
    })
    const pump = f.consumer.pump()
    await entered
    expect(await f.manual()).toMatchObject({ deliveryState: 'sent' })
    expect(await f.tools.call('reply-mode', { operationId: child.id, mode: 'none' }, metadata)).toMatchObject({
      status: 'ok',
    })
    release()
    await pump
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('requires the owner to change a selected none route', async () => {
    const f = await fixture()
    const parent = await f.receive('first')
    const child = await f.receive('second')
    expect(f.consumer.status(session).jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: child.id, replyOwnerOperationId: parent.id }),
    ]))
    expect(await f.tools.call('reply-mode', { operationId: child.id, mode: 'reply' }, metadata)).toMatchObject({
      status: 'rejected',
      code: 'REPLY_MODE_CHANGE_REQUIRES_OWNER',
    })
    expect(await f.tools.call('reply-mode', { operationId: child.id, mode: 'none' }, metadata)).toMatchObject({
      status: 'ok',
    })
    expect(await f.tools.call('reply-mode', { operationId: child.id, mode: 'conversation' }, metadata)).toMatchObject({
      status: 'rejected',
      code: 'REPLY_MODE_CHANGE_REQUIRES_OWNER',
    })
    expect(await f.tools.call('reply-mode', { operationId: parent.id, mode: 'conversation' }, metadata)).toMatchObject({
      status: 'ok',
    })
    await f.finish()
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it.each(['session', 'turn', 'binding', 'actor', 'account', 'conversation', 'reserved'])(
    'rejects a %s mismatch without suppressing the parent',
    async mismatch => {
      const f = await fixture()
      const parent = await f.receive('first')
      const child = await f.receive('second')
      const store = f.consumer.profileLogicalOwner().store
      await store.mutate(state => {
        if (mismatch === 'session') state.jobs[parent.id]!.sessionId = '01a10000-0000-7000-8000-000000000002'
        if (mismatch === 'turn') state.jobs[parent.id]!.turnId = 'another-turn'
        if (mismatch === 'binding') state.jobs[parent.id]!.bindingId = 'other-binding'
        if (mismatch === 'actor') state.inputs[parent.recordId]!.input.source.event.actor!.userId = 'other-user'
        if (mismatch === 'account') state.inputs[parent.recordId]!.input.source.event.accountId = 'other-account'
        if (mismatch === 'conversation') state.inputs[parent.recordId]!.input.source.event.conversationId = 'other-chat'
        if (mismatch === 'reserved') state.jobs[parent.id]!.state = 'replying'
      })
      await expect(f.consumer.selectReplyMode({ operationId: child.id, mode: 'none' }, session, 'turn'))
        .rejects.toThrow(mismatch === 'reserved' ? 'REPLY_ALREADY_RESERVED' : 'REPLY_OPERATION_NOT_FOUND')
      expect(store.snapshot().jobs[parent.id]!.replyMode).not.toBe('none')
    },
  )
})
