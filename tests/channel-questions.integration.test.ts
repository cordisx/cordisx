import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/index.js'
import {
  SimulatedChannelAdapter,
  SimulatedPermissionBroker,
  SIMULATOR_ADAPTER_IDENTITY,
} from '../packages/channel-runtime/src/simulator.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'

const roots: string[] = []
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dispose of cleanup.splice(0)) await dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(adapterId = 'feishu') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-questions-'))
  roots.push(root)
  const ref = { adapterId, accountId: 'account', tenantId: 'tenant' }
  const permissions = new SimulatedPermissionBroker()
  const runtime = await ChannelRuntime.open({ permissions, storePath: path.join(root, 'runtime.json') })
  const adapter = new SimulatedChannelAdapter({ ref })
  const handle = await runtime.activate(adapter, SIMULATOR_ADAPTER_IDENTITY)
  const access = {
    generation: 'test',
    runtime,
    accounts: () => [{ ref, state: 'ready' }],
    conversations: async () => ({ complete: true, conversations: [] }),
    drain: async () => {
      await handle.drainOutbound()
    },
    messageContext: async (message: { source: { event: { actor?: { userId: string } } } }) => ({
      platform: 'test',
      conversation: { id: 'oc_group', kind: 'group' },
      sender: { userId: message.source.event.actor?.userId, name: 'Real sender' },
      mentions: [],
    }),
  } as unknown as ChannelConversationAccess
  const native = {
    exists: vi.fn(async () => true),
    start: vi.fn(async (_id: string, _input: unknown, sessionId?: string) => ({
      state: 'running' as const,
      sessionId,
      turnId: 'turn',
    })),
    completion: vi.fn(async () => ({ state: 'running' as const })),
    reconcile: vi.fn(async () => ({ state: 'reconciliation-required' as const })),
  }
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(root, 'consumer.json'),
    profileId: 'p',
    access: () => access,
    native: () => native,
  })
  const tools = new ChannelConversationTools(() => access, consumer)
  cleanup.push(async () => {
    tools.dispose()
    await consumer.dispose()
    await runtime.dispose()
  })
  const channel = {
    ...ref,
    conversationId: adapterId === 'simulator' ? 'sim-conversation' : 'oc_group',
    kind: 'group' as const,
    threadId: adapterId === 'simulator' ? 'sim-conversation' : 'oc_group',
    semantics: 'conversation' as const,
  }
  await consumer.policySet({ enabled: true, groupReception: 'all' }, 0)
  for (const id of ['01a10000-0000-7000-8000-000000000001', '01a10000-0000-7000-8000-000000000002']) {
    await consumer.bind({ channel, mode: 'deliver', autoReply: false }, id)
  }
  const question = {
    account: ref,
    target: { id: channel.conversationId, kind: 'group' },
    question: 'Which?',
    options: [{ label: 'One', value: '/unbind' }, { label: 'Two', value: 'Second value' }],
    operationId: 'question-1',
  }
  return { ref, runtime, permissions, adapter, consumer, tools, native, question, channel, access }
}

