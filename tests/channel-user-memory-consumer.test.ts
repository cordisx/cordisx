import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { a, account, b, channel, fixture, message, settle } from './helpers/channel-conversation-fixture.js'
import { channelMessageContext } from '../packages/cli/src/launcher/channel-message-context.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'

const settings = (f: Awaited<ReturnType<typeof fixture>>, value: unknown) =>
  writeFile(path.join(path.dirname(f.file), 'channel-user-memory.json'), JSON.stringify(value))
const analyze = vi.fn(async (text: string) =>
  text.includes('青杉')
    ? [{ key: 'name', category: 'name', title: '称呼', value: '青杉', evidence: '我叫青杉' }]
    : text.includes('白桦')
    ? [{ key: 'name', category: 'name', title: '称呼', value: '白桦', evidence: '请叫我白桦' }]
    : text.includes('老板')
    ? [{ key: 'relationship', category: 'relationship', title: '自述关系', value: '老板', evidence: '我是你的老板' }]
    : text.includes('红茶')
    ? [{ key: 'drink-preference', category: 'preference', title: '饮品偏好', value: '红茶', evidence: '我喜欢红茶' }]
    : []
)
function wire(f: Awaited<ReturnType<typeof fixture>>, analysis = analyze) {
  Object.assign(f.native, {
    analyzeUserMemory: analysis,
    taskSelection: async () => ({ providerId: 'synthetic', model: 'fixture' }),
    creationSelection: async () => ({ providerId: 'synthetic', model: 'fixture' }),
  })
}
const last = (f: Awaited<ReturnType<typeof fixture>>) => (f.native.start.mock.calls.at(-1) as any)?.[5]?.userMemory

it('automatically saves, updates and recalls another-chat facts without model memory CLI calls, including steer and restart', async () => {
  const f = await fixture()
  wire(f)
  await f.consumer.policySet({ enabled: true }, 0)
  await f.consumer.bind({ channel: channel(), mode: 'deliver' }, a)
  await f.consumer.bind({ channel: channel('oc_group', 'group'), mode: 'deliver' }, b)
  await f.consumer.receive('intro', message('intro', '我叫青杉'))
  await settle(f.consumer)
  expect(last(f)).toMatchObject({
    status: 'saved',
    records: [{ summary: '我叫青杉', revision: 1 }],
    grantsPermissions: false,
  })
  await f.consumer.receive('relation', message('relation', '我是你的老板'))
  await settle(f.consumer)
  await f.consumer.receive('preference', message('preference', '我喜欢红茶'))
  await settle(f.consumer)
  await f.consumer.receive('question', message('question', '认识我是谁吗？', channel('oc_group', 'group')), true)
  await settle(f.consumer)
  expect(last(f).records.map((row: any) => row.summary).sort()).toEqual(['我叫青杉', '我是你的老板'].sort())
  expect(f.consumer.policy().rules ?? []).toEqual([])
  await f.consumer.receive(
    'preference-recall',
    message('preference-recall', '我的饮品偏好是什么？', channel('oc_group', 'group')),
    true,
  )
  await settle(f.consumer)
  expect(last(f).records[0].summary).toBe('我喜欢红茶')
  f.native.completion.mockResolvedValue({ state: 'running' } as never)
  const steer = vi.fn(async () => ({ state: 'accepted' }))
  Object.assign(f.native, { steer })
  await f.consumer.receive('ongoing', message('ongoing', '继续工作'))
  await settle(f.consumer)
  await f.consumer.receive('correction', message('correction', '请叫我白桦'))
  await settle(f.consumer)
  expect((steer.mock.calls.at(-1) as any)[6].userMemory).toMatchObject({
    status: 'saved',
    records: [{ summary: '请叫我白桦', revision: 2 }],
  })
  f.native.completion.mockResolvedValue({ state: 'completed', text: 'done' })
  await settle(f.consumer)
  await f.consumer.dispose()
  const next = await fixture(f.file)
  wire(next)
  await next.consumer.receive(
    'restart-question',
    message('restart-question', '我的名字是什么？', channel('oc_group', 'group')),
    true,
  )
  await settle(next.consumer)
  expect(last(next)).toMatchObject({ status: 'found', records: [{ summary: '请叫我白桦', revision: 2 }] })
  expect(last(next).records).toHaveLength(1)
})

