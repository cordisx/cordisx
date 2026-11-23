import { appendAudit, auditRecord } from './runtime-audit.js'
import { isEligibleOutbox } from './outbound-enqueue.js'
import { ChannelDeliveryObservers } from './delivery-observers.js'
export type { ChannelSentDelivery } from './delivery-observers.js'
import { createHash, randomUUID } from 'node:crypto'
import { runtimeSnapshot, visibleConnections } from './runtime-snapshot.js'
import { validateOutboundMedia } from './outbound-media.js'
import { validateOutboundContent } from './outbound-content.js'
import { mentionCapabilities, validateMentionAuthority, validateMentionDispatch } from './outbound-mention.js'
import { outboundAdapterDefinition, sendOutboundPublic } from './outbound-public.js'
import { enqueueOutbound, outboundCapabilitiesPublic } from './outbound-enqueue.js'
import {
  ChannelGenerationFencedError,
  ChannelPermissionError,
  errorCode,
  RetryableChannelError,
  secretStateForStartFailure,
  UncertainChannelSendError,
} from './runtime-errors.js'
export {
  ChannelGenerationFencedError,
  ChannelPermissionError,
  RetryableChannelError,
  UncertainChannelSendError,
} from './runtime-errors.js'
import type {
  ChannelMediaPrepareRequestV1,
  ChannelMessageSendV1,
  ChannelOutboundCapabilitiesV1,
  ChannelPreparedMediaV1,
  ChannelSendHandleV1,
} from '@cordisx/protocol/channel-outbound/v1'
import type { ChannelAdapterDefinitionV2 } from '@cordisx/protocol/channel-runtime/v2'
import { type ChannelQuestionCard, validateQuestionCard } from './question-card.js'
import { deliverySnapshot, inputsSince, latestInputCursor } from './consumer-readback.js'
import { conversationReadback, localConversationRefs } from './conversation-readback.js'
import {
  accountKey,
  canonical,
  channelInboxRecordId,
  ChannelIntegrityError,
  digest,
  nonEmptyText,
  replayKey,
  sameTenant,
  sanitizedDescriptor,
  sanitizedTenant,
  sanitizedThread,
  validateInput,
} from './runtime-validation.js'
import type { StoredInboxRecord, StoredOutboxRecord } from './store.js'
import { JsonChannelStore } from './store.js'
import type {
  ChannelAdapterDefinition,
  ChannelAdapterDescriptor,
  ChannelAdapterHandle,
  ChannelAuditSnapshot,
  ChannelClock,
  ChannelDeliveryHandle,
  ChannelInboundEnvelope,
  ChannelMessageListener,
  ChannelNotification,
  ChannelPermissionRequest,
  ChannelPluginIdentity,
  ChannelReceiveReceipt,
  ChannelRuntimeAccountSnapshot,
  ChannelRuntimeOptions,
  ChannelRuntimeSnapshot,
  ChannelSubscriptionFilter,
  ChannelTenantRef,
  ChannelThreadRef,
} from './types.js'
export { ChannelIntegrityError } from './runtime-validation.js'

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_RETRY_BASE_MS = 1_000

const SYSTEM_CLOCK: ChannelClock = Object.freeze({ now: () => new Date() })

interface ActiveConnection {
  readonly generation: number
  readonly connection: Awaited<ReturnType<ChannelAdapterDefinition['start']>>
}

function isEligibleInbox(record: StoredInboxRecord, now: number): boolean {
  if (record.status === 'queued') return true
  if (record.status === 'retrying') return Date.parse(record.nextAttemptAt ?? '') <= now
  return record.status === 'processing' && Date.parse(record.leaseExpiresAt ?? '') <= now
}

