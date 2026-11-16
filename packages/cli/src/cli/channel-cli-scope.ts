import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'

/** One explicit grant; it is never widened by a client request. */
export interface ChannelCliScope {
  readonly adapter: 'feishu' | 'lark'
  readonly account: string
  readonly tenant: string
  readonly conversation: string
  readonly actor: string
  readonly match: string
}

export function matchesChannelCliScope(scope: ChannelCliScope, message: NormalizedMessage, since: number): boolean {
  const raw = message.raw as { sender?: { tenant_key?: unknown; sender_type?: unknown } } | undefined
  return message.chatType === 'p2p'
    && message.chatId === scope.conversation
    && message.senderId === scope.actor
    && raw?.sender?.tenant_key === scope.tenant
    && raw.sender.sender_type === 'user'
    && message.rawContentType === 'text'
    && message.content === scope.match
    && Number.isFinite(message.createTime)
    && message.createTime >= since
}

export function requireCliValue(value: string | undefined, name: string, limit = 512): string {
  if (value === undefined || value.length === 0 || value.length > limit || /[\u0000\r\n]/u.test(value)) {
    throw new Error(`invalid ${name}`)
  }
  return value
}
