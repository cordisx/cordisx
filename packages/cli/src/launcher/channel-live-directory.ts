import type { ChannelEventRef, ChannelTenantRef } from '@cordisx/channel-runtime'
import type { FeishuSdkChannel } from './feishu-adapter.js'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import type {
  ChannelCommandAddressing,
  ChannelCommandUser,
  ChannelCommandUserReadback,
} from './channel-command-users.js'
import type { ChannelReplyCapabilities } from './channel-reply-routing.js'
import { ChannelConversationDirectory } from './channel-conversation-directory.js'
import {
  feishuDirectoryFailureCode,
  type FeishuFailureDiagnostic,
  feishuFailureDiagnostic,
} from './feishu-operation-error.js'

export interface ChannelDirectoryReadback {
  readonly conversations: readonly { id: string; name: string; kind: 'direct' | 'group' }[]
  readonly complete: boolean
  readonly code?: string
  readonly diagnostic?: FeishuFailureDiagnostic
}

const key = (ref: ChannelTenantRef) => JSON.stringify([ref.adapterId, ref.accountId, ref.tenantId])
const conversationKey = (event: ChannelEventRef) => JSON.stringify([key(event), event.conversationId])
const valid = (value: string | undefined): value is string =>
  Boolean(value && value.length <= 512 && !/[\0\r\n]/u.test(value))

