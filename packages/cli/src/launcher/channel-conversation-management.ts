import type {
  ChannelConversationRef,
  ChannelEventRef,
  ChannelTenantRef,
  ChannelTransportActivity,
} from '@cordisx/channel-runtime'
import type { ChannelConversationAccess } from './channel-conversation-tools.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import type { ChannelConversationIdentity } from './channel-conversation-directory.js'

export interface ChannelConversationManagementFence {
  readonly generation: string
  readonly accountGeneration: number
  readonly revision: string
}
export interface ChannelConversationManagementItem extends ChannelConversationIdentity {
  readonly ref: ChannelConversationRef
  readonly bindingCount: number
  readonly activeBindingCount: number
  readonly receivedCount: number
  readonly sentCount: number
  readonly lastActivityAt?: string
}
export interface ChannelConversationManagementPage extends ChannelConversationManagementFence {
  readonly total: number
  readonly offset: number
  readonly directoryComplete: boolean
  readonly conversations: readonly ChannelConversationManagementItem[]
}
export interface ChannelConversationManagementActivity extends ChannelConversationManagementFence {
  readonly conversation: ChannelConversationRef
  readonly total: number
  readonly offset: number
  readonly entries:
    readonly (ChannelTransportActivity & { readonly senderName?: string; readonly sessionName?: string })[]
}
export interface ChannelConversationManagementDetail extends ChannelConversationManagementFence {
  readonly conversation: ChannelConversationManagementItem
}
export interface ChannelConversationManagementBindings extends ChannelConversationManagementFence {
  readonly conversation: ChannelConversationRef
  readonly total: number
  readonly offset: number
  readonly bindings: readonly {
    readonly bindingId: string
    readonly sessionName: string
    readonly conversationName: string
  }[]
}
export type ChannelConversationManagementResult =
  | { readonly conversationPage: ChannelConversationManagementPage }
  | { readonly conversationActivity: ChannelConversationManagementActivity }
  | { readonly conversationDetail: ChannelConversationManagementDetail }
  | { readonly conversationBindings: ChannelConversationManagementBindings }
  | { readonly bindingNavigation: string }

const same = (a: ChannelTenantRef, b: ChannelTenantRef) =>
  a.adapterId === b.adapterId && a.accountId === b.accountId && a.tenantId === b.tenantId
const sameConversation = (a: ChannelConversationRef, b: ChannelConversationRef) =>
  same(a, b) && a.conversationId === b.conversationId && a.kind === b.kind
const safeName = (value: string | undefined, fallback: string) =>
  value?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120) || fallback
