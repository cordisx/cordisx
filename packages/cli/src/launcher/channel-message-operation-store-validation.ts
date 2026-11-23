import { MESSAGE_OPERATION_WRITES } from './channel-message-operation-request.js'

export function validateStoredMessageOperation(value: unknown): void {
  const invalid = () => {
    throw new Error('CHANNEL_OPERATION_STORE_INVALID')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const result = value as Record<string, unknown>
  const text = (item: unknown, maximum: number): item is string =>
    typeof item === 'string'
    && item.length > 0 && item.length <= maximum && !/[\0\r\n]/u.test(item)
  if (!text(result.operationId, 128)) return invalid()
  if (result.status === 'ok') {
    if (
      Object.keys(result).some(key => !['status', 'operation', 'operationId', 'messageId'].includes(key))
      || !MESSAGE_OPERATION_WRITES.includes(result.operation as typeof MESSAGE_OPERATION_WRITES[number])
      || !text(result.messageId, 512) || !/^om_[A-Za-z0-9_]+$/u.test(result.messageId)
    ) return invalid()
  } else {
    if (
      !['failed', 'unknown', 'rejected', 'unavailable'].includes(String(result.status))
      || Object.keys(result).some(key => !['status', 'code', 'operationId'].includes(key))
      || !text(result.code, 128) || !/^[A-Z][A-Z0-9_]*$/u.test(result.code)
    ) return invalid()
  }
}
