import { randomUUID } from 'node:crypto'
import { validateOutboundMedia } from './outbound-media.js'
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
import {
  type ChannelStoreState,
  JsonChannelStore,
  type StoredAuditRecord,
  type StoredInboxRecord,
  type StoredOutboxRecord,
} from './store.js'
import type {
  ChannelAdapterDefinition,
  ChannelAdapterDescriptor,
  ChannelAdapterHandle,
  ChannelAuditSnapshot,
  ChannelCapability,
  ChannelClock,
  ChannelDeliveryHandle,
  ChannelInboundEnvelope,
  ChannelMessageListener,
  ChannelNotification,
  ChannelPermissionDecision,
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
const MAX_AUDIT_RECORDS = 2_000

const SYSTEM_CLOCK: ChannelClock = Object.freeze({ now: () => new Date() })

export class RetryableChannelError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RetryableChannelError'
    this.code = normalizedErrorCode(code)
  }
}

export class ChannelPermissionError extends Error {
  readonly capability: ChannelCapability
  readonly decision: Exclude<ChannelPermissionDecision, 'allow'>

  constructor(capability: ChannelCapability, decision: Exclude<ChannelPermissionDecision, 'allow'>) {
    super(`Channel capability ${capability} is ${decision}`)
    this.name = 'ChannelPermissionError'
    this.capability = capability
    this.decision = decision
  }
}

export class ChannelGenerationFencedError extends Error {
  constructor() {
    super('Channel adapter generation is no longer current')
    this.name = 'ChannelGenerationFencedError'
  }
}

interface ActiveConnection {
  readonly generation: number
  readonly connection: Awaited<ReturnType<ChannelAdapterDefinition['start']>>
}

function normalizedErrorCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9._-]+/g, '_').slice(0, 128)
  return normalized.length === 0 ? 'CHANNEL_ERROR' : normalized
}

function errorCode(error: unknown): string {
  if (error instanceof RetryableChannelError) return error.code
  if (error instanceof ChannelIntegrityError) return 'INTEGRITY_ERROR'
  return normalizedErrorCode(error instanceof Error ? error.name : 'CHANNEL_ERROR')
}

function secretStateForStartFailure(
  descriptor: ChannelAdapterDescriptor,
  error: unknown,
): ChannelAdapterDescriptor['secretState'] {
  if (!(error instanceof Error)) return descriptor.secretState
  if (error.name === 'CHANNEL_SECRET_MISSING') return 'missing'
  if (error.name === 'CHANNEL_SECRET_UNAVAILABLE' || error.name === 'CHANNEL_SECRET_REF_INVALID') return 'unavailable'
  return descriptor.secretState
}

function appendAudit(state: ChannelStoreState, record: StoredAuditRecord): void {
  state.audit = [...state.audit, record].slice(-MAX_AUDIT_RECORDS)
}

function auditRecord(
  input:
    & Omit<StoredAuditRecord, 'auditId' | 'source' | 'pluginId' | 'pluginGeneration'>
    & { readonly caller: ChannelPluginIdentity },
): StoredAuditRecord {
  const { caller, ...record } = input
  return {
    ...record,
    source: caller.source,
    pluginId: caller.pluginId,
    pluginGeneration: caller.generation,
    auditId: `audit:${randomUUID()}`,
  }
}

function isEligibleInbox(record: StoredInboxRecord, now: number): boolean {
  if (record.status === 'queued') return true
  if (record.status === 'retrying') return Date.parse(record.nextAttemptAt ?? '') <= now
  return record.status === 'processing' && Date.parse(record.leaseExpiresAt ?? '') <= now
}

function isEligibleOutbox(record: StoredOutboxRecord, now: number, leaseMs: number): boolean {
  if (record.status === 'queued') return true
  if (record.status === 'retrying') return Date.parse(record.nextAttemptAt ?? '') <= now
  return record.status === 'processing' && Date.parse(record.claimedAt ?? '') + leaseMs <= now
}

export class ChannelRuntime {
  readonly #permissions: ChannelRuntimeOptions['permissions']
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
  readonly #outboundObservers = new Set<(target: ChannelThreadRef) => void>()

  /** Launcher-only observation before enqueue; failures never change delivery. */
  observeOutbound(listener: (target: ChannelThreadRef) => void): () => void {
    this.#outboundObservers.add(listener)
    return () => {
      this.#outboundObservers.delete(listener)
    }
  }

