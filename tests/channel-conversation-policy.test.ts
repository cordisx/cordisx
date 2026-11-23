import { describe, expect, it } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import {
  channelGlobalCommandAllowed,
  channelPolicyAllows,
  channelWakePrefix,
  parseChannelConversationPolicy,
} from '../packages/cli/src/launcher/channel-conversation-policy.js'
import {
  channelAutoReplyTarget,
  channelReplyDefaults,
  channelReplyTarget,
} from '../packages/cli/src/launcher/channel-reply-routing.js'

const event: ChannelEventRef = {
  adapterId: 'feishu',
  accountId: 'cli_fixture',
  tenantId: 'test',
  conversationId: 'oc_group',
  kind: 'group',
  threadId: 'oc_group',
  semantics: 'conversation',
  eventId: 'om_fixture',
  actor: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test', userId: 'alice' },
}

describe('automatic reply topic fallback', () => {
  const defaults = { mode: 'agent', fallbackMode: 'conversation' } as const
  const topic = { ...event, semantics: 'topic' as const, threadId: 'om_root', messageId: 'om_child' }
  it('retains the original root rather than anchoring to the latest message', () => {
    expect(channelAutoReplyTarget(topic, defaults)).toMatchObject({ semantics: 'topic', threadId: 'om_root' })
    expect(channelAutoReplyTarget({ ...topic, messageId: undefined }, defaults))
      .toMatchObject({ semantics: 'topic', threadId: 'om_root' })
  })
  it('preserves explicit selections, non-topic identities and other fallback modes', () => {
    expect(channelAutoReplyTarget(topic, defaults, 'conversation'))
      .toMatchObject({ semantics: 'conversation', threadId: 'oc_group' })
    expect(channelAutoReplyTarget(topic, { ...defaults, mode: 'conversation' }))
      .toMatchObject({ semantics: 'conversation', threadId: 'oc_group' })
    for (const semantics of ['conversation', 'reply-chain'] as const) {
      expect(channelAutoReplyTarget({ ...topic, semantics }, defaults))
        .toMatchObject({ semantics: 'conversation', threadId: 'oc_group' })
    }
    expect(channelAutoReplyTarget(topic, { ...defaults, fallbackMode: 'reply' }))
      .toMatchObject({ semantics: 'reply-chain', threadId: 'om_child' })
    expect(channelAutoReplyTarget(topic, defaults, 'none')).toBeUndefined()
    expect(channelAutoReplyTarget(topic, { ...defaults, fallbackMode: 'none' })).toBeUndefined()
  })
})

