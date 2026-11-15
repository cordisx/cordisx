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
