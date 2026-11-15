import { describe, expect, it, vi } from 'vitest'
import { ChannelSessionCommands } from '../packages/cli/src/launcher/channel-session-commands.js'
import { ChannelChatOrganization, channelChatTitle } from '../packages/cli/src/launcher/channel-chat-organization.js'
import {
  channelConversationPolicyV1,
  channelConversationPolicyV2,
  channelPolicyAllows,
  mergeLegacyChannelPolicy,
  parseChannelConversationPolicy,
} from '../packages/cli/src/launcher/channel-conversation-policy.js'
const event = {
  adapterId: 'feishu',
  accountId: 'test',
  tenantId: 'test',
  conversationId: 'oc_test',
  kind: 'group' as const,
  threadId: 'oc_test',
  semantics: 'conversation' as const,
  eventId: 'event',
  actor: { adapterId: 'feishu', accountId: 'test', tenantId: 'test', userId: 'alice' },
}
const binding = (sessionId: string) => ({ id: sessionId, channel: event, sessionId, state: 'active' as const })
describe('progressive Channel command experience', () => {
  it('continues all/one/multiple choices only for the original actor and current command permission', async () => {
    const unbind = vi.fn(async () => true), bindings = [binding('a'), binding('b')]
    let allowed = true
    const commands = new ChannelSessionCommands({
      bindings: () => bindings as never,
      native: () => ({ label: async (id: string) => `飞书 · ${id}` }) as never,
      allowed: () => allowed,
      unbind,
    })
    const prompt = await commands.handle(event, 'unbind', '')
    expect(prompt).toContain('飞书 · a')
    const token = /\/choose ([a-f0-9]+) all/u.exec(prompt!)![1]!
    await expect(commands.handle({ ...event, actor: { ...event.actor, userId: 'bob' } }, 'choose', `${token} all`))
      .rejects.toThrow('CHOICE_EXPIRED')
    allowed = false
    expect(await commands.handle(event, 'choose', `${token} 1,2`)).toContain('没有执行')
    expect(unbind).not.toHaveBeenCalled()
    allowed = true
    const next = await commands.handle(event, 'unbind', '')
    const nextToken = /\/choose ([a-f0-9]+) all/u.exec(next!)![1]!
    expect(await commands.handle(event, 'choose', `${nextToken} all`)).toContain('已解除绑定')
    expect(unbind).toHaveBeenCalledTimes(2)
    commands.dispose()
  })
  it('does not leak successor commands or sidebarGroup into frozen policy readback', () => {
    const policy = parseChannelConversationPolicy({
      sidebarGroup: '外部连接',
      rules: [{ id: 'r', action: 'command', effect: 'allow', commands: ['bind', 'approve'] }],
    })
    expect(channelConversationPolicyV1(policy)).not.toHaveProperty('sidebarGroup')
    expect(channelConversationPolicyV2(policy)).not.toHaveProperty('sidebarGroup')
    expect(channelConversationPolicyV2(policy).rules[0]?.commands).toEqual(['bind'])
  })
  it('preserves newer command semantics when an older form edits or deletes a mixed rule', () => {
    const policy = parseChannelConversationPolicy({
      sidebarGroup: '外部连接',
      rules: [{ id: 'r', action: 'command', effect: 'deny', commands: ['bind', 'approve'], userIds: ['alice'] }],
    })
    const edited = parseChannelConversationPolicy({
      ...channelConversationPolicyV2(policy),
      rules: [{ id: 'r', action: 'command', effect: 'allow', commands: ['bind'], userIds: ['bob'] }],
    })
    const result = parseChannelConversationPolicy(mergeLegacyChannelPolicy(policy, edited))
    expect(new Set(result.rules.map(rule => rule.id)).size).toBe(result.rules.length)
    expect(result.sidebarGroup).toBe('外部连接')
    expect(channelPolicyAllows(result, 'command', event, 'approve')).toBe(false)
    expect(result.rules.find(rule => rule.commands?.includes('approve'))).toMatchObject({
      effect: 'deny',
      userIds: ['alice'],
    })
    const removed = parseChannelConversationPolicy(
      mergeLegacyChannelPolicy(policy, parseChannelConversationPolicy({ rules: [] })),
    )
    expect(removed.rules[0]?.commands).toEqual(['approve'])
  })
  it('shows platform and real counterpart names; respects user rename and user group moves', async () => {
    expect(channelChatTitle(event, '联调群')).toBe('飞书 · 联调群')
    expect(channelChatTitle({ ...event, kind: 'direct' }, '小明')).toBe('飞书 · 小明')
    expect(channelChatTitle(event, 'oc_secret')).toBe('飞书 · 群聊')
    const read = { id: 'chat', name: 'User title', section: null }
    const nativeRequest = vi.fn(async () => ({ thread: read }))
    const organization = new ChannelChatOrganization({ nativeRequest })
    await organization.created('chat', '飞书 · 群聊', '外部连接')
    await organization.refineTitle('chat', '飞书 · 联调群')
    expect(nativeRequest.mock.calls.every(([method]) => method === 'thread/read')).toBe(true)
  })
})
