export const CHANNEL_USER_INPUT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-user-input.v1.schema.json'
export const CHANNEL_BINDING_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-binding.v1.schema.json'
export const CHANNEL_RUNTIME_SNAPSHOT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-runtime-snapshot.v1.schema.json'

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface ChannelAccountRef {
  readonly adapterId: string
  readonly accountId: string
}

export interface ChannelTenantRef extends ChannelAccountRef {
  readonly tenantId: string
}

export interface ChannelConversationRef extends ChannelTenantRef {
  readonly conversationId: string
  readonly kind: 'direct' | 'group' | 'broadcast'
}

export interface ChannelThreadRef extends ChannelConversationRef {
  readonly threadId: string
  readonly semantics: 'conversation' | 'topic' | 'reply-chain'
}

export interface ChannelUserRef extends ChannelTenantRef {
  readonly userId: string
}

export interface ChannelEventRef extends ChannelThreadRef {
  readonly eventId: string
  readonly messageId?: string
  readonly actor?: ChannelUserRef
}

export interface PlatformSessionRef {
  readonly providerId: string
  readonly remoteSessionId: string
}

export type ChannelContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
    readonly type: 'attachment'
    readonly handle: string
    readonly mediaType: string
    readonly name?: string
    readonly size: number
  }

export interface ChannelUserInput {
  readonly contract: 'cordisx.channel-user-input/v1'
  readonly schemaVersion: 1
  readonly role: 'user'
  readonly content: readonly ChannelContentBlock[]
  readonly source: {
    readonly kind: 'channel'
    readonly event: ChannelEventRef
  }
  readonly receivedAt: string
}

