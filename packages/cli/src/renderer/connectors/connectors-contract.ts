import type {
  BoundConnectorClient as ProtocolBoundConnectorClient,
  BoundConnectorClientResult,
  ConnectorCommand,
  ConnectorEvent,
  ConnectorEventPage,
  ConnectorRegistrationIdentity,
  ConnectorServiceDescriptor,
  ConnectorSubscribeRuntimeResult,
  ConnectorSubscription,
} from '@cordisx/protocol/connector-service/v1'

export const CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-service-descriptor.v1.schema.json' as const

export const CORDISX_CONNECTOR_REGISTRATION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-registration.v1.schema.json' as const

export const CORDISX_CONNECTOR_COMMAND_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-command.v1.schema.json' as const

export const CORDISX_CONNECTOR_EVENT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-event.v1.schema.json' as const

export const CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-bound-client.v1.schema.json' as const

export const CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-bound-client-result.v1.schema.json' as const

export const CORDISX_CONNECTOR_EVENT_SUBSCRIPTION_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-event-subscription.v1.schema.json' as const

export const CORDISX_CONNECTOR_EVENT_PAGE_SCHEMA_V1 =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-event-page.v1.schema.json' as const

/**
 * Formal Protocol v1 surface consumed by this Host implementation.
 *
 * The dependency is source-pinned in package.json; adapters and the broker
 * still own their private runtime state. This type is intentionally limited
 * to the serializable/wire and bound-client boundaries exported by Protocol.
 */
export interface CordisXConnectorProtocolV1 {
  readonly descriptor: ConnectorServiceDescriptor
  readonly registration: ConnectorRegistrationIdentity
  readonly command: ConnectorCommand
  readonly event: ConnectorEvent
  readonly eventPage: ConnectorEventPage
  readonly subscription: ConnectorSubscription
  readonly result: BoundConnectorClientResult
  readonly subscribeRuntimeResult: ConnectorSubscribeRuntimeResult
  readonly boundClient: ProtocolBoundConnectorClient
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-injected, principal-bound Connector client. */
    readonly connectors: CordisXBoundConnectorClient
  }
}

export type CordisXConnectorCapability =
  | 'conversation.open'
  | 'conversation.continue'
  | 'message.send'
  | 'events.receive'
  | 'run.stop'
  | 'conversation.close'
  | 'lifecycle.dispose'

export interface CordisXConnectorRegistrationIdentity {
  readonly registrationId: string
  readonly connectorId: string
  readonly generation: number
}

export interface CordisXConnectorServiceDescriptor {
  readonly $schema: typeof CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1
  readonly contract: 'cordisx.connector-service-descriptor/v1'
  readonly schemaVersion: 1
  readonly connectorId: string
  readonly protocolVersion: 1
  readonly capabilities: readonly CordisXConnectorCapability[]
}

export interface CordisXConnectorRegistration {
  readonly $schema: typeof CORDISX_CONNECTOR_REGISTRATION_SCHEMA_V1
  readonly contract: 'cordisx.connector-registration/v1'
  readonly schemaVersion: 1
  readonly registration: CordisXConnectorRegistrationIdentity
}

export interface CordisXConnectorMessage {
  readonly messageId: string
  readonly direction: 'inbound' | 'outbound'
  readonly parts: readonly [
    { readonly kind: 'text'; readonly text: string },
    ...{ readonly kind: 'text'; readonly text: string }[],
  ]
}

export type CordisXConnectorCommand =
  | {
    readonly $schema: typeof CORDISX_CONNECTOR_COMMAND_SCHEMA_V1
    readonly contract: 'cordisx.connector-command/v1'
    readonly schemaVersion: 1
    readonly commandId: string
    readonly registration: CordisXConnectorRegistrationIdentity
    readonly type: 'conversation.open'
    readonly open: { readonly mode: 'create' } | { readonly mode: 'continue'; readonly conversation: string }
  }
  | {
    readonly $schema: typeof CORDISX_CONNECTOR_COMMAND_SCHEMA_V1
    readonly contract: 'cordisx.connector-command/v1'
    readonly schemaVersion: 1
    readonly commandId: string
    readonly registration: CordisXConnectorRegistrationIdentity
    readonly type: 'message.send'
    readonly conversation: string
    readonly message: CordisXConnectorMessage & { readonly direction: 'outbound' }
  }
  | {
    readonly $schema: typeof CORDISX_CONNECTOR_COMMAND_SCHEMA_V1
    readonly contract: 'cordisx.connector-command/v1'
    readonly schemaVersion: 1
    readonly commandId: string
    readonly registration: CordisXConnectorRegistrationIdentity
    readonly type: 'run.stop'
    readonly conversation: string
    readonly run: string
  }
  | {
    readonly $schema: typeof CORDISX_CONNECTOR_COMMAND_SCHEMA_V1
    readonly contract: 'cordisx.connector-command/v1'
    readonly schemaVersion: 1
    readonly commandId: string
    readonly registration: CordisXConnectorRegistrationIdentity
    readonly type: 'conversation.close'
    readonly conversation: string
  }

