import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { ChannelMessageReadResultV1 } from '@cordisx/protocol/channel-message-read/v1'
import type { ChannelConversationPolicy } from './channel-conversation-policy.js'
import { authorizeChannelResource } from './channel-resource-permissions.js'

export async function channelHistoricalResourcesRpc(input: Record<string, unknown>, ref: ChannelTenantRef, context: {
  current: {
    readMessage?(event: ChannelEventRef, messageId: string): Promise<ChannelMessageReadResultV1>
    historicalResource?(
      event: ChannelEventRef,
      messageId: string,
      index: number,
      prepare: boolean,
      caller: string,
      authorize: () => void,
      range?: { offset: number; length: number },
      signal?: AbortSignal,
    ): Promise<unknown>
    accounts(): readonly { ref: ChannelTenantRef; state: string }[]
  }
  source?: ChannelEventRef | undefined
  consumer?: {
    commandAllowed(event: ChannelEventRef, command: string): boolean
    policy(): { policy: ChannelConversationPolicy }
  } | undefined
  caller: string
  active(): boolean
}, operation: 'resource-refetch' | 'resource-status' | 'resource-read') {
  if (
    Object.keys(input).some(key =>
      ![
        'account',
        'conversationId',
        'kind',
        'messageId',
        'index',
        ...(operation === 'resource-read' ? ['offset', 'length'] : []),
      ].includes(key)
    )
  ) {
    throw new Error('INVALID_REQUEST')
  }
  const { source, current, consumer } = context
  if (!source || !source.messageId || !source.actor || !context.caller) throw new Error('CHANNEL_CONTEXT_UNAVAILABLE')
  let expired = false
  const controller = new AbortController()
  const authorize = () => {
    if (expired) throw new Error('HISTORICAL_RESOURCE_TIMEOUT')
    if (!context.active()) throw new Error('CHANNEL_GENERATION_CHANGED')
    if (
      source.adapterId !== ref.adapterId || source.accountId !== ref.accountId || source.tenantId !== ref.tenantId
      || source.conversationId !== input.conversationId || source.kind !== input.kind
    ) {
      throw new Error('CHANNEL_SOURCE_SCOPE_MISMATCH')
    }
    if (!consumer?.commandAllowed(source, 'history')) {
      throw new Error('CHANNEL_POLICY_DENIED')
    }
    authorizeChannelResource(consumer.policy().policy, source)
    if (
      !current.accounts().some(account =>
        account.state === 'ready'
        && account.ref.adapterId === ref.adapterId && account.ref.accountId === ref.accountId
        && account.ref.tenantId === ref.tenantId
      )
    ) throw new Error('CONNECTION_NOT_READY')
  }
  if (
    typeof input.messageId !== 'string' || !/^om_[A-Za-z0-9_]{1,200}$/u.test(input.messageId)
    || !Number.isInteger(input.index) || Number(input.index) < 0 || Number(input.index) > 15
  ) {
    throw new Error('INVALID_REQUEST')
  }
  authorize()
  const range = operation === 'resource-read'
    ? { offset: Number(input.offset), length: Number(input.length) }
    : undefined
  if (
    range && (typeof input.offset !== 'number' || typeof input.length !== 'number'
      || !Number.isSafeInteger(range.offset) || range.offset < 0
      || !Number.isInteger(range.length) || range.length < 1 || range.length > 65536)
  ) throw new Error('INVALID_REQUEST')
  if (!current.readMessage || !current.historicalResource) {
    return { status: 'unavailable', code: 'HISTORICAL_RESOURCE_UNAVAILABLE' }
  }
  const work = async () => {
    let candidate: string | undefined = source.messageId
    const seen = new Set<string>()
    for (let depth = 0; candidate && depth < 16 && !seen.has(candidate); depth += 1) {
      seen.add(candidate)
      const result = await current.readMessage!(source, candidate)
      authorize()
      if (result.status !== 'ok') return result
      if (candidate === input.messageId) {
        const resource = await current.historicalResource!(
          source,
          candidate,
          Number(input.index),
          operation === 'resource-refetch',
          context.caller,
          authorize,
          range,
          controller.signal,
        )
        authorize()
        return resource
      }
      candidate = result.message.parentId
    }
    return { status: 'rejected', code: 'CHANNEL_MESSAGE_NOT_IN_REPLY_CHAIN' }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true
          controller.abort()
          reject(new Error('HISTORICAL_RESOURCE_TIMEOUT'))
        }, 2500)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
