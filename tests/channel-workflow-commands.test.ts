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
  it('explains a definitive provider-switch refusal without deleting the existing chat', async () => {
    const commands = new ChannelSessionCommands({
      bindings: () => [binding('a')] as never,
      native: () => ({ label: async () => '飞书 · 私聊' }) as never,
      allowed: () => true,
      unbind: async () => true,
      tasks: {
        boundTo: () => true,
        read: async () => ({
          revision: 1,
          settings: { providerId: 'old', model: 'old-model' },
          code: 'NATIVE_PROVIDER_SWITCH_UNAVAILABLE',
        }),
      } as never,
    })
    expect(await commands.handle(event, 'task-settings', ''))
      .toContain('当前对话不能切换服务商；可保留此对话，新建对话并选择目标服务商。')
    commands.dispose()
  })
  it('warns that an uncertain model change needs reconciliation', async () => {
    const commands = new ChannelSessionCommands({
      bindings: () => [binding('a')] as never,
      native: () => ({ label: async () => '飞书 · 私聊' }) as never,
      allowed: () => true,
      unbind: async () => true,
      tasks: {
        boundTo: () => true,
        read: async () => ({ revision: 1, settings: {}, application: 'unknown' }),
      } as never,
    })
    expect(await commands.handle(event, 'task-settings', '')).toContain('不要重复提交')
    commands.dispose()
  })
  it('preserves Fast false and project selection through all/one choices and combined flags', async () => {
    const request = vi.fn(async () => ({ application: 'saved' }))
    const commands = new ChannelSessionCommands({
      bindings: () => [binding('a'), binding('b')] as never,
      native: () => ({ label: async (id: string) => `飞书 · ${id}` }) as never,
      allowed: () => true,
      unbind: async () => true,
      tasks: {
        boundTo: () => true,
        read: async () => ({ revision: 2, settings: {} }),
        request,
        catalog: async () => ({ projects: [{ projectId: 'repo', name: '仓库' }] }),
      } as never,
    })
    const offered = await commands.handle(event, 'fast', 'off')
    const token = /\/choose ([a-f0-9]+) all/u.exec(offered!)![1]!
    await commands.handle(event, 'choose', `${token} all`)
    expect(request.mock.calls).toEqual([[event, 'a', { fast: false }, 2], [event, 'b', { fast: false }, 2]])
    request.mockClear()
    const project = await commands.handle(event, 'project', 'repo')
    const projectToken = /\/choose ([a-f0-9]+) all/u.exec(project!)![1]!
    await commands.handle(event, 'choose', `${projectToken} 2`)
    expect(request).toHaveBeenCalledWith(event, 'b', { projectId: 'repo' }, 2)
    expect(await commands.handle(event, 'project', 'list')).toContain('仓库（repo）')
    await commands.handle(event, 'task-settings', '--fast false --project repo --provider openai --model m --target a')
    expect(request).toHaveBeenLastCalledWith(event, 'a', {
      fast: false,
      projectId: 'repo',
      providerId: 'openai',
      model: 'm',
    }, 2)
    await expect(commands.handle(event, 'fast', 'maybe')).rejects.toThrow('INVALID_COMMAND_ARGUMENTS')
    commands.dispose()
  })
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
  it('creates the actual native section and moves only the newly created chat with the complete native request', async () => {
    const thread: { id: string; name: string; section: { id: string } | null } = {
      id: 'chat',
      name: '飞书 · 群聊',
      section: null,
    }
    const nativeRequest = vi.fn(async (method: string, params: Readonly<Record<string, unknown>>) => {
      if (method === 'thread/read') return { thread: { ...thread } }
      if (method === 'threadSection/list') return { data: [], nextCursor: null }
      if (method === 'threadSection/create') return { section: { id: 'section', name: '外部连接' } }
      if (method === 'thread/section/move') {
        expect(params).toEqual({ threadId: 'chat', sectionId: 'section', beforeThreadId: null })
        thread.section = { id: 'section' }
        return {}
      }
      throw Error('unexpected method')
    })
    const organization = new ChannelChatOrganization({ nativeRequest })
    await organization.created('chat', thread.name, '外部连接')
    expect(thread.section).toEqual({ id: 'section' })
    expect(nativeRequest.mock.calls.filter(([method]) => method === 'thread/section/move')).toHaveLength(1)
  })
  it('rechecks a user move after section lookup and before submitting a native move', async () => {
    const thread = { id: 'chat', name: '飞书 · 群聊', section: null as { id: string } | null }
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === 'thread/read') return { thread: { ...thread } }
      if (method === 'threadSection/list') {
        thread.section = { id: 'users-section' }
        return { data: [{ id: 'external', name: '外部连接' }], nextCursor: null }
      }
      throw Error('a user move must not be overwritten')
    })
    await new ChannelChatOrganization({ nativeRequest }).created('chat', thread.name, '外部连接')
    expect(thread.section).toEqual({ id: 'users-section' })
    expect(nativeRequest.mock.calls.some(([method]) => method === 'thread/section/move')).toBe(false)
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