describe('Channel question delivery and real consumer routing', () => {
  it('persists a card receipt, rejects forged or duplicate callbacks, and routes real actors to every binding', async () => {
    const f = await fixture()
    const sent = await f.tools.call('ask', f.question)
    expect(sent).toMatchObject({
      status: 'ok',
      presentation: 'card',
      deliveryState: 'sent',
      receipt: { state: 'sent' },
    })
    const delivery = f.adapter.sent[0]!, token = delivery.questionCard!.token
    expect(delivery.questionCard).toMatchObject({ question: 'Which?', options: ['One', 'Two'] })
    expect(JSON.stringify(delivery.questionCard)).not.toContain('/unbind')
    expect(await f.tools.call('ask', f.question)).toMatchObject({ deliveryState: 'sent' })
    expect(f.adapter.sent).toHaveLength(1)
    expect(await f.tools.call('ask', { ...f.question, question: 'different' })).toMatchObject({
      status: 'rejected',
      code: 'OPERATION_CONFLICT',
    })
    expect(await f.tools.call('receipt', { account: f.ref, operationId: f.question.operationId })).toMatchObject({
      deliveryState: 'sent',
    })
    const click = (overrides: Record<string, unknown> = {}) =>
      ({
        chatId: 'oc_group',
        messageId: 'sim-message-1',
        operator: { openId: 'ou_alice' },
        action: { tag: 'button', value: { channelQuestion: token, option: 0 } },
        ...overrides,
      }) as never
    await f.consumer.cardAction(f.ref, click({ messageId: 'sim-message-wrong' }))
    await f.consumer.cardAction(f.ref, click({ chatId: 'oc_other' }))
    await f.consumer.cardAction(
      f.ref,
      click({ action: { tag: 'button', value: { channelQuestion: token, option: 3 } } }),
    )
    await f.consumer.cardAction(f.ref, click())
    await f.consumer.cardAction(f.ref, click())
    await vi.waitFor(() => expect(f.native.start).toHaveBeenCalledTimes(2))
    const messages = f.native.start.mock.calls.map(call =>
      call[1] as { source: { event: { actor: { userId: string } } }; content: { text: string }[] }
    )
    expect(messages.every(message => message.source.event.actor.userId === 'ou_alice')).toBe(true)
    expect(messages.every(message => message.content[0]!.text.includes('/unbind'))).toBe(true)
    expect(f.consumer.bindings().filter(binding => binding.state === 'active')).toHaveLength(2)
    const contexts = f.native.start.mock.calls.map(call => call[5])
    expect(contexts).toEqual([
      expect.objectContaining({ sender: expect.objectContaining({ name: 'Real sender' }) }),
      expect.objectContaining({ sender: expect.objectContaining({ name: 'Real sender' }) }),
    ])
  })

  it('fences targeted, cancelled and expired answers, and rejects unauthorized sends', async () => {
    const f = await fixture()
    const ask = { ...f.question, targetUserId: 'ou_alice' }
    await f.tools.call('ask', ask)
    const token = f.adapter.sent[0]!.questionCard!.token
    const click = (user: string) =>
      ({
        chatId: 'oc_group',
        messageId: 'sim-message-1',
        operator: { openId: user },
        action: { tag: 'button', value: { channelQuestion: token, option: 0 } },
      }) as never
    await f.consumer.cardAction(f.ref, click('ou_bob'))
    expect(f.native.start).not.toHaveBeenCalled()
    f.access.accounts = () => [{ ref: f.ref, state: 'unavailable' }]
    expect(await f.tools.call('question-cancel', { account: f.ref, operationId: ask.operationId })).toMatchObject({
      state: 'cancelled',
    })
    await f.consumer.cardAction(f.ref, click('ou_alice'))
    expect(f.native.start).not.toHaveBeenCalled()
    f.access.accounts = () => [{ ref: f.ref, state: 'ready' }]
    await f.tools.call('ask', { ...f.question, operationId: 'expires', expiresInSeconds: 60 })
    const expiryToken = f.adapter.sent[1]!.questionCard!.token
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    await f.consumer.cardAction(f.ref, {
      chatId: 'oc_group',
      messageId: 'sim-message-2',
      operator: { openId: 'ou_alice' },
      action: { tag: 'button', value: { channelQuestion: expiryToken, option: 1 } },
    })
    expect(f.native.start).not.toHaveBeenCalled()
    vi.restoreAllMocks()
    await f.consumer.policySet(
      { enabled: true, rules: [{ id: 'deny', action: 'send', effect: 'deny' }] },
      f.consumer.policy().revision,
    )
    expect(await f.tools.call('ask', { ...f.question, operationId: 'denied' })).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_POLICY_DENIED',
    })
    expect(f.adapter.sent).toHaveLength(2)
  })

  it('accepts a bounded card-form reply only from the actual target user and matching sent card', async () => {
    const f = await fixture()
    await f.tools.call('ask', { ...f.question, targetUserId: 'ou_alice' })
    const form = (actor: string, messageId = 'sim-message-1') =>
      ({
        chatId: 'oc_group',
        messageId,
        operator: { openId: actor },
        action: { tag: 'button', name: 'channel_question_submit', value: {} },
        questionText: '/unbind',
      }) as never
    await f.consumer.cardAction(f.ref, form('ou_bob'))
    await f.consumer.cardAction(f.ref, form('ou_alice', 'wrong-message'))
    expect(f.native.start).not.toHaveBeenCalled()
    await f.consumer.cardAction(f.ref, form('ou_alice'))
    await f.consumer.cardAction(f.ref, form('ou_alice'))
    await vi.waitFor(() => expect(f.native.start).toHaveBeenCalledTimes(2))
    expect(f.consumer.bindings().filter(binding => binding.state === 'active')).toHaveLength(2)
    expect(f.native.start.mock.calls[0]![1]).toMatchObject({
      content: [{ text: expect.stringContaining('/unbind') }],
      source: { event: { actor: { userId: 'ou_alice' } } },
    })
  })

  it('routes an ordinary free-text answer through existing group policies', async () => {
    const f = await fixture()
    await f.tools.call('ask', f.question)
    await f.consumer.receive('inbox:answer', {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text: 'I would choose another option' }],
      source: {
        kind: 'channel',
        event: { ...f.channel, eventId: 'om_text', messageId: 'om_text', actor: { ...f.ref, userId: 'ou_bob' } },
      },
      receivedAt: new Date().toISOString(),
    }, true)
    await vi.waitFor(() => expect(f.native.start).toHaveBeenCalledTimes(2))
    expect((f.native.start.mock.calls[0]![1] as { content: { text: string }[] }).content[0]!.text).toBe(
      'I would choose another option',
    )
  })

  it('preserves a queued receipt after an uncertain enqueue and never duplicates the effect', async () => {
    const f = await fixture()
    const enqueue = f.runtime.notifyQuestionOnce.bind(f.runtime)
    vi.spyOn(f.runtime, 'notifyQuestionOnce').mockImplementationOnce(async (...args) => {
      await enqueue(...args)
      throw new Error('connection lost after reservation')
    })
    expect(await f.tools.call('ask', f.question)).toMatchObject({ status: 'partial', deliveryState: 'unknown' })
    expect(await f.tools.call('receipt', { account: f.ref, operationId: f.question.operationId })).toMatchObject({
      deliveryState: 'pending',
      receipt: { state: 'queued' },
    })
    expect(f.adapter.sent).toHaveLength(0)
    expect(await f.tools.call('ask', f.question)).toMatchObject({ deliveryState: 'sent' })
    expect(f.adapter.sent).toHaveLength(1)
  })

  it('reports a denied transport permission without claiming an uncertain delivery', async () => {
    const f = await fixture()
    f.permissions.setFallback('deny')
    expect(await f.tools.call('ask', f.question)).toMatchObject({
      status: 'rejected',
      code: 'CHANNEL_PERMISSION_DENIED',
    })
    expect(f.adapter.sent).toHaveLength(0)
  })

  it('honors the actual clicking actor dispatch policy', async () => {
    const f = await fixture()
    await f.tools.call('ask', f.question)
    const token = f.adapter.sent[0]!.questionCard!.token
    await f.consumer.policySet({
      enabled: true,
      groupReception: 'all',
      rules: [{ id: 'deny-bob', action: 'dispatch', effect: 'deny', userIds: ['ou_bob'] }],
    }, f.consumer.policy().revision)
    await f.consumer.cardAction(f.ref, {
      chatId: 'oc_group',
      messageId: 'sim-message-1',
      operator: { openId: 'ou_bob' },
      action: { tag: 'button', value: { channelQuestion: token, option: 0 } },
    })
    await f.consumer.pump()
    expect(f.native.start).not.toHaveBeenCalled()
  })

  it('uses numbered text for an adapter without question cards', async () => {
    const f = await fixture('simulator')
    expect(await f.tools.call('ask', f.question)).toMatchObject({
      status: 'ok',
      presentation: 'numbered-text',
      deliveryState: 'sent',
    })
    expect(f.adapter.sent[0]).toMatchObject({ text: expect.stringContaining('1. One') })
    expect(f.adapter.sent[0]!.questionCard).toBeUndefined()
    expect(f.adapter.sent[0]!.target.conversationId).toBe('sim-conversation')
    expect(await f.tools.call('ask', { ...f.question, operationId: 'targeted', targetUserId: 'user-1' })).toMatchObject(
      { status: 'rejected', code: 'QUESTION_TARGET_USER_UNSUPPORTED' },
    )
  })
})