describe('Channel policy intersection and addressing', () => {
  it('requires a global grant for global policy changes and rejects scoped group membership', () => {
    const scoped = parseChannelConversationPolicy({
      rules: [{ id: 'local', action: 'command', effect: 'allow', conversationId: 'oc_group', userIds: ['alice'] }],
    })
    expect(channelPolicyAllows(scoped, 'command', event, 'allow-user')).toBe(true)
    expect(channelGlobalCommandAllowed(scoped, event, 'allow-user')).toBe(false)
    const global = parseChannelConversationPolicy({
      rules: [{ id: 'global', action: 'command', effect: 'allow', userIds: ['alice'] }],
    })
    expect(channelGlobalCommandAllowed(global, event, 'allow-user')).toBe(true)
    const group = parseChannelConversationPolicy({
      groups: [{ id: 'ops', name: 'Ops', members: [{ tenantId: 'test', userId: 'alice' }] }],
      rules: [{ id: 'global', action: 'command', effect: 'allow', userGroupIds: ['ops'] }],
    })
    expect(channelPolicyAllows(group, 'command', event, 'allow-user')).toBe(true)
    expect(channelGlobalCommandAllowed(group, event, 'allow-user')).toBe(false)
    const denied = parseChannelConversationPolicy({
      rules: [
        { id: 'global', action: 'command', effect: 'allow', userIds: ['alice'] },
        { id: 'deny', action: 'command', effect: 'deny', conversationId: 'oc_group', userIds: ['alice'] },
      ],
    })
    expect(channelGlobalCommandAllowed(denied, event, 'allow-user')).toBe(false)
  })
  it('defaults automatic final forwarding off and preserves an explicit opt-in', () => {
    expect(parseChannelConversationPolicy(undefined).autoReply).toBe(false)
    expect(parseChannelConversationPolicy({ enabled: true }).autoReply).toBe(false)
    expect(parseChannelConversationPolicy({ autoReply: true }).autoReply).toBe(true)
  })
  it('resolves scoped reply defaults without inheriting another account and lets a binding override them', () => {
    const policy = parseChannelConversationPolicy({
      replyMode: 'agent',
      replyFallbackMode: 'conversation',
      replyModes: [
        { adapterId: 'feishu', mode: 'reply' },
        { adapterId: 'feishu', accountId: 'cli_fixture', mode: 'thread', fallbackMode: 'reply' },
        {
          adapterId: 'feishu',
          accountId: 'cli_fixture',
          conversationId: 'oc_group',
          mode: 'agent',
          fallbackMode: 'none',
        },
      ],
    })
    expect(channelReplyDefaults(policy, event)).toEqual({ mode: 'agent', fallbackMode: 'none' })
    expect(channelReplyDefaults(policy, { ...event, accountId: 'other' })).toEqual({
      mode: 'reply',
      fallbackMode: 'conversation',
    })
    expect(channelReplyDefaults(policy, event, { replyMode: 'thread', replyFallbackMode: 'reply' }))
      .toEqual({ mode: 'thread', fallbackMode: 'reply' })
    expect(channelReplyDefaults(parseChannelConversationPolicy({}), event)).toEqual({
      mode: 'agent',
      fallbackMode: 'conversation',
    })
  })
  it('rejects ambiguous reply scopes and missing anchors without silently changing the mode', () => {
    expect(() =>
      parseChannelConversationPolicy({
        replyModes: [
          { accountId: 'cli_fixture', mode: 'thread' },
          { conversationId: 'oc_group', mode: 'conversation' },
        ],
      })
    ).toThrow('AMBIGUOUS_REPLY_SCOPE')
    expect(() => parseChannelConversationPolicy({ replyFallbackMode: 'agent' })).toThrow('INVALID_REPLY_MODE')
    expect(() => channelReplyTarget(event, 'reply')).toThrow('REPLY_MESSAGE_REQUIRED')
    const anchored = { ...event, messageId: 'om_source' }
    expect(
      ['conversation', 'reply', 'thread'].map(mode =>
        channelReplyTarget(anchored, mode as 'conversation' | 'reply' | 'thread')
      ),
    )
      .toEqual([
        expect.objectContaining({ threadId: 'oc_group', semantics: 'conversation' }),
        expect.objectContaining({ threadId: 'om_source', semantics: 'reply-chain' }),
        expect.objectContaining({ threadId: 'om_source', semantics: 'topic' }),
      ])
    // Disjoint conversation kinds can have equally specific defaults.
    expect(() =>
      parseChannelConversationPolicy({
        replyModes: [
          { kinds: ['direct'], mode: 'conversation' },
          { kinds: ['group'], mode: 'thread' },
        ],
      })
    ).not.toThrow()
  })
  it('intersects global, conversation, kind, user and source-qualified group predicates', () => {
    const policy = parseChannelConversationPolicy({
      groups: [{ id: 'ops', name: 'Ops', members: [{ tenantId: 'test', userId: 'alice' }] }],
      rules: [{ id: 'global', action: 'dispatch', effect: 'allow', userIds: ['alice', 'bob'] }, {
        id: 'local',
        action: 'dispatch',
        effect: 'allow',
        conversationId: 'oc_group',
        kinds: ['group'],
        userGroupIds: ['ops'],
      }],
    })
    expect(channelPolicyAllows(policy, 'dispatch', event)).toBe(true)
    expect(channelPolicyAllows(policy, 'dispatch', { ...event, actor: { ...event.actor!, userId: 'bob' } })).toBe(false)
    expect(channelPolicyAllows(policy, 'dispatch', { ...event, tenantId: 'other' })).toBe(false)
  })
  it('denies take precedence and command-specific allowlists do not constrain other commands', () => {
    const policy = parseChannelConversationPolicy({
      rules: [
        { id: 'bind', action: 'command', effect: 'allow', userIds: ['alice'], commands: ['bind'] },
        { id: 'unbind', action: 'command', effect: 'allow', userIds: ['bob'], commands: ['unbind'] },
        { id: 'blocked', action: 'dispatch', effect: 'deny', userIds: ['alice'] },
      ],
    })
    expect(channelPolicyAllows(policy, 'command', event, 'bind')).toBe(true)
    expect(channelPolicyAllows(policy, 'command', event, 'unbind')).toBe(false)
    expect(channelPolicyAllows(policy, 'command', event, 'wake')).toBe(false)
    expect(channelPolicyAllows(policy, 'command', event, 'bind-status')).toBe(true)
    expect(channelPolicyAllows(policy, 'dispatch', event)).toBe(false)
  })
  it('uses the most specific wake prefix and rejects ambiguous duplicate scopes', () => {
    const policy = parseChannelConversationPolicy({
      wakePrefixes: [{ prefixes: ['global'] }, { accountId: 'cli_fixture', prefixes: ['bot'] }, {
        conversationId: 'oc_group',
        accountId: 'cli_fixture',
        prefixes: ['hi'],
      }],
    })
    expect(channelWakePrefix(policy, event, 'hi hello')).toBe('hi')
    expect(channelWakePrefix(policy, event, 'bot hello')).toBeUndefined()
    expect(channelWakePrefix(policy, event, 'higher')).toBeUndefined()
    expect(() => parseChannelConversationPolicy({ wakePrefixes: [{ prefixes: ['a'] }, { prefixes: ['b'] }] })).toThrow(
      'DUPLICATE_WAKE_SCOPE',
    )
  })
  it('rejects unknown predicates, groups and commands instead of silently granting authority', () => {
    expect(() => parseChannelConversationPolicy({ secretRef: 'private' })).toThrow()
    expect(() =>
      parseChannelConversationPolicy({
        rules: [{ id: 'a', action: 'command', effect: 'allow', commands: ['arbitrary'] }],
      })
    ).toThrow('INVALID_COMMAND')
    expect(() =>
      parseChannelConversationPolicy({
        rules: [{ id: 'a', action: 'dispatch', effect: 'allow', userGroupIds: ['missing'] }],
      })
    ).toThrow('INVALID_USER_GROUP')
  })
})