export type CordisXConnectorEvent =
  | ConnectorEventBase & { readonly type: 'conversation.opened'; readonly conversation: string }
  | ConnectorEventBase & {
    readonly type: 'message.received'
    readonly conversation: string
    readonly message: CordisXConnectorMessage & { readonly direction: 'inbound' }
  }
  | ConnectorEventBase & {
    readonly type: 'message.sent'
    readonly conversation: string
    readonly message: CordisXConnectorMessage & { readonly direction: 'outbound' }
  }
  | ConnectorEventBase & {
    readonly type: 'run.started' | 'run.stopped'
    readonly conversation: string
    readonly run: string
  }
  | ConnectorEventBase & { readonly type: 'conversation.closed'; readonly conversation: string }
  | ConnectorEventBase & {
    readonly type: 'connector.disposed'
    readonly disposeReason: 'explicit' | 'generation-replaced'
  }

export interface ConnectorEventBase {
  readonly $schema: typeof CORDISX_CONNECTOR_EVENT_SCHEMA_V1
  readonly contract: 'cordisx.connector-event/v1'
  readonly schemaVersion: 1
  readonly eventId: string
  readonly registration: CordisXConnectorRegistrationIdentity
  readonly sequence: number
  readonly occurredAt: string
}

export type ConnectorEventPayload =
  | { readonly type: 'conversation.opened'; readonly conversation: string }
  | {
    readonly type: 'message.received'
    readonly conversation: string
    readonly message: CordisXConnectorMessage & { readonly direction: 'inbound' }
  }
  | {
    readonly type: 'message.sent'
    readonly conversation: string
    readonly message: CordisXConnectorMessage & { readonly direction: 'outbound' }
  }
  | { readonly type: 'run.started' | 'run.stopped'; readonly conversation: string; readonly run: string }
  | { readonly type: 'conversation.closed'; readonly conversation: string }
  | { readonly type: 'connector.disposed'; readonly disposeReason: 'explicit' | 'generation-replaced' }

export type CordisXConnectorErrorCode =
  | 'adapter-unavailable'
  | 'capability-unavailable'
  | 'current-connection-client-unavailable'
  | 'invalid-request'
  | 'permission-denied'
  | 'registration-disposed'
  | 'registration-unavailable'

export interface CordisXConnectorError {
  readonly code: CordisXConnectorErrorCode
  readonly message: string
  readonly retryable?: boolean
}

export type CordisXConnectorResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: CordisXConnectorError }

export interface CordisXConnectorAdapterSuccess {
  readonly kind: 'opened' | 'sent' | 'stopped' | 'closed'
  readonly conversation: string
  readonly run?: string
}

export interface CordisXHostConnector {
  readonly descriptor: CordisXConnectorServiceDescriptor
  /** Host-private live availability; it never exposes a transport or bridge. */
  available?(capability: CordisXConnectorCapability): Promise<CordisXConnectorResult<true>>
  execute(command: CordisXConnectorCommand): Promise<CordisXConnectorResult<CordisXConnectorAdapterSuccess>>
}

export interface CordisXConnectorPermissionRequest {
  readonly registration: CordisXConnectorRegistrationIdentity
  readonly capability: CordisXConnectorCapability
  readonly command: CordisXConnectorCommand
}

export interface CordisXConnectorBrokerOptions {
  readonly authorize?: (request: CordisXConnectorPermissionRequest) => Promise<CordisXConnectorResult<true>>
  readonly now?: () => Date
  readonly nonce?: () => string
}

export type CordisXConnectorClientCapability =
  | 'connector.discovery'
  | 'connector.command.execute'
  | 'connector.events.subscribe'

export type CordisXConnectorAuthorization =
  | { readonly capability: CordisXConnectorClientCapability; readonly state: 'allowed'; readonly code: 'allowed' }
  | {
    readonly capability: CordisXConnectorClientCapability
    readonly state: 'denied'
    readonly code: 'user-denied' | 'policy-denied'
  }
  | {
    readonly capability: CordisXConnectorClientCapability
    readonly state: 'unavailable'
    readonly code: 'principal-unavailable' | 'registration-unavailable' | 'unsupported'
  }

export interface CordisXConnectorEventSubscription {
  readonly $schema: typeof CORDISX_CONNECTOR_EVENT_SUBSCRIPTION_SCHEMA_V1
  readonly contract: 'cordisx.connector-event-subscription/v1'
  readonly schemaVersion: 1
  readonly subscriptionId: string
  readonly registration: CordisXConnectorRegistrationIdentity
  readonly afterSequence: number
  readonly snapshotSequence: number
}

