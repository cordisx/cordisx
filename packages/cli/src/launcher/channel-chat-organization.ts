import type { ChannelEventRef } from '@cordisx/channel-runtime'
import type { NativeBridgeMethod } from './native-submission-control-server.js'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const safeName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim()
  return name && !/^(?:oc_|ou_)[A-Za-z0-9_]+$/u.test(name) ? name.slice(0, 96) : undefined
}
export function channelChatTitle(event: ChannelEventRef, name?: string): string {
  const platform = event.adapterId === 'feishu' ? '飞书' : event.adapterId === 'lark' ? 'Lark' : event.adapterId
  return `${platform} · ${safeName(name) ?? (event.kind === 'direct' ? '私聊' : '群聊')}`.slice(0, 120)
}

/** Only automatic chats are organized. User renames/moves permanently stop that automatic action. */
export class ChannelChatOrganization {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly owned = new Map<string, { title: string; grouped: boolean }>()
  constructor(
    private readonly input: {
      nativeRequest(method: NativeBridgeMethod, params: Readonly<Record<string, unknown>>): Promise<unknown>
    },
  ) {}
  async created(threadId: string, title: string, sectionName: string | undefined) {
    const entry = { title, grouped: false }
    this.owned.set(threadId, entry)
    const task = this.tail.then(async () => {
      const read = object(await this.input.nativeRequest('thread/read', { threadId, includeTurns: false }))
      const thread = object(read.thread)
      if (thread.id !== threadId || thread.section || !sectionName || thread.name && thread.name !== title) return
      const sections: Record<string, unknown>[] = []
      let cursor: string | undefined
      for (let page = 0; page < 10; page++) {
        const response = object(
          await this.input.nativeRequest('threadSection/list', { limit: 100, ...(cursor ? { cursor } : {}) }),
        )
        if (!Array.isArray(response.data)) throw new Error('SIDEBAR_GROUP_UNAVAILABLE')
        sections.push(...response.data.map(object))
        if (typeof response.nextCursor !== 'string' || response.nextCursor === cursor) break
        cursor = response.nextCursor
      }
      let section = sections.find(row => row.name === sectionName)
      if (!section) {
        const created = object(await this.input.nativeRequest('threadSection/create', { name: sectionName }))
        section = object(created.section ?? created)
      }
      if (typeof section.id !== 'string') throw new Error('SIDEBAR_GROUP_UNAVAILABLE')
      const current = object(
        object(await this.input.nativeRequest('thread/read', { threadId, includeTurns: false })).thread,
      )
      if (current.section || current.name && current.name !== title) return
      await this.input.nativeRequest('thread/section/move', { threadId, sectionId: section.id })
      const final = object(
        object(await this.input.nativeRequest('thread/read', { threadId, includeTurns: false })).thread,
      )
      if (object(final.section).id !== section.id) throw new Error('SIDEBAR_GROUP_READBACK_FAILED')
      entry.grouped = true
    })
    this.tail = task.catch(() => undefined)
    await task
  }
  async refineTitle(threadId: string, title: string) {
    const task = this.tail.then(async () => {
      const own = this.owned.get(threadId)
      if (!own || own.title === title) return
      const thread = object(
        object(await this.input.nativeRequest('thread/read', { threadId, includeTurns: false })).thread,
      )
      if (thread.name !== own.title) {
        this.owned.delete(threadId)
        return
      }
      await this.input.nativeRequest('thread/name/set', { threadId, name: title })
      const readback = object(
        object(await this.input.nativeRequest('thread/read', { threadId, includeTurns: false })).thread,
      )
      if (readback.name !== title) throw new Error('CHAT_TITLE_READBACK_FAILED')
      own.title = title
    })
    this.tail = task.catch(() => undefined)
    await task
  }
}
