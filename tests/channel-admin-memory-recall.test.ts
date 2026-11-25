import { expect, it } from 'vitest'
import {
  channelMemoryAdministrator,
  ownAdministratorRecall,
  ownRecallMatches,
} from '../packages/cli/src/launcher/channel-memory-recall.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { memoryKey, memoryReadable } from '../packages/cli/src/launcher/channel-memory-policy.js'

const account = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'tenant', userId: 'admin' }
const destination = {
  adapterId: account.adapterId,
  accountId: account.accountId,
  tenantId: account.tenantId,
  conversationId: 'group-B',
}
const source = { ...destination, actor: account, kind: 'group' as const, eventId: 'message' }
const rules = [{
  id: 'admin',
  adapterId: account.adapterId,
  accountId: account.accountId,
  tenantId: account.tenantId,
  action: 'command',
  effect: 'allow',
  userIds: ['admin'],
  commands: ['allow-user', 'deny-user', 'reset-user'],
}]
const policy = parseChannelConversationPolicy({ enabled: true, rules })
const now = '2026-11-24T00:00:00.000Z'
const record = {
  id: 'record',
  owner: memoryKey(account),
  scopeId: memoryKey({ ...destination, conversationId: 'A' }),
  kind: 'fact',
  title: 'Cedar project',
  summary: 'Deployment verified',
  tags: [],
  updatedAt: now,
}

it.each([
  ['你记得自己最近都做了什么吗？', { recentWork: true }],
  ['总结一下最近的工作进展', { recentWork: true }],
  ['青杉项目现在进度是什么？', { topics: ['青杉'] }],
  ['What is Cedar project progress?', { topics: ['cedar'] }],
])('resolves the real request scope for %s', (request, expected) => {
  expect(ownAdministratorRecall(request)).toEqual(expected)
})
it.each([
  '不要总结最近的工作',
  '他说“总结最近的工作”',
  '给所有群永久授权',
  '你好',
  '别人的青杉项目进度是什么',
  '请读取 Bob 的全部私聊',
])('does not infer recall authorization from %s', request => {
  expect(ownAdministratorRecall(request)).toBeUndefined()
})
it('verifies the configured positive management role and preserves exact-account and explicit deny boundaries', () => {
  expect(channelMemoryAdministrator(policy, source)).toBe(true)
  expect(channelMemoryAdministrator(policy, { ...source, actor: { ...account, userId: 'member' } })).toBe(false)
  expect(channelMemoryAdministrator(policy, { ...source, accountId: 'other' })).toBe(false)
  expect(channelMemoryAdministrator(policy, { ...source, tenantId: 'other' })).toBe(false)
  expect(channelMemoryAdministrator(parseChannelConversationPolicy({ enabled: true }), source)).toBe(false)
  expect(channelMemoryAdministrator(parseChannelConversationPolicy({ enabled: true }), source, true)).toBe(true)
  for (const action of ['dispatch', 'send', 'command']) {
    const blocked = parseChannelConversationPolicy({
      enabled: true,
      rules: [...rules, { id: 'deny', action, effect: 'deny', userIds: ['admin'] }],
    })
    expect(channelMemoryAdministrator(blocked, source, true)).toBe(false)
  }
})
it('keeps request-local reads exact-owner, relevant and recent without using source admin or linked identity as private read authority', () => {
  const authority = {
    actor: account,
    conversation: destination,
    kind: 'group' as const,
    ownRecall: { recentWork: true as const },
  }
  expect(memoryReadable(record, authority, [], {}, now)).toBe(true)
  expect(memoryReadable(record, { ...authority, ownRecall: undefined }, [], {}, now)).toBe(false)
  expect(
    memoryReadable({ ...record, owner: memoryKey({ ...account, userId: 'someone-else' }) }, authority, [], {}, now),
  ).toBe(false)
  expect(memoryReadable({ ...record, kind: 'preference', title: 'Cedar preference' }, authority, [], {}, now)).toBe(
    false,
  )
  expect(memoryReadable({ ...record, title: 'Favorite snack', summary: 'Apples' }, authority, [], {}, now)).toBe(false)
  expect(memoryReadable({ ...record, updatedAt: '2026-10-01T00:00:00.000Z' }, authority, [], {}, now)).toBe(false)
  expect(memoryReadable({ ...record, expiresAt: '2026-11-23T00:00:00.000Z' }, authority, [], {}, now)).toBe(false)
  const bound = { [memoryKey(account)]: 'entity', other: 'entity' }
  expect(memoryReadable({ ...record, owner: 'other' }, authority, [], bound, now)).toBe(false)
  expect(
    memoryReadable(
      record,
      { ...authority, actor: { ...account, accountId: 'other' }, administer: [record.scopeId] },
      [],
      {},
      now,
    ),
  ).toBe(false)
  expect(ownRecallMatches(record, { topics: ['cedar'] }, now)).toBe(true)
  expect(ownRecallMatches(record, { topics: ['maple'] }, now)).toBe(false)
})
