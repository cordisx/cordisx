import type {
  ChannelManagerConversationActivityPageV1,
  ChannelManagerConversationBindingsPageV1,
  ChannelManagerConversationDetailV1,
  ChannelManagerConversationPageV1,
  ChannelManagerConversationV1,
} from '@cordisx/protocol/channel-manager/v10'
import type { ChannelConversationRef } from '@cordisx/channel-runtime'
import type { ChannelManagerActionsApi } from './channel-manager.js'
import type { PublicChannelManagerController } from './channel-manager-public.js'
import type {
  ChannelConversationManagementFence,
  ChannelConversationManagementItem,
} from '../launcher/channel-conversation-management.js'
import type { RequestedScope } from './platform/platform-permission-store.js'
import { cloneRasterImageSnapshot } from './raster-image.js'

const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `chm1_${btoa(String.fromCharCode(...bytes)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')}`
}
const sameAccount = (left: ChannelConversationRef, right: Omit<ChannelConversationRef, 'conversationId' | 'kind'>) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId
const sameConversation = (left: ChannelConversationRef, right: ChannelConversationRef) =>
  sameAccount(left, right) && left.conversationId === right.conversationId && left.kind === right.kind
const safeName = (value: string | undefined, fallback: string) =>
  value?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120) || fallback
const safeCode = (value: string | undefined) => value && /^[A-Z0-9._-]{1,128}$/u.test(value) ? value : undefined
interface Target {
  readonly caller: string
  readonly connectionToken: string
  readonly ref: ChannelConversationRef
  readonly generation: string
  readonly accountGeneration: number
  readonly expires: number
  item: ChannelManagerConversationV1
}
interface Cursor {
  readonly caller: string
  readonly action: 'conversation-page' | 'conversation-activity' | 'conversation-bindings'
  readonly target: string
  readonly revision: string
  readonly generation: string
  readonly accountGeneration: number
  readonly offset: number
  readonly limit: number
  readonly expires: number
}
export interface ChannelConversationWorkflowInput {
  readonly caller: string
  readonly profileId: string
  readonly hostGeneration: string
  readonly controller: PublicChannelManagerController
  readonly actions: ChannelManagerActionsApi
  readonly live: () => boolean
  readonly authorize: (
    capability: 'channel.accounts.read' | 'channel.bindings.read' | 'channel.events.subscribe',
    scope?: RequestedScope,
  ) => Promise<boolean>
  readonly navigate?: (sessionId: string) => Promise<void> | void
}

interface WorkflowState {
  readonly targets: Map<string, Target>
  readonly keys: Map<string, string>
  readonly cursors: Map<string, Cursor>
  readonly entries: Map<string, { token: string; expires: number }>
  revision: number
  fingerprint: string
}
/** Owner, account incarnation and revision fenced capabilities over launcher readbacks. */
export class ChannelConversationWorkflow {
  private readonly targets: Map<string, Target>
  private readonly keys: Map<string, string>
  private readonly cursors: Map<string, Cursor>
  constructor(
    private readonly input: ChannelConversationWorkflowInput,
    private readonly state: WorkflowState = {
      targets: new Map(),
      keys: new Map(),
      cursors: new Map(),
      entries: new Map(),
      revision: 0,
      fingerprint: '',
    },
  ) {
    this.targets = state.targets
    this.keys = state.keys
    this.cursors = state.cursors
  }
  forCaller(input: Pick<ChannelConversationWorkflowInput, 'caller' | 'live' | 'authorize'>) {
    return new ChannelConversationWorkflow({ ...this.input, ...input }, this.state)
  }

