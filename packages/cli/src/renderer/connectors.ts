/**
 * Host-owned Connector broker and the only public, bound client surface.
 *
 * Connector transports, native client objects and raw bridge values remain
 * inside connector adapters. Plugins receive only a Host-bound client.
 */

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
  readonly parts: readonly [{ readonly kind: 'text'; readonly text: string }, ...{ readonly kind: 'text'; readonly text: string }[]]
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
  | ConnectorEventBase & { readonly type: 'message.received'; readonly conversation: string; readonly message: CordisXConnectorMessage & { readonly direction: 'inbound' } }
  | ConnectorEventBase & { readonly type: 'message.sent'; readonly conversation: string; readonly message: CordisXConnectorMessage & { readonly direction: 'outbound' } }
  | ConnectorEventBase & { readonly type: 'run.started' | 'run.stopped'; readonly conversation: string; readonly run: string }
  | ConnectorEventBase & { readonly type: 'conversation.closed'; readonly conversation: string }
  | ConnectorEventBase & { readonly type: 'connector.disposed'; readonly disposeReason: 'explicit' | 'generation-replaced' }

interface ConnectorEventBase {
  readonly $schema: typeof CORDISX_CONNECTOR_EVENT_SCHEMA_V1
  readonly contract: 'cordisx.connector-event/v1'
  readonly schemaVersion: 1
  readonly eventId: string
  readonly registration: CordisXConnectorRegistrationIdentity
  readonly sequence: number
  readonly occurredAt: string
}

type ConnectorEventPayload =
  | { readonly type: 'conversation.opened'; readonly conversation: string }
  | { readonly type: 'message.received'; readonly conversation: string; readonly message: CordisXConnectorMessage & { readonly direction: 'inbound' } }
  | { readonly type: 'message.sent'; readonly conversation: string; readonly message: CordisXConnectorMessage & { readonly direction: 'outbound' } }
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

export type CordisXConnectorClientCapability = 'connector.discovery' | 'connector.command.execute' | 'connector.events.subscribe'
export type CordisXConnectorAuthorization =
  | { readonly capability: CordisXConnectorClientCapability; readonly state: 'allowed'; readonly code: 'allowed' }
  | { readonly capability: CordisXConnectorClientCapability; readonly state: 'denied'; readonly code: 'user-denied' | 'policy-denied' }
  | { readonly capability: CordisXConnectorClientCapability; readonly state: 'unavailable'; readonly code: 'principal-unavailable' | 'registration-unavailable' | 'unsupported' }

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
  subscribe(registration: CordisXConnectorRegistrationIdentity, afterSequence: number): Promise<CordisXConnectorSubscribeRuntimeResult>
  dispose(): void
}

type ConnectorExecution =
  | { readonly kind: 'conversation.opened'; readonly conversation: string }
  | { readonly kind: 'message.sent'; readonly conversation: string; readonly messageId: string }
  | { readonly kind: 'run.stopped'; readonly binding: { readonly registration: CordisXConnectorRegistrationIdentity; readonly conversation: string; readonly run: string } }
  | { readonly kind: 'conversation.closed'; readonly conversation: string }

type ConnectorSnapshot = {
  readonly $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-client-snapshot.v1.schema.json'
  readonly contract: 'cordisx.connector-client-snapshot/v1'
  readonly schemaVersion: 1
  readonly observedAt: string
  readonly registrations: readonly { readonly registration: CordisXConnectorRegistrationIdentity; readonly capabilities: readonly CordisXConnectorCapability[]; readonly availability: 'available' | 'unavailable'; readonly unavailableCode?: 'generation-replaced' | 'disposed' | 'unsupported' }[]
}

type BoundConnectorClientResultBase<Type extends 'discover' | 'execute' | 'subscribe', Status extends 'accepted' | 'denied' | 'unavailable'> = {
  readonly $schema: typeof CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1
  readonly contract: 'cordisx.bound-connector-client-result/v1'
  readonly schemaVersion: 1
  readonly callId: string
  readonly type: Type
  readonly status: Status
}

type BoundConnectorClientRefusal<Type extends 'discover' | 'execute' | 'subscribe'> = BoundConnectorClientResultBase<Type, 'denied' | 'unavailable'> & {
  readonly authorization: Exclude<CordisXConnectorAuthorization, { readonly state: 'allowed' }>
}

