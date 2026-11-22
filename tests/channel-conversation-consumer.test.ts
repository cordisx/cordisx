import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'

const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
const commandGrant = { id: 'commands', action: 'command' as const, effect: 'allow' as const }
const a = '01a10000-0000-7000-8000-000000000001', b = '01a10000-0000-7000-8000-000000000002'
const channel = (id = 'oc_one', kind: 'direct' | 'group' = 'direct') => ({
  ...account,
  conversationId: id,
  kind,
  threadId: id,
  semantics: 'conversation' as const,
})
const message = (id: string, text = 'hello', source = channel()): ChannelUserInput => ({
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'channel', event: { ...source, eventId: id, messageId: id, actor: { ...account, userId: 'alice' } } },
  receivedAt: '2026-11-15T00:00:00Z',
})
const roots: string[] = [], consumers: ChannelConversationConsumer[] = []
afterEach(async () => {
  for (const consumer of consumers.splice(0)) await consumer.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(existingFile?: string) {
  const root = existingFile ? path.dirname(existingFile) : await mkdtemp(path.join(os.tmpdir(), 'channel-consumer-'))
  if (!existingFile) roots.push(root)
  const file = existingFile ?? path.join(root, 'consumer.json')
  const receipts = new Map<string, { state: string }>()
  const native = {
    contextObservations: () => undefined,
    hasPreparation: () => false,
    isPreparing: () => false,
    exists: vi.fn(async () => true),
    start: vi.fn(async (_id: string, _input: ChannelUserInput, session?: string) => ({
      state: 'running' as const,
      sessionId: session ?? a,
      turnId: 'turn-1',
    })),
    completion: vi.fn(async () => ({ state: 'completed' as const, text: 'reply' })),
    reconcile: vi.fn(async () => ({
      state: 'reconciliation-required' as const,
      code: 'NATIVE_OPERATION_UNAVAILABLE_AFTER_RESTART',
    })),
  }
  const runtime = {
    inputsSince: vi.fn(async (_caller, _filters, cursor) => ({ cursor, messages: [] })),
    notifyOnce: vi.fn(async (_value, _caller, id: string) => {
      receipts.set(id, { state: 'sent' })
      return { deliveryId: id }
    }),
    deliverySnapshot: (id: string) => receipts.get(id),
  }
  const access = {
    generation: 'fixture',
    runtime,
    accounts: () => [{ ref: account, state: 'ready' }],
    conversations: async () => ({ complete: true, conversations: [] }),
    users: vi.fn(async () => ({
      complete: true,
      users: [{ id: 'ou_bob', name: 'Bob Smith' }],
    })),
    replyCapabilities: event => ({ reply: true, thread: event.kind === 'group' }),
    drain: async () => {},
  } as unknown as ChannelConversationAccess
  const report = vi.fn()
  const consumer = await ChannelConversationConsumer.open({
    profileId: 'fixture',
    file,
    access: () => access,
    native: () => native,
    report,
  })
  consumers.push(consumer)
  return { consumer, native, runtime, file, access, report }
}
async function settle(consumer: ChannelConversationConsumer) {
  await consumer.pump()
  await consumer.pump()
}

describe('persistent Channel chat consumer', () => {
  it('does not let a conversation-scoped command grant mutate global policy', async () => {
    const f = await fixture(), source = channel('oc_scoped', 'group')
    const grant = { ...commandGrant, conversationId: source.conversationId, userIds: ['alice'] }
    await f.consumer.policySet({ enabled: true, rules: [grant] }, 0)
    await f.consumer.receive(
      'inbox:global-denied',
      message('om_global_denied', '/allow-user ou_bob --global', source),
      true,
    )
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toEqual([grant])
    expect(f.runtime.notifyOnce.mock.calls[0]?.[0].text).toContain('没有修改全局策略的权限')
    await f.consumer.receive('inbox:local-allowed', message('om_local_allowed', '/allow-user ou_bob', source), true)
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toContainEqual(expect.objectContaining({
      action: 'dispatch',
      effect: 'allow',
      conversationId: source.conversationId,
      userIds: ['ou_bob'],
    }))
  })
  it('replaces the terminal approval card after the topic receipt materializes its root snapshot', async () => {
    const f = await fixture(), source = channel('oc_cards', 'group')
    let listener!: (event: Record<string, unknown>) => void
    let visible: object | undefined
    const sendCard = vi.fn(async (_event: unknown, card: object) => {
      visible = card
      return 'om_card'
    })
    const updateCard = vi.fn(async (_event: unknown, _messageId: string, card: object) => {
      visible = card
    })
    f.access.sendCard = sendCard
    f.access.updateCard = updateCard
    const answerApproval = vi.fn(async () => {
      listener({ event: 'resolved', reference: 'native-request' })
      return { status: 'submitted' }
    })
    f.consumer.setNativeExtras(() =>
      ({
        ...f.native,
        setPersonaRegistry: vi.fn(),
        label: async () => '飞书 · 卡片群',
        approvalEvents: (callback: typeof listener) => {
          listener = callback
          return () => {}
        },
        answerApproval,
      }) as never
    )
    await f.consumer.policySet({ enabled: true, rules: [commandGrant] }, 0)
    await f.consumer.bind({ channel: source, mode: 'listen', autoReply: false }, a)
    listener({
      event: 'requested',
      reference: 'native-request',
      requestId: 7,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: a, turnId: 'turn', itemId: 'item', command: 'printf hello' },
    })
    await vi.waitFor(() => expect(sendCard).toHaveBeenCalledTimes(1))
    const initial = visible as { elements: { actions?: { value: { channelApproval: string } }[] }[] }
    const token = initial.elements.find(row => row.actions)?.actions?.[0]?.value.channelApproval!
    f.runtime.notifyOnce.mockImplementation(async (value, _caller, id) => {
      expect(value.target).toMatchObject({ semantics: 'topic', threadId: 'om_card' })
      expect(JSON.stringify(visible)).toContain('已处理')
      visible = initial // Materializing the topic root must not become the final card state.
      return { deliveryId: id }
    })
    await f.consumer.cardAction(account, {
      messageId: 'om_card',
      chatId: source.conversationId,
      operator: { openId: 'alice' },
      action: { tag: 'button', value: { channelApproval: token, decision: 'decline' } },
    })
    expect(JSON.stringify(visible)).toContain('已处理')
    expect(JSON.stringify(visible)).not.toContain('等待批准')
    expect(answerApproval).toHaveBeenCalledTimes(1)
    expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(1)
    expect(updateCard).toHaveBeenCalledTimes(2)
    expect(f.native.start).not.toHaveBeenCalled()
  })
  it.each(['conversation', 'none'])(
    'routes all Host command result paths independently of Agent mode %s',
    async replyMode => {
      const f = await fixture(), source = channel('oc_commands', 'group')
      await f.consumer.policySet({ enabled: true, replyMode, rules: [commandGrant] }, 0)
      const commands = ['/bind invalid', '/unbind invalid', '/wake', `/bind ${a}`, '/bind-status', '/unbind']
      for (const [index, command] of commands.entries()) {
        await f.consumer.receive('inbox:command:' + index, message('om_command_' + index, command, source), true)
        await settle(f.consumer)
      }
      expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(commands.length)
      expect(f.runtime.notifyOnce.mock.calls.map(([value]) => value.target)).toEqual(
        commands.map((_, index) => expect.objectContaining({ semantics: 'topic', threadId: 'om_command_' + index })),
      )
      expect(f.native.start).not.toHaveBeenCalled()
      await f.consumer.receive('inbox:command:0', message('om_command_0', commands[0]!, source), true)
      await settle(f.consumer)
      expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(commands.length)
    },
  )
  it('uses direct replies without topics, honors command/send denials and never falls back after an uncertain send', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, replyMode: 'none' }, 0)
    await f.consumer.receive('inbox:direct', message('om_direct', '/bind-status'))
    await settle(f.consumer)
    expect(f.runtime.notifyOnce.mock.calls[0]?.[0]).toMatchObject({
      target: { semantics: 'reply-chain', threadId: 'om_direct' },
    })
    await f.consumer.policySet({
      enabled: true,
      rules: [commandGrant, {
        id: 'deny-command',
        action: 'command',
        effect: 'deny',
        commands: ['deny-user'],
        userIds: ['alice'],
      }],
    }, f.consumer.policy().revision)
    await f.consumer.receive('inbox:denied-command', message('om_denied_command', '/deny-user ou_bob'))
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toHaveLength(2)
    expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(2)
    expect(f.runtime.notifyOnce.mock.calls.at(-1)?.[0].text).toContain('没有执行 /deny-user 的权限')
    await f.consumer.policySet({
      enabled: true,
      rules: [commandGrant, { id: 'deny-send', action: 'send', effect: 'deny' }],
    }, f.consumer.policy().revision)
    await f.consumer.receive('inbox:denied-send', message('om_denied_send', '/bind-status'))
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(2)
    await f.consumer.policySet({ enabled: true }, f.consumer.policy().revision)
    f.runtime.notifyOnce.mockRejectedValueOnce(new Error('uncertain send'))
    await f.consumer.receive('inbox:uncertain', message('om_uncertain', '/bind-status'))
    await settle(f.consumer)
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(3)
    expect(f.report).toHaveBeenCalledWith('CHANNEL_COMMAND_REPLY_RESULT_UNKNOWN')
  })
  it('resolves command mentions and spaced names to one policy identity and resets using the same ID', async () => {
    const f = await fixture(), source = channel('oc_users', 'group')
    await f.consumer.policySet({ enabled: true, rules: [commandGrant] }, 0)
    await f.consumer.receive('inbox:deny', message('om_deny', '/deny-user @Bob Smith', source), true, true, {
      mentions: [{ key: '@_user_2', userId: 'ou_bob', name: 'Bob Smith' }],
    })
    await settle(f.consumer)
    expect(f.access.users).not.toHaveBeenCalled()
    expect(f.consumer.policy().policy.rules.filter(rule => rule.action === 'dispatch')).toMatchObject([{
      userIds: ['ou_bob'],
      effect: 'deny',
    }])
    await f.consumer.receive('inbox:reset', message('om_reset', '/reset-user "Bob Smith"', source), true)
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toEqual([commandGrant])
    await f.consumer.receive('inbox:allow', message('om_allow', '/allow-user ou_bob --global', source), true)
    await settle(f.consumer)
    const global = f.consumer.policy().policy.rules.find(rule => rule.action === 'dispatch')
    expect(global).toMatchObject({ userIds: ['ou_bob'], effect: 'allow' })
    expect(global?.conversationId).toBeUndefined()
  })
  it('does not edit a user rule before a same-actor candidate choice and rechecks permission after lookup', async () => {
    const f = await fixture(), source = channel('oc_choices', 'group')
    const users = vi.fn(async () => ({
      complete: true,
      users: [{ id: 'ou_a', name: '同名' }, { id: 'ou_b', name: '同名' }],
    }))
    f.access.users = users
    await f.consumer.policySet({ enabled: true, rules: [commandGrant] }, 0)
    await f.consumer.receive('inbox:choose', message('om_choose', '/deny-user 同名', source), true)
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toEqual([commandGrant])
    const response = f.runtime.notifyOnce.mock.calls[0]?.[0].text
    expect(response).toContain('1. @同名 (ou_a)')
    expect(response).toContain('2. @同名 (ou_b)')
    const token = /--choose ([\w-]+) /u.exec(response)![1]!
    const other = message('om_other', '/deny-user --choose ' + token + ' 2', source)
    await f.consumer.receive('inbox:other', {
      ...other,
      source: { kind: 'channel', event: { ...other.source.event, actor: { ...account, userId: 'eve' } } },
    }, true)
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toEqual([commandGrant])
    await f.consumer.receive(
      'inbox:selected',
      message('om_selected', '/deny-user --choose ' + token + ' 2', source),
      true,
    )
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules.filter(rule => rule.action === 'dispatch')).toMatchObject([{
      userIds: ['ou_b'],
    }])
    users.mockImplementationOnce(async () => {
      await f.consumer.policySet({
        enabled: true,
        rules: [{ id: 'denied', action: 'command', effect: 'deny', commands: ['allow-user'] }],
      }, f.consumer.policy().revision)
      return { complete: true, users: [{ id: 'ou_c', name: 'Charlie' }] }
    })
    await f.consumer.receive('inbox:revoked', message('om_revoked', '/allow-user Charlie', source), true)
    await settle(f.consumer)
    expect(f.consumer.policy().policy.rules).toEqual([{
      id: 'denied',
      action: 'command',
      effect: 'deny',
      commands: ['allow-user'],
    }])
    expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(3)
  })
  it('lets the exact Agent choose its final route without a send, suppresses none, and rejects another chat/turn', async () => {
    const f = await fixture(), source = channel('oc_group', 'group')
    await f.consumer.policySet({ enabled: true, autoReply: true, replyMode: 'conversation' }, 0)
    await f.consumer.bind({ channel: source, mode: 'deliver', autoReply: true, replyMode: 'agent' }, a)
    f.native.completion.mockResolvedValue({ state: 'running' } as never)
    await f.consumer.receive('inbox:choice', message('om_choice', 'hello', source), true)
    await settle(f.consumer)
    const operationId = f.consumer.status(a).jobs[0]!.id
    const tools = new ChannelConversationTools(() => f.access, f.consumer)
    const metadata = { 'x-codex-turn-metadata': JSON.stringify({ thread_id: a, turn_id: 'turn-1' }) }
    try {
      await expect(tools.call('reply-mode', { operationId, mode: 'thread' }, {
        'x-codex-turn-metadata': { thread_id: b, turn_id: 'turn-1' },
      })).resolves.toMatchObject({ status: 'rejected', code: 'REPLY_OPERATION_NOT_FOUND' })
      await expect(tools.call('reply-mode', { operationId, mode: 'thread' }, {
        'x-codex-turn-metadata': { thread_id: a, turn_id: 'other-turn' },
      })).resolves.toMatchObject({ status: 'rejected', code: 'REPLY_OPERATION_NOT_FOUND' })
      await expect(tools.call('reply-mode', { operationId, mode: 'thread' }, metadata)).resolves.toMatchObject({
        status: 'ok',
        mode: 'thread',
        sendsMessage: false,
      })
      expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
      f.native.completion.mockResolvedValue({ state: 'completed', text: 'reply' })
      await settle(f.consumer)
      expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(1)
      expect(f.runtime.notifyOnce.mock.calls[0]?.[0]).toMatchObject({
        target: { semantics: 'topic', threadId: 'om_choice' },
      })
      await expect(tools.call('reply-mode', { operationId, mode: 'reply' }, metadata)).resolves.toMatchObject({
        status: 'rejected',
        code: 'REPLY_ALREADY_RESERVED',
      })
      f.native.completion.mockResolvedValue({ state: 'running' } as never)
      await f.consumer.receive('inbox:none', message('om_none', 'hello', source), true)
      await settle(f.consumer)
      const next = f.consumer.status(a).jobs.find(job => job.state === 'running')!
      await tools.call('reply-mode', { operationId: next.id, mode: 'none' }, metadata)
      f.native.completion.mockResolvedValue({ state: 'completed', text: 'reply' })
      await settle(f.consumer)
      expect(f.runtime.notifyOnce).toHaveBeenCalledTimes(1)
      expect(f.consumer.status(a).jobs.every(job => job.state === 'completed')).toBe(true)
    } finally {
      tools.dispose()
    }
  })
  it('keeps a reserved reply target through policy changes and process restart without a second delivery ID', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true, replyMode: 'reply' }, 0)
    await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
    const snapshot = vi.spyOn(f.runtime, 'deliverySnapshot').mockReturnValue({ state: 'queued' } as never)
    await f.consumer.receive('inbox:retry', message('om_retry'))
    await settle(f.consumer)
    expect(f.consumer.status(a).jobs[0]?.state).toBe('replying')
    const first = f.runtime.notifyOnce.mock.calls[0]!
    await f.consumer.policySet({ enabled: true, autoReply: true, replyMode: 'thread' }, f.consumer.policy().revision)
    await f.consumer.dispose()
    snapshot.mockRestore()
    const next = await fixture(f.file)
    await settle(next.consumer)
    expect(next.runtime.notifyOnce.mock.calls[0]?.[0]).toEqual(first[0])
    expect(next.runtime.notifyOnce.mock.calls[0]?.[2]).toBe(first[2])
    expect(next.runtime.notifyOnce.mock.calls[0]?.[0]).toMatchObject({ target: { semantics: 'reply-chain' } })
  })
  it('preserves many-to-many listening and history across restart', async () => {
    const f = await fixture()
    await f.consumer.bind({ channel: channel() }, a)
    await f.consumer.bind({ channel: channel('oc_two') }, a)
    await f.consumer.bind({ channel: channel() }, b)
    await f.consumer.receive('inbox:1', message('om_1'), false, true, {
      senderName: 'Alice',
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    })
    await settle(f.consumer)
    expect(f.consumer.history({}, a).messages[0]?.addressing).toEqual({
      senderName: 'Alice',
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    })
    expect(f.consumer.bindings()).toHaveLength(3)
    expect(f.consumer.history({}, a).messages).toHaveLength(1)
    expect(f.consumer.history({}, b).messages).toHaveLength(1)
    await f.consumer.dispose()
    const next = await fixture(f.file)
    expect(next.consumer.bindings()).toHaveLength(3)
    expect(next.consumer.history({}, b).messages).toHaveLength(1)
    expect(f.native.start).not.toHaveBeenCalled()
  })
  it('preserves enriched sender names for local history and uses the scoped cache for late lookups', async () => {
    const f = await fixture(), source = channel('oc_one', 'direct')
    f.access.messageContext = async () => ({
      platform: '飞书',
      conversation: { id: 'oc_one', kind: 'direct' },
      sender: { userId: 'alice', name: 'Alice' },
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    })
    await f.consumer.policySet({ enabled: true }, 0)
    await f.consumer.bind({ channel: source, mode: 'deliver' }, a)
    await f.consumer.receive('inbox:named', message('om_named', 'hello', source), false, true, {
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    })
    await settle(f.consumer)
    expect(f.consumer.history({}, a).messages[0]?.addressing).toEqual({
      senderName: 'Alice',
      mentions: [{ key: '@1', userId: 'ou_bob', name: 'Bob' }],
    })
    f.access.senderName = () => 'Cached name'
    f.access.messageContext = undefined
    await f.consumer.receive('inbox:late', message('om_late', 'later', source))
    await settle(f.consumer)
    expect(f.consumer.history({}, a).messages[1]?.addressing?.senderName).toBe('Cached name')
  })
  it('never dispatches unrelated group chatter and waits for persisted mention metadata', async () => {
    const f = await fixture(), source = channel('oc_group', 'group')
    await f.consumer.policySet({ enabled: true, groupReception: 'all' }, 0)
    await f.consumer.receive('inbox:idle', message('om_idle', 'unrelated', source))
    await settle(f.consumer)
    expect(f.native.start).not.toHaveBeenCalled()
    await f.consumer.receive('inbox:mention', message('om_mention', 'hello', source), true, false)
    await settle(f.consumer)
    expect(f.native.start).not.toHaveBeenCalled()
    await f.consumer.receive('inbox:mention', message('om_mention', 'hello', source), true, true)
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledTimes(1)
    expect(f.consumer.bindings()[0]?.sessionId).toBe(a)
    expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
    expect(f.native.completion).toHaveBeenCalledWith(a, 'turn-1', false)
  })
  it('queues for a busy chat and unbinding suppresses queued and running replies', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    const binding = await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
    f.native.start.mockResolvedValueOnce({ state: 'busy' } as never)
    await f.consumer.receive('inbox:1', message('om_1'))
    await f.consumer.pump()
    await f.consumer.bindingAction('unbind', binding.id)
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
    expect(f.consumer.status(a).jobs.every(job => job.state === 'cancelled' || job.state === 'completed')).toBe(true)
  })
  it('does not export an earlier local-only turn after opt-in, but lets later turns use the enabled mode', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    f.native.completion.mockResolvedValue({ state: 'running' } as never)
    await f.consumer.receive('inbox:local', message('om_local'))
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      undefined,
      expect.any(AbortSignal),
      expect.objectContaining({ enabled: false }),
      expect.objectContaining({ sender: { userId: 'alice' }, platform: '飞书' }),
      {},
      {},
    )
    await f.consumer.policySet({ enabled: true, autoReply: true }, f.consumer.policy().revision)
    f.native.completion.mockResolvedValue({ state: 'completed', text: 'local answer' })
    await settle(f.consumer)
    expect(f.native.completion).toHaveBeenLastCalledWith(a, 'turn-1', false)
    expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
    await f.consumer.receive('inbox:automatic', message('om_automatic'))
    await settle(f.consumer)
    expect(f.native.completion).toHaveBeenLastCalledWith(a, 'turn-1', true)
    expect(f.runtime.notifyOnce).toHaveBeenCalledOnce()
  })
  it.each(['profile', 'binding'])(
    "rechecks the current %s opt-in before collecting a running turn's final answer",
    async scope => {
      const f = await fixture()
      await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
      await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: true }, a)
      f.native.completion.mockResolvedValue({ state: 'running' } as never)
      await f.consumer.receive('inbox:running', message('om_running'))
      await settle(f.consumer)
      if (scope === 'profile') {
        await f.consumer.policySet({ enabled: true, autoReply: false }, f.consumer.policy().revision)
      } else {
        await f.consumer.bind({ channel: channel(), mode: 'deliver', autoReply: false }, a)
      }
      f.native.completion.mockResolvedValue({ state: 'completed', text: 'local answer' })
      await settle(f.consumer)
      expect(f.native.completion).toHaveBeenLastCalledWith(a, 'turn-1', false)
      expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
      expect(f.consumer.status(a).jobs[0]?.state).toBe('completed')
    },
  )
  it('rechecks policy after an asynchronous final read before reserving an external reply', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
    f.native.completion.mockImplementationOnce(async () => {
      await f.consumer.policySet({ enabled: true, autoReply: false }, f.consumer.policy().revision)
      return { state: 'completed', text: 'keep local' }
    })
    await f.consumer.receive('inbox:change', message('om_change'))
    await settle(f.consumer)
    expect(f.runtime.notifyOnce).not.toHaveBeenCalled()
    expect(f.consumer.status(a).jobs[0]?.state).toBe('completed')
  })
  it('keeps old pending jobs without a captured opt-in local across restart', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true, autoReply: true }, 0)
    f.native.completion.mockResolvedValue({ state: 'running' } as never)
    await f.consumer.receive('inbox:legacy', message('om_legacy'))
    await settle(f.consumer)
    await f.consumer.dispose()
    const store = await ChannelConversationStore.open(f.file)
    await store.mutate(state => {
      for (const job of Object.values(state.jobs)) delete job.finalDeliveryEnabled
    })
    await store.close()
    const next = await fixture(f.file)
    await settle(next.consumer)
    expect(next.native.completion).toHaveBeenLastCalledWith(a, 'turn-1', false)
    expect(next.runtime.notifyOnce).not.toHaveBeenCalled()
    expect(next.consumer.status(a).jobs[0]?.state).toBe('completed')
  })
  it('recovers uncertain reservations without repeating a native start', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    f.native.start.mockRejectedValueOnce(new Error('unknown effect'))
    await f.consumer.receive('inbox:1', message('om_1'))
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledTimes(1)
    expect(f.native.reconcile).toHaveBeenCalledTimes(1)
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledTimes(1)
  })
  it('attaches a recovered auto-created chat and continues later messages without creating another chat', async () => {
    const f = await fixture()
    await f.consumer.policySet({ enabled: true }, 0)
    f.native.start.mockRejectedValueOnce(new Error('unknown effect'))
    f.native.reconcile.mockResolvedValueOnce({ state: 'running', sessionId: a, turnId: 'turn-1' } as never)
    await f.consumer.receive('inbox:1', message('om_1'))
    await settle(f.consumer)
    await settle(f.consumer)
    expect(f.consumer.bindings()).toMatchObject([{ sessionId: a, mode: 'deliver' }])
    await f.consumer.receive('inbox:2', message('om_2'))
    await settle(f.consumer)
    expect(f.native.start).toHaveBeenCalledTimes(2)
    expect(f.native.start.mock.calls[1]?.[2]).toBe(a)
    expect(f.consumer.bindings()).toHaveLength(1)
  })
  it('uses one conversation binding across reply-chain changes', async () => {
    const f = await fixture()
    const one = await f.consumer.bind({ channel: channel('oc_group', 'group') }, a)
    const two = await f.consumer.bind({
      channel: { ...channel('oc_group', 'group'), threadId: 'om_reply', semantics: 'reply-chain' },
    }, a)
    expect(two.id).toBe(one.id)
    expect(f.consumer.bindings()).toHaveLength(1)
  })
  it('uses a policy-only revision and retains more bindings than the renderer default bound', async () => {
    const f = await fixture()
    await f.consumer.dispose()
    const store = await ChannelConversationStore.open(f.file)
    await store.mutate(state => {
      for (let index = 0; index < 300; index++) {
        state.bindings['b' + index] = {
          id: 'b' + index,
          channel: channel('oc_' + index),
          sessionId: a,
          hostId: 'local',
          profileId: 'fixture',
          createdAt: '2026-11-15T00:00:00Z',
          fromSequence: 1,
          mode: 'listen',
          autoReply: false,
          state: 'active',
        }
      }
    })
    await store.close()
    const next = await fixture(f.file)
    expect(next.consumer.bindings()).toHaveLength(300)
    await next.consumer.receive('inbox:1', message('om_1'))
    await settle(next.consumer)
    expect(next.consumer.policy().revision).toBe(0)
    await expect(next.consumer.policySet({ enabled: true }, 0)).resolves.toMatchObject({ revision: 1 })
    await expect(next.consumer.policySet({}, 0)).rejects.toThrow('REVISION_CONFLICT')
  })
})