  private assertLive(signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!this.input.live()) throw new Error('STALE_GENERATION')
    this.prune()
  }
  private prune(): void {
    const now = Date.now()
    for (const [key, value] of this.targets) if (value.expires <= now) this.targets.delete(key)
    for (const [key, value] of this.keys) if (!this.targets.has(value)) this.keys.delete(key)
    for (const [key, value] of this.cursors) if (value.expires <= now) this.cursors.delete(key)
    for (const [key, value] of this.state.entries) if (value.expires <= now) this.state.entries.delete(key)
  }
  private entryToken(target: string, id: string): string {
    const key = JSON.stringify([this.input.caller, target, id])
    const existing = this.state.entries.get(key)
    if (existing) return existing.token
    const value = token()
    this.state.entries.set(key, { token: value, expires: Date.now() + 30 * 60_000 })
    if (this.state.entries.size > 2_048) this.state.entries.delete(this.state.entries.keys().next().value!)
    return value
  }
  private scope(ref: ChannelConversationRef): RequestedScope {
    return { channelConversation: { ...ref } }
  }
  private readFence(fence: ChannelConversationManagementFence) {
    if (this.state.fingerprint !== fence.revision) {
      this.state.fingerprint = fence.revision
      this.state.revision += 1
    }
    return {
      profileId: this.input.profileId,
      hostGeneration: this.input.hostGeneration,
      snapshotRevision: this.state.revision,
    }
  }
  private cursor(
    action: Cursor['action'],
    target: string,
    afterCursor: string | undefined,
    limit: number,
  ): Cursor | undefined {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_REQUEST')
    if (afterCursor === undefined) return undefined
    const cursor = this.cursors.get(afterCursor)
    if (
      !cursor || cursor.caller !== this.input.caller || cursor.action !== action || cursor.target !== target
      || cursor.limit !== limit || cursor.expires < Date.now()
    ) throw new Error('STALE_CURSOR')
    return cursor
  }
  private pageInput(cursor: Cursor | undefined, limit: number) {
    return {
      limit,
      offset: cursor?.offset ?? 0,
      ...(cursor === undefined
        ? {}
        : {
          expectedRevision: cursor.revision,
          expectedGeneration: cursor.generation,
          expectedAccountGeneration: cursor.accountGeneration,
        }),
    }
  }
  private next(
    action: Cursor['action'],
    target: string,
    fence: ChannelConversationManagementFence,
    offset: number,
    count: number,
    total: number,
    limit: number,
  ): { nextCursor?: string } {
    if (offset + count >= total) return {}
    const nextCursor = token()
    this.cursors.set(nextCursor, {
      action,
      target,
      ...fence,
      caller: this.input.caller,
      offset: offset + count,
      limit,
      expires: Date.now() + 60_000,
    })
    if (this.cursors.size > 256) this.cursors.delete(this.cursors.keys().next().value!)
    return { nextCursor }
  }
  private resolve(value: string): Target {
    const target = this.targets.get(value)
    const account = target && this.input.controller.target(target.connectionToken)
    if (
      !target || target.caller !== this.input.caller || target.expires <= Date.now() || !account
      || !sameAccount(target.ref, account)
    ) throw new Error('TARGET_UNAVAILABLE')
    return target
  }
  private adopt(
    item: ChannelConversationManagementItem,
    connectionToken: string,
    fence: ChannelConversationManagementFence,
  ): ChannelManagerConversationV1 {
    const key = JSON.stringify([
      this.input.profileId,
      this.input.hostGeneration,
      this.input.caller,
      connectionToken,
      fence.generation,
      fence.accountGeneration,
      item.ref.conversationId,
      item.ref.kind,
    ])
    let conversationToken = this.keys.get(key)
    if (!conversationToken || !this.targets.has(conversationToken)) {
      conversationToken = token()
      this.keys.set(key, conversationToken)
    }
    let avatar
    try {
      if (item.avatar) avatar = cloneRasterImageSnapshot(item.avatar)
    } catch { /* Decoration cannot reject a relationship. */ }
    const result: ChannelManagerConversationV1 = {
      conversationToken,
      connectionToken,
      name: safeName(item.name, item.ref.kind === 'direct' ? '私聊' : '群聊'),
      kind: item.ref.kind,
      ...(avatar === undefined ? {} : { avatar }),
      bindingCount: item.bindingCount,
      activeBindingCount: item.activeBindingCount,
      receivedCount: item.receivedCount,
      sentCount: item.sentCount,
      ...(item.lastActivityAt === undefined ? {} : { lastActivityAt: item.lastActivityAt }),
    }
    this.targets.set(conversationToken, {
      caller: this.input.caller,
      ref: item.ref,
      connectionToken,
      generation: fence.generation,
      accountGeneration: fence.accountGeneration,
      item: result,
      expires: Date.now() + 30 * 60_000,
    })
    for (const [issued, old] of this.targets) {
      if (
        old.connectionToken === connectionToken
        && (old.generation !== fence.generation || old.accountGeneration !== fence.accountGeneration)
      ) this.targets.delete(issued)
    }
    this.prune()
    return result
  }

  async page(
    request: { connectionToken: string; afterCursor?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<ChannelManagerConversationPageV1> {
    this.assertLive(signal)
    if (Object.keys(request).some(key => !['connectionToken', 'afterCursor', 'limit'].includes(key))) {
      throw new Error('INVALID_REQUEST')
    }
    const ref = this.input.controller.target(request.connectionToken)
    if (
      !ref || !ref.tenantId || !await this.input.authorize('channel.accounts.read', { channelTenant: ref })
      || !await this.input.authorize('channel.bindings.read', { channelTenant: ref })
    ) throw new Error('PERMISSION_DENIED')
    const limit = request.limit ?? 100,
      cursor = this.cursor('conversation-page', request.connectionToken, request.afterCursor, limit)
    const result = await this.input.actions.run('conversation-page', { ref, ...this.pageInput(cursor, limit) })
    this.assertLive(signal)
    if (
      !this.input.controller.target(request.connectionToken)
      || !await this.input.authorize('channel.accounts.read', { channelTenant: ref })
      || !await this.input.authorize('channel.bindings.read', { channelTenant: ref })
    ) throw new Error('PERMISSION_DENIED')
    const page = result.conversationPage
    if (result.status !== 'applied' || !page) throw new Error(result.code ?? 'CHANNEL_CONVERSATIONS_UNAVAILABLE')
    if (
      page.conversations.length > limit || page.offset !== (cursor?.offset ?? 0)
      || page.total < page.offset + page.conversations.length
      || page.conversations.some(item => !sameAccount(item.ref, ref))
    ) throw new Error('INVALID_CHANNEL_READBACK')
    return {
      contract: 'cordisx.channel-manager-conversation-page/v1',
      schemaVersion: 1,
      ...this.readFence(page),
      connectionToken: request.connectionToken,
      directoryComplete: page.directoryComplete,
      total: page.total,
      conversations: page.conversations.map(item => this.adopt(item, request.connectionToken, page)),
      ...this.next(
        'conversation-page',
        request.connectionToken,
        page,
        page.offset,
        page.conversations.length,
        page.total,
        limit,
      ),
    }
  }
  async detail(value: string, signal: AbortSignal): Promise<ChannelManagerConversationDetailV1> {
    this.assertLive(signal)
    const target = this.resolve(value)
    if (
      !await this.input.authorize('channel.accounts.read', this.scope(target.ref))
      || !await this.input.authorize('channel.bindings.read', this.scope(target.ref))
    ) throw new Error('PERMISSION_DENIED')
    // A small exact-target read checks the real service incarnation before returning a cached display.
    const result = await this.input.actions.run('conversation-detail', {
      ref: target.ref,
      limit: 1,
      expectedGeneration: target.generation,
      expectedAccountGeneration: target.accountGeneration,
    })
    this.assertLive(signal)
    this.resolve(value)
    if (
      !await this.input.authorize('channel.accounts.read', this.scope(target.ref))
      || !await this.input.authorize('channel.bindings.read', this.scope(target.ref))
    ) throw new Error('PERMISSION_DENIED')
    if (result.status !== 'applied' || !result.conversationDetail) throw new Error(result.code ?? 'TARGET_UNAVAILABLE')
    const detail = result.conversationDetail
    if (
      !sameConversation(detail.conversation.ref, target.ref) || detail.generation !== target.generation
      || detail.accountGeneration !== target.accountGeneration
    ) throw new Error('INVALID_CHANNEL_READBACK')
    return {
      contract: 'cordisx.channel-manager-conversation-detail/v1',
      schemaVersion: 1,
      ...this.readFence(detail),
      conversation: this.adopt(detail.conversation, target.connectionToken, detail),
    }
  }
  async activity(
    request: { conversationToken: string; afterCursor?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<ChannelManagerConversationActivityPageV1> {
    this.assertLive(signal)
    if (Object.keys(request).some(key => !['conversationToken', 'afterCursor', 'limit'].includes(key))) {
      throw new Error('INVALID_REQUEST')
    }
    const target = this.resolve(request.conversationToken), scope = this.scope(target.ref)
    if (
      !await this.input.authorize('channel.accounts.read', scope)
      || !await this.input.authorize('channel.events.subscribe', scope)
    ) throw new Error('PERMISSION_DENIED')
    const limit = request.limit ?? 25,
      cursor = this.cursor('conversation-activity', request.conversationToken, request.afterCursor, limit)
    const result = await this.input.actions.run('conversation-activity', {
      ref: target.ref,
      expectedGeneration: target.generation,
      expectedAccountGeneration: target.accountGeneration,
      ...this.pageInput(cursor, limit),
    })
    this.assertLive(signal)
    this.resolve(request.conversationToken)
    if (
      !await this.input.authorize('channel.events.subscribe', scope)
      || !await this.input.authorize('channel.accounts.read', scope)
    ) throw new Error('PERMISSION_DENIED')
    const page = result.conversationActivity
    if (result.status !== 'applied' || !page) throw new Error(result.code ?? 'CHANNEL_ACTIVITY_UNAVAILABLE')
    if (
      !sameConversation(page.conversation, target.ref) || page.generation !== target.generation
      || page.accountGeneration !== target.accountGeneration || page.entries.length > limit
      || page.offset !== (cursor?.offset ?? 0)
      || page.entries.some(entry => !sameConversation(entry.conversation, target.ref))
    ) throw new Error('INVALID_CHANNEL_READBACK')
    return {
      contract: 'cordisx.channel-manager-conversation-activity-page/v1',
      schemaVersion: 1,
      ...this.readFence(page),
      conversationToken: request.conversationToken,
      source: 'local-transport',
      total: page.total,
      entries: page.entries.map(entry => {
        const code = safeCode(entry.code)
        return {
          entryId: this.entryToken(request.conversationToken, entry.id),
          direction: entry.direction,
          state: entry.state,
          occurredAt: entry.occurredAt,
          text: entry.text.replace(/\0/gu, '').slice(0, 8192),
          ...(entry.senderName === undefined ? {} : { senderName: safeName(entry.senderName, '用户') }),
          ...(entry.sessionName === undefined ? {} : { sessionName: safeName(entry.sessionName, 'Codex 对话') }),
          ...(code === undefined ? {} : { code }),
        }
      }),
      ...this.next(
        'conversation-activity',
        request.conversationToken,
        page,
        page.offset,
        page.entries.length,
        page.total,
        limit,
      ),
    }
  }
  async bindings(
    request: { conversationToken: string; afterCursor?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<ChannelManagerConversationBindingsPageV1> {
    this.assertLive(signal)
    if (Object.keys(request).some(key => !['conversationToken', 'afterCursor', 'limit'].includes(key))) {
      throw new Error('INVALID_REQUEST')
    }
    const target = this.resolve(request.conversationToken), scope = this.scope(target.ref)
    if (!await this.input.authorize('channel.bindings.read', scope)) throw new Error('PERMISSION_DENIED')
    const limit = request.limit ?? 100,
      cursor = this.cursor('conversation-bindings', request.conversationToken, request.afterCursor, limit)
    const snapshot = this.input.controller.bindingTargetsForConnection(
      target.connectionToken,
      target.ref.conversationId,
    )
    const fullBindings = new Map(snapshot.bindings.map(item => [item.bindingId, item.binding]))
    const result = await this.input.actions.run('conversation-bindings', {
      ref: target.ref,
      expectedGeneration: target.generation,
      expectedAccountGeneration: target.accountGeneration,
      ...this.pageInput(cursor, limit),
    })
    this.assertLive(signal)
    this.resolve(request.conversationToken)
    if (!await this.input.authorize('channel.bindings.read', scope)) throw new Error('PERMISSION_DENIED')
    const page = result.conversationBindings
    if (result.status !== 'applied' || !page) throw new Error(result.code ?? 'CHANNEL_BINDINGS_UNAVAILABLE')
    if (
      !sameConversation(page.conversation, target.ref) || page.generation !== target.generation
      || page.accountGeneration !== target.accountGeneration || page.bindings.length > limit
      || page.offset !== (cursor?.offset ?? 0)
    ) throw new Error('INVALID_CHANNEL_READBACK')
    if (
      snapshot.snapshotRevision
        !== this.input.controller.bindingTargetsForConnection(target.connectionToken, target.ref.conversationId)
          .snapshotRevision
    ) throw new Error('STALE_CHANNEL_REVISION')
    return {
      contract: 'cordisx.channel-manager-conversation-bindings-page/v1',
      schemaVersion: 1,
      ...this.readFence(page),
      conversationToken: request.conversationToken,
      connectionToken: target.connectionToken,
      total: page.total,
      bindings: page.bindings.map(label => {
        const binding = fullBindings.get(label.bindingId)
        if (!binding) throw new Error('STALE_CHANNEL_REVISION')
        return {
          ...binding,
          sessionName: safeName(label.sessionName, 'Codex 对话'),
          conversationName: safeName(label.conversationName, target.item.name),
        }
      }),
      ...this.next(
        'conversation-bindings',
        request.conversationToken,
        page,
        page.offset,
        page.bindings.length,
        page.total,
        limit,
      ),
    }
  }
  async openBinding(value: string, signal: AbortSignal): Promise<{ status: 'opened' | 'unavailable'; code?: string }> {
    this.assertLive(signal)
    const binding = this.input.controller.bindingTarget(value)
    if (
      !binding || !this.input.navigate
      || !await this.input.authorize('channel.accounts.read', { channelTenant: binding.channel })
      || !await this.input.authorize('channel.bindings.read', { channelTenant: binding.channel })
    ) return { status: 'unavailable', code: 'TARGET_UNAVAILABLE' }
    const result = await this.input.actions.run('binding-navigation', { bindingId: binding.bindingId })
    this.assertLive(signal)
    if (
      result.status !== 'applied' || this.input.controller.bindingTarget(value)?.bindingId !== binding.bindingId
      || !await this.input.authorize('channel.accounts.read', { channelTenant: binding.channel })
      || !await this.input.authorize('channel.bindings.read', { channelTenant: binding.channel })
      || result.bindingNavigation !== binding.session.remoteSessionId
    ) return { status: 'unavailable', code: 'TARGET_UNAVAILABLE' }
    await this.input.navigate(result.bindingNavigation)
    this.assertLive(signal)
    return { status: 'opened' }
  }
  dispose(): void {
    this.targets.clear()
    this.keys.clear()
    this.cursors.clear()
    this.state.entries.clear()
  }
}
