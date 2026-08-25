import { createHash, randomUUID } from 'node:crypto'
import {
  JsonChannelStore,
  type ChannelStoreState,
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
  ChannelEventRef,
  ChannelInboundEnvelope,
  ChannelInboundOperation,
  ChannelNotification,
  ChannelPermissionDecision,
  ChannelPermissionRequest,
  ChannelPluginIdentity,
  ChannelReceiveReceipt,
  ChannelRuntimeAccountSnapshot,
  ChannelRuntimeOptions,
  ChannelRuntimeSnapshot,
  ChannelSessionBinding,
  ChannelSubscriptionFilter,
  ChannelMessageListener,
  ChannelTaskResult,
  ChannelTenantRef,
  ChannelThreadRef,
  PlatformSessionRef,
  ResolvedChannelTaskOperation,
} from './types.js'

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

export class ChannelBindingUnavailableError extends Error {
  constructor() {
    super('No compatible Channel binding is available for this endpoint and route')
    this.name = 'ChannelBindingUnavailableError'
  }
}

export class ChannelIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChannelIntegrityError'
  }
}

interface ActiveConnection {
  readonly generation: number
  readonly connection: Awaited<ReturnType<ChannelAdapterDefinition['start']>>
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function normalizedErrorCode(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9._-]+/g, '_').slice(0, 128)
  return normalized.length === 0 ? 'CHANNEL_ERROR' : normalized
}

