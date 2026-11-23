import type { ChannelForwardReceiptV1, ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'

export async function feishuMessageForward(
  request: ChannelForwardRequestV1,
  channel: FeishuSdkChannel | undefined,
  current: () => boolean,
  authorize: () => void = () => {},
): Promise<ChannelForwardReceiptV1> {
  const base = {
    contract: 'cordisx.channel-forward-receipt/v1' as const,
    schemaVersion: 1 as const,
    operationId: request.operationId,
    operation: request.operation,
  }
  const client = channel?.rawClient?.im.v1.message
  if (!client || !current()) return { ...base, state: 'failed', code: 'FORWARD_UNAVAILABLE' }
  for (const messageId of request.messageIds) {
    if (!current()) return { ...base, state: 'failed', code: 'FORWARD_GENERATION_REVOKED' }
    let response
    try {
      authorize()
      response = await client.get({ path: { message_id: messageId } })
    } catch {
      return { ...base, state: 'failed', code: 'SOURCE_READ_FAILED' }
    }
    const item = response?.data?.items?.find(item => item.message_id === messageId)
    if (response?.code !== 0 || !item || item.deleted || item.chat_id !== request.source.conversationId) {
      return { ...base, state: 'failed', code: 'SOURCE_MESSAGE_DENIED' }
    }
  }
  if (!current()) return { ...base, state: 'failed', code: 'FORWARD_GENERATION_REVOKED' }
  try {
    authorize()
  } catch {
    return { ...base, state: 'failed', code: 'FORWARD_PERMISSION_REVOKED' }
  }
  try {
    const params = { receive_id_type: 'chat_id' as const, uuid: request.operationId }
    if (request.operation === 'forward') {
      const result = await client.forward({
        path: { message_id: request.messageIds[0]! },
        params,
        data: { receive_id: request.target.conversationId },
      })
      if (typeof result?.code !== 'number') return { ...base, state: 'unknown', code: 'FORWARD_RECEIPT_MISSING' }
      if (result.code !== 0) return { ...base, state: 'failed', code: `PLATFORM_FORWARD_${result.code}` }
      if (!result.data?.message_id) return { ...base, state: 'unknown', code: 'FORWARD_RECEIPT_MISSING' }
      return { ...base, state: 'sent', externalMessageId: result.data.message_id, invalidMessageIds: [] }
    }
    const result = await client.mergeForward({
      params,
      data: { receive_id: request.target.conversationId, message_id_list: [...request.messageIds] },
    })
    if (typeof result?.code !== 'number') return { ...base, state: 'unknown', code: 'FORWARD_RECEIPT_MISSING' }
    if (result.code !== 0) return { ...base, state: 'failed', code: `PLATFORM_FORWARD_${result.code}` }
    if (!result.data?.message?.message_id) return { ...base, state: 'unknown', code: 'FORWARD_RECEIPT_MISSING' }
    const invalidMessageIds = result.data.invalid_message_id_list ?? []
    if (!Array.isArray(invalidMessageIds) || invalidMessageIds.some(id => !request.messageIds.includes(id))) {
      return { ...base, state: 'unknown', code: 'FORWARD_RECEIPT_INVALID' }
    }
    return {
      ...base,
      state: invalidMessageIds.length ? 'partial' : 'sent',
      externalMessageId: result.data.message.message_id,
      invalidMessageIds,
    }
  } catch {
    return { ...base, state: 'unknown', code: 'FORWARD_EFFECT_UNCERTAIN' }
  }
}
