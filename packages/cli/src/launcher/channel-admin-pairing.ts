import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ChannelTenantRef } from '@cordisx/channel-runtime'

interface Candidate {
  readonly conversationId: string
  readonly userId: string
}
interface Pairing {
  readonly id: string
  readonly account: ChannelTenantRef
  readonly generation: string
  readonly policyRevision: number
  readonly digest: Buffer
  readonly expiresAt: number
  candidate?: Candidate
}
const sameAccount = (left: ChannelTenantRef, right: ChannelTenantRef) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId
const digest = (code: string) => createHash('sha256').update(code).digest()
const safeId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value)

/** Local-only, process-lifetime pairing; neither code nor event bodies are persisted. */
export class ChannelAdminPairing {
  private readonly pending = new Map<string, Pairing>()
  constructor(private readonly now: () => number = Date.now) {}

  begin(account: ChannelTenantRef, generation: string, policyRevision: number) {
    this.expire()
    if (
      !['feishu', 'lark'].includes(account.adapterId) || !safeId(account.accountId) || !safeId(account.tenantId)
      || !safeId(generation) || !Number.isSafeInteger(policyRevision) || policyRevision < 0
    ) {
      throw new Error('INVALID_REQUEST')
    }
    if (this.pending.size >= 16) throw new Error('PAIRING_LIMIT')
    for (const [id, item] of this.pending) if (sameAccount(item.account, account)) this.pending.delete(id)
    const id = randomBytes(24).toString('base64url'), code = randomBytes(16).toString('base64url')
    const expiresAt = this.now() + 5 * 60_000
    this.pending.set(id, { id, account: { ...account }, generation, policyRevision, digest: digest(code), expiresAt })
    return { pairingId: id, code, expiresAt: new Date(expiresAt).toISOString() }
  }

  /** The adapter supplies platform-authenticated sender metadata; no message or raw event is retained. */
  receive(input: {
    readonly account: ChannelTenantRef
    readonly generation: string
    readonly code: string
    readonly chatType: string
    readonly conversationId: unknown
    readonly senderId: unknown
    readonly senderTenant: unknown
    readonly senderType: unknown
    readonly eventTime: number
  }): boolean {
    this.expire()
    if (
      input.chatType !== 'p2p' || input.senderType !== 'user' || input.senderTenant !== input.account.tenantId
      || !safeId(input.conversationId) || !safeId(input.senderId) || !Number.isFinite(input.eventTime)
      || typeof input.code !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(input.code)
    ) return false
    const hash = digest(input.code)
    for (const item of this.pending.values()) {
      if (
        item.candidate || item.generation !== input.generation || !sameAccount(item.account, input.account)
        || input.eventTime < item.expiresAt - 5 * 60_000 || input.eventTime > this.now() + 30_000
        || !timingSafeEqual(item.digest, hash)
      ) continue
      item.candidate = { conversationId: input.conversationId, userId: input.senderId }
      return true
    }
    return false
  }

  inspect(id: string) {
    this.expire()
    const item = this.pending.get(id)
    if (!item) throw new Error('PAIRING_UNAVAILABLE')
    return {
      pairingId: item.id,
      account: item.account,
      expiresAt: new Date(item.expiresAt).toISOString(),
      state: item.candidate ? 'confirmation-required' as const : 'waiting' as const,
      ...(item.candidate ? { candidate: { ...item.candidate } } : {}),
    }
  }

  take(id: string, generation: string) {
    this.expire()
    const item = this.pending.get(id)
    if (!item || !item.candidate || item.generation !== generation) throw new Error('PAIRING_UNAVAILABLE')
    this.pending.delete(id)
    return { account: item.account, candidate: item.candidate, policyRevision: item.policyRevision }
  }

  cancel(id: string) {
    this.expire()
    return this.pending.delete(id)
  }

  dispose() {
    this.pending.clear()
  }

  private expire() {
    for (const [id, item] of this.pending) if (item.expiresAt <= this.now()) this.pending.delete(id)
  }
}
