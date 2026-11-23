import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ChannelMemoryStore } from '../packages/cli/src/launcher/channel-memory-store.js'
import { channelUserMemoryRequest } from '../packages/cli/src/launcher/channel-user-memory-request.js'
import { validateUserMemoryAssertions } from '../packages/cli/src/launcher/channel-user-memory-model.js'
import { memoryKey } from '../packages/cli/src/launcher/channel-memory-policy.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const actor = { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', userId: 'alice' }
const authority = {
  actor,
  conversation: {
    adapterId: actor.adapterId,
    accountId: actor.accountId,
    tenantId: actor.tenantId,
    conversationId: 'private',
  },
  kind: 'direct' as const,
}
const name = { key: 'name', category: 'name' as const, title: '称呼', value: '青杉', evidence: '我叫青杉' }
const source = (sequence: number) => ({ sequence, messageId: `m${sequence}` })
async function store() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'user-memory-'))
  roots.push(root)
  return new ChannelMemoryStore(root)
}

it('stores and updates the existing record, persists across restart, and fences older/duplicate introductions', async () => {
  const memory = await store()
  const first = (await memory.rememberUser(authority, [name], source(1), () => true))[0]!
  expect(first).toMatchObject({ kind: 'person', owner: memoryKey(actor), evidenceType: 'user-declared', revision: 1 })
  const revised = { ...name, value: '白桦', evidence: '请叫我白桦' }
  const second = (await memory.rememberUser(authority, [revised], source(3), () => true))[0]!
  expect(second.id).toBe(first.id)
  expect(second.revision).toBe(2)
  expect(second.provenance.messageId).toBe('m3')
  expect(await memory.rememberUser(authority, [name], source(2), () => true)).toEqual([])
  expect((await memory.rememberUser(authority, [revised], source(3), () => true))[0]?.revision).toBe(2)
  const restarted = new ChannelMemoryStore(memory.files.root)
  const group = {
    ...authority,
    kind: 'group' as const,
    conversation: { ...authority.conversation, conversationId: 'group' },
    userRecall: { identity: true as const },
  }
  expect((await restarted.get(group, first.id)).summary).toBe('请叫我白桦')
  expect(Object.keys((JSON.parse(await readFile(path.join(memory.files.root, 'state.json'), 'utf8'))).records))
    .toHaveLength(1)
  expect(await restarted.rememberUser(authority, [name], source(4), () => false)).toEqual([])
  await restarted.change(authority, first.id, 2)
  await expect(restarted.get(group, first.id)).rejects.toThrow('MEMORY_NOT_FOUND')
  expect(await restarted.rememberUser(authority, [name], source(2), () => true)).toEqual([])
  expect(await restarted.rememberUser(authority, [revised], source(3), () => true)).toEqual([])
})

it('cross-conversation reads are exact-owner and request-relevant, including existing CLI person records', async () => {
  const memory = await store()
  const records = await memory.rememberUser(
    authority,
    [name, { key: 'relationship', category: 'relationship', title: '关系', value: '同事', evidence: '我是你的同事' }, {
      key: 'drink-preference',
      category: 'preference',
      title: '饮品偏好',
      value: '红茶',
      evidence: '我喜欢红茶',
    }],
    source(1),
    () => true,
  )
  const ordinary = await memory.remember(authority, {
    kind: 'person',
    title: '自述关系',
    summary: '我是你的搭档',
    tags: [],
    entityRefs: [],
    evidenceType: 'explicit',
    confidence: 1,
  }, 'old-cli')
  const group = {
    ...authority,
    kind: 'group' as const,
    conversation: { ...authority.conversation, conversationId: 'elsewhere' },
  }
  await expect(memory.get(group, records[0]!.id)).rejects.toThrow('MEMORY_NOT_FOUND')
  const nameOnly = { ...group, userRecall: channelUserMemoryRequest('我的名字是什么？') }
  expect((await memory.browse(nameOnly, { userOnly: true }) as any).cards.map((row: any) => row.id)).toEqual([
    records[0]!.id,
  ])
  await expect(memory.get(nameOnly, records[1]!.id)).rejects.toThrow('MEMORY_NOT_FOUND')
  const identity = { ...group, userRecall: channelUserMemoryRequest('认识我是谁吗？') }
  expect((await memory.get(identity, ordinary.id)).summary).toBe('我是你的搭档')
  const preferences = { ...group, userRecall: channelUserMemoryRequest('我的饮品偏好是什么？') }
  expect((await memory.get(preferences, records[2]!.id)).summary).toContain('红茶')
  for (const change of [{ userId: 'bob' }, { accountId: 'other' }, { tenantId: 'other' }, { adapterId: 'lark' }]) {
    await expect(memory.get({ ...identity, actor: { ...actor, ...change } }, records[0]!.id)).rejects.toThrow(
      'MEMORY_NOT_FOUND',
    )
  }
  const bob = { ...authority, actor: { ...actor, userId: 'bob' } }
  const bobName = { ...name, value: '青杉', evidence: 'My name is 青杉' }
  const bobRecord = (await memory.rememberUser(bob, [bobName], source(2), () => true))[0]!
  expect((await memory.get({ ...group, actor: bob.actor, userRecall: { identity: true } }, bobRecord.id)).summary).toBe(
    'My name is 青杉',
  )
  await expect(memory.get(identity, bobRecord.id)).rejects.toThrow('MEMORY_NOT_FOUND')
})

it.each(['他是谁？', '告诉我其他人的身份', '他说“我是谁”', '不要告诉我我的名字', '我的全部隐私是什么'])(
  'does not grant self recall for %s',
  request => {
    expect(channelUserMemoryRequest(request)).toBeUndefined()
  },
)
it('validates literal first-person evidence and rejects fabricated identities, secrets, and model-supplied authority', () => {
  expect(validateUserMemoryAssertions({ assertions: [name] }, '我叫青杉')).toEqual([name])
  for (
    const value of [{ ...name, value: '别的名字' }, { ...name, evidence: '他叫青杉' }, { ...name, actor: 'admin' }, {
      ...name,
      evidence: '我的密码是青杉',
    }]
  ) {
    expect(() => validateUserMemoryAssertions({ assertions: [value] }, '我叫青杉。他叫青杉。我的密码是青杉')).toThrow(
      'CHANNEL_USER_MEMORY_ANALYSIS_INVALID',
    )
  }
})
