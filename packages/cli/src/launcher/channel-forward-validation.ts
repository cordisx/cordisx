import type { ChannelForwardReceiptV1, ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FORWARD_STORE_INVALID')
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('FORWARD_STORE_INVALID')
  }
}
function id(value: unknown, pattern = /^[A-Za-z0-9_.:-]{1,128}$/u) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('FORWARD_STORE_INVALID')
}
export function validateForwardEntry(value: unknown): {
  request: ChannelForwardRequestV1
  receipt: ChannelForwardReceiptV1
} {
  const entry = object(value)
  exact(entry, ['request', 'receipt'])
  const request = object(entry.request)
  exact(request, ['contract', 'schemaVersion', 'operation', 'operationId', 'source', 'target', 'messageIds'])
  if (
    request.contract !== 'cordisx.channel-forward/v1' || request.schemaVersion !== 1
    || !['forward', 'merge-forward'].includes(String(request.operation))
  ) throw new Error('FORWARD_STORE_INVALID')
  id(request.operationId)
  const source = object(request.source), target = object(request.target)
  for (const ref of [source, target]) {
    exact(ref, ['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'])
    for (const key of ['adapterId', 'accountId', 'tenantId']) id(ref[key])
    id(ref.conversationId, /^oc_[A-Za-z0-9_]{1,200}$/u)
    if (!['direct', 'group'].includes(String(ref.kind))) throw new Error('FORWARD_STORE_INVALID')
  }
  if (!['adapterId', 'accountId', 'tenantId'].every(key => source[key] === target[key])) {
    throw new Error('FORWARD_STORE_INVALID')
  }
  const ids = request.messageIds
  if (
    !Array.isArray(ids) || ids.length < (request.operation === 'forward' ? 1 : 2)
    || ids.length > (request.operation === 'forward' ? 1 : 100) || new Set(ids).size !== ids.length
  ) throw new Error('FORWARD_STORE_INVALID')
  ids.forEach(value => id(value, /^om_[A-Za-z0-9_]{1,200}$/u))
  const receipt = object(entry.receipt)
  const base = ['contract', 'schemaVersion', 'operation', 'operationId', 'state']
  if (
    receipt.contract !== 'cordisx.channel-forward-receipt/v1' || receipt.schemaVersion !== 1
    || receipt.operation !== request.operation || receipt.operationId !== request.operationId
  ) throw new Error('FORWARD_STORE_INVALID')
  if (receipt.state === 'sending') exact(receipt, base)
  else if (receipt.state === 'sent' || receipt.state === 'partial') {
    exact(receipt, [...base, 'externalMessageId', 'invalidMessageIds'])
    id(receipt.externalMessageId, /^om_[A-Za-z0-9_]{1,200}$/u)
    const invalid = receipt.invalidMessageIds
    if (
      !Array.isArray(invalid) || new Set(invalid).size !== invalid.length || invalid.some(value => !ids.includes(value))
      || (receipt.state === 'sent' ? invalid.length !== 0 : invalid.length === 0)
    ) throw new Error('FORWARD_STORE_INVALID')
  } else if (receipt.state === 'failed' || receipt.state === 'unknown') {
    exact(receipt, [...base, 'code'])
    id(receipt.code, /^[A-Z0-9_]{1,128}$/u)
  } else throw new Error('FORWARD_STORE_INVALID')
  return entry as unknown as { request: ChannelForwardRequestV1; receipt: ChannelForwardReceiptV1 }
}
