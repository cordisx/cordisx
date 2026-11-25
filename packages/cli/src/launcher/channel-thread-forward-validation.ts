import type {
  ChannelThreadForwardReceiptV1,
  ChannelThreadForwardRequestV1,
} from '@cordisx/protocol/channel-thread-forward/v1'
import type { ChannelForwardLedgerCodec } from './channel-forward-store.js'

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('FORWARD_STORE_INVALID')
  return value as Record<string, unknown>
}
const exact = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('FORWARD_STORE_INVALID')
  }
}
const id = (value: unknown, pattern = /^[A-Za-z0-9_.:-]{1,128}$/u) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('FORWARD_STORE_INVALID')
}
export const threadForwardCodec: ChannelForwardLedgerCodec<
  ChannelThreadForwardRequestV1,
  ChannelThreadForwardReceiptV1
> = {
  pending: request => ({
    contract: 'cordisx.channel-thread-forward-receipt/v1',
    schemaVersion: 1,
    operationId: request.operationId,
    operation: 'thread-forward',
    state: 'sending',
  }),
  unknown: (request, code) => ({
    contract: 'cordisx.channel-thread-forward-receipt/v1',
    schemaVersion: 1,
    operationId: request.operationId,
    operation: 'thread-forward',
    state: 'unknown',
    code,
  }),
  validate: value => {
    const entry = object(value)
    exact(entry, ['request', 'receipt'])
    const request = object(entry.request), receipt = object(entry.receipt)
    exact(request, [
      'contract',
      'schemaVersion',
      'operation',
      'operationId',
      'source',
      'target',
      'threadId',
      'anchorMessageId',
    ])
    if (
      request.contract !== 'cordisx.channel-thread-forward/v1' || request.schemaVersion !== 1
      || request.operation !== 'thread-forward'
    ) throw new Error('FORWARD_STORE_INVALID')
    id(request.operationId)
    id(request.threadId, /^om[t]?_[A-Za-z0-9_]{1,200}$/u)
    id(request.anchorMessageId, /^om_[A-Za-z0-9_]{1,200}$/u)
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
    if (
      receipt.contract !== 'cordisx.channel-thread-forward-receipt/v1' || receipt.schemaVersion !== 1
      || receipt.operation !== 'thread-forward' || receipt.operationId !== request.operationId
    ) {
      throw new Error('FORWARD_STORE_INVALID')
    }
    const base = ['contract', 'schemaVersion', 'operation', 'operationId', 'state']
    if (receipt.state === 'sending') exact(receipt, base)
    else if (receipt.state === 'sent') {
      exact(receipt, [...base, 'externalMessageId'])
      id(receipt.externalMessageId, /^om_[A-Za-z0-9_]{1,200}$/u)
    } else if (receipt.state === 'failed' || receipt.state === 'unknown') {
      exact(receipt, [...base, 'code'])
      id(receipt.code, /^[A-Z0-9_]{1,128}$/u)
    } else throw new Error('FORWARD_STORE_INVALID')
    return entry as unknown as { request: ChannelThreadForwardRequestV1; receipt: ChannelThreadForwardReceiptV1 }
  },
}
