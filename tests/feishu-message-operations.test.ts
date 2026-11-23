import { expect, it, vi } from 'vitest'
import {
  feishuMessageOperation,
  feishuMessageOperationCapabilities,
} from '../packages/cli/src/launcher/feishu-message-operations.js'
import { parseMessageOperation } from '../packages/cli/src/launcher/channel-message-operation-request.js'
import type { FeishuSdkChannel } from '../packages/cli/src/launcher/feishu-adapter.js'

const account = { adapterId: 'feishu', accountId: 'app', tenantId: 'tenant' }
const base = { account, conversationId: 'oc_chat', kind: 'group' }
const event = {
  ...account,
  conversationId: 'oc_chat',
  kind: 'group' as const,
  threadId: 'oc_chat',
  semantics: 'conversation' as const,
  eventId: 'event',
  messageId: 'om_source',
}
const fixture = () => {
  const item = {
    message_id: 'om_owned',
    chat_id: 'oc_chat',
    msg_type: 'text',
    sender: { id: 'app', id_type: 'app_id', sender_type: 'app' },
    body: { content: '{"text":"old"}' },
  }
  const get = vi.fn(async () => ({ code: 0, data: { items: [item] } }))
  const update = vi.fn(async () => ({ code: 0 }))
  const remove = vi.fn(async () => ({ code: 0 }))
  const patch = vi.fn(async () => ({ code: 0 }))
  const readUsers = vi.fn(async () => ({
    code: 0,
    data: { items: [{ user_id: 'ou_reader', timestamp: '1', tenant_key: 'secret' }], has_more: false },
  }))
  const channel = {
    botIdentity: { openId: 'ou_bot' },
    rawClient: {
      im: {
        v1: {
          message: { get, update, delete: remove, patch, readUsers },
          pin: { create: update, delete: remove, list: readUsers },
          messageReaction: { list: readUsers },
        },
      },
    },
  } as unknown as FeishuSdkChannel
  return { item, get, update, remove, patch, readUsers, channel }
}

it('edits only owned exact-conversation text with a positive business receipt', async () => {
  const fixtureValue = fixture()
  const request = parseMessageOperation('message-edit', {
    ...base,
    messageId: 'om_owned',
    operationId: 'edit',
    content: { type: 'text', text: 'new' },
  })
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toMatchObject({ status: 'ok', messageId: 'om_owned' })
  expect(fixtureValue.update).toHaveBeenCalledWith({
    path: { message_id: 'om_owned' },
    data: { msg_type: 'text', content: '{"text":"new"}' },
  })
  fixtureValue.item.chat_id = 'oc_other'
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toMatchObject({ status: 'rejected' })
  expect(fixtureValue.update).toHaveBeenCalledTimes(1)
})

it('rejects human ownership and treats missing business receipts as unknown', async () => {
  const fixtureValue = fixture()
  const request = parseMessageOperation('message-recall', { ...base, messageId: 'om_owned', operationId: 'recall' })
  fixtureValue.item.sender.sender_type = 'user'
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toMatchObject({ code: 'CHANNEL_MESSAGE_NOT_OWNED' })
  expect(fixtureValue.remove).not.toHaveBeenCalled()
  fixtureValue.item.sender.sender_type = 'app'
  fixtureValue.remove.mockResolvedValueOnce({ code: undefined } as unknown as { code: number })
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toMatchObject({ status: 'unknown' })
})

it('rejects control cards and updates only plain notice cards', async () => {
  const fixtureValue = fixture()
  fixtureValue.item.msg_type = 'interactive'
  fixtureValue.item.body.content = '{"elements":[{"tag":"action","actions":[]}]}'
  const request = parseMessageOperation('card-update', {
    ...base,
    messageId: 'om_owned',
    operationId: 'card',
    card: { template: 'notice', title: 'Note', body: 'new' },
  })
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toMatchObject({ code: 'CHANNEL_CONTROL_CARD_DENIED' })
  expect(fixtureValue.patch).not.toHaveBeenCalled()
  fixtureValue.item.body.content = '{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"old"}}]}'
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toMatchObject({ status: 'ok' })
})

