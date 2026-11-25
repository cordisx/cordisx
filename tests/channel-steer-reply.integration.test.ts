import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

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
  'cordisx/channelContext': 'synthetic-context',
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
  const consumer = await ChannelConversationConsumer.open({
    appId: 'codex',
    profileId: 'fixture',
    file: path.join(root, 'consumer.json'),
    access: () => access as never,
    native: () => native as never,
  })
  consumer.setNativeExtras(() => native as never)
  const tools = new ChannelConversationTools(() => access as never, consumer)
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
  const manual = () =>
    tools.call('send', {
      account,
      target: { id: 'oc_fixture', kind: 'direct', replyMode: 'conversation' },
      operationId: 'manual',
      text: 'manual message',
    }, metadata)
  const finish = async () => {
    completion.mockResolvedValue({ state: 'completed', text: 'automatic final' } as never)
    await settle()
  }
  return {
    consumer,
    tools,
    send,
    receive,
    manual,
    finish,
    completion,
    failDrain: () => {
      drainFails = true
    },
  }
}

describe('steered replies with a real outbox', () => {
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
