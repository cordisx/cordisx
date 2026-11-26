import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type {
  ChannelMessageOperationCapabilityV1,
  ChannelMessageOperationItemV1,
  ChannelMessageOperationRequestV1,
  ChannelMessageOperationResultV1,
} from '@cordisx/protocol/channel-message-operations/v1'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { renderFeishuTypedContent } from './feishu-outbound-media.js'
import { MESSAGE_OPERATION_WRITES, MESSAGE_OPERATIONS } from './channel-message-operation-request.js'
import { safeCardBody } from './feishu-plain-card.js'

const scopes = {
  'message-edit': ['im:message:update', 'im:message:send_as_bot'],
  'message-recall': ['im:message:recall', 'im:message:send_as_bot'],
  'card-update': ['im:message:send_as_bot'],
  'pin-add': ['im:message.pins:write_only', 'im:message:send_as_bot'],
  'pin-remove': ['im:message.pins:write_only', 'im:message:send_as_bot'],
  'pin-list': ['im:message.pins:read', 'im:message:readonly'],
  'read-users': ['im:message:basic', 'im:message:readonly'],
  'reaction-list': ['im:message.reactions:read', 'im:message:readonly'],
} as const

export function feishuMessageOperationCapabilities(
  channel: FeishuSdkChannel | undefined,
): ChannelMessageOperationCapabilityV1[] {
  const client = channel?.rawClient?.im.v1
  const methods = {
    'message-edit': client?.message?.update,
    'message-recall': client?.message?.delete,
    'card-update': client?.message?.patch,
    'pin-add': client?.pin?.create,
    'pin-remove': client?.pin?.delete,
    'pin-list': client?.pin?.list,
    'read-users': client?.message?.readUsers,
    'reaction-list': client?.messageReaction?.list,
  }
  return MESSAGE_OPERATIONS.map(operation => ({
    operation,
    implementation: methods[operation] && (operation === 'pin-list' || client?.message?.get)
      ? 'supported'
      : 'unsupported',
    authorization: 'not-verified',
    scope: operation === 'reaction-list'
      ? 'source-message'
      : operation.startsWith('pin-')
      ? 'conversation'
      : 'own-message',
    write: MESSAGE_OPERATION_WRITES.includes(operation as typeof MESSAGE_OPERATION_WRITES[number]),
    permissionAlternatives: [...scopes[operation]],
    restrictions: [
      'exact-account-and-conversation',
      'platform-permissions-and-membership-required',
      ...(operation === 'message-edit' ? ['text-post-only', 'administrator-edit-window', 'maximum-20-edits'] : []),
      ...(operation === 'message-recall'
        ? ['own-message-only', 'administrator-recall-window', 'not-local-history-delete']
        : []),
      ...(operation === 'read-users' ? ['own-message-only', 'maximum-age-7-days', 'explicit-page-only'] : []),
      ...(operation === 'card-update' ? ['notice-status-only', 'no-control-card-replacement'] : []),
      ...(operation === 'pin-list' ? ['group-only', 'explicit-page-only'] : []),
      ...(operation === 'reaction-list' ? ['incoming-source-message-only', 'explicit-page-only'] : []),
    ],
  }))
}

const bounded = (value: unknown, maximum = 512): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\0\r\n]/u.test(value)
    ? value
    : undefined