  private constructor(options: ChannelRuntimeOptions, store: JsonChannelStore) {
    this.#permissions = options.permissions
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

  /** Launcher lifecycle control for one account; queues and every other connection remain intact. */
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

  /** Launcher-only operation identity. Public plugin send retains its existing API. */
  async notifyOnce(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
    deliveryId: string,
  ): Promise<ChannelDeliveryHandle> {
    return this.#enqueueNotification(notification, caller, deliveryId)
  }

  /** Host-only bounded question; plugin notifications remain text-only. */
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
    this.#assertRuntimeActive()
    const target = sanitizedThread(notification.target)
    if (!['completion', 'approval', 'failure', 'reply'].includes(notification.kind)) {
      throw new ChannelIntegrityError('Channel notification kind is invalid')
    }
    const media = notification.media === undefined ? undefined : validateOutboundMedia(notification.media)
    if (media && (notification.text !== '' || questionCard !== undefined)) {
      throw new ChannelIntegrityError('Media cannot be combined with text or a question card')
    }
    if (!media && !nonEmptyText(notification.text, 100_000)) {
      throw new ChannelIntegrityError('Channel notification text is invalid')
    }
    const key = accountKey(target)
    const adapter = this.#store.snapshot().adapters[key]
    if (adapter === undefined) throw new ChannelGenerationFencedError()
    if (!/^delivery:[A-Za-z0-9-]{1,128}$/u.test(deliveryId)) {
      throw new ChannelIntegrityError('Invalid delivery identity')
    }
    await this.#requirePermission({
      caller,
      capability: 'channel.messages.send',
      source: target,
      generation: adapter.generation,
      operationId: deliveryId,
    })
    for (const listener of this.#outboundObservers) {
      try {
        listener(target)
      } catch { /* ancillary feedback cannot affect delivery */ }
    }
    const now = this.#now()
    await this.#store.transaction(state => {
      if (state.adapters[key]?.generation !== adapter.generation) throw new ChannelGenerationFencedError()
      const prior = state.outbox[deliveryId]
      if (prior) {
        if (
          canonical(prior.caller) !== canonical(caller) || canonical(prior.target) !== canonical(target)
          || prior.kind !== notification.kind || prior.text !== notification.text
          || canonical(prior.media ?? null) !== canonical(media ?? null)
          || canonical(prior.questionCard ?? null) !== canonical(questionCard ?? null)
        ) throw new ChannelIntegrityError('Operation conflict')
        return
      }
      state.outbox[deliveryId] = {
        deliveryId,
        accountKey: key,
        generation: adapter.generation,
        caller,
        target,
        kind: notification.kind,
        text: notification.text,
        ...(media ? { media } : {}),
        ...(questionCard ? { questionCard } : {}),
        createdAt: now,
        updatedAt: now,
        status: 'queued',
        attempts: 0,
      }
      appendAudit(
        state,
        auditRecord({
          caller,
          recordedAt: now,
          accountKey: key,
          generation: adapter.generation,
          operationId: deliveryId,
          action: 'channel.delivery.enqueue',
          outcome: 'queued',
        }),
      )
    })
    return Object.freeze({
      deliveryId,
      cancel: () => this.#cancelDelivery(deliveryId),
    })
  }

  async connections(caller: ChannelPluginIdentity): Promise<readonly ChannelRuntimeAccountSnapshot[]> {
    this.#assertRuntimeActive()
    const snapshot = this.snapshot()
    const visible: ChannelRuntimeAccountSnapshot[] = []
    for (const account of snapshot.accounts) {
      const decision = await this.#permissions.authorize({
        caller,
        capability: 'channel.accounts.read',
        source: account.ref,
        generation: account.generation,
        operationId: `connections:${digest([caller, account.ref, account.generation])}`,
      })
      if (decision === 'allow') visible.push(account)
    }
    return visible
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
    const state = this.#store.snapshot()
    const accounts = Object.entries(state.adapters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, adapter]) => {
        const inbox = Object.values(state.inbox).filter(record => record.accountKey === key)
        const outbox = Object.values(state.outbox).filter(record => record.accountKey === key)
        return {
          ref: adapter.ref,
          adapterKind: adapter.kind,
          implementationStatus: adapter.implementationStatus,
          connectionState: adapter.connectionState,
          secretState: adapter.secretState,
          generation: adapter.generation,
          lastGoodRevision: adapter.lastGoodRevision,
          ...(adapter.cursorUpdatedAt === undefined ? {} : { cursorUpdatedAt: adapter.cursorUpdatedAt }),
          ...(adapter.lastErrorCode === undefined ? {} : { lastErrorCode: adapter.lastErrorCode }),
          inbound: {
            pending: inbox.filter(record => record.status === 'queued' || record.status === 'processing').length,
            retrying: inbox.filter(record => record.status === 'retrying').length,
            deadLetter: inbox.filter(record => record.status === 'dead-letter').length,
          },
          outbound: {
            pending: outbox.filter(record => record.status === 'queued' || record.status === 'processing').length,
            retrying: outbox.filter(record => record.status === 'retrying').length,
            deadLetter: outbox.filter(record => record.status === 'dead-letter').length,
          },
        }
      })
    return Object.freeze({
      contract: 'cordisx.channel-runtime-snapshot/v1',
      schemaVersion: 1,
      observedAt: this.#now(),
      accounts,
    })
  }

  auditSnapshot(): readonly ChannelAuditSnapshot[] {
    return this.#store.snapshot().audit
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#outboundObservers.clear()
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

      try {
        if (claimed.media && active.connection.supportsOutboundMedia !== true) {
          throw new ChannelIntegrityError('Channel adapter media support is unavailable')
        }
        const result = await active.connection.send({
          deliveryId: claimed.deliveryId,
          target: claimed.target,
          kind: claimed.kind,
          text: claimed.text,
          ...(claimed.media ? { media: validateOutboundMedia(claimed.media) } : {}),
          ...(claimed.questionCard ? { questionCard: claimed.questionCard } : {}),
          createdAt: claimed.createdAt,
        })
        const completedAt = this.#now()
        await this.#store.transaction(state => {
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
        })
      } catch (error) {
        const failedAt = this.#clock.now()
        await this.#store.transaction(state => {
          const current = state.outbox[claimed.deliveryId]
          if (current?.generation !== generation || current.status !== 'processing') return
          if (state.adapters[current.accountKey]?.generation !== generation) return
          const retry = error instanceof RetryableChannelError && current.attempts < this.#maxAttempts
          const status = retry ? 'retrying' : 'dead-letter'
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
      if (current.status === 'processing' || current.status === 'sent') return 'irreversible'
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
