import type { ChannelMessageOperationRequestV1 } from '@cordisx/protocol/channel-message-operations/v1'

export const MESSAGE_OPERATION_READS = ['pin-list', 'read-users', 'reaction-list'] as const
export const MESSAGE_OPERATION_WRITES = [
  'message-edit',
  'message-recall',
  'pin-add',
  'pin-remove',
  'card-update',
] as const
export const MESSAGE_OPERATIONS = [...MESSAGE_OPERATION_READS, ...MESSAGE_OPERATION_WRITES] as const

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const string = (value: unknown, maximum: number, multiline = false): string => {
  if (
    typeof value !== 'string' || !value.trim() || [...value].length > maximum
    || (multiline ? /\0/u : /[\0\r\n]/u).test(value)
  ) throw new Error('INVALID_REQUEST')
  return value
}
const keys = (value: Record<string, unknown>, allowed: readonly string[]): void => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
}

export function parseMessageOperation(operation: string, value: unknown): ChannelMessageOperationRequestV1 {
  if (!MESSAGE_OPERATIONS.includes(operation as typeof MESSAGE_OPERATIONS[number])) throw new Error('INVALID_OPERATION')
  const input = record(value)
  const write = MESSAGE_OPERATION_WRITES.includes(operation as typeof MESSAGE_OPERATION_WRITES[number])
  const extra = operation === 'message-edit' ? ['content'] : operation === 'card-update'
    ? ['card']
    : operation === 'pin-list'
    ? ['startTime', 'endTime']
    : operation === 'reaction-list'
    ? ['emojiType']
    : []
  keys(input, [
    'account',
    'conversationId',
    'kind',
    ...(write ? ['operationId'] : ['pageSize', 'pageToken']),
    ...(operation === 'pin-list' ? [] : ['messageId']),
    ...extra,
  ])
  const account = record(input.account)
  keys(account, ['adapterId', 'accountId', 'tenantId'])
  for (const key of ['adapterId', 'accountId', 'tenantId']) string(account[key], 512)
  const conversationId = string(input.conversationId, 512)
  if (!/^oc_[A-Za-z0-9_]+$/u.test(conversationId) || !['direct', 'group'].includes(String(input.kind))) {
    throw new Error('INVALID_TARGET')
  }
  if (operation !== 'pin-list' && !/^om_[A-Za-z0-9_]+$/u.test(string(input.messageId, 512))) {
    throw new Error('INVALID_TARGET')
  }
  if (operation === 'pin-list' && input.kind !== 'group') throw new Error('INVALID_TARGET')
  if (write) string(input.operationId, 128)
  if (
    input.pageSize !== undefined && (!Number.isSafeInteger(input.pageSize)
      || Number(input.pageSize) < 1 || Number(input.pageSize) > 50)
  ) throw new Error('INVALID_PAGE_SIZE')
  if (input.pageToken !== undefined) string(input.pageToken, 4096)
  for (const key of ['startTime', 'endTime']) {
    if (input[key] !== undefined && !/^[0-9]{1,16}$/u.test(string(input[key], 16))) throw new Error('INVALID_TIME')
  }
  if (
    input.startTime !== undefined && input.endTime !== undefined
    && BigInt(String(input.startTime)) >= BigInt(String(input.endTime))
  ) throw new Error('INVALID_TIME')
  if (input.emojiType !== undefined && !/^[A-Za-z0-9_]{1,64}$/u.test(string(input.emojiType, 64))) {
    throw new Error('INVALID_EMOJI')
  }
  if (operation === 'message-edit') {
    const content = record(input.content)
    if (content.type === 'text') {
      keys(content, ['type', 'text'])
      string(content.text, 16384, true)
    } else if (content.type === 'richtext') {
      keys(content, ['type', 'blocks'])
      if (!Array.isArray(content.blocks) || !content.blocks.length || content.blocks.length > 128) {
        throw new Error('INVALID_CONTENT')
      }
      for (const block of content.blocks) {
        const item = record(block)
        keys(item, ['text', 'style'])
        string(item.text, 4096, true)
        if (!['plain', 'strong', 'emphasis', 'code'].includes(String(item.style))) throw new Error('INVALID_CONTENT')
      }
    } else throw new Error('INVALID_CONTENT')
    const texts = content.type === 'text'
      ? [content.text]
      : (content.blocks as { text: string }[]).map(block => block.text)
    if (texts.some(value => /<\/?at\b|@_user_|@all\b/iu.test(String(value)))) {
      throw new Error('CHANNEL_EDIT_MENTION_UNSUPPORTED')
    }
  }
  if (operation === 'card-update') {
    const card = record(input.card)
    keys(card, ['template', 'title', 'body', 'status'])
    if (!['notice', 'status'].includes(String(card.template))) throw new Error('INVALID_CARD')
    string(card.title, 256, true)
    string(card.body, 16384, true)
    if (card.template === 'notice' && card.status !== undefined) throw new Error('INVALID_CARD')
    if (card.template === 'status' && !['pending', 'running', 'completed', 'failed'].includes(String(card.status))) {
      throw new Error('INVALID_CARD')
    }
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error('INVALID_REQUEST')
  return structuredClone({ ...input, operation }) as ChannelMessageOperationRequestV1
}