export interface ChannelSessionBinding {
  readonly contract: 'cordisx.channel-binding/v1'
  readonly schemaVersion: 1
  readonly bindingId: string
  readonly channel: ChannelThreadRef
  readonly session: PlatformSessionRef
  readonly createdBy: ChannelUserRef
  readonly createdFrom: ChannelEventRef
  readonly routeId: string
  readonly revision: number
  readonly state: 'active' | 'archived' | 'unavailable'
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ChannelTaskCreateOperation {
  readonly kind: 'create'
  readonly provider?: { readonly id: string } | { readonly useDefault: true }
  readonly model?: { readonly id: string } | { readonly useDefault: true }
  readonly profile?: { readonly id: string } | { readonly useDefault: true }
  readonly workspace: { readonly alias: string }
}

export type ChannelInboundOperation =
  | ChannelTaskCreateOperation
  | { readonly kind: 'list'; readonly searchTerm?: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'read' }
  | { readonly kind: 'open' }
  | { readonly kind: 'continue' }
  | { readonly kind: 'followup' }
  | { readonly kind: 'steer' }
  | { readonly kind: 'interrupt' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'restore' }

export interface ChannelInboundEnvelope {
  readonly routeId: string
  readonly input: ChannelUserInput
  readonly operation: ChannelInboundOperation
}

export type ResolvedChannelTaskOperation =
  | ChannelTaskCreateOperation
  | { readonly kind: 'list'; readonly searchTerm?: string }
  | { readonly kind: 'status'; readonly session: PlatformSessionRef }
  | { readonly kind: 'read'; readonly session: PlatformSessionRef }
  | { readonly kind: 'open'; readonly session: PlatformSessionRef }
  | { readonly kind: 'continue'; readonly session: PlatformSessionRef }
  | { readonly kind: 'followup'; readonly session: PlatformSessionRef }
  | { readonly kind: 'steer'; readonly session: PlatformSessionRef }
  | { readonly kind: 'interrupt'; readonly session: PlatformSessionRef }
  | { readonly kind: 'archive'; readonly session: PlatformSessionRef }
  | { readonly kind: 'restore'; readonly session: PlatformSessionRef }

export interface ChannelTaskContext {
  readonly operationId: string
  readonly routeId: string
  readonly input: ChannelUserInput
  readonly binding?: ChannelSessionBinding
}

export interface ChannelTaskResult {
  readonly session?: PlatformSessionRef
  readonly data?: Readonly<Record<string, JsonValue>>
}

export interface ChannelTaskGateway {
  execute(operation: ResolvedChannelTaskOperation, context: ChannelTaskContext): Promise<ChannelTaskResult>
}

export interface ChannelPluginIdentity {
  /** Launcher-owned canonical package source. */
  readonly source: string
  readonly pluginId: string
  readonly generation: string
}

export type ChannelCapability =
  | 'models.read'
  | 'tasks.catalog.read'
  | 'tasks.content.read'
  | 'tasks.create'
  | 'tasks.control'
  | 'turns.submit'
  | 'turns.control'
  | 'agent.events.read'
  | 'agent.messages.append'
  | 'channel.accounts.read'
  | 'channel.accounts.connect'
  | 'channel.events.receive'
  | 'channel.events.subscribe'
  | 'channel.messages.send'
  | 'channel.bindings.read'
  | 'channel.bindings.write'
  | 'channel.attachments.read'

export interface ChannelPermissionRequest {
  readonly caller: ChannelPluginIdentity
  readonly capability: ChannelCapability
  readonly source: ChannelEventRef | ChannelTenantRef
  readonly session?: PlatformSessionRef
  readonly generation: number
  readonly operationId: string
}

export type ChannelPermissionDecision = 'allow' | 'ask' | 'deny'

export interface ChannelPermissionBroker {
  authorize(request: ChannelPermissionRequest): Promise<ChannelPermissionDecision>
}

export type ChannelAdapterKind =
  | 'simulator'
  | 'feishu'
  | 'lark'
  | 'wecom-intelligent-bot'
  | 'wecom-enterprise-app'
  | 'wecom-message-push'
  | 'wechat-service'

export type ChannelImplementationStatus =
  | 'implemented'
  | 'verified'
  | 'experimental'
  | 'unavailable'
  | 'planned'

export interface ChannelAdapterDescriptor {
  readonly ref: ChannelTenantRef
  readonly kind: ChannelAdapterKind
  readonly implementationStatus: ChannelImplementationStatus
  readonly configurationRevision: number
  readonly secretState: 'missing' | 'ready' | 'unavailable'
}

export interface ChannelOutboundDelivery {
  readonly deliveryId: string
  readonly target: ChannelThreadRef
  readonly kind: 'completion' | 'approval' | 'failure' | 'reply'
  readonly text: string
  readonly createdAt: string
}

export interface ChannelSendResult {
  readonly externalMessageId: string
  readonly recallHandle?: string
}

export interface ChannelAdapterConnection {
  send(delivery: ChannelOutboundDelivery): Promise<ChannelSendResult>
  stop(reason: 'replaced' | 'disposed' | 'failed'): Promise<void>
}

export interface ChannelAdapterHost {
  readonly generation: number
  readonly ref: ChannelTenantRef
  receive(envelope: ChannelInboundEnvelope): Promise<ChannelReceiveReceipt>
}

export interface ChannelAdapterDefinition {
  readonly descriptor: ChannelAdapterDescriptor
  start(host: ChannelAdapterHost): Promise<ChannelAdapterConnection>
}

export interface ChannelAdapterHandle {
  readonly ref: ChannelTenantRef
  readonly generation: number
  receive(envelope: ChannelInboundEnvelope): Promise<ChannelReceiveReceipt>
  drainInbound(limit?: number): Promise<number>
  drainOutbound(limit?: number): Promise<number>
  dispose(): Promise<void>
}

export interface ChannelSubscriptionFilter {
  readonly account: ChannelTenantRef
  readonly conversationId?: string
  readonly userId?: string
}

export interface ChannelMessageEvent {
  readonly delivery: 'live-experimental'
  readonly recordId: string
  readonly input: ChannelUserInput
}

export type ChannelMessageListener = (event: ChannelMessageEvent) => void | Promise<void>

export interface ChannelReceiveReceipt {
  readonly recordId: string
  readonly duplicate: boolean
  readonly status: ChannelInboxStatus
}

export type ChannelInboxStatus =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'applied'
  | 'permission-pending'
  | 'denied'
  | 'failed'
  | 'dead-letter'

export type ChannelOutboxStatus =
  | 'queued'
  | 'processing'
  | 'retrying'
  | 'sent'
  | 'cancelled'
  | 'dead-letter'

export interface ChannelNotification {
  readonly target: ChannelThreadRef
  readonly kind: ChannelOutboundDelivery['kind']
  readonly text: string
}

export interface ChannelDeliveryHandle {
  readonly deliveryId: string
  cancel(): Promise<'cancelled' | 'irreversible' | 'not-found'>
}

export interface ChannelRuntimeAccountSnapshot {
  readonly ref: ChannelTenantRef
  readonly adapterKind: ChannelAdapterKind
  readonly implementationStatus: ChannelImplementationStatus
  readonly connectionState: 'disabled' | 'starting' | 'ready' | 'retrying' | 'unavailable' | 'stopped'
  readonly secretState: 'missing' | 'ready' | 'unavailable'
  readonly generation: number
  readonly lastGoodRevision: number
  readonly cursorUpdatedAt?: string
  readonly lastErrorCode?: string
  readonly inbound: { readonly pending: number; readonly retrying: number; readonly deadLetter: number }
  readonly outbound: { readonly pending: number; readonly retrying: number; readonly deadLetter: number }
}

export interface ChannelRuntimeSnapshot {
  readonly contract: 'cordisx.channel-runtime-snapshot/v1'
  readonly schemaVersion: 1
  readonly observedAt: string
  readonly accounts: readonly ChannelRuntimeAccountSnapshot[]
  readonly bindings: ReadonlyArray<Pick<
    ChannelSessionBinding,
    'bindingId' | 'channel' | 'session' | 'routeId' | 'revision' | 'state'
  >>
}

export interface ChannelAuditSnapshot {
  readonly auditId: string
  readonly recordedAt: string
  readonly accountKey: string
  readonly generation: number
  readonly operationId: string
  readonly source: string
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly action: string
  readonly outcome: string
  readonly capability?: string
  readonly bindingRevision?: number
  readonly sessionKey?: string
  readonly eventKey?: string
}

export interface ChannelClock {
  now(): Date
}

export interface ChannelRuntimeOptions {
  readonly gateway: ChannelTaskGateway
  readonly permissions: ChannelPermissionBroker
  readonly storePath: string
  readonly clock?: ChannelClock
  readonly maxAttempts?: number
  readonly leaseMs?: number
  readonly retryBaseMs?: number
}
