import { BoundConnectorClient, SerializedConnectorSubscription } from './connectors-client.js'

import {
  clone,
  commandCapability,
  commandValid,
  ConnectorEventPayload,
  ConnectorSnapshot,
  CORDISX_CONNECTOR_EVENT_SCHEMA_V1,
  CORDISX_CONNECTOR_EVENT_SUBSCRIPTION_SCHEMA_V1,
  CORDISX_CONNECTOR_REGISTRATION_SCHEMA_V1,
  CordisXBoundConnectorClient,
  CordisXBoundConnectorClientOptions,
  CordisXConnectorAdapterSuccess,
  CordisXConnectorBrokerOptions,
  CordisXConnectorBrokerSnapshot,
  CordisXConnectorCommand,
  CordisXConnectorEvent,
  CordisXConnectorPermissionRequest,
  CordisXConnectorRegistration,
  CordisXConnectorRegistrationIdentity,
  CordisXConnectorResult,
  CordisXConnectorSubscription,
  CordisXHostConnector,
  descriptorValid,
  failure,
  freeze,
  handle,
  Listener,
  RegistrationRecord,
  sameRegistration,
} from './connectors-contract.js'

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
  /**
   * Host-bootstrap-only adversarial probe. It is unset in product launches;
   * no plugin, wire message, configuration value, or renderer global can
   * install it. The hook runs after the listener is attached and before the
   * replay watermark is stamped.
   */
  private internalSubscriptionObserver:
    | ((registration: CordisXConnectorRegistrationIdentity) => Promise<void>)
    | undefined
  private disposed = false

  constructor(options: CordisXConnectorBrokerOptions = {}) {
    this.authorize = options.authorize
      ?? (async () => failure('permission-denied', 'Host authorization is required for Connector commands'))
    this.now = options.now ?? (() => new Date())
    this.nonce = options.nonce ?? (() =>
      typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)
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
      registration: freeze({
        registrationId: `cxconnector:${this.nonce()}`,
        connectorId: connector.descriptor.connectorId,
        generation,
      }),
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
    return freeze(
      [...this.registrations.values()]
        .filter(record => record.state === 'active')
        .map(record => clone(record.registration))
        .sort((left, right) => left.registration.connectorId.localeCompare(right.registration.connectorId)),
    )
  }

  snapshot(): CordisXConnectorBrokerSnapshot {
    return freeze({
      registrations: [...this.registrations.values()].map(record => ({
        descriptor: clone(record.connector.descriptor),
        registration: clone(record.registration),
        state: record.state,
        eventCount: record.events.length,
      })).sort((left, right) =>
        left.registration.registration.connectorId.localeCompare(right.registration.registration.connectorId)
      ),
      rawBridgeExposed: false as const,
      secondConnectionCreated: false as const,
    })
  }

  async command(
    command: CordisXConnectorCommand,
    hostAuthorized = false,
  ): Promise<CordisXConnectorResult<CordisXConnectorAdapterSuccess>> {
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
    if (
      command.type === 'conversation.open' && command.open.mode === 'continue'
      && !record.conversations.has(command.open.conversation)
    ) {
      return failure('invalid-request', 'Conversation handle was not issued by this registration')
    }
    if ('conversation' in command && !record.conversations.has(command.conversation)) {
      return failure('invalid-request', 'Conversation handle was not issued by this registration')
    }
    if (command.type === 'run.stop' && record.runs.get(command.run) !== command.conversation) {
      return failure('invalid-request', 'Run handle is not bound to this conversation')
    }
    if (!hostAuthorized) {
      const permission = await this.authorize({
        registration: clone(command.registration),
        capability,
        command: clone(command),
      })
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

  subscribe(
    registration: CordisXConnectorRegistrationIdentity,
    afterSequence: number,
    listener: Listener,
  ): CordisXConnectorResult<() => void> {
    if (this.disposed) return failure('registration-disposed', 'Connector broker is disposed')
    const record = this.record(registration)
    if (record === undefined) return failure('registration-unavailable', 'Connector registration is unavailable')
    if (record.state !== 'active') return failure('registration-disposed', 'Connector registration is disposed')
    if (!record.connector.descriptor.capabilities.includes('events.receive')) {
      return failure('capability-unavailable', 'Connector does not declare events.receive')
    }
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      return failure('invalid-request', 'Event cursor is invalid')
    }
    for (const event of record.events) if (event.sequence > afterSequence) listener(clone(event))
    record.listeners.add(listener)
    return {
      ok: true,
      value: () => {
        record.listeners.delete(listener)
      },
    }
  }

  dispose(registration: CordisXConnectorRegistrationIdentity): CordisXConnectorResult<true> {
    const record = this.record(registration)
    if (record === undefined) return failure('registration-unavailable', 'Connector registration is unavailable')
    if (record.state === 'disposed') return failure('registration-disposed', 'Connector registration is disposed')
    if (!record.connector.descriptor.capabilities.includes('lifecycle.dispose')) {
      return failure('capability-unavailable', 'Connector does not declare lifecycle.dispose')
    }
    this.disposeRecord(record, 'explicit')
    return { ok: true, value: true }
  }

  disposeAll(): void {
    if (this.disposed) return
    this.disposed = true
    for (const record of this.registrations.values()) {
      if (record.state === 'active') this.disposeRecord(record, 'explicit')
    }
  }

  /** @internal Only an in-process Host bootstrap may install this probe. */
  setInternalSubscriptionObserver(
    observer: ((registration: CordisXConnectorRegistrationIdentity) => Promise<void>) | undefined,
  ): void {
    this.internalSubscriptionObserver = observer
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
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/connector-client-snapshot.v1.schema.json',
      contract: 'cordisx.connector-client-snapshot/v1' as const,
      schemaVersion: 1 as const,
      observedAt: this.now().toISOString(),
      registrations: registrations.sort((left, right) =>
        left.registration.connectorId.localeCompare(right.registration.connectorId)
      ),
    })
  }

  async openSubscription(
    registration: CordisXConnectorRegistrationIdentity,
    afterSequence: number,
  ): Promise<CordisXConnectorResult<CordisXConnectorSubscription>> {
    if (this.disposed) return failure('registration-disposed', 'Connector broker is disposed')
    const record = this.record(registration)
    if (record === undefined || record.state !== 'active') {
      return failure('registration-unavailable', 'Connector registration is unavailable')
    }
    if (!record.connector.descriptor.capabilities.includes('events.receive')) {
      return failure('capability-unavailable', 'Connector does not declare events.receive')
    }
    if (!Number.isInteger(afterSequence) || afterSequence < -1) {
      return failure('invalid-request', 'Event cursor is invalid')
    }
    if (record.events.length === 0) {
      return failure('adapter-unavailable', 'Connector has no serializable event ledger yet')
    }
    if (afterSequence > record.events.at(-1)!.sequence) {
      return failure('invalid-request', 'Event cursor is ahead of the Host ledger')
    }
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
    try {
      await this.internalSubscriptionObserver?.(clone(record.registration.registration))
    } catch {
      record.listeners.delete(listener)
      return failure('adapter-unavailable', 'Host subscription observer did not complete', true)
    }
    const subscription = freeze({
      $schema: CORDISX_CONNECTOR_EVENT_SUBSCRIPTION_SCHEMA_V1,
      contract: 'cordisx.connector-event-subscription/v1' as const,
      schemaVersion: 1 as const,
      subscriptionId: `cxsubscription:${this.nonce()}`,
      registration: clone(record.registration.registration),
      afterSequence,
      snapshotSequence: record.events.at(-1)!.sequence,
    })
    stream = new SerializedConnectorSubscription(subscription, () => {
      record.listeners.delete(listener)
    })
    const replay = record.events.filter(event =>
      event.sequence > afterSequence && event.sequence <= subscription.snapshotSequence
    )
    stream.replay(replay)
    for (const event of buffered) stream.live(event)
    return { ok: true, value: stream }
  }

  private active(connectorId: string): RegistrationRecord | undefined {
    return [...this.registrations.values()].find(record =>
      record.state === 'active' && record.registration.registration.connectorId === connectorId
    )
  }

  private record(registration: CordisXConnectorRegistrationIdentity): RegistrationRecord | undefined {
    const record = this.registrations.get(registration.registrationId)
    return record !== undefined && sameRegistration(record.registration.registration, registration) ? record : undefined
  }

  private validateAdapterSuccess(
    command: CordisXConnectorCommand,
    value: CordisXConnectorAdapterSuccess,
  ): CordisXConnectorResult<true> {
    if (!handle(value.conversation)) {
      return failure('adapter-unavailable', 'Connector adapter returned an invalid conversation handle')
    }
    const expected = command.type === 'conversation.open'
      ? 'opened'
      : command.type === 'message.send'
      ? 'sent'
      : command.type === 'run.stop'
      ? 'stopped'
      : 'closed'
    if (value.kind !== expected) {
      return failure('adapter-unavailable', 'Connector adapter returned an invalid command outcome')
    }
    if (
      command.type === 'conversation.open' && command.open.mode === 'continue'
      && value.conversation !== command.open.conversation
    ) {
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

  private commitOperation(
    record: RegistrationRecord,
    command: CordisXConnectorCommand,
    value: CordisXConnectorAdapterSuccess,
  ): void {
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
    if (record.connector.descriptor.capabilities.includes('lifecycle.dispose')) {
      this.emit(record, { type: 'connector.disposed', disposeReason: reason })
    }
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
      try {
        listener(clone(event))
      } catch { /* observers cannot corrupt Host event order */ }
    }
  }
}
