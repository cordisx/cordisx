import type { ChannelConversationRef, ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import { loadChannelAccountAvatar } from './channel-account-identity.js'
import type { FeishuSdkChannel } from './feishu-adapter.js'

export interface ChannelConversationIdentity {
  readonly name?: string
  readonly avatar?: RasterImageSnapshotV1
}

const accountKey = (ref: ChannelTenantRef) => JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
const validName = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120) || undefined : undefined

/** Decoration uses the connected account and cannot publish after an account replacement. */
export class ChannelConversationDirectory {
  private readonly lifetime = new AbortController()
  private readonly accountVersions = new Map<string, number>()
  private readonly cache = new Map<string, { until: number; identity: ChannelConversationIdentity }>()
  private readonly pending = new Map<string, Promise<ChannelConversationIdentity>>()

  invalidate(ref: ChannelTenantRef): void {
    const key = accountKey(ref)
    this.accountVersions.set(key, (this.accountVersions.get(key) ?? 0) + 1)
    for (const cached of this.cache.keys()) if (cached.startsWith(`${key}:`)) this.cache.delete(cached)
  }

  async identity(
    ref: ChannelConversationRef,
    channel: FeishuSdkChannel | undefined,
    name?: string,
    event?: ChannelEventRef,
  ): Promise<ChannelConversationIdentity> {
    const account = accountKey(ref), version = this.accountVersions.get(account) ?? 0
    const key = `${account}:${version}:${ref.conversationId}`
    const fallback = { ...(validName(name) === undefined ? {} : { name: validName(name)! }) }
    const live = () => !this.lifetime.signal.aborted && (this.accountVersions.get(account) ?? 0) === version
    const cached = this.cache.get(key)
    if (cached && cached.until > Date.now()) return cached.identity
    const existing = this.pending.get(key)
    if (existing) return existing
    const operation = new AbortController()
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal])
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<ChannelConversationIdentity>(resolve => {
      timer = setTimeout(() => {
        operation.abort()
        resolve(fallback)
      }, 2_000)
    })
    const task = Promise.race([this.read(ref, channel, fallback.name, event, signal), timeout]).then(identity => {
      if (!live()) return fallback
      this.cache.set(key, { until: Date.now() + 60_000, identity })
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
      return identity
    }).finally(() => {
      clearTimeout(timer!)
      operation.abort()
      this.pending.delete(key)
    })
    this.pending.set(key, task)
    return task
  }

  private async read(
    ref: ChannelConversationRef,
    channel: FeishuSdkChannel | undefined,
    name: string | undefined,
    event: ChannelEventRef | undefined,
    signal: AbortSignal,
  ): Promise<ChannelConversationIdentity> {
    const fallback = { ...(name === undefined ? {} : { name }) }
    if (signal.aborted || !channel?.rawClient) return fallback
    let displayName = name, source: string | undefined
    try {
      const response = ref.kind === 'group'
        ? await channel.rawClient.im.v1.chat.get({ path: { chat_id: ref.conversationId } })
        : ref.kind === 'direct' && event?.actor?.userId
        ? await channel.rawClient.contact.v3.user.get({
          path: { user_id: event.actor.userId },
          params: { user_id_type: 'open_id' },
        })
        : undefined
      if (signal.aborted || !response || response.code !== 0) return fallback
      const data = response.data as {
        name?: unknown
        avatar?: unknown
        user?: { name?: unknown; avatar?: { avatar_240?: unknown } }
      } | undefined
      displayName = validName(data?.name ?? data?.user?.name) ?? displayName
      const avatar = data?.avatar ?? data?.user?.avatar?.avatar_240
      if (typeof avatar === 'string' && avatar.length <= 4096) source = avatar
    } catch {
      return fallback
    }
    const avatar = source === undefined
      ? undefined
      : await loadChannelAccountAvatar(source, signal).catch(() => undefined)
    if (signal.aborted) return fallback
    return { ...(displayName === undefined ? {} : { name: displayName }), ...(avatar === undefined ? {} : { avatar }) }
  }

  dispose(): void {
    this.lifetime.abort()
    this.cache.clear()
    this.pending.clear()
    this.accountVersions.clear()
  }
}
