import { describe, expect, it, vi } from 'vitest'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { createNativeAgentModelsHandler } from '../packages/cli/src/launcher/native-agent-models.js'

const account = { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'test' }
function fixture() {
  const receipts = new Map<string, { state: string }>()
  const notifyOnce = vi.fn(async (_message, _caller, id: string) => {
    receipts.set(id, { state: 'sent' })
    return { deliveryId: id }
  })
  const drain = vi.fn(async () => {})
  const access = {
    generation: 'one',
    accounts: () => [{ ref: account, state: 'ready' }],
    conversations: vi.fn(async () => ({
      complete: true,
      conversations: [{ id: 'oc_group', name: 'Test', kind: 'group' }],
    })),
    drain,
    runtime: { notifyOnce, deliverySnapshot: (id: string) => receipts.get(id) },
  } as unknown as ChannelConversationAccess
  const tools = new ChannelConversationTools(() => access)
  return { tools, access, notifyOnce, drain }
}
describe('configured Channel tools', () => {
  it('maps each explicit target mode and validates all reply anchors before a batch effect', async () => {
    const f = fixture()
    try {
      await expect(f.tools.call('send-many', {
        account,
        operationId: 'routes',
        text: 'requested',
        targets: [
          { id: 'oc_one', kind: 'group', replyMode: 'conversation' },
          { id: 'oc_one', kind: 'group', replyMode: 'reply', replyTo: 'om_source' },
          { id: 'oc_one', kind: 'group', replyMode: 'thread', replyTo: 'om_source' },
        ],
      })).resolves.toMatchObject({ status: 'ok' })
      expect(f.notifyOnce.mock.calls.map(([notification]) => (notification as { target: unknown }).target)).toEqual([
        expect.objectContaining({ semantics: 'conversation', threadId: 'oc_one' }),
        expect.objectContaining({ semantics: 'reply-chain', threadId: 'om_source' }),
        expect.objectContaining({ semantics: 'topic', threadId: 'om_source' }),
      ])
      f.notifyOnce.mockClear()
      for (
        const target of [
          { id: 'oc_one', kind: 'group', replyMode: 'thread' },
          { id: 'oc_one', kind: 'group', replyMode: 'conversation', replyTo: 'om_source' },
          { id: 'oc_one', kind: 'group', replyMode: 'none' },
        ]
      ) {
        await expect(
          f.tools.call('send-many', {
            account,
            operationId: 'bad-route',
            text: 'requested',
            targets: [{ id: 'oc_one', kind: 'group' }, target],
          }),
        ).resolves.toMatchObject({ status: 'rejected' })
      }
      expect(f.notifyOnce).not.toHaveBeenCalled()
    } finally {
      f.tools.dispose()
    }
  })
  it('ordinary native tool dispatch uses the configured authority and caller metadata', async () => {
    const f = fixture(), call = vi.fn((operation, value, metadata) => f.tools.call(operation, value, metadata))
    const native = createNativeAgentModelsHandler({ channel: call } as never)
    try {
      const metadata = { threadId: 'current-chat' }
      await expect(native('channel:connections', {}, metadata)).resolves.toMatchObject({
        status: 'ok',
        connections: [{ ref: account }],
      })
      expect(call).toHaveBeenCalledWith('connections', {}, metadata)
      expect(f.notifyOnce).not.toHaveBeenCalled()
    } finally {
      f.tools.dispose()
    }
  })
  it('validates every batch target before sending and exposes honest partial receipts', async () => {
    const f = fixture()
    try {
      await expect(
        f.tools.call('send-many', {
          account,
          operationId: 'bad',
          text: 'requested',
          targets: [{ id: 'oc_one', kind: 'group' }, { id: 'invalid', kind: 'group' }],
        }),
      ).resolves.toMatchObject({ status: 'rejected' })
      expect(f.notifyOnce).not.toHaveBeenCalled()
      f.notifyOnce.mockRejectedValueOnce(new Error('CHANNEL_EFFECT_UNCERTAIN'))
      await expect(
        f.tools.call('send-many', {
          account,
          operationId: 'uncertain',
          text: 'requested',
          targets: [{ id: 'oc_one', kind: 'group' }, { id: 'oc_two', kind: 'group' }],
        }),
      ).resolves.toMatchObject({ status: 'partial', attempted: 1 })
      expect(f.notifyOnce).toHaveBeenCalledTimes(1)
    } finally {
      f.tools.dispose()
    }
  })
  it('reads the same individual receipts for a stable batch operation without sending again', async () => {
    const f = fixture()
    try {
      const result = await f.tools.call('send-many', {
        account,
        operationId: 'one',
        text: 'requested',
        targets: [{ id: 'oc_one', kind: 'group' }, { id: 'ou_user', kind: 'direct' }],
      })
      expect(result).toMatchObject({ status: 'ok', receipts: [{ state: 'sent' }, { state: 'sent' }] })
      await expect(f.tools.call('receipt', { account, operationId: 'one', targetCount: 2 })).resolves.toMatchObject(
        result as object,
      )
      expect(f.notifyOnce).toHaveBeenCalledTimes(2)
    } finally {
      f.tools.dispose()
    }
  })
})

