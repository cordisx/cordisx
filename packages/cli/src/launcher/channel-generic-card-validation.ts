import type { ChannelCardActionRequestV1, ChannelCardActionResultV1 } from '@cordisx/protocol/channel-card-actions/v1'

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
}
const text = (value: unknown, maximum: number, multiline = false): string => {
  if (
    typeof value !== 'string' || !value.trim() || [...value].length > maximum
    || (multiline ? /\0/u : /[\0\r\n]/u).test(value)
  ) throw new Error('INVALID_REQUEST')
  return value
}
const integer = (value: unknown, minimum: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error('INVALID_REQUEST')
  }
}

export function parseGenericCardAction(operation: string, value: unknown): ChannelCardActionRequestV1 {
  const input = object(value)
  const base = ['account', 'conversationId', 'kind']
  const extra = operation === 'card-action-publish'
    ? [
      'operationId',
      'messageId',
      'expectedVersion',
      'template',
      'title',
      'body',
      'actions',
      'operatorIds',
      'expiresInSeconds',
    ]
    : operation === 'card-action-read'
    ? ['messageId', 'version', 'pageSize', 'pageToken']
    : operation === 'card-action-receipt'
    ? ['operationId']
    : undefined
  if (!extra) throw new Error('INVALID_OPERATION')
  keys(input, [...base, ...extra])
  const account = object(input.account)
  keys(account, ['adapterId', 'accountId', 'tenantId'])
  for (const key of ['adapterId', 'accountId', 'tenantId']) text(account[key], 128)
  if (
    !/^oc_[A-Za-z0-9_]+$/u.test(text(input.conversationId, 256)) || !['direct', 'group'].includes(String(input.kind))
  ) throw new Error('INVALID_TARGET')
  if (operation !== 'card-action-receipt' && !/^om_[A-Za-z0-9_]+$/u.test(text(input.messageId, 256))) {
    throw new Error('INVALID_TARGET')
  }
  if (operation !== 'card-action-read') text(input.operationId, 128)
  if (operation === 'card-action-publish') {
    integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1)
    integer(input.expiresInSeconds, 1, 3600)
    if (input.template !== 'action-notice') throw new Error('INVALID_TEMPLATE')
    text(input.title, 200)
    text(input.body, 4000, true)
    if (!Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 5) {
      throw new Error('INVALID_ACTIONS')
    }
    const ids = new Set<string>()
    for (const value of input.actions) {
      const action = object(value)
      keys(action, ['id', 'label'])
      const id = text(action.id, 64)
      if (!/^[A-Za-z0-9_-]+$/u.test(id) || ids.has(id)) throw new Error('INVALID_ACTIONS')
      ids.add(id)
      text(action.label, 80)
    }
    if (input.operatorIds !== undefined) {
      if (!Array.isArray(input.operatorIds) || !input.operatorIds.length || input.operatorIds.length > 50) {
        throw new Error('INVALID_OPERATORS')
      }
      for (const id of input.operatorIds) {
        if (!/^ou_[A-Za-z0-9_]+$/u.test(text(id, 128))) throw new Error('INVALID_OPERATORS')
      }
      if (new Set(input.operatorIds).size !== input.operatorIds.length) throw new Error('INVALID_OPERATORS')
    }
  } else if (operation === 'card-action-read') {
    integer(input.version, 1, Number.MAX_SAFE_INTEGER)
    if (input.pageSize !== undefined) integer(input.pageSize, 1, 50)
    if (input.pageToken !== undefined) text(input.pageToken, 256)
  }
  return structuredClone({ ...input, operation }) as unknown as ChannelCardActionRequestV1
}

export function validateGenericCardReceipt(value: unknown): asserts value is ChannelCardActionResultV1 {
  const result = object(value)
  if (result.status === 'ok') {
    keys(result, ['status', 'operation', 'messageId', 'version', 'expiresAt', 'operationId'])
    if (result.operation !== 'card-action-publish') throw new Error('CHANNEL_OPERATION_STORE_INVALID')
    text(result.messageId, 256)
    text(result.operationId, 128)
    integer(result.version, 1, Number.MAX_SAFE_INTEGER)
    if (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))) {
      throw new Error('CHANNEL_OPERATION_STORE_INVALID')
    }
  } else {
    keys(result, ['status', 'code', 'operationId'])
    if (
      !['unknown', 'unavailable', 'rejected', 'failed'].includes(String(result.status))
      || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(text(result.code, 128))
    ) throw new Error('CHANNEL_OPERATION_STORE_INVALID')
    text(result.operationId, 128)
  }
}
