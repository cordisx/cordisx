import type { ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelRemoteMessageV1 } from '@cordisx/protocol/channel-remote-history/v1'
import type {
  ChannelThreadHistoryRequestV1,
  ChannelThreadHistoryResultV1,
} from '@cordisx/protocol/channel-thread-history/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { channelParticipantName } from './channel-message-context.js'
import { feishuDirectoryFailureCode, feishuFailureDiagnostic } from './feishu-operation-error.js'

export interface ChannelThreadHistoryRequest
  extends Omit<ChannelThreadHistoryRequestV1, 'account' | 'pageSize' | 'order'>
{
  readonly pageSize: number
  readonly order: 'asc' | 'desc'
}

const active = new WeakMap<object, number>()
type DefinedProperties<Value> =
  & { [Key in keyof Value as undefined extends Value[Key] ? never : Key]: Value[Key] }
  & { [Key in keyof Value as undefined extends Value[Key] ? Key : never]?: Exclude<Value[Key], undefined> }
const defined = <Value extends object>(value: Value): DefinedProperties<Value> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as DefinedProperties<Value>

export async function channelThreadHistory(
  ref: ChannelTenantRef,
  request: ChannelThreadHistoryRequest,
  channel: FeishuSdkChannel | undefined,
  authorize: () => void,
): Promise<ChannelThreadHistoryResultV1> {
  const client = channel?.rawClient
  if (!client?.im.v1.message?.get || !client.im.v1.message.list) {
    return { status: 'unavailable', code: 'CHANNEL_THREAD_HISTORY_UNAVAILABLE' } as const
  }
  if ((active.get(client) ?? 0) >= 8) {
    return { status: 'unavailable', code: 'CHANNEL_THREAD_HISTORY_BUSY' } as const
  }
  active.set(client, (active.get(client) ?? 0) + 1)
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const check = () => {
    if (expired) throw new Error('CHANNEL_THREAD_HISTORY_TIMEOUT')
    authorize()
  }
  try {
    const operation = Promise.resolve().then(async () => {
      check()
      const anchor = await client.im.v1.message.get({
        path: { message_id: request.anchorMessageId },
        params: { user_id_type: 'open_id' },
      })
      check()
      if (anchor.code !== 0) return { status: 'rejected', code: 'CHANNEL_THREAD_ANCHOR_UNAVAILABLE' } as const
      const message = anchor.data?.items?.find(item => item.message_id === request.anchorMessageId)
      if (
        !message || message.deleted || message.chat_id !== request.conversationId
        || message.thread_id !== request.threadId
      ) {
        return { status: 'rejected', code: 'CHANNEL_THREAD_SOURCE_MISMATCH' } as const
      }
      const response = await client.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: request.threadId,
          page_size: request.pageSize,
          sort_type: request.order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
          with_sender_name: true,
          ...(request.pageToken ? { page_token: request.pageToken } : {}),
        },
      })
      check()
      if (response.code !== 0) {
        const diagnostic = feishuFailureDiagnostic('directory', response)
        return {
          status: 'rejected',
          code: feishuDirectoryFailureCode(diagnostic) === 'CHANNEL_DIRECTORY_PERMISSION_DENIED'
            ? 'CHANNEL_THREAD_HISTORY_PERMISSION_DENIED'
            : 'CHANNEL_THREAD_HISTORY_FAILED',
          diagnostic,
        } as const
      }
      const page = response.data
      if (
        !page || !Array.isArray(page.items) || page.items.length > request.pageSize
        || typeof page.has_more !== 'boolean' || page.has_more && !page.page_token
        || page.page_token !== undefined && (typeof page.page_token !== 'string'
            || page.page_token.length > 2048 || /[\u0000\r\n]/u.test(page.page_token))
        || page.has_more && page.page_token === request.pageToken
        || Buffer.byteLength(JSON.stringify(page), 'utf8') > 1_048_576
        || page.items.some(item =>
          !item.message_id || item.chat_id !== request.conversationId
          || item.thread_id !== request.threadId
        )
      ) {
        return { status: 'rejected', code: 'CHANNEL_THREAD_HISTORY_INVALID_PAGE' } as const
      }
      const messages: ChannelRemoteMessageV1[] = page.items.map(item =>
        defined({
          messageId: item.message_id,
          type: item.msg_type,
          createTime: item.create_time,
          deleted: item.deleted,
          updated: item.updated,
          content: item.body?.content,
          threadId: item.thread_id,
          rootId: item.root_id,
          parentId: item.parent_id,
          sender: item.sender && defined({
            id: item.sender.id,
            idType: item.sender.id_type,
            type: item.sender.sender_type,
            tenantId: item.sender.tenant_key,
            name: channelParticipantName(item.sender.sender_name)
              ?? channelParticipantName(item.sender.sender_i18n_names?.zh_cn)
              ?? channelParticipantName(item.sender.sender_i18n_names?.en_us)
              ?? channelParticipantName(item.sender.sender_i18n_names?.ja_jp),
          }),
          mentions: (item.mentions ?? []).map(mention =>
            defined({
              key: mention.key,
              id: mention.id,
              idType: mention.id_type,
              tenantId: mention.tenant_key,
              name: channelParticipantName(mention.name),
            })
          ),
        })
      )
      return {
        status: 'ok',
        source: 'remote',
        account: ref,
        conversation: { id: request.conversationId, kind: request.kind },
        threadId: request.threadId,
        anchorMessageId: request.anchorMessageId,
        order: request.order,
        hasMore: page.has_more,
        ...(page.page_token ? { pageToken: page.page_token } : {}),
        messages,
      } as const
    }).finally(() => active.set(client, Math.max(0, (active.get(client) ?? 1) - 1)))
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new Error('CHANNEL_THREAD_HISTORY_TIMEOUT'))
        }, 10_000)
      }),
    ])
  } catch (error) {
    const code = error instanceof Error
        && ['CHANNEL_THREAD_HISTORY_TIMEOUT', 'CHANNEL_GENERATION_CHANGED', 'CHANNEL_POLICY_DENIED'].includes(
          error.message,
        )
      ? error.message
      : 'CHANNEL_THREAD_HISTORY_FAILED'
    return { status: 'unavailable', code } as const
  } finally {
    clearTimeout(timer)
  }
}
