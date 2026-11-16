import type { ChannelConversationRef, ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { RasterImageSnapshotV1 } from '@cordisx/protocol/raster-image/v1'
import { loadChannelAccountAvatar } from './channel-account-identity.js'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import { ChannelConversationDisplayStore, conversationDisplayName } from './channel-conversation-display-store.js'

export interface ChannelConversationIdentity {
  readonly name?: string
  readonly avatar?: RasterImageSnapshotV1
}

const accountKey = (ref: ChannelTenantRef) => JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])

/** Decoration uses the connected account and cannot publish after an account replacement. */
export class ChannelConversationDirectory {
  private readonly lifetime = new AbortController()
  private readonly accountVersions = new Map<string, number>()
  private readonly cache = new Map<string, number>()
  private readonly pending = new Map<string, { task: Promise<ChannelConversationIdentity>; abort: () => void }>()

  constructor(private readonly display = new ChannelConversationDisplayStore()) {}

  invalidate(ref: ChannelTenantRef): void {
    const key = accountKey(ref)
    this.accountVersions.set(key, (this.accountVersions.get(key) ?? 0) + 1)
    for (const cached of this.cache.keys()) if (cached.startsWith(`${key}:`)) this.cache.delete(cached)
    for (const [pending, operation] of this.pending) {
      if (pending.startsWith(`${key}:`)) operation.abort()
    }
  }

  async identity(
    ref: ChannelConversationRef,
    channel: FeishuSdkChannel | undefined,
    name?: string,
    event?: ChannelEventRef,
  ): Promise<ChannelConversationIdentity> {
    const account = accountKey(ref), version = this.accountVersions.get(account) ?? 0
    const key = `${account}:${version}:${ref.kind}:${ref.conversationId}`
    const cleanName = conversationDisplayName(name, ref)
    const fallback = { ...(cleanName === undefined ? {} : { name: cleanName }) }
    const live = () => !this.lifetime.signal.aborted && (this.accountVersions.get(account) ?? 0) === version
    if (!live()) return fallback
    if (cleanName && !this.display.get(ref)?.name) this.display.put(ref, { name: cleanName })
    const hint = (): ChannelConversationIdentity => {
      const cached = this.display.get(ref)
      return {
        ...(cached?.name === undefined ? fallback : { name: cached.name }),
        ...(cached?.avatar === undefined ? {} : { avatar: cached.avatar }),
      }
    }
    const prior = hint()
    if (!channel?.rawClient) return prior
    const cached = this.cache.get(key)
    if (cached && cached > Date.now()) return prior
    const existing = this.pending.get(key)
    if (existing) return prior.name || prior.avatar ? prior : existing.task
    const operation = new AbortController()
    const signal = AbortSignal.any([operation.signal, this.lifetime.signal])
    let success = false
    let resolveName!: (identity: ChannelConversationIdentity) => void
    const nameReady = new Promise<ChannelConversationIdentity>(resolve => {
      resolveName = resolve
    })
    const publish = (identity: ChannelConversationIdentity) => {
      if (!live() || signal.aborted) return
      success = true
      this.display.put(ref, identity)
      if (hint().name) resolveName(hint())
    }
    const stopped = new Promise<ChannelConversationIdentity>(resolve => {
      signal.addEventListener('abort', () => resolve(live() ? hint() : fallback), { once: true })
    })
    const timer = setTimeout(() => operation.abort(), 2_000)
    const task = Promise.race([
      this.read(ref, channel, cleanName, event, signal, publish).catch(() => fallback),
      stopped,
    ]).then(() => {
      if (!live()) return fallback
      this.cache.set(key, Date.now() + (success ? 60_000 : 10_000))
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!)
      return hint()
    }).finally(() => {
      clearTimeout(timer)
      operation.abort()
      this.pending.delete(key)
    })
    this.pending.set(key, { task, abort: () => operation.abort() })
    // A cached identity returns immediately. Cold names publish before artwork finishes.
    return prior.name || prior.avatar ? prior : Promise.race([task, nameReady])
  }

  private async read(
    ref: ChannelConversationRef,
    channel: FeishuSdkChannel | undefined,
    name: string | undefined,
    event: ChannelEventRef | undefined,
    signal: AbortSignal,
    publish: (identity: ChannelConversationIdentity) => void,
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
      displayName = conversationDisplayName(data?.name ?? data?.user?.name, ref) ?? displayName
      publish({ ...(displayName === undefined ? {} : { name: displayName }) })
      const avatar = data?.avatar ?? data?.user?.avatar?.avatar_240
      if (typeof avatar === 'string' && avatar.length <= 4096) source = avatar
    } catch {
      return fallback
    }
    const avatar = source === undefined
      ? undefined
      : await loadChannelAccountAvatar(source, signal).catch(() => undefined)
    if (signal.aborted) return fallback
    const identity = {
      ...(displayName === undefined ? {} : { name: displayName }),
      ...(avatar === undefined ? {} : { avatar }),
    }
    if (avatar !== undefined) publish({ avatar })
    return identity
  }

  dispose(): void {
    this.lifetime.abort()
    this.cache.clear()
    this.pending.clear()
    this.accountVersions.clear()
  }
}
