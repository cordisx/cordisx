import { expect, it, vi } from 'vitest'
import type { ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { feishuMessageForward } from './feishu-message-forward.js'

const request: ChannelForwardRequestV1 = {
  contract: 'cordisx.channel-forward/v1',
  schemaVersion: 1,
  operation: 'forward',
  operationId: 'one',
  source: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId: 'oc_source', kind: 'group' },
  target: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId: 'oc_target', kind: 'group' },
  messageIds: ['om_one'],
}
function fixture() {
  const get = vi.fn(async ({ path }: { path: { message_id: string } }) => ({
    code: 0,
    data: { items: [{ message_id: path.message_id, chat_id: 'oc_source', deleted: false }] },
  }))
  const forward = vi.fn(async () => ({ code: 0, data: { message_id: 'om_result' } }))
  const mergeForward = vi.fn(async () => ({
    code: 0,
    data: { message: { message_id: 'om_merge' }, invalid_message_id_list: ['om_two'] },
  }))
  const channel = {
    rawClient: { im: { v1: { message: { get, forward, mergeForward } } } },
  } as unknown as FeishuSdkChannel
  return { channel, get, forward, mergeForward }
}
it('calls official forward with UUID and the actual receipt', async () => {
  const { channel, forward, mergeForward } = fixture()
  expect(await feishuMessageForward(request, channel, () => true)).toMatchObject({
    state: 'sent',
    externalMessageId: 'om_result',
  })
  expect(forward).toHaveBeenCalledWith({
    path: { message_id: 'om_one' },
    params: { receive_id_type: 'chat_id', uuid: 'one' },
    data: { receive_id: 'oc_target' },
  })
  expect(mergeForward).not.toHaveBeenCalled()
})
it('retains actual merge partial receipt and ordered IDs', async () => {
  const { channel, mergeForward } = fixture()
  expect(
    await feishuMessageForward(
      { ...request, operation: 'merge-forward', messageIds: ['om_one', 'om_two'] },
      channel,
      () => true,
    ),
  )
    .toMatchObject({ state: 'partial', externalMessageId: 'om_merge', invalidMessageIds: ['om_two'] })
  expect(mergeForward.mock.calls[0]).toEqual([{
    params: { receive_id_type: 'chat_id', uuid: 'one' },
    data: { receive_id: 'oc_target', message_id_list: ['om_one', 'om_two'] },
  }])
})
it('denies foreign or deleted source before effect', async () => {
  const { channel, get, forward } = fixture()
  get.mockResolvedValueOnce({
    code: 0,
    data: { items: [{ message_id: 'om_one', chat_id: 'oc_foreign', deleted: false }] },
  })
  expect(await feishuMessageForward(request, channel, () => true)).toMatchObject({
    state: 'failed',
    code: 'SOURCE_MESSAGE_DENIED',
  })
  expect(forward).not.toHaveBeenCalled()
})
it('never falls back to channel.send and retains platform rejection codes', async () => {
  const { channel, forward } = fixture()
  forward.mockResolvedValueOnce({ code: 230001, data: { message_id: '' } })
  expect(await feishuMessageForward(request, channel, () => true)).toMatchObject({
    state: 'failed',
    code: 'PLATFORM_FORWARD_230001',
  })
  forward.mockRejectedValueOnce(new Error('timeout'))
  expect(await feishuMessageForward(request, channel, () => true)).toMatchObject({ state: 'unknown' })
  expect(await feishuMessageForward(request, undefined, () => true)).toMatchObject({
    state: 'failed',
    code: 'FORWARD_UNAVAILABLE',
  })
})
