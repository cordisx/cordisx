import { expect, it } from 'vitest'
import { authorizeChannelForward } from './channel-forward-permissions.js'
import { CHANNEL_CONVERSATION_POLICY_INITIAL } from './channel-conversation-policy.js'

const event = {
  adapterId: 'feishu',
  accountId: 'bot',
  tenantId: 'tenant',
  conversationId: 'oc_source',
  kind: 'group' as const,
  threadId: 'oc_source',
  semantics: 'conversation' as const,
  eventId: 'event',
  actor: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', userId: 'ou_actor' },
}
it('does not inherit send or broad command grants', () => {
  const policy = {
    ...CHANNEL_CONVERSATION_POLICY_INITIAL,
    enabled: true,
    rules: [
      { id: 'send', action: 'send' as const, effect: 'allow' as const },
      { id: 'all-commands', action: 'command' as const, effect: 'allow' as const },
    ],
  }
  expect(() => authorizeChannelForward(policy, event, 'forward')).toThrow('PERMISSION_DENIED')
})
it('separates read, single and merge grants and honors scope and deny', () => {
  const rule = {
    id: 'forward',
    action: 'command' as const,
    effect: 'allow' as const,
    conversationId: 'oc_source',
    userIds: ['ou_actor'],
    commands: ['forward'],
  }
  const policy = { ...CHANNEL_CONVERSATION_POLICY_INITIAL, enabled: true, rules: [rule] }
  expect(() => authorizeChannelForward(policy, event, 'forward')).not.toThrow()
  expect(() => authorizeChannelForward(policy, event, 'read')).toThrow('PERMISSION_DENIED')
  expect(() => authorizeChannelForward(policy, event, 'merge-forward')).toThrow('PERMISSION_DENIED')
  expect(() => authorizeChannelForward(policy, { ...event, conversationId: 'oc_other' }, 'forward')).toThrow(
    'PERMISSION_DENIED',
  )
  expect(() =>
    authorizeChannelForward(
      { ...policy, rules: [...policy.rules, { ...rule, id: 'deny', effect: 'deny' }] },
      event,
      'forward',
    )
  ).toThrow('PERMISSION_DENIED')
})