type BoundConnectorClientAccepted<Type extends 'discover' | 'execute' | 'subscribe'> = BoundConnectorClientResultBase<Type, 'accepted'> & {
  readonly authorization: Extract<CordisXConnectorAuthorization, { readonly state: 'allowed' }>
} & (Type extends 'discover' ? { readonly snapshot: ConnectorSnapshot }
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
  readonly authorize: (capability: CordisXConnectorClientCapability, registration?: CordisXConnectorRegistrationIdentity) => Promise<CordisXConnectorAuthorization>
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

type Listener = (event: CordisXConnectorEvent) => void

interface RegistrationRecord {
  readonly connector: CordisXHostConnector
  readonly registration: CordisXConnectorRegistration
  readonly conversations: Set<string>
  readonly runs: Map<string, string>
  readonly events: CordisXConnectorEvent[]
  readonly listeners: Set<Listener>
  state: 'active' | 'disposed'
}

const CAPABILITIES: ReadonlySet<CordisXConnectorCapability> = new Set([
  'conversation.open', 'conversation.continue', 'message.send', 'events.receive', 'run.stop', 'conversation.close', 'lifecycle.dispose',
])

function freeze<Value>(value: Value): Value {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
  return Object.freeze(value)
}

function clone<Value>(value: Value): Value {
  return freeze(typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value)
}

function failure(code: CordisXConnectorErrorCode, message: string, retryable?: boolean): CordisXConnectorResult<never> {
  return { ok: false, error: { code, message, ...(retryable === undefined ? {} : { retryable }) } }
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)
}

