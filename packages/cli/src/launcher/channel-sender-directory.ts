import { clearTimeout, setTimeout } from 'node:timers'
import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { channelParticipantName } from './channel-message-context.js'
import { ChannelConversationDisplayStore } from './channel-conversation-display-store.js'

const accountKey = (ref: ChannelTenantRef) => JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
const userKey = (event: ChannelEventRef) => JSON.stringify([accountKey(event), event.actor?.userId])
const MAX_HINTS = 5_000
const MAX_PENDING = 32
const FRESH_MS = 24 * 60 * 60_000

/** Decorative, account-scoped names; no credential, contact record, membership or permission cache. */
export class ChannelSenderDirectory {
  private readonly names = new Map<string, { name: string; until: number }>()
  private readonly pending = new Map<string, Promise<string | undefined>>()
  private readonly versions = new Map<string, number>()
  private disposed = false
  private accounts?: ReadonlySet<string>
  constructor(private readonly display = new ChannelConversationDisplayStore()) {}
  private ref(event: ChannelEventRef) {
    return {
      adapterId: event.adapterId,
      accountId: event.accountId,
      tenantId: event.tenantId,
      conversationId: event.actor!.userId,
      kind: 'direct' as const,
    }
  }
  retainAccounts(refs: readonly ChannelTenantRef[]): void {
    const allowed = new Set(refs.map(accountKey))
    const before = this.accounts
    this.accounts = allowed
    const known = new Set([...this.versions.keys(), ...(before ?? []), ...allowed])
    for (const account of known) {
      if (before && before.has(account) !== allowed.has(account)) {
        this.versions.set(account, (this.versions.get(account) ?? 0) + 1)
      } else if (!this.versions.has(account)) this.versions.set(account, 0)
    }
    this.display.retainAccounts(refs)
    for (const id of [...this.names.keys(), ...this.pending.keys()]) {
      if (!allowed.has(JSON.parse(id)[0])) {
        this.names.delete(id)
        this.pending.delete(id)
      }
    }
  }
  observe(event: ChannelEventRef, name: unknown): void {
    const safe = channelParticipantName(name)
    if (this.disposed || !event.actor?.userId || !safe || this.accounts && !this.accounts.has(accountKey(event))) return
    this.names.delete(userKey(event))
    this.names.set(userKey(event), { name: safe, until: Date.now() + FRESH_MS })
    const ref = this.ref(event), stored = this.display.get(ref)
    // A successful revalidation must advance persistent freshness, even if the name is unchanged.
    const refreshSame = stored !== undefined && Date.now() - Date.parse(stored.updatedAt) >= FRESH_MS
    this.display.put(ref, { name: safe }, { refreshSame })
    while (this.names.size > MAX_HINTS) this.names.delete(this.names.keys().next().value!)
  }
  invalidate(ref: ChannelTenantRef): void {
    const account = accountKey(ref)
    this.versions.set(account, (this.versions.get(account) ?? 0) + 1)
    for (const id of this.pending.keys()) if (JSON.parse(id)[0] === account) this.pending.delete(id)
  }
  cachedName(event: ChannelEventRef): string | undefined {
    if (this.disposed || !event.actor?.userId || this.accounts && !this.accounts.has(accountKey(event))) {
      return undefined
    }
    return this.names.get(userKey(event))?.name ?? this.display.get(this.ref(event))?.name
  }
  async name(event: ChannelEventRef, channel: FeishuSdkChannel | undefined): Promise<string | undefined> {
    if (this.disposed || !event.actor?.userId || this.accounts && !this.accounts.has(accountKey(event))) {
      return undefined
    }
    const id = userKey(event), account = accountKey(event)
    const stored = this.display.get(this.ref(event))
    const saved = this.names.get(id)
      ?? (stored?.name ? { name: stored.name, until: Date.parse(stored.updatedAt) + FRESH_MS } : undefined)
    if (saved && saved.until > Date.now()) return saved.name
    if (!this.versions.has(account)) this.versions.set(account, 0)
    const version = this.versions.get(account)
    const live = () =>
      !this.disposed && this.versions.get(account) === version && (!this.accounts || this.accounts.has(account))
    let pending = this.pending.get(id)
    if (!pending && this.pending.size < MAX_PENDING && channel?.rawClient) {
      const client = channel.rawClient
      pending = (async () => {
        let name: string | undefined
        // Fetch the known message first: sender names may be available through message
        // read authority even when the app has no contact-directory scope.
        if (event.messageId && client.im.v1.message?.get) {
          try {
            const response = await client.im.v1.message.get({
              path: { message_id: event.messageId },
              params: { user_id_type: 'open_id', with_sender_name: true },
            })
            const item = response.code === 0
              ? response.data?.items?.find(item =>
                item.message_id === event.messageId && item.chat_id === event.conversationId
                && (item.sender?.id_type === 'open_id' && item.sender.id === event.actor!.userId
                  || item.sender?.open_bot_id === event.actor!.userId)
              )
              : undefined
            name = channelParticipantName(item?.sender?.sender_name)
              ?? channelParticipantName(item?.sender?.sender_i18n_names?.zh_cn)
              ?? channelParticipantName(item?.sender?.sender_i18n_names?.en_us)
              ?? channelParticipantName(item?.sender?.sender_i18n_names?.ja_jp)
          } catch {}
        }
        if (!name && live()) {
          try {
            const user = await client.contact.v3.user.get({
              path: { user_id: event.actor!.userId },
              params: { user_id_type: 'open_id' },
            })
            if (user.code === 0) name = channelParticipantName(user.data?.user?.name)
          } catch {}
        }
        // Group member names remain available on enterprises that do not grant full contact access.
        if (!name && event.kind === 'group' && live() && client.im.v1.chatMembers?.get) {
          let pageToken: string | undefined
          for (let page = 0; page < 20 && live(); page++) {
            try {
              const response = await client.im.v1.chatMembers.get({
                path: { chat_id: event.conversationId },
                params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
              })
              if (response.code !== 0) break
              const member = response.data?.items?.find(item => item.member_id === event.actor!.userId)
              name = channelParticipantName(member?.name)
              if (
                name || !response.data?.has_more || !response.data.page_token || pageToken === response.data.page_token
              ) break
              pageToken = response.data.page_token
            } catch {
              break
            }
          }
        }
        if (!live()) return undefined
        if (name) this.observe(event, name)
        return name ?? saved?.name
      })()
      this.pending.set(id, pending)
      const own = pending
      void pending.then(() => {
        if (this.pending.get(id) === own) this.pending.delete(id)
      }, () => {
        if (this.pending.get(id) === own) this.pending.delete(id)
      })
    }
    if (saved) return saved.name
    if (!pending) return undefined
    // One slow directory cannot hold up incoming model tasks indefinitely; a successful late lookup serves the next input.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), 2_000)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  clear(): void {
    this.disposed = true
    this.names.clear()
    this.pending.clear()
    this.versions.clear()
  }
}
