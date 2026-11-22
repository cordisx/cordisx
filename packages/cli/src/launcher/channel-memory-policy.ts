import { createHash } from 'node:crypto'

export interface MemoryAccount {
  adapterId: string
  accountId: string
  tenantId: string
  userId: string
}
export interface MemoryConversation {
  adapterId: string
  accountId: string
  tenantId: string
  conversationId: string
}
export interface MemoryAuthority {
  actor: MemoryAccount
  conversation: MemoryConversation
  kind: 'direct' | 'group'
  ownDisclosure?: boolean
  ownTopic?: readonly string[]
  administer?: readonly string[]
}
export interface MemoryGrant {
  id: string
  source: string
  target: { kind: 'conversation' | 'account' | 'entity'; id: string }
  createdBy: string
  createdAt: string
  expiresAt?: string
  recordIds?: string[]
  revokedAt?: string
}
export const memoryKey = (value: MemoryAccount | MemoryConversation): string => {
  const parts = 'userId' in value
    ? [value.adapterId, value.accountId, value.tenantId, value.userId]
    : [value.adapterId, value.accountId, value.tenantId, value.conversationId]
  if (parts.some(part => typeof part !== 'string' || !part || part.length > 512 || /[\0\r\n]/u.test(part))) {
    throw new Error('MEMORY_INVALID_IDENTITY')
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}
export function memoryReadable(
  record: {
    id: string
    scopeId: string
    owner: string
    expiresAt?: string
    title?: string
    tags?: string[]
    summary?: string
    keywords?: string
  },
  authority: MemoryAuthority,
  grants: readonly MemoryGrant[],
  bindings: Readonly<Record<string, string>>,
  now: string,
): boolean {
  if (record.expiresAt && record.expiresAt <= now) return false
  const actor = memoryKey(authority.actor), destination = memoryKey(authority.conversation)
  const own = record.owner === actor
    || bindings[actor] !== undefined && bindings[actor] === bindings[record.owner]
  const topic = [record.title, record.summary, record.keywords, ...(record.tags ?? [])].join(' ').toLowerCase()
  if (
    own && (authority.kind === 'direct' || authority.ownDisclosure === true
      || authority.ownTopic?.some(word => topic.includes(word)))
  ) return true
  return grants.some(grant =>
    grant.source === record.scopeId && !grant.revokedAt && (!grant.expiresAt || grant.expiresAt > now)
    && (!grant.recordIds || grant.recordIds.includes(record.id))
    && (grant.target.kind === 'conversation'
      ? grant.target.id === destination
      : authority.kind !== 'direct'
      ? false
      : grant.target.kind === 'account'
      ? grant.target.id === actor
      : bindings[actor] === grant.target.id)
  )
}
