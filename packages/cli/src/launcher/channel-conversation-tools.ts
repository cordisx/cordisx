import type {
  ChannelRuntime,
  ChannelSubscriptionFilter,
  ChannelTenantRef,
  ChannelThreadRef,
} from '@cordisx/channel-runtime'
import { createHash } from 'node:crypto'
import { callerThreadId, callerTurnId } from './agent-bridge-context.js'
import type { ChannelConversationConsumer } from './channel-conversation-consumer.js'
import type { ChannelDirectoryReadback } from './channel-live-directory.js'
import type { ChannelCommandUserReadback } from './channel-command-users.js'
import { type ChannelReplyCapabilities, channelReplyMode, channelReplyTarget } from './channel-reply-routing.js'

export interface ChannelConversationAccess {
  readonly generation: string
  readonly runtime: ChannelRuntime
  accounts(): readonly { ref: ChannelTenantRef; name?: string; state: string }[]
  conversations(ref: ChannelTenantRef): Promise<ChannelDirectoryReadback>
  /** Launcher-only identity/capability lookups; no new plugin or Agent authority. */
  users?(event: import('@cordisx/channel-runtime').ChannelEventRef): Promise<ChannelCommandUserReadback>
  replyCapabilities?(event: import('@cordisx/channel-runtime').ChannelEventRef): ChannelReplyCapabilities
  name?(event: import('@cordisx/channel-runtime').ChannelEventRef): Promise<string | undefined>
  sendCard?(event: import('@cordisx/channel-runtime').ChannelEventRef, card: object): Promise<string>
  updateCard?(event: import('@cordisx/channel-runtime').ChannelEventRef, messageId: string, card: object): Promise<void>
  drain(ref: ChannelTenantRef): Promise<void>
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST')
  return value as Record<string, unknown>
}
const text = (value: unknown, maximum = 512, multiline = false): string => {
  if (
    typeof value !== 'string' || !value.trim() || value.length > maximum
    || (multiline ? /\0/u : /[\0\r\n]/u).test(value)
  ) {
    throw new Error('INVALID_REQUEST')
  }
  return value
}
const sameAccount = (left: ChannelTenantRef, right: ChannelTenantRef) =>
  left.adapterId === right.adapterId && left.accountId === right.accountId && left.tenantId === right.tenantId

/** Native tools and CLI reuse this launch's configured runtime, never a second SDK connection. */
export class ChannelConversationTools {
  private readonly lifetime = new AbortController()
  private pendingListeners = 0
  constructor(
    private readonly access: () => ChannelConversationAccess | undefined,
    private readonly consumer?: ChannelConversationConsumer,
    private readonly documents?: (input: unknown) => Promise<unknown>,
    private readonly execution?: (operation: string, args: Record<string, unknown>) => Promise<unknown>,
  ) {}

