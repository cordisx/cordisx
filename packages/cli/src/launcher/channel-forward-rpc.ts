import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
function identifier(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error('INVALID_REQUEST')
  return value
}
function conversation(value: unknown, account: ChannelTenantRef) {
  const input = record(value)
  if (
    Object.keys(input).some(key => !['id', 'kind'].includes(key)) || !['direct', 'group'].includes(String(input.kind))
  ) {
    throw new Error('FORWARD_TARGET_UNSUPPORTED')
  }
  return {
    ...account,
    conversationId: identifier(input.id, /^oc_[A-Za-z0-9_]{1,200}$/u),
    kind: input.kind as 'direct' | 'group',
  }
}

export async function channelForwardRpc(input: {
  operation: string
  value: Record<string, unknown>
  access: ChannelConversationAccess & {
    forward?: (
      request: ChannelForwardRequestV1,
      scope: string,
      readOnly: boolean,
      authorize: () => void,
    ) => Promise<unknown>
  }
  source?: ChannelEventRef
  scope: string
  authorize(event: ChannelEventRef, operation: 'read' | 'forward' | 'merge-forward'): void
}) {
  const value = input.value
  if (
    Object.keys(value).some(key =>
      !['account', 'source', 'target', 'messageIds', 'operationId', 'operation'].includes(key)
    )
  ) {
    throw new Error('INVALID_REQUEST')
  }
  const raw = record(value.account)
  if (Object.keys(raw).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
    throw new Error('INVALID_REQUEST')
  }
  const account = {
    adapterId: identifier(raw.adapterId, /^[A-Za-z0-9_.:-]{1,128}$/u),
    accountId: identifier(raw.accountId, /^[A-Za-z0-9_.:-]{1,128}$/u),
    tenantId: identifier(raw.tenantId, /^[A-Za-z0-9_.:-]{1,128}$/u),
  }
  if (
    !input.access.accounts().some(item =>
      item.state === 'ready'
      && Object.keys(account).every(key =>
        item.ref[key as keyof ChannelTenantRef] === account[key as keyof ChannelTenantRef]
      )
    )
  ) throw new Error('CONNECTION_NOT_READY')
  const operation = input.operation === 'forward-receipt' ? value.operation : input.operation
  if (!['forward', 'merge-forward'].includes(String(operation))) throw new Error('INVALID_REQUEST')
  if (input.operation !== 'forward-receipt' && value.operation !== undefined) throw new Error('INVALID_REQUEST')
  const source = conversation(value.source, account), target = conversation(value.target, account)
  const operationId = identifier(value.operationId, /^[A-Za-z0-9_.:-]{1,128}$/u)
  const messageIds = value.messageIds
  if (
    !Array.isArray(messageIds) || messageIds.length < (operation === 'forward' ? 1 : 2)
    || messageIds.length > (operation === 'forward' ? 1 : 100) || new Set(messageIds).size !== messageIds.length
  ) {
    throw new Error('INVALID_REQUEST')
  }
  const ids = messageIds.map(messageId => identifier(messageId, /^om_[A-Za-z0-9_]{1,200}$/u))
  if (
    input.source
    && !['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'].every(key =>
      input.source![key as keyof ChannelEventRef] === source[key as keyof typeof source]
    )
  ) throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
  const event = (ref: typeof source): ChannelEventRef => ({
    ...ref,
    threadId: ref.conversationId,
    semantics: 'conversation',
    eventId: operationId,
    ...(input.source?.actor ? { actor: input.source.actor } : {}),
  })
  input.authorize(event(source), 'read')
  input.authorize(event(target), operation as 'forward' | 'merge-forward')
  if (!input.access.forward) return { status: 'unavailable', code: 'FORWARD_UNAVAILABLE' }
  const request: ChannelForwardRequestV1 = {
    contract: 'cordisx.channel-forward/v1',
    schemaVersion: 1,
    operation: operation as 'forward' | 'merge-forward',
    operationId,
    source,
    target,
    messageIds: ids,
  }
  return {
    status: 'ok',
    receipt: await input.access.forward(request, input.scope, input.operation === 'forward-receipt', () => {
      input.authorize(event(source), 'read')
      input.authorize(event(target), operation as 'forward' | 'merge-forward')
    }),
  }
}