export interface CordisXConnectorEventPage {
  readonly $schema: typeof CORDISX_CONNECTOR_EVENT_PAGE_SCHEMA_V1
  readonly contract: 'cordisx.connector-event-page/v1'
  readonly schemaVersion: 1
  readonly subscription: CordisXConnectorEventSubscription
  readonly afterSequence: number
  readonly phase: 'replay' | 'live'
  readonly events: readonly CordisXConnectorEvent[]
  readonly nextAfterSequence: number
  readonly hasMore: boolean
}

export interface CordisXConnectorSubscription {
  readonly subscription: CordisXConnectorEventSubscription
  readonly pages: AsyncIterable<CordisXConnectorEventPage>
  unsubscribe(): void
}

export interface CordisXBoundConnectorClient {
  readonly $schema: typeof CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1
  readonly contract: 'cordisx.bound-connector-client/v1'
  readonly schemaVersion: 1
  discover(): Promise<CordisXBoundConnectorClientResult<'discover'>>
  execute(command: CordisXConnectorCommand): Promise<CordisXBoundConnectorClientResult<'execute'>>
  subscribe(
    registration: CordisXConnectorRegistrationIdentity,
    afterSequence: number,
  ): Promise<CordisXConnectorSubscribeRuntimeResult>
  dispose(): void
}

export type ConnectorExecution =
  | { readonly kind: 'conversation.opened'; readonly conversation: string }
  | { readonly kind: 'message.sent'; readonly conversation: string; readonly messageId: string }
  | {
    readonly kind: 'run.stopped'
    readonly binding: {
      readonly registration: CordisXConnectorRegistrationIdentity
      readonly conversation: string
      readonly run: string
    }
  }
  | { readonly kind: 'conversation.closed'; readonly conversation: string }

export type ConnectorSnapshot = {
  readonly $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-client-snapshot.v1.schema.json'
  readonly contract: 'cordisx.connector-client-snapshot/v1'
  readonly schemaVersion: 1
  readonly observedAt: string
  readonly registrations: readonly {
    readonly registration: CordisXConnectorRegistrationIdentity
    readonly capabilities: readonly CordisXConnectorCapability[]
    readonly availability: 'available' | 'unavailable'
    readonly unavailableCode?: 'generation-replaced' | 'disposed' | 'unsupported'
  }[]
}

export type BoundConnectorClientResultBase<
  Type extends 'discover' | 'execute' | 'subscribe',
  Status extends 'accepted' | 'denied' | 'unavailable',
> = {
  readonly $schema: typeof CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1
  readonly contract: 'cordisx.bound-connector-client-result/v1'
  readonly schemaVersion: 1
  readonly callId: string
  readonly type: Type
  readonly status: Status
}

export type BoundConnectorClientRefusal<Type extends 'discover' | 'execute' | 'subscribe'> =
  & BoundConnectorClientResultBase<Type, 'denied' | 'unavailable'>
  & {
    readonly authorization: Exclude<CordisXConnectorAuthorization, { readonly state: 'allowed' }>
  }

export type BoundConnectorClientAccepted<Type extends 'discover' | 'execute' | 'subscribe'> =
  & BoundConnectorClientResultBase<Type, 'accepted'>
  & {
    readonly authorization: Extract<CordisXConnectorAuthorization, { readonly state: 'allowed' }>
  }
  & (Type extends 'discover' ? { readonly snapshot: ConnectorSnapshot }
    : Type extends 'execute' ? { readonly execution: ConnectorExecution }
    : { readonly subscription: CordisXConnectorEventSubscription })

export type CordisXBoundConnectorClientResult<Type extends 'discover' | 'execute' | 'subscribe'> =
  | BoundConnectorClientRefusal<Type>
  | BoundConnectorClientAccepted<Type>

export type CordisXConnectorSubscribeRuntimeResult =
  | { readonly result: BoundConnectorClientAccepted<'subscribe'>; readonly handle: CordisXConnectorSubscription }
  | { readonly result: BoundConnectorClientRefusal<'subscribe'> }

export interface CordisXBoundConnectorClientOptions {
  /** Host-issued principal liveness; no plugin value can replace this closure. */
  readonly active: () => boolean
  /** Host PermissionBroker outcome for this exact owner and target. */
  readonly authorize: (
    capability: CordisXConnectorClientCapability,
    registration?: CordisXConnectorRegistrationIdentity,
  ) => Promise<CordisXConnectorAuthorization>
  readonly callId?: () => string
}

export interface CordisXConnectorBrokerSnapshot {
  readonly registrations: readonly {
    readonly descriptor: CordisXConnectorServiceDescriptor
    readonly registration: CordisXConnectorRegistration
    readonly state: 'active' | 'disposed'
    readonly eventCount: number
  }[]
  readonly rawBridgeExposed: false
  readonly secondConnectionCreated: false
}