  async call(operation: string, value: unknown, metadata?: unknown): Promise<unknown> {
    try {
      if (this.lifetime.signal.aborted) throw new Error('CHANNEL_UNAVAILABLE')
      if (operation === 'docs') {
        return this.documents
          ? await this.documents(value)
          : { status: 'unavailable', code: 'DOCUMENTS_UNAVAILABLE' }
      }
      const input = object(value)
      if (operation.startsWith('execution-')) {
        if (!this.consumer && !this.execution) return { status: 'unavailable', code: 'EXECUTION_SETTINGS_UNAVAILABLE' }
        const callerSession = callerThreadId(metadata)
        if (callerSession && operation.endsWith('-set') && operation.includes('defaults')) {
          throw new Error('PROFILE_SETTINGS_REQUIRE_LOCAL_USER')
        }
        if (callerSession && input.sessionId !== undefined && input.sessionId !== callerSession) {
          throw new Error('SESSION_SCOPE_MISMATCH')
        }
        const args = {
          ...input,
          ...(operation.includes('defaults') ? {} : { sessionId: input.sessionId ?? callerSession }),
        }
        return this.execution
          ? await this.execution(operation, args)
          : await this.consumer!.executionOperation(operation, args)
      }
      const current = this.access()
      if (!current) return { status: 'unavailable', code: 'CHANNEL_NOT_CONFIGURED' }
      if (operation === 'reply-mode') {
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        const callerSession = callerThreadId(metadata)
        const sessionId = input.sessionId === undefined ? callerSession : text(input.sessionId)
        if (!sessionId) throw new Error('SESSION_REQUIRED')
        if (callerSession !== undefined && callerSession !== sessionId) throw new Error('REPLY_OPERATION_NOT_FOUND')
        const { sessionId: _session, ...request } = input
        return { status: 'ok', ...await this.consumer.selectReplyMode(request, sessionId, callerTurnId(metadata)) }
      }
      if (['bind', 'unbind', 'bind-status', 'history', 'policy', 'policy-set'].includes(operation)) {
        if (!this.consumer) return { status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' }
        if (operation === 'policy') return { status: 'ok', ...this.consumer.policy() }
        if (operation === 'policy-set') {
          if (
            Object.keys(input).some(key => !['policy', 'expectedRevision'].includes(key))
            || !Number.isSafeInteger(input.expectedRevision)
          ) {
            throw new Error('INVALID_REQUEST')
          }
          return { status: 'ok', ...await this.consumer.policySet(input.policy, Number(input.expectedRevision)) }
        }
        // Native metadata defaults to the current chat. Local CLI may explicitly address a chat in this profile.
        const sessionId = input.sessionId === undefined ? callerThreadId(metadata) : text(input.sessionId)
        if (!sessionId) throw new Error('SESSION_REQUIRED')
        const { sessionId: _session, ...request } = input
        if (operation === 'bind') return { status: 'ok', binding: await this.consumer.bind(request, sessionId) }
        if (operation === 'unbind') return { status: 'ok', removed: await this.consumer.unbind(request, sessionId) }
        if (operation === 'history') return this.consumer.history(request, sessionId)
        if (Object.keys(request).length) throw new Error('INVALID_REQUEST')
        return this.consumer.status(sessionId)
      }
      if (operation === 'connections') {
        if (Object.keys(input).length) throw new Error('INVALID_REQUEST')
        return { status: 'ok', generation: current.generation, connections: current.accounts() }
      }
      const account = object(input.account)
      if (Object.keys(account).some(key => !['adapterId', 'accountId', 'tenantId'].includes(key))) {
        throw new Error('INVALID_REQUEST')
      }
      const ref = {
        adapterId: text(account.adapterId),
        accountId: text(account.accountId),
        tenantId: text(account.tenantId),
      }
      if (
        !current.accounts().some(item =>
          sameAccount(item.ref, ref) && (operation === 'receipt' || item.state === 'ready')
        )
      ) {
        throw new Error('CONNECTION_NOT_READY')
      }
      const caller = {
        source: 'cordisx:native-channel',
        pluginId: 'host-channel-tools',
        // Correlation is not an ownership or permission grant. The endpoint is launch/user scoped.
        generation: callerThreadId(metadata) ?? 'local-cli',
      }
      if (operation === 'conversations') {
        if (Object.keys(input).some(key => key !== 'account')) throw new Error('INVALID_REQUEST')
        const directory = await current.conversations(ref)
        return { status: directory.complete ? 'ok' : 'partial', generation: current.generation, ...directory }
      }
      if (operation === 'send' || operation === 'send-many' || operation === 'receipt') {
        const allowed = operation === 'send'
          ? ['account', 'target', 'text', 'operationId']
          : operation === 'send-many'
          ? ['account', 'targets', 'text', 'operationId']
          : ['account', 'operationId', 'targetCount']
        if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('INVALID_REQUEST')
        const operationId = text(input.operationId, 128)
        const targets = operation === 'send-many' ? input.targets : [input.target]
        if (operation === 'send-many' && (!Array.isArray(targets) || !targets.length || targets.length > 1000)) {
          throw new Error('INVALID_TARGET')
        }
        const sendText = operation === 'receipt' ? undefined : text(input.text, 8192, true)
        // Validate the entire batch before enqueueing its first effect.
        const parsed = operation === 'receipt' ? [] : (targets as unknown[]).map(value => {
          const raw = object(value)
          if (Object.keys(raw).some(key => !['id', 'kind', 'replyTo', 'replyMode'].includes(key))) {
            throw new Error('INVALID_REQUEST')
          }
          const id = text(raw.id)
          if (
            !['direct', 'group'].includes(String(raw.kind)) || !/^(?:oc_|ou_)[A-Za-z0-9_]+$/u.test(id)
            || raw.kind === 'group' && !id.startsWith('oc_')
          ) throw new Error('INVALID_TARGET')
          const replyTo = raw.replyTo === undefined ? undefined : text(raw.replyTo)
          if (replyTo !== undefined && (!id.startsWith('oc_') || !/^om_[A-Za-z0-9_]+$/u.test(replyTo))) {
            throw new Error('INVALID_TARGET')
          }
          const mode = raw.replyMode === undefined
            ? replyTo === undefined ? 'conversation' : 'reply'
            : channelReplyMode(raw.replyMode)
          if (mode === 'none' || mode === 'agent' || mode === 'conversation' && replyTo !== undefined) {
            throw new Error('INVALID_REPLY_MODE')
          }
          const target: ChannelThreadRef = channelReplyTarget({
            ...ref,
            conversationId: id,
            kind: raw.kind as 'direct' | 'group',
            threadId: id,
            semantics: 'conversation',
            eventId: operationId,
            ...(replyTo === undefined ? {} : { messageId: replyTo }),
          }, mode)
          if (this.consumer && !this.consumer.sendAllowed({ ...target, eventId: input.operationId as string })) {
            throw new Error('CHANNEL_POLICY_DENIED')
          }
          return target
        })
        if (
          operation === 'receipt' && input.targetCount !== undefined && (!Number.isSafeInteger(input.targetCount)
            || Number(input.targetCount) < 1 || Number(input.targetCount) > 1000)
        ) throw new Error('INVALID_REQUEST')
        const multiple = operation === 'send-many' || operation === 'receipt' && input.targetCount !== undefined
        const count = operation === 'receipt' ? Number(input.targetCount ?? 1) : parsed.length
        const receipts: unknown[] = []
        let attempted = 0
        try {
          for (let index = 0; index < count; index += 1) {
            if (this.lifetime.signal.aborted || this.access()?.generation !== current.generation) {
              throw new Error('CHANNEL_GENERATION_CHANGED')
            }
            const deliveryId = `delivery:${
              createHash('sha256').update(
                JSON.stringify([caller, ref, multiple ? `${operationId}:${index}` : operationId]),
              ).digest('hex')
            }`
            if (operation !== 'receipt') {
              attempted += 1
              await current.runtime.notifyOnce(
                { target: parsed[index]!, kind: 'reply', text: sendText! },
                caller,
                deliveryId,
              )
              if (!this.lifetime.signal.aborted) await current.drain(ref)
            }
            // Missing is explicit. JSON.stringify must never silently erase a missing receipt.
            receipts.push(current.runtime.deliverySnapshot(deliveryId, caller) ?? null)
          }
        } catch (error) {
          return {
            status: 'partial',
            generation: current.generation,
            operationId,
            deliveryState: 'unknown',
            receipts,
            attempted,
            code: error instanceof Error && /^[A-Z_]+$/u.test(error.message)
              ? error.message
              : 'CHANNEL_EFFECT_UNCERTAIN',
          }
        }
        return {
          status: 'ok',
          generation: current.generation,
          operationId,
          deliveryState: receipts.every(receipt => (receipt as { state?: string } | null)?.state === 'sent')
            ? 'sent'
            : receipts.every(receipt => receipt === null)
            ? 'not-found'
            : receipts.some(receipt =>
                ['dead-letter', 'cancelled'].includes(String((receipt as { state?: string } | null)?.state))
              )
            ? 'failed'
            : receipts.some(receipt =>
                ['queued', 'sending', 'retrying'].includes(String((receipt as { state?: string } | null)?.state))
              )
            ? 'pending'
            : 'unknown',
          ...(multiple ? { receipts } : { receipt: receipts[0] }),
        }
      }
      if (
        operation !== 'listen'
        || Object.keys(input).some(key =>
          !['account', 'conversationIds', 'afterCursor', 'timeoutSeconds'].includes(key)
        )
      ) {
        throw new Error('INVALID_REQUEST')
      }
      if (!Array.isArray(input.conversationIds) || !input.conversationIds.length) {
        throw new Error('INVALID_TARGET')
      }
      const ids = input.conversationIds.map(id => text(id))
      if (ids.some(id => !/^oc_[A-Za-z0-9_]+$/u.test(id)) || new Set(ids).size !== ids.length) {
        throw new Error('INVALID_TARGET')
      }
      const timeout = input.timeoutSeconds ?? 30
      if (!Number.isInteger(timeout) || Number(timeout) < 0 || Number(timeout) > 60 || this.pendingListeners >= 16) {
        throw new Error('INVALID_DURATION')
      }
      const filters: ChannelSubscriptionFilter[] = ids.map(conversationId => ({ account: ref, conversationId }))
      const cursor = input.afterCursor === undefined ? current.runtime.latestInputCursor() : text(input.afterCursor)
      let readback = await current.runtime.inputsSince(caller, filters, cursor, 50)
      if (readback.messages.length || timeout === 0) return { status: 'ok', ...readback }
      this.pendingListeners += 1
      const subscriptions: (() => void)[] = []
      let timer: ReturnType<typeof setTimeout> | undefined
      let wake: () => void = () => {}
      const ready = new Promise<void>(resolve => {
        wake = resolve
      })
      const abort = () => wake()
      this.lifetime.signal.addEventListener('abort', abort, { once: true })
      try {
        for (const filter of filters) subscriptions.push(await current.runtime.subscribe(caller, filter, wake))
        // Re-read after registration so an event between the first read and subscribe is retained.
        readback = await current.runtime.inputsSince(caller, filters, cursor, 50)
        if (!readback.messages.length) {
          timer = setTimeout(wake, Number(timeout) * 1000)
          await ready
          const latest = this.access()
          if (
            this.lifetime.signal.aborted || latest?.generation !== current.generation
            || latest.runtime !== current.runtime
          ) {
            throw new Error('CHANNEL_GENERATION_CHANGED')
          }
          readback = await current.runtime.inputsSince(caller, filters, cursor, 50)
        }
        return { status: 'ok', ...readback }
      } finally {
        this.pendingListeners -= 1
        if (timer) clearTimeout(timer)
        this.lifetime.signal.removeEventListener('abort', abort)
        subscriptions.forEach(dispose => dispose())
      }
    } catch (error) {
      const code = error instanceof Error && /^[A-Z_]{3,80}$/u.test(error.message)
        ? error.message
        : 'CHANNEL_OPERATION_FAILED'
      return { status: 'rejected', code }
    }
  }
  dispose(): void {
    this.lifetime.abort()
  }
}
