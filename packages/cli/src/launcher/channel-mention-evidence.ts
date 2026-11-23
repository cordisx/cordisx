import type { ChannelThreadRef } from '@cordisx/channel-runtime'

export class ChannelMentionEvidence {
  private readonly senders = new Map<string, Map<string, number>>()
  private active = true

  constructor(
    private readonly account: Pick<ChannelThreadRef, 'adapterId' | 'accountId' | 'tenantId'>,
    private readonly now: () => number = Date.now,
  ) {}

  observe(target: ChannelThreadRef, userId: string): void {
    if (!this.active || !this.sameAccount(target) || !/^ou_[A-Za-z0-9_]+$/u.test(userId)) return
    const key = JSON.stringify([target.kind, target.conversationId])
    let users = this.senders.get(key)
    if (!users) {
      if (this.senders.size >= 256) this.senders.delete(this.senders.keys().next().value!)
      users = new Map()
      this.senders.set(key, users)
    }
    if (users.size >= 256) users.delete(users.keys().next().value!)
    users.set(userId, this.now() + 300_000)
  }

  async verify(target: ChannelThreadRef, userIds: readonly string[]): Promise<void> {
    const users = this.senders.get(JSON.stringify([target.kind, target.conversationId]))
    if (!this.active || !this.sameAccount(target) || userIds.some(userId => (users?.get(userId) ?? 0) <= this.now())) {
      throw new Error('CHANNEL_MENTION_UNVERIFIED')
    }
  }

  dispose(): void {
    this.active = false
    this.senders.clear()
  }

  private sameAccount(target: ChannelThreadRef): boolean {
    return target.adapterId === this.account.adapterId && target.accountId === this.account.accountId
      && target.tenantId === this.account.tenantId
  }
}