export type Listener = (event: CordisXConnectorEvent) => void

export interface RegistrationRecord {
  readonly connector: CordisXHostConnector
  readonly registration: CordisXConnectorRegistration
  readonly conversations: Set<string>
  readonly runs: Map<string, string>
  readonly events: CordisXConnectorEvent[]
  readonly listeners: Set<Listener>
  state: 'active' | 'disposed'
}

export const CAPABILITIES: ReadonlySet<CordisXConnectorCapability> = new Set([
  'conversation.open',
  'conversation.continue',
  'message.send',
  'events.receive',
  'run.stop',
  'conversation.close',
  'lifecycle.dispose',
])

export function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

export function clone<Value>(value: Value): Value {
  return freeze(
    typeof globalThis.structuredClone === 'function'
      ? globalThis.structuredClone(value)
      : JSON.parse(JSON.stringify(value)) as Value,
  )
}

export function failure(
  code: CordisXConnectorErrorCode,
  message: string,
  retryable?: boolean,
): CordisXConnectorResult<never> {
  return { ok: false, error: { code, message, ...(retryable === undefined ? {} : { retryable }) } }
}

export function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)
}

export function handle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

export function sameRegistration(
  left: CordisXConnectorRegistrationIdentity,
  right: CordisXConnectorRegistrationIdentity,
): boolean {
  return left.registrationId === right.registrationId && left.connectorId === right.connectorId
    && left.generation === right.generation
}

export function commandCapability(command: CordisXConnectorCommand): CordisXConnectorCapability {
  return command.type === 'conversation.open'
    ? command.open.mode === 'create' ? 'conversation.open' : 'conversation.continue'
    : command.type
}

export function commandValid(command: CordisXConnectorCommand): boolean {
  if (
    !handle(command.commandId) || !sameObjectKeys(command.registration, ['registrationId', 'connectorId', 'generation'])
    || !handle(command.registration.registrationId) || !identifier(command.registration.connectorId)
    || !Number.isInteger(command.registration.generation) || command.registration.generation < 1
  ) return false
  if (
    command.$schema !== CORDISX_CONNECTOR_COMMAND_SCHEMA_V1 || command.contract !== 'cordisx.connector-command/v1'
    || command.schemaVersion !== 1
  ) return false
  if (command.type === 'conversation.open') {
    return sameObjectKeys(command as object, [
      '$schema',
      'contract',
      'schemaVersion',
      'commandId',
      'registration',
      'type',
      'open',
    ])
      && sameObjectKeys(command.open, command.open.mode === 'create' ? ['mode'] : ['mode', 'conversation'])
      && (command.open.mode === 'create' || (command.open.mode === 'continue' && handle(command.open.conversation)))
  }
  if (command.type === 'message.send') {
    return sameObjectKeys(command as object, [
      '$schema',
      'contract',
      'schemaVersion',
      'commandId',
      'registration',
      'type',
      'conversation',
      'message',
    ])
      && handle(command.conversation) && messageValid(command.message, 'outbound')
  }
  if (command.type === 'run.stop') {
    return sameObjectKeys(command as object, [
      '$schema',
      'contract',
      'schemaVersion',
      'commandId',
      'registration',
      'type',
      'conversation',
      'run',
    ])
      && handle(command.conversation) && handle(command.run)
  }
  return sameObjectKeys(command as object, [
    '$schema',
    'contract',
    'schemaVersion',
    'commandId',
    'registration',
    'type',
    'conversation',
  ])
    && handle(command.conversation)
}

export function sameObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

export function messageValid(message: CordisXConnectorMessage, direction: 'inbound' | 'outbound'): boolean {
  return sameObjectKeys(message as object, ['messageId', 'direction', 'parts'])
    && handle(message.messageId) && message.direction === direction
    && Array.isArray(message.parts) && message.parts.length > 0 && message.parts.length <= 128
    && message.parts.every(part =>
      sameObjectKeys(part, ['kind', 'text']) && part.kind === 'text'
      && typeof part.text === 'string' && part.text.length > 0 && part.text.length <= 65_536
    )
}

export function descriptorValid(descriptor: CordisXConnectorServiceDescriptor): boolean {
  return descriptor.$schema === CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1
    && descriptor.contract === 'cordisx.connector-service-descriptor/v1'
    && descriptor.schemaVersion === 1 && descriptor.protocolVersion === 1 && identifier(descriptor.connectorId)
    && Array.isArray(descriptor.capabilities) && descriptor.capabilities.length > 0
    && descriptor.capabilities.length <= 7
    && new Set(descriptor.capabilities).size === descriptor.capabilities.length
    && descriptor.capabilities.every(capability => CAPABILITIES.has(capability))
}
