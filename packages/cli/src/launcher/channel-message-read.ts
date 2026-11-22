import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelMessageReadResultV1, ChannelReferencedMessageV1 } from '@cordisx/protocol/channel-message-read/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { channelParticipantName } from './channel-message-context.js'

export type ChannelReferencedMessage = ChannelReferencedMessageV1
export type ChannelMessageReadResult = ChannelMessageReadResultV1

const active = new WeakMap<object, number>()
const MAX_ACTIVE = 8
const MAX_CONTENT = 12_000
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^om_[A-Za-z0-9_]{1,200}$/u.test(value)

/** Read one message with the live account, never accept another conversation's data. */
export async function channelMessageRead(
  event: ChannelEventRef,
  messageId: string,
  channel: FeishuSdkChannel | undefined,
  timeoutMs = 2_500,
): Promise<ChannelMessageReadResult> {
  const client = channel?.rawClient
  const get = client?.im.v1.message?.get
  if (!client || !get || !validId(messageId)) return { status: 'unavailable', code: 'CHANNEL_MESSAGE_UNAVAILABLE' }
  if ((active.get(client) ?? 0) >= MAX_ACTIVE) return { status: 'unavailable', code: 'CHANNEL_MESSAGE_BUSY' }
  active.set(client, (active.get(client) ?? 0) + 1)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const operation = Promise.resolve().then(() =>
      get({
        path: { message_id: messageId },
        params: { user_id_type: 'open_id', with_sender_name: true },
      })
    ).finally(() => active.set(client, Math.max(0, (active.get(client) ?? 1) - 1)))
    const response = await Promise.race([
      operation,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
    if (!response) return { status: 'unavailable', code: 'CHANNEL_MESSAGE_TIMEOUT' }
    if (response.code !== 0) return { status: 'unavailable', code: 'CHANNEL_MESSAGE_READ_FAILED' }
    const item = response.data?.items?.find(row => row.message_id === messageId)
    if (!item || item.chat_id !== event.conversationId || item.deleted) {
      return { status: 'unavailable', code: 'CHANNEL_MESSAGE_NOT_ACCESSIBLE' }
    }
    const body = item.body?.content
    const name = channelParticipantName(item.sender?.sender_name)
      ?? channelParticipantName(item.sender?.sender_i18n_names?.zh_cn)
      ?? channelParticipantName(item.sender?.sender_i18n_names?.en_us)
      ?? channelParticipantName(item.sender?.sender_i18n_names?.ja_jp)
    return {
      status: 'ok',
      message: {
        messageId,
        ...(validId(item.parent_id) ? { parentId: item.parent_id } : {}),
        ...(item.msg_type ? { type: item.msg_type } : {}),
        ...(item.sender
          ? {
            sender: {
              ...(item.sender.id ? { id: item.sender.id } : {}),
              ...(item.sender.id_type ? { idType: item.sender.id_type } : {}),
              ...(item.sender.sender_type ? { type: item.sender.sender_type } : {}),
              ...(name ? { name } : {}),
            },
          }
          : {}),
        ...(typeof body === 'string' ? { content: body.slice(0, MAX_CONTENT) } : {}),
        ...(typeof body === 'string' && body.length > MAX_CONTENT ? { truncated: true } : {}),
      },
    }
  } catch {
    return { status: 'unavailable', code: 'CHANNEL_MESSAGE_READ_FAILED' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Resolve the direct parent, not the root of a potentially deeper reply chain. */
export async function channelDirectReply(
  event: ChannelEventRef,
  channel: FeishuSdkChannel | undefined,
): Promise<ChannelMessageReadResult | undefined> {
  if (event.semantics === 'conversation' || !event.messageId) return undefined
  const current = await channelMessageRead(event, event.messageId, channel)
  if (current.status !== 'ok') return current
  if (!current.message.parentId) return { status: 'unavailable', code: 'CHANNEL_PARENT_NOT_AVAILABLE' }
  return await channelMessageRead(event, current.message.parentId, channel)
}
