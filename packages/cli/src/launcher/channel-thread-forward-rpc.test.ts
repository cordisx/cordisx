import { describe, expect, it, vi } from 'vitest'
import { channelThreadForwardRpc } from './channel-thread-forward-rpc.js'
import { authorizedChannelForwardOperation } from './channel-forward-authority.js'
import { authorizeChannelForward } from './channel-forward-permissions.js'
import { CHANNEL_CONVERSATION_POLICY_INITIAL } from './channel-conversation-policy.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const source = {
  ...account,
  conversationId: 'oc_source',
  kind: 'group' as const,
  threadId: 'omt_topic',
  eventId: 'event',
  semantics: 'topic' as const,
  actor: { ...account, userId: 'ou_actor' },
}
const value = {
  account,
  source: { id: 'oc_source', kind: 'group' },
  target: { id: 'oc_target', kind: 'group' },
  operationId: 'stable',
  threadId: 'omt_topic',
  anchorMessageId: 'om_anchor',
}

describe('whole-topic authorization boundary', () => {
  it('keeps operation ownership stable across later inputs without disclosing other actors', async () => {
    const scopes: string[] = []
    const access = {
      accounts: () => [{ ref: account, state: 'ready' }],
      threadForward: vi.fn(async (_request: unknown, scope: string) => {
        scopes.push(scope)
        return { state: 'unknown' }
      }),
    }
    for (
      const event of [source, { ...source, eventId: 'later', messageId: 'om_later', threadId: 'omt_later' }, {
        ...source,
        actor: { ...source.actor, userId: 'ou_other' },
      }]
    ) {
      await authorizedChannelForwardOperation('thread-forward-receipt', value, {
        current: access as never,
        source: event,
        callerSession: 'session',
        turnId: event.eventId,
        active: () => true,
      })
    }
    expect(scopes[0]).toBe(scopes[1])
    expect(scopes[2]).not.toBe(scopes[0])
  })
  it('normalizes only the authenticated source and independently checks the destination', async () => {
    const threadForward = vi.fn(async () => ({ state: 'sent', externalMessageId: 'om_native' }))
    const authorize = vi.fn()
    const access = { accounts: () => [{ ref: account, state: 'ready' }], threadForward }
    expect(
      await channelThreadForwardRpc({
        operation: 'thread-forward',
        value,
        access: access as never,
        source,
        scope: 'verified-caller',
        active: () => true,
        authorize,
      }),
    ).toMatchObject({ status: 'ok' })
    expect(threadForward).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: 'omt_topic',
        anchorMessageId: 'om_anchor',
        source: { ...account, conversationId: 'oc_source', kind: 'group' },
      }),
      'verified-caller',
      false,
      expect.any(Function),
    )
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'oc_source', actor: source.actor }),
      'read',
    )
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'oc_target', actor: source.actor }),
      'thread-forward',
    )
    await expect(
      channelThreadForwardRpc({
        operation: 'thread-forward',
        value: { ...value, source: { id: 'oc_other', kind: 'group' } },
        access: access as never,
        source,
        scope: 'verified-caller',
        active: () => true,
        authorize,
      }),
    )
      .rejects.toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
    expect(threadForward).toHaveBeenCalledTimes(1)
  })
  it('rejects stale generation before disclosure and never gives a bound caller missing source access', async () => {
    let active = true
    const access = {
      accounts: () => [{ ref: account, state: 'ready' }],
      threadForward: vi.fn(async () => {
        active = false
        return { state: 'sent', externalMessageId: 'om_private' }
      }),
    }
    await expect(
      channelThreadForwardRpc({
        operation: 'thread-forward',
        value,
        access: access as never,
        source,
        scope: 'verified-caller',
        active: () => active,
        authorize: () => {},
      }),
    ).rejects.toThrow('THREAD_FORWARD_REVOKED')
    await expect(
      authorizedChannelForwardOperation('thread-forward', value, {
        current: access as never,
        nativeCaller: 'session',
        consumer: { taskSettings: { isBound: () => true } } as never,
        active: () => true,
      }),
    )
      .rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
  })
  it('does not derive whole-thread mutation authority from send or legacy forward grants', () => {
    const rule = {
      id: 'allow',
      effect: 'allow' as const,
      action: 'command' as const,
      commands: ['send', 'forward', 'merge-forward', 'forward-read'],
    }
    const policy = { ...CHANNEL_CONVERSATION_POLICY_INITIAL, enabled: true, rules: [rule] }
    expect(() => authorizeChannelForward(policy, source, 'thread-forward')).toThrow('CHANNEL_FORWARD_PERMISSION_DENIED')
    const explicit = { ...policy, rules: [{ ...rule, commands: ['forward-read', 'thread-forward'] }] }
    expect(() => authorizeChannelForward(explicit, source, 'read')).not.toThrow()
    expect(() => authorizeChannelForward(explicit, source, 'thread-forward')).not.toThrow()
    const revoked = {
      ...explicit,
      rules: [...explicit.rules, { ...rule, id: 'deny', effect: 'deny' as const, commands: ['thread-forward'] }],
    }
    expect(() => authorizeChannelForward(revoked, source, 'thread-forward')).toThrow(
      'CHANNEL_FORWARD_PERMISSION_DENIED',
    )
  })
})
