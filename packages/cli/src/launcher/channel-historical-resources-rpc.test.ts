import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelHistoricalResourcesRpc } from './channel-historical-resources-rpc.js'
import { CHANNEL_CONVERSATION_POLICY_INITIAL, parseChannelConversationPolicy } from './channel-conversation-policy.js'
import { authorizeChannelResource } from './channel-resource-permissions.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const source: ChannelEventRef = {
  ...account,
  conversationId: 'oc_chat',
  kind: 'group',
  threadId: 'om_root',
  semantics: 'reply-chain',
  eventId: 'incoming',
  messageId: 'om_incoming',
  actor: { ...account, userId: 'ou_actor' },
}
const input = { account, conversationId: 'oc_chat', kind: 'group', messageId: 'om_old', index: 0 }
const policy = {
  ...CHANNEL_CONVERSATION_POLICY_INITIAL,
  enabled: true,
  rules: [{
    id: 'resource',
    action: 'command' as const,
    effect: 'allow' as const,
    commands: ['resource-read'],
    userIds: ['ou_actor'],
  }],
}
const context = () => ({
  current: {
    accounts: () => [{ ref: account, state: 'ready' }],
    readMessage: vi.fn(async (_source: ChannelEventRef, messageId: string) => ({
      status: 'ok' as const,
      message: { messageId, ...(messageId === 'om_incoming' ? { parentId: 'om_old' } : {}) },
    })),
    historicalResource: vi.fn(async () => ({ status: 'ok', resource: { state: 'not-prepared' } })),
  },
  source,
  caller: 'session',
  active: () => true,
  consumer: { commandAllowed: () => true, policy: () => ({ policy }) },
})

describe('historical resource RPC authorization', () => {
  it('requires explicit resource-read allow, does not inherit generic/history/send grants', () => {
    expect(parseChannelConversationPolicy(policy).rules[0]?.commands).toEqual(['resource-read'])
    for (const commands of [undefined, ['history'], ['send'], ['forward-read']]) {
      const rule = {
        id: 'generic',
        action: 'command' as const,
        effect: 'allow' as const,
        ...(commands ? { commands } : {}),
      }
      expect(() => authorizeChannelResource({ ...policy, rules: [rule] }, source)).toThrow(
        'CHANNEL_RESOURCE_PERMISSION_DENIED',
      )
    }
    expect(() => authorizeChannelResource(policy, source)).not.toThrow()
    expect(() =>
      authorizeChannelResource({
        ...policy,
        rules: [...policy.rules, { id: 'deny', action: 'command', effect: 'deny' }],
      }, source)
    ).toThrow('CHANNEL_RESOURCE_PERMISSION_DENIED')
  })
  it('walks only the source ancestry and passes stable caller and range', async () => {
    const ctx = context()
    await channelHistoricalResourcesRpc({ ...input, offset: 0, length: 65536 }, account, ctx, 'resource-read')
    expect(ctx.current.readMessage.mock.calls.map(call => call[1])).toEqual(['om_incoming', 'om_old'])
    expect(ctx.current.historicalResource).toHaveBeenCalledWith(
      source,
      'om_old',
      0,
      false,
      'session',
      expect.any(Function),
      { offset: 0, length: 65536 },
      expect.any(AbortSignal),
    )
    expect(await channelHistoricalResourcesRpc({ ...input, messageId: 'om_sibling' }, account, ctx, 'resource-refetch'))
      .toEqual({ status: 'rejected', code: 'CHANNEL_MESSAGE_NOT_IN_REPLY_CHAIN' })
    expect(ctx.current.historicalResource).toHaveBeenCalledTimes(1)
  })
  it('rejects raw keys, URLs, invalid ranges and source mismatch before SDK reads', async () => {
    const ctx = context()
    for (
      const value of [{ ...input, fileKey: 'key' }, { ...input, url: 'https://example.test' }, {
        ...input,
        offset: 0,
        length: 65537,
      }, { ...input, index: -1 }]
    ) {
      await expect(channelHistoricalResourcesRpc(value, account, ctx, 'resource-read')).rejects.toThrow(
        'INVALID_REQUEST',
      )
    }
    await expect(
      channelHistoricalResourcesRpc({ ...input, conversationId: 'oc_other' }, account, ctx, 'resource-status'),
    )
      .rejects.toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
    expect(ctx.current.readMessage).not.toHaveBeenCalled()
  })
  it('bounds the entire ancestry operation and does not continue after late parent resolution', async () => {
    vi.useFakeTimers()
    const ctx = context()
    let resolve!: (value: { status: 'ok'; message: { messageId: string; parentId: string } }) => void
    ctx.current.readMessage.mockImplementationOnce(() =>
      new Promise(done => {
        resolve = done
      })
    )
    try {
      const result = channelHistoricalResourcesRpc(input, account, ctx, 'resource-refetch').catch(error =>
        error.message
      )
      await vi.advanceTimersByTimeAsync(2501)
      expect(await result).toBe('HISTORICAL_RESOURCE_TIMEOUT')
      resolve({ status: 'ok', message: { messageId: 'om_incoming', parentId: 'om_old' } })
      await vi.advanceTimersByTimeAsync(1)
      expect(ctx.current.readMessage).toHaveBeenCalledTimes(1)
      expect(ctx.current.historicalResource).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