const safeCode = (value: string | undefined) => value && /^[A-Z0-9._-]{1,128}$/u.test(value) ? value : undefined
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
async function bounded<T>(task: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task.catch(() => fallback),
      new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Launcher-only read seam. No credentials, task transcript, sending, binding or reconnection. */
export class ChannelConversationManagement {
  constructor(
    private readonly access: () => ChannelConversationAccess | undefined,
    private readonly consumer?: Pick<
      ChannelConversationConsumer,
      'managementReadback' | 'bindingLabels' | 'bindingNavigation'
    >,
  ) {}

  async read(action: string, input: Record<string, unknown>): Promise<ChannelConversationManagementResult> {
    const current = this.access()
    if (!current) throw new Error('CHANNEL_UNAVAILABLE')
    if (action === 'binding-navigation') {
      if (Object.keys(input).some(key => key !== 'bindingId') || typeof input.bindingId !== 'string') {
        throw new Error('INVALID_REQUEST')
      }
      const binding = this.consumer?.managementReadback().bindings.find(item => item.id === input.bindingId)
      const account = binding && current.runtime.snapshot().accounts.find(item => same(item.ref, binding.channel))
      if (!binding || !account) throw new Error('TARGET_UNAVAILABLE')
      const sessionId = await bounded(
        this.consumer?.bindingNavigation(input.bindingId) ?? Promise.resolve(undefined),
        undefined,
        1_500,
      )
      if (this.access()?.generation !== current.generation) throw new Error('STALE_GENERATION')
      if (
        current.runtime.snapshot().accounts.find(item => same(item.ref, binding.channel))?.generation
          !== account.generation
      ) throw new Error('TARGET_UNAVAILABLE')
      if (!sessionId) throw new Error('TARGET_UNAVAILABLE')
      return { bindingNavigation: sessionId }
    }
    if (
      Object.keys(input).some(key =>
        !['ref', 'offset', 'limit', 'expectedRevision', 'expectedGeneration', 'expectedAccountGeneration'].includes(key)
      )
    ) throw new Error('INVALID_REQUEST')
    const raw = record(input.ref)
    if (Object.keys(raw).some(key => !['adapterId', 'accountId', 'tenantId', 'conversationId', 'kind'].includes(key))) {
      throw new Error('INVALID_REQUEST')
    }
    for (const key of ['adapterId', 'accountId', 'tenantId']) {
      if (
        typeof raw[key] !== 'string' || !(raw[key] as string).length || (raw[key] as string).length > 512
        || /[\0\r\n]/u.test(raw[key] as string)
      ) throw new Error('INVALID_REQUEST')
    }
    const account: ChannelTenantRef = {
      adapterId: String(raw.adapterId),
      accountId: String(raw.accountId),
      tenantId: String(raw.tenantId),
    }
    if (action === 'conversation-page' && (raw.conversationId !== undefined || raw.kind !== undefined)) {
      throw new Error('INVALID_REQUEST')
    }
    if (
      action !== 'conversation-page'
      && (typeof raw.conversationId !== 'string' || !raw.conversationId || raw.conversationId.length > 512
        || /[\0\r\n]/u.test(raw.conversationId) || !['direct', 'group', 'broadcast'].includes(String(raw.kind)))
    ) throw new Error('INVALID_REQUEST')
    if (!current.accounts().some(item => same(item.ref, account))) throw new Error('TARGET_UNAVAILABLE')
    const limit = input.limit ?? 25, offset = input.offset ?? 0
    if (
      !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 || !Number.isSafeInteger(offset)
      || Number(offset) < 0
    ) throw new Error('INVALID_REQUEST')
    const consumer = this.consumer?.managementReadback()
    const transport = current.runtime.accountConversationReadback(account)
    const adapter = current.runtime.snapshot().accounts.find(item => same(item.ref, account))
    const fence = {
      generation: current.generation,
      accountGeneration: adapter?.generation ?? 0,
      revision: JSON.stringify([
        current.generation,
        adapter?.generation ?? 0,
        transport.revision,
        consumer?.revision ?? 0,
      ]),
    }
    const check = () => {
      const now = this.access()
      if (now?.generation !== current.generation || !now.accounts().some(item => same(item.ref, account))) {
        throw new Error('STALE_GENERATION')
      }
      if (
        now.runtime.snapshot().accounts.find(item => same(item.ref, account))?.generation !== fence.accountGeneration
      ) throw new Error('TARGET_UNAVAILABLE')
      if (
        input.expectedGeneration !== undefined && input.expectedGeneration !== fence.generation
        || input.expectedAccountGeneration !== undefined && input.expectedAccountGeneration !== fence.accountGeneration
      ) throw new Error('TARGET_UNAVAILABLE')
    }
    const checkRevision = () => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== fence.revision) {
        throw new Error('STALE_CURSOR')
      }
    }
    check()
    const bindings = (consumer?.bindings ?? []).filter(binding => same(binding.channel, account))
    const refs = new Map<string, ChannelConversationRef>()
    for (const ref of current.runtime.localConversationRefs(account)) refs.set(ref.conversationId, ref)
    for (const binding of bindings) refs.set(binding.channel.conversationId, binding.channel)
    if (action === 'conversation-page' || action === 'conversation-detail') {
      const directory = await bounded(
        current.displayConversations?.(account) ?? current.conversations(account),
        { conversations: [], complete: false },
        3_000,
      )
      check()
      const names = new Map(directory.conversations.map(item => [item.id, item.name]))
      for (const item of directory.conversations) {
        refs.set(item.id, { ...account, conversationId: item.id, kind: item.kind })
      }
      fence.revision = JSON.stringify([
        fence.revision,
        directory.complete,
        directory.conversations.map(item => [item.id, item.kind, item.name]).sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
        [...refs.values()].map(ref => [ref.conversationId, ref.kind]).sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
      ])
      checkRevision()
      const counts = new Map<string, { receivedCount: number; sentCount: number; lastActivityAt?: string }>()
      for (const entry of transport.entries) {
        const count = counts.get(entry.conversation.conversationId) ?? { receivedCount: 0, sentCount: 0 }
        if (entry.direction === 'incoming') count.receivedCount += 1
        else if (entry.state === 'sent') count.sentCount += 1
        if (!count.lastActivityAt || entry.occurredAt > count.lastActivityAt) count.lastActivityAt = entry.occurredAt
        counts.set(entry.conversation.conversationId, count)
      }
      const all = [...refs.values()].sort((left, right) =>
        (counts.get(right.conversationId)?.lastActivityAt ?? '').localeCompare(
          counts.get(left.conversationId)?.lastActivityAt ?? '',
        ) || left.conversationId.localeCompare(right.conversationId)
      )
      if (Number(offset) > all.length) throw new Error('STALE_CURSOR')
      const selected = action === 'conversation-detail'
        ? all.filter(ref => ref.conversationId === raw.conversationId && ref.kind === raw.kind)
        : all.slice(Number(offset), Number(offset) + Number(limit))
      const conversations = await Promise.all(selected.map(async (ref, index) => {
        const event: ChannelEventRef = {
          ...ref,
          threadId: ref.conversationId,
          semantics: 'conversation',
          eventId: 'management-display',
        }
        // At most eight independent decoration requests per page. A missing avatar never blocks records.
        const cached = current.conversationDisplay?.(ref) ?? {}
        const identity: ChannelConversationIdentity = index < 8
          ? await bounded(current.conversationIdentity?.(event) ?? Promise.resolve(cached), cached, 1_800)
          : cached
        const related = bindings.filter(binding => sameConversation(binding.channel, ref))
        const count = counts.get(ref.conversationId) ?? { receivedCount: 0, sentCount: 0 }
        // A failed decoration may return the raw ID; it must not hide a directory name.
        const name = identity.name && identity.name !== ref.conversationId
          ? identity.name
          : names.get(ref.conversationId)
        return {
          ref,
          ...identity,
          name: safeName(name === ref.conversationId ? undefined : name, ref.kind === 'direct' ? '私聊' : '群聊'),
          bindingCount: related.length,
          activeBindingCount: related.filter(item => item.state === 'active').length,
          ...count,
        }
      }))
      check()
      if (action === 'conversation-detail') {
        if (conversations.length !== 1) throw new Error('TARGET_UNAVAILABLE')
        return { conversationDetail: { ...fence, conversation: conversations[0]! } }
      }
      return {
        conversationPage: {
          ...fence,
          total: all.length,
          offset: Number(offset),
          directoryComplete: directory.complete,
          conversations,
        },
      }
    }
    if (
      typeof raw.conversationId !== 'string' || !raw.conversationId
      || !['direct', 'group', 'broadcast'].includes(String(raw.kind))
    ) throw new Error('INVALID_REQUEST')
    const ref = { ...account, conversationId: raw.conversationId, kind: raw.kind as ChannelConversationRef['kind'] }
    checkRevision()
    if (action === 'conversation-activity') {
      const all = transport.entries.filter(entry => sameConversation(entry.conversation, ref))
      if (Number(offset) > all.length) throw new Error('STALE_CURSOR')
      const selected = all.slice(Number(offset), Number(offset) + Number(limit))
      const attributed = (entry: typeof selected[number]) =>
        entry.sessionId
          ?? consumer?.deliveries.find(item => item.deliveryId === entry.id && sameConversation(item.event, ref))
            ?.sessionId
      const ids = [...new Set(selected.flatMap(entry => attributed(entry) ? [attributed(entry)!] : []))]
      const labels = await bounded(
        this.consumer?.bindingLabels(bindings.filter(item => ids.includes(item.sessionId)).map(item => item.id))
          ?? Promise.resolve([]),
        [],
        1_500,
      )
      const entries = selected.map(entry => {
        const sessionId = attributed(entry)
        const binding = bindings.find(binding => binding.sessionId === sessionId)
        const sessionName = labels.find(label => label.bindingId === binding?.id)?.sessionName
        const senderName = consumer?.senders.find(sender =>
          sender.event.eventId === entry.eventId && sameConversation(sender.event, ref)
        )?.name
        const code = safeCode(entry.code)
        const { code: _privateCode, ...safe } = entry
        return {
          ...safe,
          text: entry.text.replace(/\0/gu, '').slice(0, 8192),
          ...(senderName === undefined ? {} : { senderName: safeName(senderName, '用户') }),
          ...(sessionName === undefined ? {} : { sessionName: safeName(sessionName, 'Codex 对话') }),
          ...(code === undefined ? {} : { code }),
        }
      })
      check()
      return {
        conversationActivity: { ...fence, conversation: ref, total: all.length, offset: Number(offset), entries },
      }
    }
    if (action === 'conversation-bindings') {
      const all = bindings.filter(item => sameConversation(item.channel, ref))
      if (Number(offset) > all.length) throw new Error('STALE_CURSOR')
      const selected = all.slice(Number(offset), Number(offset) + Number(limit))
      const labels = await bounded(
        this.consumer?.bindingLabels(selected.map(binding => binding.id)) ?? Promise.resolve([]),
        [],
        1_500,
      )
      check()
      return {
        conversationBindings: {
          ...fence,
          conversation: ref,
          total: all.length,
          offset: Number(offset),
          bindings: selected.map(binding => ({
            bindingId: binding.id,
            sessionName: safeName(labels.find(label => label.bindingId === binding.id)?.sessionName, 'Codex 对话'),
            conversationName: safeName(
              labels.find(label => label.bindingId === binding.id)?.conversationName,
              ref.kind === 'direct' ? '私聊' : '群聊',
            ),
          })),
        },
      }
    }
    throw new Error('INVALID_REQUEST')
  }
}