it('retains a queued question across restart, shares send authorization and detects payload conflicts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-question-outbox-'))
  roots.push(root)
  const file = path.join(root, 'outbox.json')
  const permissions = new SimulatedPermissionBroker()
  const ref = { adapterId: 'simulator', accountId: 'local', tenantId: 'test' }
  const target = {
    ...ref,
    conversationId: 'oc_group',
    kind: 'group' as const,
    threadId: 'oc_group',
    semantics: 'conversation' as const,
  }
  const caller = { source: 'cordisx:native-channel', pluginId: 'host-channel-tools', generation: 'chat' }
  const notification = { target, kind: 'reply' as const, text: 'Question\n1. Yes' }
  const card = { token: 'a'.repeat(64), question: 'Question', options: ['Yes'] }
  const first = await ChannelRuntime.open({ permissions, storePath: file })
  await first.activate(new SimulatedChannelAdapter({ ref }), SIMULATOR_ADAPTER_IDENTITY)
  await first.notifyQuestionOnce(notification, caller, 'delivery:question', card)
  expect(first.deliverySnapshot('delivery:question', caller)?.state).toBe('queued')
  await expect(first.notifyQuestionOnce(notification, caller, 'delivery:question', { ...card, question: 'Changed' }))
    .rejects.toThrow('Operation conflict')
  await expect(first.notifyQuestionOnce(notification, caller, 'delivery:bad', { ...card, token: 'bad' })).rejects
    .toThrow('Invalid question card')
  await first.dispose()
  const second = await ChannelRuntime.open({ permissions, storePath: file })
  const adapter = new SimulatedChannelAdapter({ ref })
  const handle = await second.activate(adapter, SIMULATOR_ADAPTER_IDENTITY)
  await handle.drainOutbound()
  expect(adapter.sent[0]?.questionCard).toEqual(card)
  expect(second.deliverySnapshot('delivery:question', caller)?.state).toBe('sent')
  expect(permissions.requests.filter(request => request.capability === 'channel.messages.send')).toHaveLength(3)
  await second.dispose()
})