function handle(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function sameRegistration(left: CordisXConnectorRegistrationIdentity, right: CordisXConnectorRegistrationIdentity): boolean {
  return left.registrationId === right.registrationId && left.connectorId === right.connectorId && left.generation === right.generation
}

function commandCapability(command: CordisXConnectorCommand): CordisXConnectorCapability {
  return command.type === 'conversation.open'
    ? command.open.mode === 'create' ? 'conversation.open' : 'conversation.continue'
    : command.type
}

function commandValid(command: CordisXConnectorCommand): boolean {
  if (!handle(command.commandId) || !sameObjectKeys(command.registration, ['registrationId', 'connectorId', 'generation'])
    || !handle(command.registration.registrationId) || !identifier(command.registration.connectorId)
    || !Number.isInteger(command.registration.generation) || command.registration.generation < 1) return false
  if (command.$schema !== CORDISX_CONNECTOR_COMMAND_SCHEMA_V1 || command.contract !== 'cordisx.connector-command/v1' || command.schemaVersion !== 1) return false
  if (command.type === 'conversation.open') {
    return sameObjectKeys(command as object, ['$schema', 'contract', 'schemaVersion', 'commandId', 'registration', 'type', 'open'])
      && sameObjectKeys(command.open, command.open.mode === 'create' ? ['mode'] : ['mode', 'conversation'])
      && (command.open.mode === 'create' || (command.open.mode === 'continue' && handle(command.open.conversation)))
  }
  if (command.type === 'message.send') {
    return sameObjectKeys(command as object, ['$schema', 'contract', 'schemaVersion', 'commandId', 'registration', 'type', 'conversation', 'message'])
      && handle(command.conversation) && messageValid(command.message, 'outbound')
  }
  if (command.type === 'run.stop') {
    return sameObjectKeys(command as object, ['$schema', 'contract', 'schemaVersion', 'commandId', 'registration', 'type', 'conversation', 'run'])
      && handle(command.conversation) && handle(command.run)
  }
  return sameObjectKeys(command as object, ['$schema', 'contract', 'schemaVersion', 'commandId', 'registration', 'type', 'conversation'])
    && handle(command.conversation)
}

function sameObjectKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function messageValid(message: CordisXConnectorMessage, direction: 'inbound' | 'outbound'): boolean {
  return sameObjectKeys(message as object, ['messageId', 'direction', 'parts'])
    && handle(message.messageId) && message.direction === direction
    && Array.isArray(message.parts) && message.parts.length > 0 && message.parts.length <= 128
    && message.parts.every(part => sameObjectKeys(part, ['kind', 'text']) && part.kind === 'text'
      && typeof part.text === 'string' && part.text.length > 0 && part.text.length <= 65_536)
}

function descriptorValid(descriptor: CordisXConnectorServiceDescriptor): boolean {
  return descriptor.$schema === CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1
    && descriptor.contract === 'cordisx.connector-service-descriptor/v1'
    && descriptor.schemaVersion === 1 && descriptor.protocolVersion === 1 && identifier(descriptor.connectorId)
    && Array.isArray(descriptor.capabilities) && descriptor.capabilities.length > 0 && descriptor.capabilities.length <= 7
    && new Set(descriptor.capabilities).size === descriptor.capabilities.length
    && descriptor.capabilities.every(capability => CAPABILITIES.has(capability))
}

/**
 * A generation-fenced Host broker. It never gives callers an adapter, native
 * handle map, transport, or raw bridge; callers retain only issued opaque data.
 */
export class CordisXConnectorBroker {
  private readonly registrations = new Map<string, RegistrationRecord>()
  private readonly generations = new Map<string, number>()
  private readonly authorize: (request: CordisXConnectorPermissionRequest) => Promise<CordisXConnectorResult<true>>
  private readonly now: () => Date
  private readonly nonce: () => string
  private disposed = false

  constructor(options: CordisXConnectorBrokerOptions = {}) {
    this.authorize = options.authorize ?? (async () => failure('permission-denied', 'Host authorization is required for Connector commands'))
    this.now = options.now ?? (() => new Date())
    this.nonce = options.nonce ?? (() => typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
  }

  register(connector: CordisXHostConnector): CordisXConnectorResult<CordisXConnectorRegistration> {
    if (this.disposed) return failure('registration-disposed', 'Connector broker is disposed')
    if (!descriptorValid(connector.descriptor)) return failure('invalid-request', 'Connector descriptor is invalid')
    const previous = this.active(connector.descriptor.connectorId)
    if (previous !== undefined) this.disposeRecord(previous, 'generation-replaced')
    const generation = (this.generations.get(connector.descriptor.connectorId) ?? 0) + 1
    this.generations.set(connector.descriptor.connectorId, generation)
    const registration = freeze({
      $schema: CORDISX_CONNECTOR_REGISTRATION_SCHEMA_V1,
      contract: 'cordisx.connector-registration/v1' as const,
      schemaVersion: 1 as const,
      registration: freeze({ registrationId: `cxconnector:${this.nonce()}`, connectorId: connector.descriptor.connectorId, generation }),
    })
    this.registrations.set(registration.registration.registrationId, {
      connector,
      registration,
      conversations: new Set(),
      runs: new Map(),
      events: [],
      listeners: new Set(),
      state: 'active',
    })
    return { ok: true, value: clone(registration) }
  }

  discover(): readonly CordisXConnectorRegistration[] {
    return freeze([...this.registrations.values()]
      .filter(record => record.state === 'active')
      .map(record => clone(record.registration))
      .sort((left, right) => left.registration.connectorId.localeCompare(right.registration.connectorId)))
  }

  snapshot(): CordisXConnectorBrokerSnapshot {
    return freeze({
      registrations: [...this.registrations.values()].map(record => ({
        descriptor: clone(record.connector.descriptor),
        registration: clone(record.registration),
        state: record.state,
        eventCount: record.events.length,
      })).sort((left, right) => left.registration.registration.connectorId.localeCompare(right.registration.registration.connectorId)),
      rawBridgeExposed: false as const,
      secondConnectionCreated: false as const,
    })
  }

  async command(command: CordisXConnectorCommand, hostAuthorized = false): Promise<CordisXConnectorResult<CordisXConnectorAdapterSuccess>> {
    if (this.disposed) return failure('registration-disposed', 'Connector broker is disposed')
    if (!commandValid(command)) return failure('invalid-request', 'Connector command is invalid')
    const record = this.record(command.registration)
    if (record === undefined) return failure('registration-unavailable', 'Connector registration is unavailable')
    if (record.state !== 'active') return failure('registration-disposed', 'Connector registration is disposed')
    const capability = commandCapability(command)
    if (!record.connector.descriptor.capabilities.includes(capability)) {
      return failure('capability-unavailable', `Connector does not declare ${capability}`)
    }
    const availability = record.connector.available === undefined
      ? { ok: true as const, value: true as const }
      : await record.connector.available(capability)
    if (!availability.ok) return availability
    if (command.type === 'conversation.open' && command.open.mode === 'continue' && !record.conversations.has(command.open.conversation)) {
      return failure('invalid-request', 'Conversation handle was not issued by this registration')
    }
    if ('conversation' in command && !record.conversations.has(command.conversation)) {
      return failure('invalid-request', 'Conversation handle was not issued by this registration')
    }
    if (command.type === 'run.stop' && record.runs.get(command.run) !== command.conversation) return failure('invalid-request', 'Run handle is not bound to this conversation')
    if (!hostAuthorized) {
      const permission = await this.authorize({ registration: clone(command.registration), capability, command: clone(command) })
      if (!permission.ok) return permission
    }
    let result: CordisXConnectorResult<CordisXConnectorAdapterSuccess>
    try {
      result = await record.connector.execute(clone(command))
    } catch {
      return failure('adapter-unavailable', 'Connector adapter did not complete the command', true)
    }
    if (!result.ok) return result
    const validation = this.validateAdapterSuccess(command, result.value)
    if (!validation.ok) return validation
    this.commitOperation(record, command, result.value)
    return { ok: true, value: clone(result.value) }
  }

  subscribe(registration: CordisXConnectorRegistrationIdentity, afterSequence: number, listener: Listener): CordisXConnectorResult<() => void> {
    if (this.disposed) return failure('registration-disposed', 'Connector broker is disposed')
    const record = this.record(registration)
    if (record === undefined) return failure('registration-unavailable', 'Connector registration is unavailable')
    if (record.state !== 'active') return failure('registration-disposed', 'Connector registration is disposed')
    if (!record.connector.descriptor.capabilities.includes('events.receive')) return failure('capability-unavailable', 'Connector does not declare events.receive')
    if (!Number.isInteger(afterSequence) || afterSequence < -1) return failure('invalid-request', 'Event cursor is invalid')
    for (const event of record.events) if (event.sequence > afterSequence) listener(clone(event))
    record.listeners.add(listener)
    return { ok: true, value: () => { record.listeners.delete(listener) } }
  }

  dispose(registration: CordisXConnectorRegistrationIdentity): CordisXConnectorResult<true> {
    const record = this.record(registration)
    if (record === undefined) return failure('registration-unavailable', 'Connector registration is unavailable')
    if (record.state === 'disposed') return failure('registration-disposed', 'Connector registration is disposed')
    if (!record.connector.descriptor.capabilities.includes('lifecycle.dispose')) return failure('capability-unavailable', 'Connector does not declare lifecycle.dispose')
    this.disposeRecord(record, 'explicit')
    return { ok: true, value: true }
  }

  disposeAll(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.registrations.values()) if (record.state === 'active') this.disposeRecord(record, 'explicit')
  }

  /** Creates the only plugin-visible surface; principal binding remains Host-owned. */
  bind(options: CordisXBoundConnectorClientOptions): CordisXBoundConnectorClient {
    return new BoundConnectorClient(this, options)
  }

  async clientSnapshot(): Promise<ConnectorSnapshot> {
    const registrations = await Promise.all([...this.registrations.values()].map(async record => {
      let availability: 'available' | 'unavailable' = record.state === 'active' ? 'available' : 'unavailable'
      let unavailableCode: 'generation-replaced' | 'disposed' | 'unsupported' | undefined
      if (record.state !== 'active') {
        unavailableCode = 'disposed'
      } else if (record.connector.available !== undefined) {
        let available: CordisXConnectorResult<true>
        try {
          available = await record.connector.available('conversation.open')
        } catch {
          available = failure('adapter-unavailable', 'Connector availability probe failed')
        }
        if (!available.ok) {
          availability = 'unavailable'
          unavailableCode = 'unsupported'
        }
      }
      return freeze({
        registration: clone(record.registration.registration),
        capabilities: clone(record.connector.descriptor.capabilities),
        availability,
        ...(unavailableCode === undefined ? {} : { unavailableCode }),
      })
    }))
    return freeze({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-client-snapshot.v1.schema.json',
      contract: 'cordisx.connector-client-snapshot/v1' as const,
      schemaVersion: 1 as const,
      observedAt: this.now().toISOString(),
      registrations: registrations.sort((left, right) => left.registration.connectorId.localeCompare(right.registration.connectorId)),
    })
  }

  async openSubscription(registration: CordisXConnectorRegistrationIdentity, afterSequence: number): Promise<CordisXConnectorResult<CordisXConnectorSubscription>> {
    if (this.disposed) return failure('registration-disposed', 'Connector broker is disposed')
    const record = this.record(registration)
    if (record === undefined || record.state !== 'active') return failure('registration-unavailable', 'Connector registration is unavailable')
    if (!record.connector.descriptor.capabilities.includes('events.receive')) return failure('capability-unavailable', 'Connector does not declare events.receive')
    if (!Number.isInteger(afterSequence) || afterSequence < -1) return failure('invalid-request', 'Event cursor is invalid')
    if (record.events.length === 0) return failure('adapter-unavailable', 'Connector has no serializable event ledger yet')
    if (afterSequence > record.events.at(-1)!.sequence) return failure('invalid-request', 'Event cursor is ahead of the Host ledger')
    if (record.connector.available !== undefined) {
      try {
        const availability = await record.connector.available('events.receive')
        if (!availability.ok) return availability
      } catch {
        return failure('adapter-unavailable', 'Connector event availability probe failed', true)
      }
    }
    let stream: SerializedConnectorSubscription | undefined
    const buffered: CordisXConnectorEvent[] = []
    const listener: Listener = event => {
      if (stream === undefined) buffered.push(clone(event))
      else stream.live(event)
    }
    // Install the listener before taking the replay watermark. The small
    // buffer preserves events produced reentrantly while the stream descriptor
    // is being stamped.
    record.listeners.add(listener)
    const subscription = freeze({
      $schema: CORDISX_CONNECTOR_EVENT_SUBSCRIPTION_SCHEMA_V1,
      contract: 'cordisx.connector-event-subscription/v1' as const,
      schemaVersion: 1 as const,
      subscriptionId: `cxsubscription:${this.nonce()}`,
      registration: clone(record.registration.registration),
      afterSequence,
      snapshotSequence: record.events.at(-1)!.sequence,
    })
    stream = new SerializedConnectorSubscription(subscription, () => { record.listeners.delete(listener) })
    const replay = record.events.filter(event => event.sequence > afterSequence && event.sequence <= subscription.snapshotSequence)
    stream.replay(replay)
    for (const event of buffered) stream.live(event)
    return { ok: true, value: stream }
  }

  private active(connectorId: string): RegistrationRecord | undefined {
    return [...this.registrations.values()].find(record => record.state === 'active' && record.registration.registration.connectorId === connectorId)
  }

  private record(registration: CordisXConnectorRegistrationIdentity): RegistrationRecord | undefined {
    const record = this.registrations.get(registration.registrationId)
    return record !== undefined && sameRegistration(record.registration.registration, registration) ? record : undefined
  }

  private validateAdapterSuccess(command: CordisXConnectorCommand, value: CordisXConnectorAdapterSuccess): CordisXConnectorResult<true> {
    if (!handle(value.conversation)) return failure('adapter-unavailable', 'Connector adapter returned an invalid conversation handle')
    const expected = command.type === 'conversation.open' ? 'opened'
      : command.type === 'message.send' ? 'sent'
        : command.type === 'run.stop' ? 'stopped' : 'closed'
    if (value.kind !== expected) return failure('adapter-unavailable', 'Connector adapter returned an invalid command outcome')
    if (command.type === 'conversation.open' && command.open.mode === 'continue' && value.conversation !== command.open.conversation) {
      return failure('adapter-unavailable', 'Connector adapter changed an opaque continuation handle')
    }
    if ('conversation' in command && value.conversation !== command.conversation) {
      return failure('adapter-unavailable', 'Connector adapter changed an opaque conversation handle')
    }
    if (command.type === 'run.stop' && (!handle(value.run) || value.run !== command.run)) {
      return failure('adapter-unavailable', 'Connector adapter returned an invalid run handle')
    }
    return { ok: true, value: true }
  }

  private commitOperation(record: RegistrationRecord, command: CordisXConnectorCommand, value: CordisXConnectorAdapterSuccess): void {
    if (command.type === 'conversation.open') {
      record.conversations.add(value.conversation)
      this.emit(record, { type: 'conversation.opened', conversation: value.conversation })
      if (value.run !== undefined) {
        record.runs.set(value.run, value.conversation)
        this.emit(record, { type: 'run.started', conversation: value.conversation, run: value.run })
      }
      return
    }
    if (command.type === 'message.send') {
      this.emit(record, { type: 'message.sent', conversation: value.conversation, message: command.message })
      if (value.run !== undefined) {
        record.runs.set(value.run, value.conversation)
        this.emit(record, { type: 'run.started', conversation: value.conversation, run: value.run })
      }
      return
    }
    if (command.type === 'run.stop') {
      record.runs.delete(command.run)
      this.emit(record, { type: 'run.stopped', conversation: value.conversation, run: command.run })
      return
    }
    record.conversations.delete(command.conversation)
    this.emit(record, { type: 'conversation.closed', conversation: value.conversation })
  }

  private disposeRecord(record: RegistrationRecord, reason: 'explicit' | 'generation-replaced'): void {
    record.state = 'disposed'
    if (record.connector.descriptor.capabilities.includes('lifecycle.dispose')) this.emit(record, { type: 'connector.disposed', disposeReason: reason })
    record.listeners.clear()
    record.conversations.clear()
    record.runs.clear()
  }

  private emit(record: RegistrationRecord, payload: ConnectorEventPayload): void {
    const event = freeze({
      $schema: CORDISX_CONNECTOR_EVENT_SCHEMA_V1,
      contract: 'cordisx.connector-event/v1' as const,
      schemaVersion: 1 as const,
      eventId: `cxconnector-event:${record.registration.registration.registrationId}:${record.events.length}`,
      registration: clone(record.registration.registration),
      sequence: record.events.length,
      occurredAt: this.now().toISOString(),
      ...payload,
    }) as CordisXConnectorEvent
    record.events.push(event)
    for (const listener of record.listeners) {
      try { listener(clone(event)) } catch { /* observers cannot corrupt Host event order */ }
    }
  }
}

class SerializedConnectorSubscription implements CordisXConnectorSubscription, AsyncIterable<CordisXConnectorEventPage> {
  readonly pages: AsyncIterable<CordisXConnectorEventPage> = this
  private readonly pending: CordisXConnectorEventPage[] = []
  private readonly waiters: ((value: IteratorResult<CordisXConnectorEventPage>) => void)[] = []
  private cursor: number
  private replayDone = false
  private closed = false

  constructor(readonly subscription: CordisXConnectorEventSubscription, private readonly remove: () => void) {
    this.cursor = subscription.afterSequence
  }

  replay(events: readonly CordisXConnectorEvent[]): void {
    for (let index = 0; index < events.length; index += 1) this.enqueue('replay', events[index]!, index < events.length - 1)
    this.replayDone = true
  }

  live(event: CordisXConnectorEvent): void {
    if (this.closed || event.sequence <= this.subscription.snapshotSequence) return
    this.enqueue('live', event, false)
    if (event.type === 'connector.disposed') this.closeAfterDrain()
  }

  unsubscribe(): void {
    if (this.closed) return
    this.closed = true
    this.remove()
    this.flush()
  }

  [Symbol.asyncIterator](): AsyncIterator<CordisXConnectorEventPage> { return this }

  next(): Promise<IteratorResult<CordisXConnectorEventPage>> {
    const page = this.pending.shift()
    if (page !== undefined) return Promise.resolve({ done: false, value: page })
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise(resolve => this.waiters.push(resolve))
  }

  private enqueue(phase: 'replay' | 'live', event: CordisXConnectorEvent, hasMore: boolean): void {
    if (event.sequence !== this.cursor + 1) return
    const page = freeze({
      $schema: CORDISX_CONNECTOR_EVENT_PAGE_SCHEMA_V1,
      contract: 'cordisx.connector-event-page/v1' as const,
      schemaVersion: 1 as const,
      subscription: clone(this.subscription),
      afterSequence: this.cursor,
      phase,
      events: freeze([clone(event)]),
      nextAfterSequence: event.sequence,
      hasMore,
    })
    this.cursor = event.sequence
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.pending.push(page)
    else waiter({ done: false, value: page })
  }

  private closeAfterDrain(): void {
    this.closed = true
    this.remove()
    this.flush()
  }

  private flush(): void {
    if (this.pending.length !== 0) return
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

class BoundConnectorClient implements CordisXBoundConnectorClient {
  readonly $schema = CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1
  readonly contract = 'cordisx.bound-connector-client/v1' as const
  readonly schemaVersion = 1 as const
  private readonly subscriptions = new Set<CordisXConnectorSubscription>()
  private closed = false
  private nextCall = 0

  constructor(private readonly broker: CordisXConnectorBroker, private readonly options: CordisXBoundConnectorClientOptions) {}

  async discover(): Promise<CordisXBoundConnectorClientResult<'discover'>> {
    const callId = this.callId()
    const authorization = await this.authorize('connector.discovery')
    if (authorization.state !== 'allowed') return this.refusal(callId, 'discover', authorization)
    return freeze({ ...this.base(callId, 'discover', 'accepted', authorization), snapshot: await this.broker.clientSnapshot() })
  }

  async execute(command: CordisXConnectorCommand): Promise<CordisXBoundConnectorClientResult<'execute'>> {
    const callId = this.callId()
    const authorization = await this.authorize('connector.command.execute', command.registration)
    if (authorization.state !== 'allowed') return this.refusal(callId, 'execute', authorization)
    const result = await this.broker.command(command, true)
    if (!result.ok) return this.refusal(callId, 'execute', { capability: 'connector.command.execute', state: 'unavailable', code: 'unsupported' })
    const execution: ConnectorExecution = command.type === 'conversation.open'
      ? { kind: 'conversation.opened', conversation: result.value.conversation }
      : command.type === 'message.send' ? { kind: 'message.sent', conversation: result.value.conversation, messageId: command.message.messageId }
        : command.type === 'run.stop' ? { kind: 'run.stopped', binding: { registration: clone(command.registration), conversation: command.conversation, run: command.run } }
          : { kind: 'conversation.closed', conversation: command.conversation }
    return freeze({ ...this.base(callId, 'execute', 'accepted', authorization), execution })
  }

  async subscribe(registration: CordisXConnectorRegistrationIdentity, afterSequence: number): Promise<CordisXConnectorSubscribeRuntimeResult> {
    const callId = this.callId()
    const authorization = await this.authorize('connector.events.subscribe', registration)
    if (authorization.state !== 'allowed') return { result: this.refusal(callId, 'subscribe', authorization) }
    const opened = await this.broker.openSubscription(registration, afterSequence)
    if (!opened.ok) return { result: this.refusal(callId, 'subscribe', { capability: 'connector.events.subscribe', state: 'unavailable', code: 'unsupported' }) }
    this.subscriptions.add(opened.value)
    const original = opened.value.unsubscribe.bind(opened.value)
    const handle: CordisXConnectorSubscription = Object.freeze({
      subscription: opened.value.subscription,
      pages: opened.value.pages,
      unsubscribe: () => { original(); this.subscriptions.delete(opened.value) },
    })
    return { result: freeze({ ...this.base(callId, 'subscribe', 'accepted', authorization), subscription: clone(opened.value.subscription) }), handle }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const subscription of this.subscriptions) subscription.unsubscribe()
    this.subscriptions.clear()
  }

  private async authorize(capability: CordisXConnectorClientCapability, registration?: CordisXConnectorRegistrationIdentity): Promise<CordisXConnectorAuthorization> {
    if (this.closed || !this.options.active()) return { capability, state: 'unavailable', code: 'principal-unavailable' }
    return await this.options.authorize(capability, registration)
  }

  private callId(): string { return this.options.callId?.() ?? `cxcall:${this.nextCall++}` }
  private base<Type extends 'discover' | 'execute' | 'subscribe'>(callId: string, type: Type, status: 'accepted', authorization: Extract<CordisXConnectorAuthorization, { readonly state: 'allowed' }>) {
    return { $schema: CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1, contract: 'cordisx.bound-connector-client-result/v1' as const, schemaVersion: 1 as const, callId, type, status, authorization }
  }
  private refusal<Type extends 'discover' | 'execute' | 'subscribe'>(callId: string, type: Type, authorization: Exclude<CordisXConnectorAuthorization, { readonly state: 'allowed' }>): BoundConnectorClientRefusal<Type> {
    return freeze({ $schema: CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1, contract: 'cordisx.bound-connector-client-result/v1' as const, schemaVersion: 1 as const, callId, type, status: authorization.state === 'denied' ? 'denied' as const : 'unavailable' as const, authorization }) as BoundConnectorClientRefusal<Type>
  }
}
