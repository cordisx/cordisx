import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { channelCommandAddressing, ChannelCommandUsers } from '../packages/cli/src/launcher/channel-command-users.js'
import { channelCommandReplyTarget } from '../packages/cli/src/launcher/channel-reply-routing.js'

const event: ChannelEventRef = {
  adapterId: 'feishu',
  accountId: 'cli_test',
  tenantId: 'tenant',
  conversationId: 'oc_test',
  kind: 'group',
  threadId: 'oc_test',
  semantics: 'conversation',
  eventId: 'om_test',
  messageId: 'om_test',
  actor: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant', userId: 'ou_actor' },
}
const request = { event, command: 'deny-user', global: false }
const tokenIn = (value: { readonly message: string }) => /--choose ([\w-]+) /u.exec(value.message)![1]!

describe('Channel command user resolution', () => {
  it('uses native mention IDs ahead of names and keeps only minimal addressing metadata', async () => {
    const users = new ChannelCommandUsers(), directory = vi.fn()
    const addressing = channelCommandAddressing({
      senderName: 'Actor',
      mentions: [
        { key: '@_user_1', openId: 'ou_bot', name: 'Bot', isBot: true },
        { key: '@_user_2', openId: 'ou_person', userId: 'wrong-id-type', name: '张 三' },
        { key: '@_all', openId: 'all', name: '所有人' },
      ],
      raw: { secret: 'unused' },
    } as never)
    expect(addressing).toEqual({
      mentions: [{ key: '@_user_2', userId: 'ou_person', name: '张 三' }],
      senderName: 'Actor',
    })
    await expect(users.resolve({ ...request, argument: '@张 三', addressing, directory })).resolves.toEqual({
      userId: 'ou_person',
    })
    await expect(users.resolve({ ...request, argument: '@_user_2', addressing, directory })).resolves.toEqual({
      userId: 'ou_person',
    })
    await expect(users.resolve({ ...request, argument: 'ou_person', directory })).resolves.toEqual({
      userId: 'ou_person',
    })
    await expect(users.resolve({ ...request, argument: 'id:platform-user', directory })).resolves.toEqual({
      userId: 'platform-user',
    })
    expect(directory).not.toHaveBeenCalled()
  })
  it('resolves unique full names and offers explicit choices for fuzzy or partial matches', async () => {
    const users = new ChannelCommandUsers()
    const directory = vi.fn(async () => ({ complete: true, users: [{ id: 'ou_a', name: 'Alice Smith' }] }))
    await expect(users.resolve({ ...request, argument: '"ALICE SMITH"', directory })).resolves.toEqual({
      userId: 'ou_a',
    })
    const fuzzy = await users.resolve({ ...request, argument: 'Alice', directory })
    expect(fuzzy).toMatchObject({ message: expect.stringContaining('--choose') })
    const token = tokenIn(fuzzy as { message: string })
    await expect(users.resolve({ ...request, argument: `--choose ${token} 1` })).resolves.toEqual({ userId: 'ou_a' })
    const partial = await users.resolve({
      ...request,
      argument: 'Alice Smith',
      directory: async () => ({ complete: false, users: [{ id: 'ou_a', name: 'Alice Smith' }] }),
    })
    expect(partial).toMatchObject({ message: expect.stringContaining('未完整读取') })
  })
  it('fences choices to actor, account, tenant, conversation, command and scope, then consumes them once', async () => {
    const users = new ChannelCommandUsers()
    const offered = await users.resolve({
      ...request,
      global: true,
      argument: '同名',
      directory: async () => ({ complete: true, users: [{ id: 'ou_a', name: '同名' }, { id: 'ou_b', name: '同名' }] }),
    })
    const token = tokenIn(offered as { message: string }), argument = `--choose ${token} 2`
    const mismatches = [
      { event: { ...event, accountId: 'another-account' } },
      { event: { ...event, adapterId: 'another-adapter' } },
      { event: { ...event, tenantId: 'another-tenant' } },
      { event: { ...event, conversationId: 'oc_other' } },
      { event: { ...event, actor: { ...event.actor!, userId: 'ou_other' } } },
      { command: 'allow-user' },
      { global: false },
    ]
    for (const mismatch of mismatches) {
      expect(await users.resolve({ ...request, global: true, argument, ...mismatch })).toMatchObject({
        message: expect.stringContaining('不属于'),
      })
    }
    expect(await users.resolve({ ...request, global: true, argument: `--choose ${token} 3` })).toMatchObject({
      message: expect.stringContaining('序号无效'),
    })
    await expect(users.resolve({ ...request, global: true, argument })).resolves.toEqual({ userId: 'ou_b' })
    expect(await users.resolve({ ...request, global: true, argument })).toMatchObject({
      message: expect.stringContaining('已过期'),
    })
  })
  it('pages candidates, expires choices and disposes them without a persistent selection token', async () => {
    let now = 0
    const users = new ChannelCommandUsers(() => now)
    const offered = await users.resolve({
      ...request,
      argument: 'Duplicate',
      directory: async () => ({
        complete: true,
        users: Array.from({ length: 12 }, (_, index) => ({ id: 'ou_' + index, name: 'Duplicate' })),
      }),
    })
    const token = tokenIn(offered as { message: string })
    expect(offered).toMatchObject({ message: expect.stringContaining('第 1/2 页') })
    expect(await users.resolve({ ...request, argument: `--list ${token} 2` })).toMatchObject({
      message: expect.stringContaining('12. @Duplicate (ou_11)'),
    })
    now = 10 * 60_000
    expect(await users.resolve({ ...request, argument: `--choose ${token} 1` })).toMatchObject({
      message: expect.stringContaining('已过期'),
    })
    const next = await users.resolve({
      ...request,
      argument: 'Duplicate',
      directory: async () => ({ complete: false, users: [{ id: 'ou_one', name: 'Duplicate' }] }),
    })
    users.dispose()
    expect(await users.resolve({ ...request, argument: `--choose ${tokenIn(next as { message: string })} 1` }))
      .toMatchObject({ message: expect.stringContaining('已过期') })
  })
  it('never guesses unknown names, all-user mentions or malformed IDs and strips private failures', async () => {
    const users = new ChannelCommandUsers(),
      directory = vi.fn(async () => {
        throw new Error('private-token')
      })
    for (const argument of ['@所有人', '@_all', 'id:has spaces', '--choose missing 0', 'name\nmore']) {
      expect(await users.resolve({ ...request, argument, directory })).not.toHaveProperty('userId')
    }
    const missing = await users.resolve({ ...request, argument: 'Nobody', directory })
    expect(JSON.stringify(missing)).toContain('CHANNEL_DIRECTORY_FAILED')
    expect(JSON.stringify(missing)).not.toContain('private-token')
    const unsafe = await users.resolve({
      ...request,
      argument: 'Nobody',
      directory: async () => ({ users: [], complete: false, code: 'private code' }),
    })
    expect(JSON.stringify(unsafe)).not.toContain('private code')
  })
})

describe('Host command reply capability selection', () => {
  it('prefers supported topics and falls back before sending when the adapter or anchor is unavailable', () => {
    expect(channelCommandReplyTarget(event, { reply: true, thread: true })).toMatchObject({
      semantics: 'topic',
      threadId: 'om_test',
    })
    expect(channelCommandReplyTarget(event, { reply: true, thread: false })).toMatchObject({
      semantics: 'reply-chain',
      threadId: 'om_test',
    })
    expect(channelCommandReplyTarget(event)).toMatchObject({ semantics: 'conversation', threadId: 'oc_test' })
    const { messageId: _message, ...withoutAnchor } = event
    expect(channelCommandReplyTarget(withoutAnchor, { reply: true, thread: true })).toMatchObject({
      semantics: 'conversation',
    })
  })
})