function errorCode(error: unknown): string {
  if (error instanceof RetryableChannelError) return error.code
  if (error instanceof ChannelBindingUnavailableError) return 'BINDING_UNAVAILABLE'
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

function accountKey(ref: ChannelTenantRef): string {
  return canonical([ref.adapterId, ref.accountId, ref.tenantId])
}

function threadKey(ref: ChannelThreadRef): string {
  return canonical([
    ref.adapterId,
    ref.accountId,
    ref.tenantId,
    ref.conversationId,
    ref.kind,
    ref.threadId,
    ref.semantics,
  ])
}

function endpointRouteKey(ref: ChannelThreadRef, routeId: string): string {
  return canonical([threadKey(ref), routeId])
}

function sessionKey(ref: PlatformSessionRef): string {
  return canonical([ref.providerId, ref.remoteSessionId])
}

function replayKey(event: ChannelEventRef): string {
  return canonical([event.adapterId, event.accountId, event.eventId])
}

function sameTenant(left: ChannelTenantRef, right: ChannelTenantRef): boolean {
  return accountKey(left) === accountKey(right)
}

function sameThread(left: ChannelThreadRef, right: ChannelThreadRef): boolean {
  return threadKey(left) === threadKey(right)
}

function appendAudit(state: ChannelStoreState, record: StoredAuditRecord): void {
  state.audit = [...state.audit, record].slice(-MAX_AUDIT_RECORDS)
}

function auditRecord(
  input: Omit<StoredAuditRecord, 'auditId' | 'source' | 'pluginId' | 'pluginGeneration'>
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

function requiredCapabilities(operation: ChannelInboundOperation): readonly ChannelCapability[] {
  switch (operation.kind) {
    case 'create': return ['channel.bindings.write', 'tasks.create', 'turns.submit']
    case 'list': return ['tasks.catalog.read']
    case 'status': return ['channel.bindings.read', 'tasks.catalog.read']
    case 'read': return ['channel.bindings.read', 'tasks.content.read']
    case 'open': return ['channel.bindings.read', 'tasks.catalog.read']
    case 'continue': return ['channel.bindings.read', 'tasks.control']
    case 'followup': return ['channel.bindings.read', 'agent.messages.append']
    case 'steer': return ['channel.bindings.read', 'agent.messages.append']
    case 'interrupt': return ['channel.bindings.read', 'turns.control']
    case 'archive': return ['channel.bindings.read', 'channel.bindings.write', 'tasks.control']
    case 'restore': return ['channel.bindings.read', 'channel.bindings.write', 'tasks.control']
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ChannelIntegrityError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter(key => !allowed.includes(key))
  if (extras.length > 0) throw new ChannelIntegrityError(`${label} contains unsupported fields`)
}

function nonEmptyText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}

function validateActor(value: unknown): void {
  const actor = objectRecord(value, 'Channel actor')
  exactKeys(actor, ['adapterId', 'accountId', 'tenantId', 'userId'], 'Channel actor')
  for (const field of ['adapterId', 'accountId', 'tenantId', 'userId']) {
    if (!nonEmptyText(actor[field], 512)) throw new ChannelIntegrityError(`Channel actor ${field} is invalid`)
  }
}

function validateEvent(value: unknown): void {
  const event = objectRecord(value, 'Channel event')
  exactKeys(event, [
    'adapterId', 'accountId', 'tenantId', 'conversationId', 'kind', 'threadId',
    'semantics', 'eventId', 'messageId', 'actor',
  ], 'Channel event')
  for (const field of ['adapterId', 'accountId', 'tenantId', 'conversationId', 'threadId', 'eventId']) {
    if (!nonEmptyText(event[field], 512)) throw new ChannelIntegrityError(`Channel event ${field} is invalid`)
  }
  if (event.messageId !== undefined && !nonEmptyText(event.messageId, 512)) {
    throw new ChannelIntegrityError('Channel event messageId is invalid')
  }
  if (event.kind !== 'direct' && event.kind !== 'group' && event.kind !== 'broadcast') {
    throw new ChannelIntegrityError('Channel conversation kind is invalid')
  }
  if (event.semantics !== 'conversation' && event.semantics !== 'topic' && event.semantics !== 'reply-chain') {
    throw new ChannelIntegrityError('Channel thread semantics are invalid')
  }
  if (event.actor !== undefined) validateActor(event.actor)
}

function validateSelector(value: unknown, label: string): void {
  const selector = objectRecord(value, label)
  if ('id' in selector) {
    exactKeys(selector, ['id'], label)
    if (!nonEmptyText(selector.id, 512)) throw new ChannelIntegrityError(`${label} id is invalid`)
    return
  }
  exactKeys(selector, ['useDefault'], label)
  if (selector.useDefault !== true) throw new ChannelIntegrityError(`${label} default selector is invalid`)
}

function validateOperation(value: unknown): void {
  const operation = objectRecord(value, 'Channel operation')
  if (operation.kind === 'create') {
    exactKeys(operation, ['kind', 'provider', 'model', 'profile', 'workspace'], 'Channel create operation')
    if (operation.provider !== undefined) validateSelector(operation.provider, 'Channel provider selector')
    if (operation.model !== undefined) validateSelector(operation.model, 'Channel model selector')
    if (operation.profile !== undefined) validateSelector(operation.profile, 'Channel profile selector')
    const workspace = objectRecord(operation.workspace, 'Channel workspace selector')
    exactKeys(workspace, ['alias'], 'Channel workspace selector')
    if (!nonEmptyText(workspace.alias, 512)) throw new ChannelIntegrityError('Channel workspace alias is invalid')
    return
  }
  if (operation.kind === 'list') {
    exactKeys(operation, ['kind', 'searchTerm'], 'Channel list operation')
    if (operation.searchTerm !== undefined && !nonEmptyText(operation.searchTerm, 1_000)) {
      throw new ChannelIntegrityError('Channel search term is invalid')
    }
    return
  }
  if (!['status', 'read', 'open', 'continue', 'followup', 'steer', 'interrupt', 'archive', 'restore'].includes(String(operation.kind))) {
    throw new ChannelIntegrityError('Channel operation kind is invalid')
  }
  exactKeys(operation, ['kind'], 'Channel operation')
}

function validateInput(ref: ChannelTenantRef, envelope: ChannelInboundEnvelope): void {
  const rawEnvelope = objectRecord(envelope, 'Channel inbound envelope')
  exactKeys(rawEnvelope, ['routeId', 'input', 'operation'], 'Channel inbound envelope')
  const input = objectRecord(envelope.input, 'Channel user input')
  exactKeys(input, ['contract', 'schemaVersion', 'role', 'content', 'source', 'receivedAt'], 'Channel user input')
  if (input.contract !== 'cordisx.channel-user-input/v1' || input.schemaVersion !== 1 || input.role !== 'user') {
    throw new ChannelIntegrityError('Channel ingress must be a version-1 sourced user input')
  }
  if (!Array.isArray(input.content) || input.content.length === 0 || input.content.length > 64) {
    throw new ChannelIntegrityError('Channel input content is invalid')
  }
  for (const [index, rawBlock] of input.content.entries()) {
    const block = objectRecord(rawBlock, `Channel content block ${index}`)
    if (block.type === 'text') {
      exactKeys(block, ['type', 'text'], `Channel content block ${index}`)
      if (!nonEmptyText(block.text, 100_000)) throw new ChannelIntegrityError('Channel text block is invalid')
    } else if (block.type === 'attachment') {
      exactKeys(block, ['type', 'handle', 'mediaType', 'name', 'size'], `Channel content block ${index}`)
      if (!nonEmptyText(block.handle, 512) || !nonEmptyText(block.mediaType, 255)) {
        throw new ChannelIntegrityError('Channel attachment handle or media type is invalid')
      }
      if (block.name !== undefined && !nonEmptyText(block.name, 1_024)) {
        throw new ChannelIntegrityError('Channel attachment name is invalid')
      }
      if (!Number.isInteger(block.size) || Number(block.size) < 0 || Number(block.size) > 1_073_741_824) {
        throw new ChannelIntegrityError('Channel attachment size is invalid')
      }
    } else {
      throw new ChannelIntegrityError('Channel content block type is invalid')
    }
  }
  const source = objectRecord(input.source, 'Channel input source')
  exactKeys(source, ['kind', 'event'], 'Channel input source')
  if (source.kind !== 'channel') throw new ChannelIntegrityError('Channel input source kind is invalid')
  validateEvent(source.event)
  if (!nonEmptyText(input.receivedAt, 64) || !Number.isFinite(Date.parse(input.receivedAt))) {
    throw new ChannelIntegrityError('Channel input receivedAt is invalid')
  }
  const typedEvent = envelope.input.source.event
  if (!sameTenant(ref, typedEvent)) {
    throw new ChannelIntegrityError('Channel event does not belong to the active adapter account/tenant')
  }
  if (typedEvent.actor !== undefined && !sameTenant(typedEvent, typedEvent.actor)) {
    throw new ChannelIntegrityError('Channel actor does not belong to the event account/tenant')
  }
  if (!nonEmptyText(envelope.routeId, 512)) throw new ChannelIntegrityError('Channel route id is invalid')
  validateOperation(envelope.operation)
}

function sanitizedTenant(ref: ChannelTenantRef): ChannelTenantRef {
  if (!nonEmptyText(ref.adapterId, 128)
    || !nonEmptyText(ref.accountId, 512)
    || !nonEmptyText(ref.tenantId, 512)) {
    throw new ChannelIntegrityError('Channel tenant identity is invalid')
  }
  return { adapterId: ref.adapterId, accountId: ref.accountId, tenantId: ref.tenantId }
}

function sanitizedDescriptor(descriptor: ChannelAdapterDescriptor): ChannelAdapterDescriptor {
  const ref = sanitizedTenant(descriptor.ref)
  if (!['simulator', 'feishu', 'lark', 'wecom-intelligent-bot', 'wecom-enterprise-app', 'wecom-message-push', 'wechat-service'].includes(descriptor.kind)) {
    throw new ChannelIntegrityError('Channel adapter kind is invalid')
  }
  if (!['implemented', 'verified', 'experimental', 'unavailable', 'planned'].includes(descriptor.implementationStatus)) {
    throw new ChannelIntegrityError('Channel adapter implementation status is invalid')
  }
  if (!Number.isInteger(descriptor.configurationRevision) || descriptor.configurationRevision < 1) {
    throw new ChannelIntegrityError('Channel adapter configuration revision is invalid')
  }
  if (!['missing', 'ready', 'unavailable'].includes(descriptor.secretState)) {
    throw new ChannelIntegrityError('Channel adapter secret readiness is invalid')
  }
  return {
    ref,
    kind: descriptor.kind,
    implementationStatus: descriptor.implementationStatus,
    configurationRevision: descriptor.configurationRevision,
    secretState: descriptor.secretState,
  }
}

function sanitizedThread(ref: ChannelThreadRef): ChannelThreadRef {
  if (!nonEmptyText(ref.adapterId, 128)
    || !nonEmptyText(ref.accountId, 512)
    || !nonEmptyText(ref.tenantId, 512)
    || !nonEmptyText(ref.conversationId, 512)
    || !nonEmptyText(ref.threadId, 512)) {
    throw new ChannelIntegrityError('Channel target identity is invalid')
  }
  if (ref.kind !== 'direct' && ref.kind !== 'group' && ref.kind !== 'broadcast') {
    throw new ChannelIntegrityError('Channel target conversation kind is invalid')
  }
  if (ref.semantics !== 'conversation' && ref.semantics !== 'topic' && ref.semantics !== 'reply-chain') {
    throw new ChannelIntegrityError('Channel target thread semantics are invalid')
  }
  return {
    adapterId: ref.adapterId,
    accountId: ref.accountId,
    tenantId: ref.tenantId,
    conversationId: ref.conversationId,
    kind: ref.kind,
    threadId: ref.threadId,
    semantics: ref.semantics,
  }
}

function findBinding(
  bindings: readonly ChannelSessionBinding[],
  channel: ChannelThreadRef,
  routeId: string,
  operation: ChannelInboundOperation['kind'],
): ChannelSessionBinding {
  const candidates = bindings
    .filter(binding => sameThread(binding.channel, channel) && binding.routeId === routeId)
    .sort((left, right) => right.revision - left.revision)
  const binding = operation === 'continue' || operation === 'restore'
    ? candidates.find(candidate => candidate.state !== 'unavailable')
    : candidates.find(candidate => candidate.state === 'active')
  if (binding === undefined) throw new ChannelBindingUnavailableError()
  return binding
}

function resolveOperation(
  operation: ChannelInboundOperation,
  binding: ChannelSessionBinding | undefined,
): ResolvedChannelTaskOperation {
  if (operation.kind === 'create' || operation.kind === 'list') return operation
  if (binding === undefined) throw new ChannelBindingUnavailableError()
  return { ...operation, session: binding.session }
}

export class ChannelRuntime {
  readonly #gateway: ChannelRuntimeOptions['gateway']
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

  private constructor(options: ChannelRuntimeOptions, store: JsonChannelStore) {
    this.#gateway = options.gateway
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
        appendAudit(state, auditRecord({
          caller,
          recordedAt: now,
          accountKey: key,
          generation,
          operationId,
          action: 'channel.adapter.activate',
          outcome: 'failed-last-good-retained',
        }))
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
        appendAudit(state, auditRecord({
          caller,
          recordedAt: now,
          accountKey: key,
          generation,
          operationId,
          action: 'channel.adapter.activate',
          outcome: 'ready',
        }))
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
          appendAudit(state, auditRecord({
            caller,
            recordedAt: failedAt,
            accountKey: key,
            generation,
            operationId,
            action: 'channel.adapter.replace',
            outcome: `prior-stop-failed:${errorCode(error)}`,
          }))
        })
      }
    }

    let handleDisposed = false
    return Object.freeze({
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
    } satisfies ChannelAdapterHandle)
  }

  async notify(
    notification: ChannelNotification,
    caller: ChannelPluginIdentity,
  ): Promise<ChannelDeliveryHandle> {
    this.#assertRuntimeActive()
    const target = sanitizedThread(notification.target)
    if (!['completion', 'approval', 'failure', 'reply'].includes(notification.kind)) {
      throw new ChannelIntegrityError('Channel notification kind is invalid')
    }
    if (!nonEmptyText(notification.text, 100_000)) {
      throw new ChannelIntegrityError('Channel notification text is invalid')
    }
    const key = accountKey(target)
    const adapter = this.#store.snapshot().adapters[key]
    if (adapter === undefined) throw new ChannelGenerationFencedError()
    const deliveryId = `delivery:${randomUUID()}`
    await this.#requirePermission({
      caller,
      capability: 'channel.messages.send',
      source: target,
      generation: adapter.generation,
      operationId: deliveryId,
    })
    const now = this.#now()
    await this.#store.transaction(state => {
      if (state.adapters[key]?.generation !== adapter.generation) throw new ChannelGenerationFencedError()
      state.outbox[deliveryId] = {
        deliveryId,
        accountKey: key,
        generation: adapter.generation,
        caller,
        target,
        kind: notification.kind,
        text: notification.text,
        createdAt: now,
        updatedAt: now,
        status: 'queued',
        attempts: 0,
      }
      appendAudit(state, auditRecord({
        caller,
        recordedAt: now,
        accountKey: key,
        generation: adapter.generation,
        operationId: deliveryId,
        action: 'channel.delivery.enqueue',
        outcome: 'queued',
      }))
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
      source: account,
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
    const bindings = [...state.bindings]
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId))
      .map(binding => ({
        bindingId: binding.bindingId,
        channel: binding.channel,
        session: binding.session,
        routeId: binding.routeId,
        revision: binding.revision,
        state: binding.state,
      }))
    return Object.freeze({
      contract: 'cordisx.channel-runtime-snapshot/v1',
      schemaVersion: 1,
      observedAt: this.#now(),
      accounts,
      bindings,
    })
  }

  auditSnapshot(): readonly ChannelAuditSnapshot[] {
    return this.#store.snapshot().audit
  }

  /**
   * Launcher-private binding controls. These change only the durable Channel
   * binding record; task/session controls remain the responsibility of the
   * configured gateway.
   */
  async archiveBinding(bindingId: string): Promise<'applied' | 'unavailable' | 'not-found'> {
    return await this.#setBindingState(bindingId, 'active', 'archived', 'archive')
  }

  async restoreBinding(bindingId: string): Promise<'applied' | 'unavailable' | 'not-found'> {
    return await this.#setBindingState(bindingId, 'archived', 'active', 'restore')
  }

  async unbind(bindingId: string): Promise<'applied' | 'not-found'> {
    this.#assertRuntimeActive()
    const now = this.#now()
    return await this.#store.transaction(state => {
      const index = state.bindings.findIndex(binding => binding.bindingId === bindingId)
      if (index < 0) return 'not-found' as const
      const binding = state.bindings[index]!
      state.bindings.splice(index, 1)
      this.#appendBindingAudit(state, binding, 'channel.binding.unbind', 'applied', now)
      return 'applied' as const
    })
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
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
    const recordId = `inbox:${digest(eventReplayKey)}`
    const operationId = `channel-operation:${digest([eventReplayKey, envelope.routeId])}`
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
      appendAudit(state, auditRecord({
        caller,
        recordedAt: now,
        accountKey: key,
        generation,
        operationId,
        action: 'channel.inbound.persist',
        outcome: 'queued',
        eventKey: eventReplayKey,
      }))
      return { recordId, duplicate: false, status: 'queued' }
    })
    if (!receipt.duplicate) queueMicrotask(() => {
      void this.#publishInput(recordId, generation, envelope).catch(() => undefined)
    })
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
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.recordId.localeCompare(right.recordId))[0]
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
      appendAudit(state, auditRecord({
        caller: record.caller,
        recordedAt: claimedAt,
        accountKey: key,
        generation,
        operationId: record.operationId,
        action: 'channel.inbound.claim',
        outcome: 'claimed',
        eventKey: replayKey(record.envelope.input.source.event),
      }))
      return structuredClone(record)
    })
    if (claimed === undefined) return

    try {
      let binding: ChannelSessionBinding | undefined
      if (claimed.envelope.operation.kind !== 'create' && claimed.envelope.operation.kind !== 'list') {
        binding = findBinding(
          this.#store.snapshot().bindings,
          claimed.envelope.input.source.event,
          claimed.envelope.routeId,
          claimed.envelope.operation.kind,
        )
      }
      for (const capability of requiredCapabilities(claimed.envelope.operation)) {
        const decision = await this.#permissions.authorize({
          caller: claimed.caller,
          capability,
          source: claimed.envelope.input.source.event,
          ...(binding === undefined ? {} : { session: binding.session }),
          generation,
          operationId: claimed.operationId,
        })
        if (decision !== 'allow') {
          await this.#finalizePermission(recordId, generation, capability, decision)
          return
        }
      }
      const operation = resolveOperation(claimed.envelope.operation, binding)
      const result = await this.#gateway.execute(operation, {
        operationId: claimed.operationId,
        routeId: claimed.envelope.routeId,
        input: claimed.envelope.input,
        ...(binding === undefined ? {} : { binding }),
      })
      await this.#finalizeApplied(recordId, generation, result)
    } catch (error) {
      await this.#finalizeFailure(recordId, generation, error)
    }
  }

  async #finalizePermission(
    recordId: string,
    generation: number,
    capability: ChannelCapability,
    decision: Exclude<ChannelPermissionDecision, 'allow'>,
  ): Promise<void> {
    const now = this.#now()
    await this.#store.transaction(state => {
      const current = state.inbox[recordId]
      if (current?.leaseGeneration !== generation || current.status !== 'processing') return
      if (state.adapters[current.accountKey]?.generation !== generation) return
      state.inbox[recordId] = {
        ...current,
        status: decision === 'ask' ? 'permission-pending' : 'denied',
        permission: decision,
        errorCode: decision === 'ask' ? 'PERMISSION_PENDING' : 'PERMISSION_DENIED',
        updatedAt: now,
      }
      appendAudit(state, auditRecord({
        caller: current.caller,
        recordedAt: now,
        accountKey: current.accountKey,
        generation,
        operationId: current.operationId,
        action: 'channel.permission',
        outcome: decision,
        capability,
        eventKey: replayKey(current.envelope.input.source.event),
      }))
    })
  }

  async #finalizeApplied(recordId: string, generation: number, result: ChannelTaskResult): Promise<void> {
    const now = this.#now()
    await this.#store.transaction(state => {
      const current = state.inbox[recordId]
      if (current?.leaseGeneration !== generation || current.status !== 'processing') return
      if (state.adapters[current.accountKey]?.generation !== generation) return
      let bindingRevision: number | undefined
      let targetSession = result.session
      if (current.envelope.operation.kind === 'create') {
        if (result.session === undefined) throw new ChannelIntegrityError('Task creation did not return a complete Platform session reference')
        const actor = current.envelope.input.source.event.actor
        if (actor === undefined) throw new ChannelIntegrityError('Task creation requires an attributed Channel actor')
        const endpoint = current.envelope.input.source.event
        const endpointKey = endpointRouteKey(endpoint, current.envelope.routeId)
        const revisions = state.bindings.filter(binding => endpointRouteKey(binding.channel, binding.routeId) === endpointKey)
        const revision = Math.max(0, ...revisions.map(binding => binding.revision)) + 1
        state.bindings = state.bindings.map(binding => (
          endpointRouteKey(binding.channel, binding.routeId) === endpointKey && binding.state === 'active'
            ? { ...binding, state: 'archived' as const, updatedAt: now }
            : binding
        ))
        const binding: ChannelSessionBinding = {
          contract: 'cordisx.channel-binding/v1',
          schemaVersion: 1,
          bindingId: `binding:${digest([endpointKey, sessionKey(result.session), revision])}`,
          channel: {
            adapterId: endpoint.adapterId,
            accountId: endpoint.accountId,
            tenantId: endpoint.tenantId,
            conversationId: endpoint.conversationId,
            kind: endpoint.kind,
            threadId: endpoint.threadId,
            semantics: endpoint.semantics,
          },
          session: result.session,
          createdBy: actor,
          createdFrom: endpoint,
          routeId: current.envelope.routeId,
          revision,
          state: 'active',
          createdAt: now,
          updatedAt: now,
        }
        state.bindings.push(binding)
        bindingRevision = revision
      } else if (current.envelope.operation.kind === 'archive'
        || current.envelope.operation.kind === 'restore'
        || current.envelope.operation.kind === 'continue') {
        const desired = current.envelope.operation.kind === 'archive' ? 'archived' : 'active'
        state.bindings = state.bindings.map(binding => {
          if (!sameThread(binding.channel, current.envelope.input.source.event)
            || binding.routeId !== current.envelope.routeId
            || (targetSession !== undefined && sessionKey(binding.session) !== sessionKey(targetSession))) return binding
          bindingRevision = binding.revision
          targetSession = binding.session
          return { ...binding, state: desired, updatedAt: now }
        })
      }
      state.inbox[recordId] = {
        ...current,
        status: 'applied',
        result,
        updatedAt: now,
      }
      appendAudit(state, auditRecord({
        caller: current.caller,
        recordedAt: now,
        accountKey: current.accountKey,
        generation,
        operationId: current.operationId,
        action: `channel.task.${current.envelope.operation.kind}`,
        outcome: 'applied',
        ...(bindingRevision === undefined ? {} : { bindingRevision }),
        ...(targetSession === undefined ? {} : { sessionKey: sessionKey(targetSession) }),
        eventKey: replayKey(current.envelope.input.source.event),
      }))
    })
  }

  async #finalizeFailure(recordId: string, generation: number, error: unknown): Promise<void> {
    const now = this.#clock.now()
    await this.#store.transaction(state => {
      const current = state.inbox[recordId]
      if (current?.leaseGeneration !== generation || current.status !== 'processing') return
      if (state.adapters[current.accountKey]?.generation !== generation) return
      const retry = error instanceof RetryableChannelError && current.attempts < this.#maxAttempts
      const terminalStatus = error instanceof RetryableChannelError ? 'dead-letter' : 'failed'
      const status = retry ? 'retrying' : terminalStatus
      const nextAttemptAt = retry
        ? new Date(now.getTime() + this.#retryDelay(current.attempts)).toISOString()
        : undefined
      state.inbox[recordId] = {
        ...current,
        status,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
        errorCode: errorCode(error),
        updatedAt: now.toISOString(),
      }
      appendAudit(state, auditRecord({
        caller: current.caller,
        recordedAt: now.toISOString(),
        accountKey: current.accountKey,
        generation,
        operationId: current.operationId,
        action: `channel.task.${current.envelope.operation.kind}`,
        outcome: status,
        eventKey: replayKey(current.envelope.input.source.event),
      }))
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
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deliveryId.localeCompare(right.deliveryId))[0]
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
          appendAudit(state, auditRecord({
            caller: current.caller,
            recordedAt: this.#now(),
            accountKey: current.accountKey,
            generation,
            operationId: current.deliveryId,
            action: 'channel.permission',
            outcome: decision,
            capability: 'channel.messages.send',
          }))
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
        appendAudit(state, auditRecord({
          caller: record.caller,
          recordedAt: claimedAt,
          accountKey: key,
          generation,
          operationId: record.deliveryId,
          action: 'channel.delivery.claim',
          outcome: 'claimed',
        }))
        return structuredClone(record)
      })
      if (claimed === undefined) continue

      try {
        const result = await active.connection.send({
          deliveryId: claimed.deliveryId,
          target: claimed.target,
          kind: claimed.kind,
          text: claimed.text,
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
          appendAudit(state, auditRecord({
            caller: current.caller,
            recordedAt: completedAt,
            accountKey: key,
            generation,
            operationId: current.deliveryId,
            action: 'channel.delivery.send',
            outcome: result.recallHandle === undefined ? 'sent-irreversible' : 'sent-recallable',
          }))
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
            ...(retry ? { nextAttemptAt: new Date(failedAt.getTime() + this.#retryDelay(current.attempts)).toISOString() } : {}),
            errorCode: errorCode(error),
            updatedAt: failedAt.toISOString(),
          }
          appendAudit(state, auditRecord({
            caller: current.caller,
            recordedAt: failedAt.toISOString(),
            accountKey: key,
            generation,
            operationId: current.deliveryId,
            action: 'channel.delivery.send',
            outcome: status,
          }))
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
      appendAudit(state, auditRecord({
        caller: current.caller,
        recordedAt: now,
        accountKey: current.accountKey,
        generation: current.generation,
        operationId: deliveryId,
        action: 'channel.delivery.cancel',
        outcome: 'cancelled-before-claim',
      }))
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

  async #setBindingState(
    bindingId: string,
    currentState: ChannelSessionBinding['state'],
    nextState: ChannelSessionBinding['state'],
    action: 'archive' | 'restore',
  ): Promise<'applied' | 'unavailable' | 'not-found'> {
    this.#assertRuntimeActive()
    const now = this.#now()
    return await this.#store.transaction(state => {
      const index = state.bindings.findIndex(binding => binding.bindingId === bindingId)
      if (index < 0) return 'not-found' as const
      const binding = state.bindings[index]!
      if (binding.state !== currentState) return 'unavailable' as const
      state.bindings[index] = { ...binding, state: nextState, updatedAt: now }
      this.#appendBindingAudit(state, binding, `channel.binding.${action}`, 'applied', now)
      return 'applied' as const
    })
  }

  #appendBindingAudit(
    state: ChannelStoreState,
    binding: ChannelSessionBinding,
    action: string,
    outcome: string,
    recordedAt: string,
  ): void {
    const adapter = state.adapters[accountKey(binding.channel)]
    if (adapter === undefined) return
    appendAudit(state, auditRecord({
      caller: adapter.owner,
      recordedAt,
      accountKey: accountKey(binding.channel),
      generation: adapter.generation,
      operationId: `binding:${binding.bindingId}`,
      action,
      outcome,
      bindingRevision: binding.revision,
    }))
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