export async function feishuMessageOperation(
  request: ChannelMessageOperationRequestV1,
  event: ChannelEventRef,
  channel: FeishuSdkChannel | undefined,
  guard: { readonly authorize: () => void; readonly ownsPlainCard: (messageId: string) => boolean },
): Promise<ChannelMessageOperationResultV1> {
  const client = channel?.rawClient
  const operation = request.operation
  const operationId = 'operationId' in request ? request.operationId : undefined
  const failure = (
    status: 'unavailable' | 'rejected' | 'failed' | 'unknown',
    code: string,
  ): ChannelMessageOperationResultV1 => ({ status, code, ...(operationId ? { operationId } : {}) })
  if (
    !client || !feishuMessageOperationCapabilities(channel).some(item =>
      item.operation === operation
      && item.implementation === 'supported'
    )
  ) return failure('unavailable', 'CHANNEL_OPERATION_UNAVAILABLE')
  if (
    event.adapterId !== request.account.adapterId || event.accountId !== request.account.accountId
    || event.tenantId !== request.account.tenantId || event.conversationId !== request.conversationId
    || event.kind !== request.kind
  ) return failure('rejected', 'CHANNEL_SOURCE_SCOPE_MISMATCH')
  let submitted = false
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const effect = async (): Promise<ChannelMessageOperationResultV1> => {
    guard.authorize()
    if ('messageId' in request) {
      const response = await client.im.v1.message.get({
        path: { message_id: request.messageId },
        params: { user_id_type: 'open_id' },
      })
      if (response.code !== 0) return failure('unavailable', 'CHANNEL_MESSAGE_READ_FAILED')
      const item = response.data?.items?.find(row => row.message_id === request.messageId)
      if (!item || item.chat_id !== request.conversationId || item.deleted) {
        return failure('rejected', 'CHANNEL_MESSAGE_NOT_ACCESSIBLE')
      }
      if (['message-edit', 'message-recall', 'card-update', 'read-users'].includes(operation)) {
        const sender = item.sender
        const owned = sender?.sender_type === 'app' && ((sender.id_type === 'app_id' && sender.id === event.accountId)
          || (sender.id_type === 'open_id' && sender.id === channel?.botIdentity?.openId))
        if (!owned) return failure('rejected', 'CHANNEL_MESSAGE_NOT_OWNED')
      }
      if (
        operation === 'message-edit' && (!['text', 'post'].includes(item.msg_type ?? '')
          || (request.content.type === 'text' ? 'text' : 'post') !== item.msg_type)
      ) {
        return failure('rejected', 'CHANNEL_EDIT_TYPE_MISMATCH')
      }
      if (
        operation === 'card-update' && (!guard.ownsPlainCard(request.messageId)
          || item.msg_type !== 'interactive' || !safeCardBody(item.body?.content))
      ) {
        return failure('rejected', 'CHANNEL_CONTROL_CARD_DENIED')
      }
    }
    const page = 'pageSize' in request
      ? { page_size: request.pageSize ?? 20, ...(request.pageToken ? { page_token: request.pageToken } : {}) }
      : { page_size: 20 }
    if (expired) return failure('unavailable', 'CHANNEL_OPERATION_TIMEOUT')
    guard.authorize()
    submitted = MESSAGE_OPERATION_WRITES.includes(operation as typeof MESSAGE_OPERATION_WRITES[number])
    const response = await (async () => {
      if (request.operation === 'message-edit') {
        const rendered = renderFeishuTypedContent(request.content)
        if (rendered.msg_type === 'interactive') throw new Error('INVALID_CONTENT')
        const content = JSON.stringify(rendered.content)
        if (Buffer.byteLength(content) > (rendered.msg_type === 'post' ? 30000 : 150000)) {
          submitted = false
          throw new Error('INVALID_CONTENT')
        }
        return client.im.v1.message.update({
          path: { message_id: request.messageId },
          data: { msg_type: rendered.msg_type, content },
        })
      }
      if (request.operation === 'message-recall') {
        return client.im.v1.message.delete({ path: { message_id: request.messageId } })
      }
      if (request.operation === 'pin-add') return client.im.v1.pin.create({ data: { message_id: request.messageId } })
      if (request.operation === 'pin-remove') {
        return client.im.v1.pin.delete({ path: { message_id: request.messageId } })
      }
      if (request.operation === 'card-update') {
        const card = request.card
        const rendered = renderFeishuTypedContent({
          type: 'card',
          title: card.title,
          body: card.template === 'status' ? `${card.status}\n${card.body}` : card.body,
        })
        return client.im.v1.message.patch({
          path: { message_id: request.messageId },
          data: { content: JSON.stringify(rendered.content) },
        })
      }
      if (request.operation === 'pin-list') {
        return client.im.v1.pin.list({
          params: {
            chat_id: request.conversationId,
            ...page,
            ...(request.startTime ? { start_time: request.startTime } : {}),
            ...(request.endTime ? { end_time: request.endTime } : {}),
          },
        })
      }
      if (request.operation === 'read-users') {
        return client.im.v1.message.readUsers({
          path: { message_id: request.messageId },
          params: { ...page, user_id_type: 'open_id' },
        })
      }
      if (request.operation !== 'reaction-list') throw new Error('INVALID_OPERATION')
      return client.im.v1.messageReaction.list({
        path: { message_id: request.messageId },
        params: {
          ...page,
          user_id_type: 'open_id',
          ...(request.emojiType ? { reaction_type: request.emojiType } : {}),
        },
      })
    })()
    if (typeof response.code !== 'number') {
      return failure(submitted ? 'unknown' : 'unavailable', 'CHANNEL_OPERATION_RECEIPT_MISSING')
    }
    if (response.code !== 0) return failure('failed', `CHANNEL_PLATFORM_${response.code}`)
    if (submitted) {
      return {
        status: 'ok',
        operation,
        ...(operationId ? { operationId } : {}),
        ...('messageId' in request ? { messageId: request.messageId } : {}),
      }
    }
    const data = response.data as
      | { items?: Record<string, unknown>[]; has_more?: boolean; page_token?: string }
      | undefined
    if (
      !data || !Array.isArray(data.items) || data.items.length > page.page_size || typeof data.has_more !== 'boolean'
      || (data.has_more && !bounded(data.page_token, 4096))
    ) return failure('unavailable', 'CHANNEL_OPERATION_PAGE_INVALID')
    const items: ChannelMessageOperationItemV1[] = []
    for (const item of data.items) {
      if (operation === 'pin-list') {
        if (item.chat_id !== request.conversationId || !bounded(item.message_id)) {
          return failure('unavailable', 'CHANNEL_OPERATION_PAGE_INVALID')
        }
        items.push({
          type: 'pin',
          messageId: String(item.message_id),
          ...(bounded(item.create_time) ? { createdAt: String(item.create_time) } : {}),
        })
      } else if (operation === 'read-users') {
        if (!bounded(item.user_id)) return failure('unavailable', 'CHANNEL_OPERATION_PAGE_INVALID')
        items.push({
          type: 'reader',
          userId: String(item.user_id),
          ...(bounded(item.timestamp) ? { readAt: String(item.timestamp) } : {}),
        })
      } else {
        const reaction = item.reaction_type as { emoji_type?: unknown } | undefined
        const actor = item.operator as { operator_id?: unknown; operator_type?: unknown } | undefined
        if (!bounded(item.reaction_id) || !bounded(reaction?.emoji_type, 64)) {
          return failure('unavailable', 'CHANNEL_OPERATION_PAGE_INVALID')
        }
        items.push({
          type: 'reaction',
          reactionId: String(item.reaction_id),
          emojiType: String(reaction?.emoji_type),
          ...(bounded(actor?.operator_id) ? { operatorId: String(actor?.operator_id) } : {}),
          ...(actor?.operator_type === 'app' || actor?.operator_type === 'user'
            ? { operatorType: actor.operator_type }
            : {}),
          ...(bounded(item.action_time) ? { createdAt: String(item.action_time) } : {}),
        })
      }
    }
    return {
      status: 'ok',
      operation,
      items,
      hasMore: data.has_more,
      ...(data.has_more ? { pageToken: data.page_token } : {}),
    }
  }
  try {
    return await Promise.race([
      effect(),
      new Promise<ChannelMessageOperationResultV1>(resolve => {
        timer = setTimeout(() => {
          expired = true
          resolve(failure(submitted ? 'unknown' : 'unavailable', 'CHANNEL_OPERATION_TIMEOUT'))
        }, 5000)
      }),
    ])
  } catch {
    return failure(submitted ? 'unknown' : 'unavailable', 'CHANNEL_OPERATION_UNCERTAIN')
  } finally {
    if (timer) clearTimeout(timer)
  }
}