/** Directory reads use the same SDK that owns the live connection. No second authentication or transport. */
export class ChannelLiveDirectory {
  private readonly identities = new ChannelConversationDirectory()
  private readonly channels = new Map<string, FeishuSdkChannel>()
  private readonly observed = new Map<string, Map<string, { id: string; name: string; kind: 'direct' | 'group' }>>()
  private readonly observedUsers = new Map<string, Map<string, ChannelCommandUser>>()
  private readonly observedEvents = new Map<string, ChannelEventRef>()
  observe(input: ChannelUserInput, addressing?: ChannelCommandAddressing): void {
    const event = input.source.event
    this.observedEvents.set(conversationKey(event), event)
    if (event.kind !== 'direct' && event.kind !== 'group') return
    const rows = this.observed.get(key(event)) ?? new Map()
    rows.set(event.conversationId, {
      id: event.conversationId,
      name: rows.get(event.conversationId)?.name
        ?? (event.kind === 'direct' && valid(addressing?.senderName) ? addressing.senderName : event.conversationId),
      kind: event.kind,
    })
    this.observed.set(key(event), rows)
    const users = this.observedUsers.get(conversationKey(event)) ?? new Map<string, ChannelCommandUser>()
    if (valid(event.actor?.userId) && valid(addressing?.senderName)) {
      users.set(event.actor.userId, { id: event.actor.userId, name: addressing.senderName })
    }
    for (const mention of addressing?.mentions ?? []) {
      if (valid(mention.userId) && valid(mention.name)) {
        users.set(mention.userId, { id: mention.userId, name: mention.name })
      }
    }
    this.observedUsers.set(conversationKey(event), users)
  }
  connected(ref: ChannelTenantRef, channel: FeishuSdkChannel | undefined): void {
    if (this.channels.get(key(ref)) !== channel) this.identities.invalidate(ref)
    if (channel) this.channels.set(key(ref), channel)
    else this.channels.delete(key(ref))
  }
  async name(event: ChannelEventRef): Promise<string | undefined> {
    const observed = this.observed.get(key(event))?.get(event.conversationId)?.name
    if (observed && observed !== event.conversationId && !/^(?:oc_|ou_)[A-Za-z0-9_]+$/u.test(observed)) return observed
    const channel = this.channels.get(key(event))
    try {
      if (event.kind === 'group' && channel?.getChatInfo) {
        const chat = await channel.getChatInfo(event.conversationId)
        if (valid(chat.name) && chat.name !== event.conversationId) {
          this.observed.get(key(event))?.set(event.conversationId, {
            id: event.conversationId,
            name: chat.name,
            kind: 'group',
          })
          return chat.name
        }
      }
      if (event.kind === 'direct' && event.actor?.userId && channel?.rawClient) {
        const cached = this.observedUsers.get(conversationKey(event))?.get(event.actor.userId)?.name
        if (valid(cached)) return cached
        const response = await channel.rawClient.contact.v3.user.get({
          path: { user_id: event.actor.userId },
          params: { user_id_type: 'open_id' },
        })
        if (response.code === 0 && valid(response.data?.user?.name)) return response.data.user.name
      }
    } catch {}
    return undefined
  }
  channel(ref: ChannelTenantRef) {
    return this.channels.get(key(ref))
  }
  conversationIdentity(event: ChannelEventRef) {
    return this.identities.identity(
      event,
      this.channels.get(key(event)),
      this.observed.get(key(event))?.get(event.conversationId)?.name,
      this.observedEvents.get(conversationKey(event)) ?? event,
    )
  }
  /** Only a connected Feishu/Lark adapter declares these supported routes; unknown adapters use main-stream replies. */
  replyCapabilities(event: ChannelEventRef): ChannelReplyCapabilities {
    const connected = this.channels.has(key(event))
    return { reply: connected, thread: connected && event.kind === 'group' }
  }
  async users(event: ChannelEventRef): Promise<ChannelCommandUserReadback> {
    const client = this.channels.get(key(event))?.rawClient
    const result = new Map(this.observedUsers.get(conversationKey(event)) ?? [])
    const members = new Map<string, ChannelCommandUser>()
    let completeMembers = true
    const partial = (code: string): ChannelCommandUserReadback => ({
      users: [...result.values()],
      complete: false,
      code,
    })
    if (!client?.im.v1.chatMembers?.get || event.kind !== 'group') return partial('CHANNEL_DIRECTORY_UNAVAILABLE')
    const seenPages = new Set<string>()
    let pageToken: string | undefined
    for (let page = 0; page < 20; page += 1) {
      try {
        const response = await client.im.v1.chatMembers.get({
          path: { chat_id: event.conversationId },
          params: {
            member_id_type: 'open_id',
            page_size: 100,
            ...(pageToken === undefined ? {} : { page_token: pageToken }),
          },
        })
        if (response.code !== 0) {
          return partial(feishuDirectoryFailureCode(feishuFailureDiagnostic('directory', response)))
        }
        if (!response.data || !Array.isArray(response.data.items)) return partial('CHANNEL_DIRECTORY_INVALID_PAGE')
        for (const user of response.data.items) {
          if (
            valid(user.member_id) && valid(user.name)
            && (user.member_id_type === 'open_id'
              || user.member_id_type === undefined && user.member_id.startsWith('ou_'))
          ) {
            const member = { id: user.member_id, name: user.name }
            result.set(user.member_id, member)
            members.set(user.member_id, member)
          } else completeMembers = false
        }
        if (response.data.trigger_security_conf_limit) return partial('CHANNEL_DIRECTORY_PERMISSION_DENIED')
        if (response.data.has_more === false) {
          return completeMembers
            ? { users: [...members.values()], complete: true }
            : partial('CHANNEL_DIRECTORY_INVALID_PAGE')
        }
        if (!response.data.has_more || !response.data.page_token || seenPages.has(response.data.page_token)) {
          return partial('CHANNEL_DIRECTORY_INVALID_PAGE')
        }
        pageToken = response.data.page_token
        seenPages.add(pageToken)
      } catch (error) {
        return partial(feishuDirectoryFailureCode(feishuFailureDiagnostic('directory', error)))
      }
    }
    return partial('CHANNEL_DIRECTORY_PAGINATION_LIMIT')
  }
  async conversations(ref: ChannelTenantRef): Promise<ChannelDirectoryReadback> {
    const client = this.channels.get(key(ref))?.rawClient
    const result = new Map(this.observed.get(key(ref)) ?? [])
    const partial = (code: string, diagnostic?: FeishuFailureDiagnostic): ChannelDirectoryReadback => ({
      conversations: [...result.values()],
      complete: false,
      code,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    })
    if (!client) return partial('CHANNEL_DIRECTORY_UNAVAILABLE')
    let pageToken: string | undefined
    for (let page = 0; page < 20; page += 1) {
      try {
        const response = await client.im.v1.chat.list({
          params: { page_size: 100, ...(pageToken === undefined ? {} : { page_token: pageToken }) },
        })
        if (response.code !== 0) {
          const diagnostic = feishuFailureDiagnostic('directory', response)
          return partial(feishuDirectoryFailureCode(diagnostic), diagnostic)
        }
        for (const chat of response.data?.items ?? []) {
          if (chat.chat_id) {
            const prior = result.get(chat.chat_id)
            const name = valid(chat.name) && chat.name !== chat.chat_id ? chat.name : prior?.name ?? chat.chat_id
            const row = { id: chat.chat_id, name, kind: 'group' as const }
            result.set(chat.chat_id, row)
            // Retain successful display names for a later transient directory failure.
            if (this.channels.get(key(ref))?.rawClient === client) {
              const observed = this.observed.get(key(ref)) ?? new Map()
              observed.set(chat.chat_id, row)
              this.observed.set(key(ref), observed)
            }
          }
        }
        if (!response.data?.has_more) return { conversations: [...result.values()], complete: true }
        if (!response.data.page_token) return partial('CHANNEL_DIRECTORY_INVALID_PAGE')
        pageToken = response.data.page_token
      } catch (error) {
        const diagnostic = feishuFailureDiagnostic('directory', error)
        return partial(feishuDirectoryFailureCode(diagnostic), diagnostic)
      }
    }
    return partial('CHANNEL_DIRECTORY_PAGINATION_LIMIT')
  }
  clear(): void {
    this.identities.dispose()
    this.channels.clear()
    this.observed.clear()
    this.observedUsers.clear()
    this.observedEvents.clear()
  }
}