describe('local binding inventory boundary', () => {
  it('filters exact scope, returns only binding metadata and denies native enumeration or cross-session operations', async () => {
    const f = fixture()
    const bindings = [
      {
        id: 'first',
        sessionId: 'chat-one',
        state: 'active',
        mode: 'deliver',
        channel: { ...account, conversationId: 'oc_one', kind: 'group', threadId: 'secret-thread' },
        secretRef: 'never-export',
      },
      {
        id: 'second',
        sessionId: 'chat-two',
        state: 'archived',
        mode: 'listen',
        channel: { ...account, conversationId: 'oc_two', kind: 'group' },
      },
      {
        id: 'third',
        sessionId: 'chat-three',
        state: 'active',
        mode: 'deliver',
        channel: { ...account, tenantId: 'other', conversationId: 'oc_one', kind: 'group' },
      },
      {
        id: 'generic',
        sessionId: 'chat-generic',
        state: 'active',
        mode: 'deliver',
        channel: {
          adapterId: 'other-adapter',
          accountId: 'account',
          tenantId: 'tenant',
          conversationId: 'room:team-7',
          kind: 'group',
        },
      },
    ]
    const consumer = {
      status: vi.fn(() => ({ status: 'ok', revision: 42, bindings, jobs: [{ prompt: 'never-export' }] })),
      agentAccess: { caller: () => undefined, source: () => undefined },
      taskSettings: { isBound: () => false },
    }
    const tools = new ChannelConversationTools(() => f.access, consumer as never)
    const native = createNativeAgentModelsHandler(
      {
        channel: (operation: string, input: unknown, metadata: unknown) => tools.call(operation, input, metadata),
      } as never,
    )
    try {
      const result = await tools.callLocal('local-bindings', { account, conversationId: 'oc_one' })
      expect(result).toEqual({
        status: 'ok',
        generation: 'one',
        revision: 42,
        bindings: [{
          bindingId: 'first',
          sessionId: 'chat-one',
          state: 'active',
          mode: 'deliver',
          channel: { ...account, conversationId: 'oc_one', kind: 'group' },
        }],
      })
      expect(JSON.stringify(result)).not.toContain('never-export')
      expect(
        await tools.callLocal('local-bindings', {
          account: { adapterId: 'other-adapter', accountId: 'account', tenantId: 'tenant' },
          conversationId: 'room:team-7',
        }),
      ).toMatchObject({
        status: 'ok',
        revision: 42,
        bindings: [{ bindingId: 'generic', sessionId: 'chat-generic', mode: 'deliver' }],
      })
      expect(await tools.callLocal('local-bindings', { account, conversationId: '  ' })).toMatchObject({
        status: 'rejected',
        code: 'INVALID_REQUEST',
      })
      expect(await tools.callLocal('local-bindings', { account, conversationId: 'x'.repeat(513) })).toMatchObject({
        status: 'rejected',
        code: 'INVALID_REQUEST',
      })
      expect(await tools.callLocal('local-bindings', {})).toMatchObject({
        status: 'ok',
        bindings: expect.arrayContaining([
          expect.objectContaining({ bindingId: 'second', state: 'archived', mode: 'listen' }),
        ]),
      })
      expect(await tools.callLocal('local-bindings', { conversationId: 'oc_one' })).toMatchObject({
        status: 'rejected',
        code: 'INVALID_REQUEST',
      })
      const metadata = { 'openai/threadId': 'chat-one' }
      expect(await tools.callLocal('local-bindings', {}, metadata)).toMatchObject({
        status: 'rejected',
        code: 'LOCAL_CLI_REQUIRED',
      })
      expect(await tools.callLocal('local-bindings', {}, { 'cordisx/channelContext': 'untrusted' })).toMatchObject({
        status: 'rejected',
        code: 'LOCAL_CLI_REQUIRED',
      })
      expect(await native('channel:local-bindings', { account, conversationId: 'oc_one' }, metadata)).toMatchObject({
        status: 'rejected',
      })
      expect(await native('channel:local-bindings', { account, conversationId: 'oc_one' })).toMatchObject({
        status: 'rejected',
      })
      expect(await native('channel:bind-status', { sessionId: 'chat-two' }, metadata)).toMatchObject({
        status: 'rejected',
        code: 'SESSION_SCOPE_MISMATCH',
      })
      expect(await native('channel:bind-status', { sessionId: 'chat-one' }, metadata)).toMatchObject({
        status: 'ok',
        revision: 42,
      })
    } finally {
      tools.dispose()
      f.tools.dispose()
    }
  })
})