export class ChannelRuntime {
  readonly #permissions: ChannelRuntimeOptions['permissions']
  readonly #outboundMediaDescriptor: ChannelRuntimeOptions['outboundMediaDescriptor']
  readonly #prepareOutbound: ChannelRuntimeOptions['prepareOutbound']
  readonly #resolveOutboundMedia: ChannelRuntimeOptions['resolveOutboundMedia']
  readonly #store: JsonChannelStore
  readonly #clock: ChannelClock
  readonly #maxAttempts: number
  readonly #leaseMs: number
  readonly #retryBaseMs: number
  readonly #connections = new Map<string, ActiveConnection>()
  readonly #subscriptions = new Map<string, {
    readonly caller: ChannelPluginIdentity
    readonly filter: ChannelSubscriptionFilter
    readonly listener: ChannelMessageListener
  }>()
  #disposed = false
  readonly #deliveryObservers = new ChannelDeliveryObservers()
  observeSentDelivery = this.#deliveryObservers.observeSent
  observeOutbound = this.#deliveryObservers.observeEnqueued
  async notifyGuardedOnce(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
    id: string,
    guard: () => boolean,
  ) {
    if (this.#store.snapshot().outbox[id] && !this.#store.snapshot().outbox[id]?.guardedDelivery) {
      throw new ChannelIntegrityError('Guarded delivery conflicts with unguarded operation')
    }
    this.#deliveryObservers.guard(id, guard)
    return this.notifyOnce(notification, caller, id)
  }

  private constructor(options: ChannelRuntimeOptions, store: JsonChannelStore) {
    this.#permissions = options.permissions
    this.#outboundMediaDescriptor = options.outboundMediaDescriptor
    this.#prepareOutbound = options.prepareOutbound
    this.#resolveOutboundMedia = options.resolveOutboundMedia
    this.#store = store
    this.#clock = options.clock ?? SYSTEM_CLOCK
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS
    if (this.#maxAttempts < 1) throw new RangeError('maxAttempts must be at least 1')
    if (this.#leaseMs < 1) throw new RangeError('leaseMs must be positive')
    if (this.#retryBaseMs < 1) throw new RangeError('retryBaseMs must be positive')
  }

  static async open(options: ChannelRuntimeOptions): Promise<ChannelRuntime> {
    return new ChannelRuntime(options, await JsonChannelStore.open(options.storePath))
  }

  async activate(
    definition: ChannelAdapterDefinition,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelAdapterHandle> {
    this.#assertRuntimeActive()
    const descriptor = sanitizedDescriptor(definition.descriptor)
    const key = accountKey(descriptor.ref)
    const existing = this.#store.snapshot().adapters[key]
    if (existing !== undefined && descriptor.configurationRevision < existing.lastGoodRevision) {
      throw new ChannelIntegrityError('Channel adapter configuration revision is older than last-good')
    }
    const generation = (existing?.generation ?? 0) + 1
    const operationId = `activate:${digest([key, descriptor.configurationRevision, generation])}`
    await this.#requirePermission({
      caller,
      capability: 'channel.accounts.connect',
      source: descriptor.ref,
      generation,
      operationId,
    })

    let connection: ActiveConnection['connection']
    try {
      connection = await definition.start({
        generation,
        ref: descriptor.ref,
        receive: envelope => this.#receiveAt(descriptor.ref, generation, caller, envelope),
        drainInbound: async limit => await this.#drainInboundAt(descriptor.ref, generation, limit),
        drainOutbound: async limit => await this.#drainOutboundAt(descriptor.ref, generation, limit),
      })
    } catch (error) {
      const now = this.#now()
      await this.#store.transaction(state => {
        const current = state.adapters[key]
        state.adapters[key] = current === undefined
          ? {
            ...descriptor,
            secretState: secretStateForStartFailure(descriptor, error),
            owner: caller,
            generation: 1,
            lastGoodRevision: 0,
            connectionState: 'unavailable',
            lastErrorCode: errorCode(error),
          }
          : { ...current, secretState: secretStateForStartFailure(current, error), lastErrorCode: errorCode(error) }
        appendAudit(
          state,
          auditRecord({
            caller,
            recordedAt: now,
            accountKey: key,
            generation,
            operationId,
            action: 'channel.adapter.activate',
            outcome: 'failed-last-good-retained',
          }),
        )
      })
      throw error
    }

    const now = this.#now()
    try {
      await this.#store.transaction(state => {
        state.adapters[key] = {
          ...descriptor,
          owner: caller,
          generation,
          lastGoodRevision: descriptor.configurationRevision,
          connectionState: 'ready',
          cursorUpdatedAt: now,
        }
        appendAudit(
          state,
          auditRecord({
            caller,
            recordedAt: now,
            accountKey: key,
            generation,
            operationId,
            action: 'channel.adapter.activate',
            outcome: 'ready',
          }),
        )
      })
    } catch (error) {
      await connection.stop('failed').catch(() => undefined)
      throw error
    }

    const prior = this.#connections.get(key)
    this.#connections.set(key, { generation, connection })
    if (prior !== undefined) {
      try {
        await prior.connection.stop('replaced')
      } catch (error) {
        const failedAt = this.#now()
        await this.#store.transaction(state => {
          const adapter = state.adapters[key]
          if (adapter?.generation === generation) {
            state.adapters[key] = { ...adapter, lastErrorCode: 'PRIOR_GENERATION_STOP_FAILED' }
          }
          appendAudit(
            state,
            auditRecord({
              caller,
              recordedAt: failedAt,
              accountKey: key,
              generation,
              operationId,
              action: 'channel.adapter.replace',
              outcome: `prior-stop-failed:${errorCode(error)}`,
            }),
          )
        })
      }
    }

    let handleDisposed = false
    return Object.freeze(
      {
        ref: descriptor.ref,
        generation,
        receive: async (envelope: ChannelInboundEnvelope) => {
          if (handleDisposed) throw new ChannelGenerationFencedError()
          return await this.#receiveAt(descriptor.ref, generation, caller, envelope)
        },
        drainInbound: async (limit?: number) => {
          if (handleDisposed) throw new ChannelGenerationFencedError()
          return await this.#drainInboundAt(descriptor.ref, generation, limit)
        },
        drainOutbound: async (limit?: number) => {
          if (handleDisposed) throw new ChannelGenerationFencedError()
          return await this.#drainOutboundAt(descriptor.ref, generation, limit)
        },
        dispose: async () => {
          if (handleDisposed) return
          handleDisposed = true
          await this.#disposeGeneration(descriptor.ref, generation)
        },
      } satisfies ChannelAdapterHandle,
    )
  }

  async deactivate(ref: ChannelTenantRef): Promise<void> {
    this.#assertRuntimeActive()
    const key = accountKey(sanitizedTenant(ref))
    const current = this.#connections.get(key)
    if (current !== undefined) {
      await current.connection.stop('replaced')
      this.#connections.delete(key)
    }
    await this.#store.transaction(state => {
      const adapter = state.adapters[key]
      if (adapter !== undefined) state.adapters[key] = { ...adapter, connectionState: 'disabled' }
    })
  }

  async drainOutbound(ref: ChannelTenantRef, limit = 100): Promise<number> {
    const generation = this.#store.snapshot().adapters[accountKey(ref)]?.generation
    if (generation === undefined) throw new ChannelGenerationFencedError()
    return this.#drainOutboundAt(ref, generation, limit)
  }

  async notify(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelDeliveryHandle> {
    return this.notifyOnce(notification, caller, `delivery:${randomUUID()}`)
  }

  async notifyOnce(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
    deliveryId: string,
  ): Promise<ChannelDeliveryHandle> {
    return this.#enqueueNotification(notification, caller, deliveryId)
  }

  async sendTyped(
    request: ChannelMessageSendV1,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelSendHandleV1> {
    if (request.contract !== 'cordisx.channel-message-send/v1' || request.schemaVersion !== 1) {
      throw new ChannelIntegrityError('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
    }
    return sendOutboundPublic(
      request,
      caller,
      (notification, identity, id) => this.notifyOnce(notification, identity, id),
      id => this.#store.snapshot().outbox[id],
    )
  }

  async sendTypedV2(
    request: import('@cordisx/protocol/channel-outbound/v2').ChannelMessageSendV2,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelSendHandleV1> {
    if (request.contract !== 'cordisx.channel-message-send/v2' || request.schemaVersion !== 2) {
      throw new ChannelIntegrityError('CHANNEL_TYPED_CONTENT_PROTOCOL_UNAVAILABLE')
    }
    return sendOutboundPublic(
      request,
      caller,
      (notification, identity, id) => this.notifyOnce(notification, identity, id),
      id => this.#store.snapshot().outbox[id],
    )
  }

  async outboundCapabilitiesV2(
    target: ChannelThreadRef,
    caller: ChannelPluginIdentity,
  ): Promise<import('@cordisx/protocol/channel-outbound/v2').ChannelOutboundCapabilitiesV2> {
    const original = await this.outboundCapabilities(target, caller)
    const connection = this.#connections.get(accountKey(target))?.connection
    return mentionCapabilities(original, connection)
  }

  async validateMentionContent(
    target: ChannelThreadRef,
    content: import('./outbound-content.js').ChannelOutboundContent,
    caller: ChannelPluginIdentity,
  ): Promise<void> {
    this.#assertRuntimeActive()
    const safeTarget = sanitizedThread(target)
    const active = this.#connections.get(accountKey(safeTarget))
    if (!active) throw new ChannelGenerationFencedError()
    await validateMentionAuthority(safeTarget, content, caller, active, request => this.#requirePermission(request))
    this.#assertGeneration(safeTarget, active.generation)
  }

  sendOutbound(request: ChannelMessageSendV1, caller: ChannelPluginIdentity): Promise<ChannelSendHandleV1> {
    return this.sendTyped(request, caller)
  }

  async outboundCapabilities(
    target: ChannelThreadRef,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelOutboundCapabilitiesV1> {
    return outboundCapabilitiesPublic(
      {
        assertActive: () => this.#assertRuntimeActive(),
        store: this.#store,
        requirePermission: request => this.#requirePermission(request),
        connections: this.#connections,
        FencedError: ChannelGenerationFencedError,
      },
      target,
      caller,
    )
  }

  async prepareOutbound(
    request: ChannelMediaPrepareRequestV1,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelPreparedMediaV1> {
    await this.outboundCapabilities(request.target, caller)
    if (!this.#prepareOutbound) throw new ChannelIntegrityError('Prepared media broker unavailable')
    return this.#prepareOutbound(request, caller)
  }

  async activateV2(
    definition: ChannelAdapterDefinitionV2,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelAdapterHandle> {
    return this.activate(
      outboundAdapterDefinition(
        definition,
        id => this.#store.snapshot().outbox[id],
        this.#resolveOutboundMedia,
        ref => this.#store.snapshot().adapters[accountKey(ref)]?.generation,
      ),
      caller,
    )
  }

  async notifyQuestionOnce(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
    deliveryId: string,
    card: ChannelQuestionCard,
  ): Promise<ChannelDeliveryHandle> {
    return this.#enqueueNotification(notification, caller, deliveryId, validateQuestionCard(card))
  }

  async #enqueueNotification(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
    deliveryId: string,
    questionCard?: ChannelQuestionCard,
  ): Promise<ChannelDeliveryHandle> {
    return enqueueOutbound(
      {
        assertActive: () => this.#assertRuntimeActive(),
        store: this.#store,
        connections: this.#connections,
        requirePermission: request => this.#requirePermission(request),
        mediaDescriptor: this.#outboundMediaDescriptor,
        observers: this.#deliveryObservers.enqueued,
        guarded: id => this.#deliveryObservers.guarded(id),
        now: () => this.#now(),
        cancel: id => this.#cancelDelivery(id),
        FencedError: ChannelGenerationFencedError,
        appendAudit,
        auditRecord,
      },
      notification,
      caller,
      deliveryId,
      questionCard,
    )
  }

  async connections(caller: ChannelPluginIdentity): Promise<readonly ChannelRuntimeAccountSnapshot[]> {
    this.#assertRuntimeActive()
    return visibleConnections(this.snapshot(), this.#permissions, caller)
  }

  deliverySnapshot(id: string, caller: ChannelPluginIdentity) {
    return deliverySnapshot(this.#store.snapshot(), id, caller)
  }
  latestInputCursor(): string {
    return latestInputCursor(this.#store.snapshot())
  }
  /** Launcher-owned management projection; not exposed by the brokered plugin facade. */
  conversationReadback(ref: import('./types.js').ChannelConversationRef) {
    this.#assertRuntimeActive()
    return conversationReadback(this.#store.snapshot(), ref)
  }
  accountConversationReadback(ref: ChannelTenantRef) {
    this.#assertRuntimeActive()
    return conversationReadback(this.#store.snapshot(), sanitizedTenant(ref))
  }
  localConversationRefs(ref: ChannelTenantRef) {
    this.#assertRuntimeActive()
    return localConversationRefs(this.#store.snapshot(), ref)
  }
  async inputsSince(
    caller: ChannelPluginIdentity,
    filters: readonly ChannelSubscriptionFilter[],
    cursor: string,
    limit = 50,
  ) {
    this.#assertRuntimeActive()
    return inputsSince(this.#store.snapshot(), this.#permissions, caller, filters, cursor, limit)
  }

  async subscribe(
    caller: ChannelPluginIdentity,
    filter: ChannelSubscriptionFilter,
    listener: ChannelMessageListener,
  ): Promise<() => void> {
    this.#assertRuntimeActive()
    const account = sanitizedTenant(filter.account)
    if (filter.conversationId !== undefined && !nonEmptyText(filter.conversationId, 512)) {
      throw new ChannelIntegrityError('Channel subscription conversationId is invalid')
    }
    if (filter.userId !== undefined && !nonEmptyText(filter.userId, 512)) {
      throw new ChannelIntegrityError('Channel subscription userId is invalid')
    }
    const safeFilter: ChannelSubscriptionFilter = {
      account,
      ...(filter.conversationId === undefined ? {} : { conversationId: filter.conversationId }),
      ...(filter.userId === undefined ? {} : { userId: filter.userId }),
    }
    const adapter = this.#store.snapshot().adapters[accountKey(account)]
    if (adapter === undefined) throw new ChannelGenerationFencedError()
    const subscriptionId = `subscription:${randomUUID()}`
    await this.#requirePermission({
      caller,
      capability: 'channel.events.subscribe',
      source: {
        ...account,
        ...(safeFilter.conversationId === undefined ? {} : { conversationId: safeFilter.conversationId }),
        ...(safeFilter.userId === undefined ? {} : { actor: { ...account, userId: safeFilter.userId } }),
      },
      generation: adapter.generation,
      operationId: subscriptionId,
    })
    this.#subscriptions.set(subscriptionId, { caller, filter: safeFilter, listener })
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.#subscriptions.delete(subscriptionId)
    }
  }

  snapshot(): ChannelRuntimeSnapshot {
    return runtimeSnapshot(this.#store.snapshot(), this.#now())
  }

  auditSnapshot(): readonly ChannelAuditSnapshot[] {
    return this.#store.snapshot().audit
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#deliveryObservers.dispose()
    this.#subscriptions.clear()
    const active = [...this.#connections.entries()]
    this.#connections.clear()
    await Promise.all(active.map(async ([key, item]) => {
      await item.connection.stop('disposed')
      const now = this.#now()
      await this.#store.transaction(state => {
        const adapter = state.adapters[key]
        if (adapter?.generation === item.generation) {
          state.adapters[key] = { ...adapter, connectionState: 'stopped' }
        }
      })
    }))
  }

  async #receiveAt(
    ref: ChannelTenantRef,
    generation: number,
    caller: ChannelPluginIdentity,
    envelope: ChannelInboundEnvelope,
  ): Promise<ChannelReceiveReceipt> {
    this.#assertRuntimeActive()
    this.#assertGeneration(ref, generation)
    validateInput(ref, envelope)
    const event = envelope.input.source.event
    const eventReplayKey = replayKey(event)
    const recordId = channelInboxRecordId(event)
    const operationId = `channel-event:${digest(eventReplayKey)}`
    const key = accountKey(ref)
    await this.#requirePermission({
      caller,
      capability: 'channel.events.receive',
      source: event,
      generation,
      operationId,
    })
    const fingerprint = digest(envelope)
    const now = this.#now()
    const receipt = await this.#store.transaction<ChannelReceiveReceipt>(state => {
      if (state.adapters[key]?.generation !== generation) throw new ChannelGenerationFencedError()
      const existing = state.inbox[recordId]
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new ChannelIntegrityError('A replay identity was reused with different normalized content')
        }
        return { recordId, duplicate: true, status: existing.status }
      }
      state.inbox[recordId] = {
        recordId,
        fingerprint,
        accountKey: key,
        operationId,
        caller,
        envelope,
        generation,
        receivedAt: now,
        updatedAt: now,
        status: 'queued',
        attempts: 0,
      }
      const adapter = state.adapters[key]
      if (adapter !== undefined) state.adapters[key] = { ...adapter, cursorUpdatedAt: now }
      appendAudit(
        state,
        auditRecord({
          caller,
          recordedAt: now,
          accountKey: key,
          generation,
          operationId,
          action: 'channel.inbound.persist',
          outcome: 'queued',
          eventKey: eventReplayKey,
        }),
      )
      return { recordId, duplicate: false, status: 'queued' }
    })
    if (!receipt.duplicate) {
      queueMicrotask(() => {
        void this.#publishInput(recordId, generation, envelope).catch(() => undefined)
      })
    }
    return receipt
  }

  async #drainInboundAt(ref: ChannelTenantRef, generation: number, limit = 100): Promise<number> {
    this.#assertRuntimeActive()
    this.#assertGeneration(ref, generation)
    const key = accountKey(ref)
    let processed = 0
    while (processed < Math.max(0, limit)) {
      this.#assertGeneration(ref, generation)
      const nowMs = this.#clock.now().getTime()
      const next = Object.values(this.#store.snapshot().inbox)
        .filter(record => record.accountKey === key && isEligibleInbox(record, nowMs))
        .sort((left, right) =>
          left.receivedAt.localeCompare(right.receivedAt) || left.recordId.localeCompare(right.recordId)
        )[0]
      if (next === undefined) break
      await this.#processInbox(next.recordId, ref, generation)
      processed += 1
    }
    return processed
  }

  async #processInbox(recordId: string, ref: ChannelTenantRef, generation: number): Promise<void> {
    const key = accountKey(ref)
    const claimedAt = this.#now()
    const leaseExpiresAt = new Date(Date.parse(claimedAt) + this.#leaseMs).toISOString()
    const claimed = await this.#store.transaction(state => {
      const current = state.inbox[recordId]
      if (current === undefined || current.accountKey !== key || !isEligibleInbox(current, Date.parse(claimedAt))) {
        return undefined
      }
      if (state.adapters[key]?.generation !== generation) return undefined
      const record: StoredInboxRecord = {
        ...current,
        generation,
        status: 'processing',
        attempts: current.attempts + 1,
        leaseGeneration: generation,
        leaseExpiresAt,
        updatedAt: claimedAt,
      }
      state.inbox[recordId] = record
      appendAudit(
        state,
        auditRecord({
          caller: record.caller,
          recordedAt: claimedAt,
          accountKey: key,
          generation,
          operationId: record.operationId,
          action: 'channel.inbound.claim',
          outcome: 'claimed',
          eventKey: replayKey(record.envelope.input.source.event),
        }),
      )
      return structuredClone(record)
    })
    if (claimed === undefined) return

    await this.#finalizeEventAccepted(recordId, generation)
  }

  async #finalizeEventAccepted(recordId: string, generation: number): Promise<void> {
    const now = this.#now()
    await this.#store.transaction(state => {
      const current = state.inbox[recordId]
      if (current?.leaseGeneration !== generation || current.status !== 'processing') return
      if (state.adapters[current.accountKey]?.generation !== generation) return
      state.inbox[recordId] = { ...current, status: 'applied', updatedAt: now }
      appendAudit(
        state,
        auditRecord({
          caller: current.caller,
          recordedAt: now,
          accountKey: current.accountKey,
          generation,
          operationId: current.operationId,
          action: 'channel.event.accept',
          outcome: 'applied',
          eventKey: replayKey(current.envelope.input.source.event),
        }),
      )
    })
  }

  async #drainOutboundAt(ref: ChannelTenantRef, generation: number, limit = 100): Promise<number> {
    this.#assertRuntimeActive()
    this.#assertGeneration(ref, generation)
    const key = accountKey(ref)
    const active = this.#connections.get(key)
    if (active?.generation !== generation) throw new ChannelGenerationFencedError()
    let processed = 0
    while (processed < Math.max(0, limit)) {
      this.#assertGeneration(ref, generation)
      const nowMs = this.#clock.now().getTime()
      const next = Object.values(this.#store.snapshot().outbox)
        .filter(record => record.accountKey === key && isEligibleOutbox(record, nowMs, this.#leaseMs))
        .sort((left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.deliveryId.localeCompare(right.deliveryId)
        )[0]
      if (next === undefined) break

      const decision = await this.#permissions.authorize({
        caller: next.caller,
        capability: 'channel.messages.send',
        source: next.target,
        generation,
        operationId: next.deliveryId,
      })
      if (decision !== 'allow') {
        await this.#store.transaction(state => {
          const current = state.outbox[next.deliveryId]
          if (current === undefined) return
          state.outbox[next.deliveryId] = {
            ...current,
            status: 'dead-letter',
            errorCode: decision === 'ask' ? 'PERMISSION_PENDING' : 'PERMISSION_DENIED',
            updatedAt: this.#now(),
          }
          appendAudit(
            state,
            auditRecord({
              caller: current.caller,
              recordedAt: this.#now(),
              accountKey: current.accountKey,
              generation,
              operationId: current.deliveryId,
              action: 'channel.permission',
              outcome: decision,
              capability: 'channel.messages.send',
            }),
          )
        })
        processed += 1
        continue
      }

      const claimedAt = this.#now()
      const claimed = await this.#store.transaction(state => {
        const current = state.outbox[next.deliveryId]
        if (current === undefined || !isEligibleOutbox(current, Date.parse(claimedAt), this.#leaseMs)) return undefined
        if (state.adapters[key]?.generation !== generation) return undefined
        const record: StoredOutboxRecord = {
          ...current,
          generation,
          status: 'processing',
          attempts: current.attempts + 1,
          claimedAt,
          updatedAt: claimedAt,
        }
        state.outbox[next.deliveryId] = record
        appendAudit(
          state,
          auditRecord({
            caller: record.caller,
            recordedAt: claimedAt,
            accountKey: key,
            generation,
            operationId: record.deliveryId,
            action: 'channel.delivery.claim',
            outcome: 'claimed',
          }),
        )
        return structuredClone(record)
      })
      if (claimed === undefined) continue
      if (claimed.guardedDelivery && !this.#deliveryObservers.permitted(claimed.deliveryId)) {
        await this.#store.transaction(state => this.#deliveryObservers.cancelStale(state, claimed, this.#now()))
        processed += 1
        continue
      }

      try {
        if (claimed.content && claimed.effectiveType !== 'text') {
          await validateMentionDispatch(claimed.target, claimed.content, active.connection)
        }
        if (claimed.content && !(active.connection.outboundTypes ?? ['text']).includes(claimed.effectiveType!)) {
          throw new ChannelIntegrityError('Effective outbound type is no longer supported')
        }
        if (claimed.media && active.connection.supportsOutboundMedia !== true) {
          throw new ChannelIntegrityError('Channel adapter media support is unavailable')
        }
        const result = await active.connection.send({
          deliveryId: claimed.deliveryId,
          target: claimed.target,
          kind: claimed.kind,
          text: claimed.text,
          ...(claimed.idempotencyKey === undefined ? {} : { idempotencyKey: claimed.idempotencyKey }),
          ...(claimed.content
            ? {
              content: claimed.effectiveType === 'text'
                ? { type: 'text' as const, text: claimed.text }
                : validateOutboundContent(claimed.content),
              fallback: claimed.fallback!,
              requestedType: claimed.requestedType!,
              effectiveType: claimed.effectiveType!,
            }
            : {}),
          ...(claimed.media ? { media: validateOutboundMedia(claimed.media) } : {}),
          ...(claimed.questionCard ? { questionCard: claimed.questionCard } : {}),
          createdAt: claimed.createdAt,
        })
        const completedAt = this.#now()
        if (!result || typeof result.externalMessageId !== 'string' || result.externalMessageId.length === 0) {
          throw new UncertainChannelSendError('OUTBOUND_RECEIPT_MISSING')
        }
        const sent = await this.#store.transaction(state => {
          const current = state.outbox[claimed.deliveryId]
          if (current?.generation !== generation || current.status !== 'processing') return
          if (state.adapters[current.accountKey]?.generation !== generation) return
          state.outbox[claimed.deliveryId] = {
            ...current,
            status: 'sent',
            externalMessageId: result.externalMessageId,
            ...(result.recallHandle === undefined ? {} : { recallHandle: result.recallHandle }),
            updatedAt: completedAt,
          }
          appendAudit(
            state,
            auditRecord({
              caller: current.caller,
              recordedAt: completedAt,
              accountKey: key,
              generation,
              operationId: current.deliveryId,
              action: 'channel.delivery.send',
              outcome: result.recallHandle === undefined ? 'sent-irreversible' : 'sent-recallable',
            }),
          )
          return true
        })
        if (sent) {
          this.#deliveryObservers.confirmed({
            target: claimed.target,
            caller: claimed.caller,
            deliveryId: claimed.deliveryId,
            createdAt: claimed.createdAt,
            sentAt: completedAt,
          })
        }
      } catch (error) {
        const failedAt = this.#clock.now()
        await this.#store.transaction(state => {
          const current = state.outbox[claimed.deliveryId]
          if (current?.generation !== generation || current.status !== 'processing') return
          if (state.adapters[current.accountKey]?.generation !== generation) return
          const retry = error instanceof RetryableChannelError && current.attempts < this.#maxAttempts
          const status = error instanceof UncertainChannelSendError ? 'unknown' : retry ? 'retrying' : 'dead-letter'
          state.outbox[claimed.deliveryId] = {
            ...current,
            status,
            ...(retry
              ? { nextAttemptAt: new Date(failedAt.getTime() + this.#retryDelay(current.attempts)).toISOString() }
              : {}),
            errorCode: errorCode(error),
            updatedAt: failedAt.toISOString(),
          }
          appendAudit(
            state,
            auditRecord({
              caller: current.caller,
              recordedAt: failedAt.toISOString(),
              accountKey: key,
              generation,
              operationId: current.deliveryId,
              action: 'channel.delivery.send',
              outcome: status,
            }),
          )
        })
      }
      processed += 1
    }
    return processed
  }

  async #cancelDelivery(deliveryId: string): Promise<'cancelled' | 'irreversible' | 'not-found'> {
    const now = this.#now()
    return this.#store.transaction(state => {
      const current = state.outbox[deliveryId]
      if (current === undefined) return 'not-found'
      if (current.status === 'processing' || current.status === 'sent' || current.status === 'unknown') {
        return 'irreversible'
      }
      if (current.status !== 'queued' && current.status !== 'retrying') return 'not-found'
      state.outbox[deliveryId] = { ...current, status: 'cancelled', updatedAt: now }
      appendAudit(
        state,
        auditRecord({
          caller: current.caller,
          recordedAt: now,
          accountKey: current.accountKey,
          generation: current.generation,
          operationId: deliveryId,
          action: 'channel.delivery.cancel',
          outcome: 'cancelled-before-claim',
        }),
      )
      return 'cancelled'
    })
  }

  async #publishInput(
    recordId: string,
    generation: number,
    envelope: ChannelInboundEnvelope,
  ): Promise<void> {
    const event = envelope.input.source.event
    const subscriptions = [...this.#subscriptions.entries()].filter(([, subscription]) => (
      sameTenant(subscription.filter.account, event)
      && (subscription.filter.conversationId === undefined
        || subscription.filter.conversationId === event.conversationId)
      && (subscription.filter.userId === undefined
        || subscription.filter.userId === event.actor?.userId)
    ))
    await Promise.allSettled(subscriptions.map(async ([subscriptionId, subscription]) => {
      if (!this.#subscriptions.has(subscriptionId)) return
      const decision = await this.#permissions.authorize({
        caller: subscription.caller,
        capability: 'channel.events.subscribe',
        source: event,
        generation,
        operationId: `${subscriptionId}:${recordId}`,
      })
      if (decision !== 'allow' || !this.#subscriptions.has(subscriptionId)) return
      await subscription.listener(Object.freeze({
        delivery: 'live-experimental',
        recordId,
        input: structuredClone(envelope.input),
      }))
    }))
  }

  async #requirePermission(request: ChannelPermissionRequest): Promise<void> {
    const decision = await this.#permissions.authorize(request)
    if (decision !== 'allow') throw new ChannelPermissionError(request.capability, decision)
  }

  async #disposeGeneration(ref: ChannelTenantRef, generation: number): Promise<void> {
    const key = accountKey(ref)
    const active = this.#connections.get(key)
    if (active?.generation !== generation) return
    this.#connections.delete(key)
    await active.connection.stop('disposed')
    await this.#store.transaction(state => {
      const adapter = state.adapters[key]
      if (adapter?.generation === generation) {
        state.adapters[key] = { ...adapter, connectionState: 'stopped' }
      }
    })
  }

  #assertGeneration(ref: ChannelTenantRef, generation: number): void {
    const key = accountKey(ref)
    const adapter = this.#store.snapshot().adapters[key]
    const active = this.#connections.get(key)
    if (adapter?.generation !== generation || active?.generation !== generation) {
      throw new ChannelGenerationFencedError()
    }
  }

  #retryDelay(attempts: number): number {
    return Math.min(60_000, this.#retryBaseMs * (2 ** Math.max(0, attempts - 1)))
  }

  #now(): string {
    return this.#clock.now().toISOString()
  }

  #assertRuntimeActive(): void {
    if (this.#disposed) throw new Error('Channel runtime is disposed')
  }
}
