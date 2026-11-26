import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { ChannelMessageOperationRequestV1 } from '@cordisx/protocol/channel-message-operations/v1'
import { createHash } from 'node:crypto'
import type { ChannelMessageOperationLedger } from './channel-message-operation-ledger.js'
import {
  MESSAGE_OPERATION_WRITES,
  MESSAGE_OPERATIONS,
  parseMessageOperation,
} from './channel-message-operation-request.js'
import { feishuMessageOperation, feishuMessageOperationCapabilities } from './feishu-message-operations.js'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { CHANNEL_MESSAGE_CAPABILITY_INVENTORY } from './channel-message-capability-inventory.js'

export const CHANNEL_MESSAGE_OPERATION_COMMANDS = [
  'card-action-publish',
  'card-action-read',
  'card-action-receipt',
  ...MESSAGE_OPERATIONS,
  'message-capabilities',
  'message-operation-receipt',
] as const

export async function channelMessageOperationsRpc(operation: string, input: Record<string, unknown>, context: {
  readonly source?: ChannelEventRef | undefined
  readonly callerScope: string
  readonly ledger: ChannelMessageOperationLedger
  readonly channel: (event: ChannelEventRef) => FeishuSdkChannel | undefined
  readonly authorize: (event: ChannelEventRef, write: boolean) => void
  readonly active: () => boolean
  readonly ownsPlainCard: (event: ChannelEventRef, messageId: string) => boolean
}): Promise<unknown> {
  const discovery = operation === 'message-capabilities'
  const receipt = operation === 'message-operation-receipt'
  if (discovery || receipt) {
    const allowed = ['account', 'conversationId', 'kind', ...(receipt ? ['operationId'] : [])]
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
    if (
      receipt && (typeof input.operationId !== 'string' || !input.operationId.trim()
        || input.operationId.length > 128 || /[\0\r\n]/u.test(input.operationId))
    ) throw new Error('INVALID_REQUEST')
  }
  const request = discovery || receipt
    ? parseMessageOperation('pin-list', { account: input.account, conversationId: input.conversationId, kind: 'group' })
    : parseMessageOperation(operation, input)
  if (discovery || receipt) {
    if (!['direct', 'group'].includes(String(input.kind))) throw new Error('INVALID_TARGET')
  }
  const kind = (discovery || receipt ? input.kind : request.kind) as 'direct' | 'group'
  const source = context.source
  if (
    source && (source.adapterId !== request.account.adapterId || source.accountId !== request.account.accountId
      || source.tenantId !== request.account.tenantId || source.conversationId !== request.conversationId
      || source.kind !== kind)
  ) throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
  const event: ChannelEventRef = source
    ?? {
      ...request.account,
      conversationId: request.conversationId,
      kind,
      threadId: request.conversationId,
      semantics: 'conversation',
      eventId: 'message-operation',
    }
  const write = MESSAGE_OPERATION_WRITES.includes(operation as typeof MESSAGE_OPERATION_WRITES[number])
  context.authorize(event, write)
  if (!context.active()) throw new Error('CHANNEL_GENERATION_CHANGED')
  const scope = [context.callerScope, request.account, request.conversationId, kind]
  if (receipt) {
    return { status: 'ok', receipt: await context.ledger.receipt(context.ledger.key(scope, String(input.operationId))) }
  }
  const channel = context.channel(event)
  if (discovery) {
    return {
      status: 'ok',
      capabilities: feishuMessageOperationCapabilities(channel),
      inventory: CHANNEL_MESSAGE_CAPABILITY_INVENTORY,
    }
  }
  if (
    operation === 'reaction-list' && source && request.operation === 'reaction-list'
    && request.messageId !== source.messageId
  ) throw new Error('CHANNEL_SOURCE_MESSAGE_REQUIRED')
  const effect = async () => {
    context.authorize(event, write)
    if (!context.active() || context.channel(event) !== channel) throw new Error('CHANNEL_GENERATION_CHANGED')
    const result = await feishuMessageOperation(request, event, channel, {
      authorize: () => {
        context.authorize(event, write)
        if (!context.active() || context.channel(event) !== channel) throw new Error('CHANNEL_GENERATION_CHANGED')
      },
      ownsPlainCard: messageId => context.ownsPlainCard(event, messageId),
    })
    if (!context.active() || context.channel(event) !== channel) {
      return {
        status: 'unknown' as const,
        code: 'CHANNEL_GENERATION_CHANGED',
        ...('operationId' in request ? { operationId: request.operationId } : {}),
      }
    }
    return result
  }
  if (!write) return effect()
  const mutation = request as Extract<ChannelMessageOperationRequestV1, { operationId: string }>
  const descriptor = canonical(mutation)
  return context.ledger.execute(
    context.ledger.key(scope, mutation.operationId),
    descriptor,
    mutation.operationId,
    effect,
  )
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map((
        [key, item],
      ) => [key, canonical(item)]),
    )
  }
  return value
}

export function messageOperationCallerScope(session: string | undefined, source: ChannelEventRef | undefined): string {
  return createHash('sha256').update(JSON.stringify([
    session ?? 'local-cli',
    source
      ? {
        adapterId: source.adapterId,
        accountId: source.accountId,
        tenantId: source.tenantId,
        conversationId: source.conversationId,
        kind: source.kind,
        actor: source.actor ?? null,
      }
      : null,
  ])).digest('hex')
}
