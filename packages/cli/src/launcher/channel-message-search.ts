import type { ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelRemoteMessageV1 } from '@cordisx/protocol/channel-remote-history/v1'
import type {
  ChannelMessageSearchRequestV1,
  ChannelMessageSearchResultV1,
} from '@cordisx/protocol/channel-message-search/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'

export type ChannelMessageSearchRequest = Omit<ChannelMessageSearchRequestV1, 'account' | 'pageSize'> & {
  pageSize: number
}
const active = new WeakMap<object, number>()
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
  return value as Record<string, unknown>
}
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !/^om_[A-Za-z0-9_]{1,200}$/u.test(value)) {
    throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
  }
  return value
}
const optionalText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const requiredText = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000\r\n]/u.test(value)) {
    throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
  }
  return value
}

export async function channelMessageSearch(
  ref: ChannelTenantRef,
  request: ChannelMessageSearchRequest,
  channel: FeishuSdkChannel | undefined,
  authorize: () => void,
): Promise<ChannelMessageSearchResultV1> {
  const client = channel?.rawClient
  if (!client?.request) return { status: 'unavailable', code: 'CHANNEL_SEARCH_UNAVAILABLE' }
  if ((active.get(client) ?? 0) >= 8) return { status: 'unavailable', code: 'CHANNEL_SEARCH_BUSY' }
  if (
    !request.query.trim() || request.query.length > 1024 || request.query.includes('\u0000')
    || !/^[0-9]{1,13}$/u.test(request.startTime) || !/^[0-9]{1,13}$/u.test(request.endTime)
    || !Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 50
    || request.pageToken !== undefined
      && (!request.pageToken || request.pageToken.length > 2048 || /[\u0000\r\n]/u.test(request.pageToken))
  ) {
    return { status: 'rejected', code: 'CHANNEL_SEARCH_INVALID_REQUEST' }
  }
  const start = BigInt(request.startTime) * 1000n, end = BigInt(request.endTime) * 1000n
  if (start >= end || end > 8_640_000_000_000_000n) {
    return { status: 'rejected', code: 'CHANNEL_SEARCH_INVALID_REQUEST' }
  }
  active.set(client, (active.get(client) ?? 0) + 1)
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    if (expired) throw new Error('CHANNEL_SEARCH_TIMEOUT')
    authorize()
  }
  const page = (response: unknown) => {
    const envelope = object(response)
    if (envelope.code !== 0) throw new Error('CHANNEL_SEARCH_PLATFORM_REJECTED')
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 1_048_576) throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
    return object(envelope.data)
  }
  try {
    const operation = Promise.resolve().then(async (): Promise<ChannelMessageSearchResultV1> => {
      check()
      const search = page(
        await client.request({
          method: 'POST',
          url: '/open-apis/im/v1/messages/search',
          params: { page_size: request.pageSize, ...(request.pageToken ? { page_token: request.pageToken } : {}) },
          data: {
            query: request.query,
            filter: {
              chat_ids: [request.conversationId],
              time_range: {
                start_time: new Date(Number(start)).toISOString(),
                end_time: new Date(Number(end)).toISOString(),
              },
            },
          },
        }),
      )
      check()
      if (
        !Array.isArray(search.items) || search.items.length > request.pageSize || typeof search.has_more !== 'boolean'
        || search.page_token !== undefined && (typeof search.page_token !== 'string' || !search.page_token
            || search.page_token.length > 2048 || /[\u0000\r\n]/u.test(search.page_token))
        || search.has_more && (!search.page_token || search.page_token === request.pageToken)
      ) {
        throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
      }
      const ids = search.items.map(hit => identifier(object(object(hit).meta_data).message_id))
      if (new Set(ids).size !== ids.length) throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
      let messages: ChannelRemoteMessageV1[] = []
      if (ids.length) {
        check()
        const details = page(
          await client.request({
            method: 'GET',
            url: '/open-apis/im/v1/messages/mget',
            params: { message_ids: ids, user_id_type: 'open_id' },
            paramsSerializer: () =>
              new URLSearchParams([
                ...ids.map(messageId => ['message_ids', messageId]),
                ['user_id_type', 'open_id'],
              ]).toString(),
          }),
        )
        check()
        if (!Array.isArray(details.items) || details.items.length !== ids.length) {
          throw new Error('CHANNEL_SEARCH_DETAIL_UNAVAILABLE')
        }
        const byId = new Map<string, Record<string, unknown>>()
        for (const raw of details.items) {
          const item = object(raw), messageId = identifier(item.message_id)
          if (
            !ids.includes(messageId) || byId.has(messageId) || item.chat_id !== request.conversationId
            || typeof item.create_time !== 'string' || !/^[0-9]{1,16}$/u.test(item.create_time)
            || BigInt(item.create_time) < start || BigInt(item.create_time) >= end
          ) {
            throw new Error('CHANNEL_SEARCH_SOURCE_MISMATCH')
          }
          byId.set(messageId, item)
        }
        messages = ids.map(messageId => {
          const item = byId.get(messageId)!
          const body = item.body === undefined ? {} : object(item.body)
          const text = (key: string, value: unknown) =>
            optionalText(value) === undefined ? {} : { [key]: value as string }
          return {
            messageId,
            createTime: item.create_time as string,
            ...text('type', item.msg_type),
            ...text('content', body.content),
            ...text('threadId', item.thread_id),
            ...text('rootId', item.root_id),
            ...text('parentId', item.parent_id),
            ...(typeof item.deleted === 'boolean' ? { deleted: item.deleted } : {}),
            ...(typeof item.updated === 'boolean' ? { updated: item.updated } : {}),
            ...(item.sender === undefined ? {} : {
              sender: (() => {
                const sender = object(item.sender)
                return {
                  id: requiredText(sender.id),
                  idType: requiredText(sender.id_type),
                  type: requiredText(sender.sender_type),
                  ...text('tenantId', sender.tenant_key),
                  ...text('name', sender.sender_name),
                }
              })(),
            }),
            mentions: item.mentions === undefined ? [] : (() => {
              if (!Array.isArray(item.mentions)) throw new Error('CHANNEL_SEARCH_INVALID_PAGE')
              return item.mentions.map(raw => {
                const mention = object(raw)
                return {
                  key: requiredText(mention.key),
                  id: requiredText(mention.id),
                  idType: requiredText(mention.id_type),
                  ...text('tenantId', mention.tenant_key),
                  ...text('name', mention.name),
                }
              })
            })(),
          }
        })
      }
      check()
      return {
        status: 'ok',
        source: 'remote',
        account: ref,
        conversation: { id: request.conversationId, kind: request.kind },
        query: request.query,
        startTime: request.startTime,
        endTime: request.endTime,
        hasMore: search.has_more,
        ...(typeof search.page_token === 'string' ? { pageToken: search.page_token } : {}),
        messages,
      }
    }).finally(() => active.set(client, Math.max(0, (active.get(client) ?? 1) - 1)))
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(new Error('CHANNEL_SEARCH_TIMEOUT'))
        }, 10_000)
      }),
    ])
  } catch (error) {
    const code = error instanceof Error
        && /^(?:CHANNEL_SEARCH_|CHANNEL_GENERATION_CHANGED$|CHANNEL_POLICY_DENIED$)/u.test(error.message)
      ? error.message
      : 'CHANNEL_SEARCH_FAILED'
    return { status: 'unavailable', code }
  } finally {
    clearTimeout(timer)
  }
}