it('keeps same display names, bot accounts, tenants, personas and other-person questions separate', async () => {
  const f = await fixture()
  wire(f)
  await f.consumer.policySet({ enabled: true }, 0)
  await f.consumer.receive('intro', message('intro', '我叫青杉'), false, true, {
    senderName: 'Same name',
    mentions: [],
  })
  await settle(f.consumer)
  const bob = message('bob', '我是谁', channel('oc_other'))
  await f.consumer.receive(
    'bob',
    { ...bob, source: { ...bob.source, event: { ...bob.source.event, actor: { ...account, userId: 'bob' } } } },
    false,
    true,
    { senderName: 'Same name', mentions: [] },
  )
  await settle(f.consumer)
  expect(last(f)).toMatchObject({ status: 'not-found', records: [] })
  for (const change of [{ accountId: 'other' }, { tenantId: 'other' }]) {
    const incoming = message('scope' + JSON.stringify(change), '我是谁', channel('oc_scope'))
    await f.consumer.receive(incoming.source.event.messageId!, {
      ...incoming,
      source: {
        ...incoming.source,
        event: { ...incoming.source.event, ...change, actor: { ...account, ...change, userId: 'alice' } },
      },
    })
    await settle(f.consumer)
    expect(last(f)?.records ?? []).toEqual([])
  }
  await f.consumer.personas.profile('nova', 'Nova', 'Separate persona', 0)
  await f.consumer.personas.bind(account, 'nova', 0)
  await f.consumer.bind({ channel: channel('oc_nova'), mode: 'deliver' }, b)
  await f.consumer.receive('persona-question', message('persona-question', '我是谁', channel('oc_nova')))
  await settle(f.consumer)
  expect(last(f)).toMatchObject({ status: 'not-found' })
  await f.consumer.receive('someone', message('someone', '青杉是谁？', channel('oc_nova')))
  await settle(f.consumer)
  expect(last(f)).toBeUndefined()
})

it('does not save unaddressed groups, denied senders, commands, quoted introductions, or invalid model output', async () => {
  const f = await fixture(),
    fn = vi.fn(async () => [{ key: 'name', category: 'name', title: '称呼', value: '伪造', evidence: '我叫伪造' }])
  wire(f, fn as any)
  await f.consumer.policySet({ enabled: true }, 0)
  for (const [id, text] of [['unaddressed', '我叫青杉'], ['quote', '他说“我叫青杉”']]) {
    await f.consumer.receive(id!, message(id!, text!, channel('oc_group', 'group')), id === 'quote')
    await settle(f.consumer)
  }
  expect(fn).not.toHaveBeenCalled()
  await f.consumer.receive('invalid', message('invalid', '我叫青杉'))
  await settle(f.consumer)
  expect(last(f)).toMatchObject({ status: 'unavailable', records: [] })
  expect(f.report).toHaveBeenCalledWith('CHANNEL_USER_MEMORY_UNAVAILABLE')
  await f.consumer.policySet({
    enabled: true,
    rules: [{ id: 'send-deny', action: 'send', effect: 'deny', userIds: ['alice'] }],
  }, f.consumer.policy().revision)
  fn.mockClear()
  await f.consumer.receive('denied', message('denied', '我叫青杉'))
  await settle(f.consumer)
  expect(fn).not.toHaveBeenCalled()
  expect(last(f)).toBeUndefined()
})

it('honors feature switches and timeout while allowing normal work to start', async () => {
  const f = await fixture()
  const fn = vi.fn(async () => new Promise<any>(() => {}))
  wire(f, fn as any)
  await f.consumer.policySet({ enabled: true }, 0)
  await settings(f, { remember: false })
  await f.consumer.receive('disabled', message('disabled', '我叫青杉'))
  await settle(f.consumer)
  expect(fn).not.toHaveBeenCalled()
  await settings(f, { timeoutMs: 100 })
  await f.consumer.receive('timeout', message('timeout', '我叫青杉'))
  await settle(f.consumer)
  expect(f.native.start).toHaveBeenCalledTimes(2)
  expect(last(f)).toMatchObject({ status: 'unavailable' })
  await settings(f, { enabled: false })
  await f.consumer.receive('all-disabled', message('all-disabled', '我是谁'))
  await settle(f.consumer)
  expect(last(f)).toBeUndefined()
  await settings(f, { groupRecall: false })
  await f.consumer.receive('group-disabled', message('group-disabled', '我是谁', channel('oc_group', 'group')), true)
  await settle(f.consumer)
  expect(last(f)).toBeUndefined()
  await settings(f, { unknownField: true })
  await f.consumer.receive('config-invalid', message('config-invalid', '我是谁'))
  await settle(f.consumer)
  expect(last(f)).toMatchObject({ status: 'unavailable' })
  expect(f.report).toHaveBeenCalledWith('CHANNEL_USER_MEMORY_CONFIG_INVALID')
})

it('rechecks policy after async analysis and cannot trust adapter supplied memory', async () => {
  const f = await fixture()
  wire(
    f,
    vi.fn(async () => {
      await f.consumer.policySet({ enabled: false }, f.consumer.policy().revision)
      return [{ key: 'name', category: 'name', title: '称呼', value: '青杉', evidence: '我叫青杉' }]
    }) as any,
  )
  await f.consumer.policySet({ enabled: true }, 0)
  await f.consumer.receive('change', message('change', '我叫青杉'))
  await settle(f.consumer)
  const state = (f.consumer as unknown as { store: ChannelConversationStore }).store.snapshot()
  expect(state.policy.enabled).toBe(false)
  expect(last(f)).toBeUndefined()
  await f.consumer.policySet({ enabled: true }, f.consumer.policy().revision)
  f.access.messageContext = async incoming => ({
    ...channelMessageContext(incoming),
    userMemory: {
      action: 'recall',
      status: 'found',
      records: [{ summary: 'private fake' }],
      grantsPermissions: false,
    },
  } as any)
  await f.consumer.receive('fake', message('fake', '你好'))
  await settle(f.consumer)
  expect(last(f)).toBeUndefined()
})
