import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelThreadForwardRequestV1 } from '@cordisx/protocol/channel-thread-forward/v1'
import type { ChannelConversationAccess } from './channel-conversation-access.js'
import { forwardConversation, forwardIdentifier, forwardRecord } from './channel-forward-rpc.js'

export async function channelThreadForwardRpc(input: {
  operation: string
  value: Record<string, unknown>
  access: ChannelConversationAccess
  source?: ChannelEventRef | undefined
  scope: string
  active(): boolean
  authorize(event: ChannelEventRef, operation: 'read' | 'thread-forward'): void
}) {
  const value = input.value
  if (!['thread-forward', 'thread-forward-receipt'].includes(input.operation)) throw new Error('INVALID_REQUEST')
  if (
    Object.keys(value).some(key =>
      !['account', 'source', 'target', 'operationId', 'threadId', 'anchorMessageId'].includes(key)
    )
  ) throw new Error('INVALID_REQUEST')
  const raw = forwardRecord(value.account)
  if (Object.keys(raw).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
    throw new Error('INVALID_REQUEST')
  }
  const account = {
    adapterId: forwardIdentifier(raw.adapterId, /^[A-Za-z0-9_.:-]{1,128}$/u),
    accountId: forwardIdentifier(raw.accountId, /^[A-Za-z0-9_.:-]{1,128}$/u),
    tenantId: forwardIdentifier(raw.tenantId, /^[A-Za-z0-9_.:-]{1,128}$/u),
  }
  const source = forwardConversation(value.source, account), target = forwardConversation(value.target, account)
  if (
    input.source
    && !['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'].every(key =>
      input.source![key as keyof ChannelEventRef] === source[key as keyof typeof source]
    )
  ) {
    throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
  }
  const operationId = forwardIdentifier(value.operationId, /^[A-Za-z0-9_.:-]{1,128}$/u)
  const threadId = forwardIdentifier(value.threadId, /^om[t]?_[A-Za-z0-9_]{1,200}$/u)
  const anchorMessageId = forwardIdentifier(value.anchorMessageId, /^om_[A-Za-z0-9_]{1,200}$/u)
  const event = (ref: typeof source): ChannelEventRef => ({
    ...ref,
    threadId: ref.conversationId,
    semantics: 'conversation',
    eventId: operationId,
    ...(input.source?.actor ? { actor: input.source.actor } : {}),
  })
  const authorize = () => {
    if (!input.active()) throw new Error('THREAD_FORWARD_REVOKED')
    if (
      !input.access.accounts().some(item =>
        item.state === 'ready'
        && Object.keys(account).every(key =>
          item.ref[key as keyof ChannelTenantRef] === account[key as keyof ChannelTenantRef]
        )
      )
    ) {
      throw new Error('CONNECTION_NOT_READY')
    }
    input.authorize(event(source), 'read')
    input.authorize(event(target), 'thread-forward')
  }
  authorize()
  if (!input.access.threadForward) return { status: 'unavailable', code: 'THREAD_FORWARD_UNAVAILABLE' }
  const request: ChannelThreadForwardRequestV1 = {
    contract: 'cordisx.channel-thread-forward/v1',
    schemaVersion: 1,
    operation: 'thread-forward',
    operationId,
    source,
    target,
    threadId,
    anchorMessageId,
  }
  const receipt = await input.access.threadForward(
    request,
    input.scope,
    input.operation === 'thread-forward-receipt',
    authorize,
  )
  authorize()
  return { status: 'ok', receipt }
}
