import type {
  ChannelThreadForwardReceiptV1,
  ChannelThreadForwardRequestV1,
} from '@cordisx/protocol/channel-thread-forward/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'

const active = new WeakMap<object, number>()
export async function feishuThreadForward(
  request: ChannelThreadForwardRequestV1,
  channel: FeishuSdkChannel | undefined,
  current: () => boolean,
  authorize: () => void,
): Promise<ChannelThreadForwardReceiptV1> {
  const base = {
    contract: 'cordisx.channel-thread-forward-receipt/v1' as const,
    schemaVersion: 1 as const,
    operation: 'thread-forward' as const,
    operationId: request.operationId,
  }
  const client = channel?.rawClient
  if (!client?.im.v1.message.get || !client.im.v1.thread?.forward || !client.im.v1.chat?.get || !current()) {
    return { ...base, state: 'failed', code: 'THREAD_FORWARD_UNAVAILABLE' }
  }
  if ((active.get(client) ?? 0) >= 8) return { ...base, state: 'failed', code: 'THREAD_FORWARD_BUSY' }
  active.set(client, (active.get(client) ?? 0) + 1)
  let expired = false, effectStarted = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    if (expired || !current()) throw new Error('THREAD_FORWARD_REVOKED')
    authorize()
  }
  try {
    const operation = Promise.resolve().then(async (): Promise<ChannelThreadForwardReceiptV1> => {
      check()
      const anchor = await client.im.v1.message.get({ path: { message_id: request.anchorMessageId } })
      check()
      const item = anchor.data?.items?.find(message => message.message_id === request.anchorMessageId)
      if (
        anchor.code !== 0 || !item || item.deleted || item.chat_id !== request.source.conversationId
        || item.thread_id !== request.threadId
      ) {
        return { ...base, state: 'failed', code: 'THREAD_FORWARD_SOURCE_DENIED' }
      }
      check()
      const destination = await client.im.v1.chat.get({ path: { chat_id: request.target.conversationId } })
      check()
      const mode = destination.data?.chat_mode
      const targetKind = mode === 'p2p' ? 'direct' : mode === 'group' || mode === 'topic' ? 'group' : undefined
      if (destination.code !== 0 || targetKind !== request.target.kind) {
        return { ...base, state: 'failed', code: 'THREAD_FORWARD_TARGET_DENIED' }
      }
      check()
      effectStarted = true
      const response = await client.im.v1.thread.forward({
        path: { thread_id: request.threadId },
        params: { receive_id_type: 'chat_id', uuid: request.operationId },
        data: { receive_id: request.target.conversationId },
      })
      check()
      if (typeof response.code !== 'number' || !Number.isInteger(response.code)) {
        return { ...base, state: 'unknown', code: 'THREAD_FORWARD_RECEIPT_MISSING' }
      }
      if (response.code !== 0) {
        return response.data?.message_id
          ? { ...base, state: 'unknown', code: 'THREAD_FORWARD_EFFECT_UNCERTAIN' }
          : { ...base, state: 'failed', code: 'PLATFORM_THREAD_FORWARD_REJECTED' }
      }
      if (
        !response.data?.message_id || !/^om_[A-Za-z0-9_]{1,200}$/u.test(response.data.message_id)
        || response.data.chat_id !== request.target.conversationId || response.data.deleted
        || Object.hasOwn(response.data, 'invalid_message_ids')
      ) {
        return { ...base, state: 'unknown', code: 'THREAD_FORWARD_RECEIPT_UNVERIFIED' }
      }
      return { ...base, state: 'sent', externalMessageId: response.data.message_id }
    }).finally(() => active.set(client, Math.max(0, (active.get(client) ?? 1) - 1)))
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new Error('THREAD_FORWARD_TIMEOUT'))
        }, 10_000)
      }),
    ])
  } catch {
    return {
      ...base,
      state: effectStarted ? 'unknown' : 'failed',
      code: effectStarted ? 'THREAD_FORWARD_EFFECT_UNCERTAIN' : 'THREAD_FORWARD_PRECHECK_FAILED',
    }
  } finally {
    clearTimeout(timer)
  }
}