it('reads exactly one page with no tenant secrets and never claims permissions verified', async () => {
  const fixtureValue = fixture()
  const request = parseMessageOperation('read-users', {
    ...base,
    messageId: 'om_owned',
    pageToken: 'cursor',
    pageSize: 10,
  })
  expect(
    await feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => true,
    }),
  ).toEqual({
    status: 'ok',
    operation: 'read-users',
    items: [{ type: 'reader', userId: 'ou_reader', readAt: '1' }],
    hasMore: false,
  })
  expect(fixtureValue.readUsers).toHaveBeenCalledTimes(1)
  expect(fixtureValue.readUsers).toHaveBeenCalledWith({
    path: { message_id: 'om_owned' },
    params: { page_size: 10, page_token: 'cursor', user_id_type: 'open_id' },
  })
  expect(feishuMessageOperationCapabilities(fixtureValue.channel).every(item => item.authorization === 'not-verified'))
    .toBe(true)
})

it('rejects raw card actions, invalid pagination and extra fields before SDK calls', () => {
  expect(() =>
    parseMessageOperation('message-edit', {
      ...base,
      messageId: 'om_owned',
      operationId: 'x',
      content: { type: 'text', text: '<at user_id="ou_user">User</at>' },
    })
  ).toThrow('CHANNEL_EDIT_MENTION_UNSUPPORTED')
  expect(() => parseMessageOperation('read-users', { ...base, messageId: 'om_owned', pageSize: 51 })).toThrow()
  expect(() =>
    parseMessageOperation('message-recall', { ...base, messageId: 'om_owned', operationId: 'x', token: 'secret' })
  ).toThrow()
  expect(() =>
    parseMessageOperation('card-update', {
      ...base,
      messageId: 'om_owned',
      operationId: 'x',
      card: { template: 'notice', title: 'Title', body: 'Body', actions: [] },
    })
  ).toThrow()
})

it('revalidates permission after platform read and denies untracked cards', async () => {
  const fixtureValue = fixture()
  const request = parseMessageOperation('message-recall', { ...base, messageId: 'om_owned', operationId: 'recall' })
  let allowed = true
  fixtureValue.get.mockImplementationOnce(async () => {
    allowed = false
    return { code: 0, data: { items: [fixtureValue.item] } }
  })
  const authorize = () => {
    if (!allowed) throw new Error('CHANNEL_PERMISSION_DENIED')
  }
  expect(await feishuMessageOperation(request, event, fixtureValue.channel, { authorize, ownsPlainCard: () => false }))
    .toMatchObject({ status: 'unavailable' })
  expect(fixtureValue.remove).not.toHaveBeenCalled()
  fixtureValue.item.msg_type = 'interactive'
  fixtureValue.item.body.content = '{"elements":[{"tag":"div","text":{"tag":"plain_text","content":"looks safe"}}]}'
  const card = parseMessageOperation('card-update', {
    ...base,
    messageId: 'om_owned',
    operationId: 'card',
    card: { template: 'notice', title: 'New', body: 'New' },
  })
  expect(
    await feishuMessageOperation(card, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => false,
    }),
  ).toMatchObject({ code: 'CHANNEL_CONTROL_CARD_DENIED' })
  expect(fixtureValue.patch).not.toHaveBeenCalled()
})

it('does not submit a write when a platform read arrives after timeout', async () => {
  vi.useFakeTimers()
  try {
    const fixtureValue = fixture()
    fixtureValue.get.mockImplementationOnce(() =>
      new Promise(resolve => setTimeout(() => resolve({ code: 0, data: { items: [fixtureValue.item] } }), 6000))
    )
    const request = parseMessageOperation('message-recall', { ...base, messageId: 'om_owned', operationId: 'recall' })
    const pending = feishuMessageOperation(request, event, fixtureValue.channel, {
      authorize: () => {},
      ownsPlainCard: () => false,
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(await pending).toMatchObject({ status: 'unavailable', code: 'CHANNEL_OPERATION_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixtureValue.remove).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
