import type { ChannelTenantRef } from '@cordisx/channel-runtime'
import type {
  ChannelRemoteHistoryRequestV1,
  ChannelRemoteHistoryResultV1,
} from '@cordisx/protocol/channel-remote-history/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { channelParticipantName } from './channel-message-context.js'
import { channelPublicCardContent } from './channel-public-card-content.js'
import { feishuDirectoryFailureCode, feishuFailureDiagnostic } from './feishu-operation-error.js'

export interface ChannelRemoteHistoryRequest
  extends Omit<ChannelRemoteHistoryRequestV1, 'account' | 'pageSize' | 'order'>
{
  readonly pageSize: number
  readonly order: 'asc' | 'desc'
}

const activeReads = new WeakMap<object, number>()
const MAX_ACTIVE_READS = 8
type DefinedProperties<T> =
  & { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
  & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> }
const defined = <T extends object>(value: T): DefinedProperties<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as DefinedProperties<T>

/** Exactly one bounded platform page, using the already-connected account. */
export async function channelRemoteHistory(
  ref: ChannelTenantRef,
  request: ChannelRemoteHistoryRequest,
  channel: FeishuSdkChannel | undefined,
): Promise<ChannelRemoteHistoryResultV1> {
  const client = channel?.rawClient
  const list = client?.im.v1.message?.list
  if (!client || !list) return { status: 'unavailable', code: 'CHANNEL_REMOTE_HISTORY_UNAVAILABLE' } as const
  if ((activeReads.get(client) ?? 0) >= MAX_ACTIVE_READS) {
    return { status: 'unavailable', code: 'CHANNEL_REMOTE_HISTORY_BUSY' } as const
  }
  activeReads.set(client, (activeReads.get(client) ?? 0) + 1)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const operation = Promise.resolve().then(() =>
      list({
        params: {
          container_id_type: 'chat',
          container_id: request.conversationId,
          start_time: request.startTime,
          end_time: request.endTime,
          page_size: request.pageSize,
          sort_type: request.order === 'asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
          with_sender_name: true,
          ...(request.pageToken ? { page_token: request.pageToken } : {}),
        },
      })
    ).finally(() => activeReads.set(client, Math.max(0, (activeReads.get(client) ?? 1) - 1)))
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CHANNEL_REMOTE_HISTORY_TIMEOUT')), 10_000)
      }),
    ])
    if (result.code !== 0) {
      const diagnostic = feishuFailureDiagnostic('directory', result)
      return {
        status: 'rejected',
        code: feishuDirectoryFailureCode(diagnostic) === 'CHANNEL_DIRECTORY_PERMISSION_DENIED'
          ? 'CHANNEL_REMOTE_HISTORY_PERMISSION_DENIED'
          : 'CHANNEL_REMOTE_HISTORY_FAILED',
        diagnostic,
      } as const
    }
    if (
      !result.data || !Array.isArray(result.data.items) || result.data.items.length > request.pageSize
      || result.data.items.some(item => item.chat_id !== undefined && item.chat_id !== request.conversationId)
      || typeof result.data.has_more !== 'boolean'
      || result.data.has_more && !result.data.page_token
    ) {
      return { status: 'rejected', code: 'CHANNEL_REMOTE_HISTORY_INVALID_PAGE' } as const
    }
    return {
      status: 'ok',
      source: 'remote' as const,
      account: ref,
      conversation: { id: request.conversationId, kind: request.kind },
      startTime: request.startTime,
      endTime: request.endTime,
      order: request.order,
      hasMore: result.data.has_more,
      ...(result.data.page_token ? { pageToken: result.data.page_token } : {}),
      messages: result.data.items.map(item =>
        defined({
          messageId: item.message_id,
          type: item.msg_type,
          createTime: item.create_time,
          deleted: item.deleted,
          updated: item.updated,
          content: channelPublicCardContent(item.msg_type, item.body?.content),
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
      ),
    } as const
  } catch (error) {
    if (error instanceof Error && error.message === 'CHANNEL_REMOTE_HISTORY_TIMEOUT') {
      return { status: 'unavailable', code: error.message } as const
    }
    const diagnostic = feishuFailureDiagnostic('directory', error)
    return {
      status: 'rejected',
      code: feishuDirectoryFailureCode(diagnostic) === 'CHANNEL_DIRECTORY_PERMISSION_DENIED'
        ? 'CHANNEL_REMOTE_HISTORY_PERMISSION_DENIED'
        : 'CHANNEL_REMOTE_HISTORY_FAILED',
      diagnostic,
    } as const
  } finally {
    clearTimeout(timer)
  }
}
