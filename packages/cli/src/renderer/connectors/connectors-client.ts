import type { CordisXConnectorBroker } from './connectors-broker.js'

import {
  BoundConnectorClientRefusal,
  clone,
  ConnectorExecution,
  CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1,
  CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1,
  CORDISX_CONNECTOR_EVENT_PAGE_SCHEMA_V1,
  CordisXBoundConnectorClient,
  CordisXBoundConnectorClientOptions,
  CordisXBoundConnectorClientResult,
  CordisXConnectorAuthorization,
  CordisXConnectorClientCapability,
  CordisXConnectorCommand,
  CordisXConnectorEvent,
  CordisXConnectorEventPage,
  CordisXConnectorEventSubscription,
  CordisXConnectorRegistrationIdentity,
  CordisXConnectorSubscribeRuntimeResult,
  CordisXConnectorSubscription,
  freeze,
  handle,
} from './connectors-contract.js'

export class SerializedConnectorSubscription
  implements CordisXConnectorSubscription, AsyncIterable<CordisXConnectorEventPage>
{
  readonly pages: AsyncIterable<CordisXConnectorEventPage> = this
  private readonly pending: CordisXConnectorEventPage[] = []
  private readonly waiters: ((value: IteratorResult<CordisXConnectorEventPage>) => void)[] = []
  private cursor: number
  private replayDone = false
  private closed = false
  private cancelled = false

  constructor(readonly subscription: CordisXConnectorEventSubscription, private readonly remove: () => void) {
    this.cursor = subscription.afterSequence
  }

  replay(events: readonly CordisXConnectorEvent[]): void {
    for (let index = 0; index < events.length; index += 1) {
      this.enqueue('replay', events[index]!, index < events.length - 1)
    }
    this.replayDone = true
  }

  live(event: CordisXConnectorEvent): void {
    if (this.closed || event.sequence <= this.subscription.snapshotSequence) return
    this.enqueue('live', event, false)
    if (event.type === 'connector.disposed') this.closeAfterDrain()
  }

  unsubscribe(): void {
    this.cancel()
  }

  [Symbol.asyncIterator](): AsyncIterator<CordisXConnectorEventPage> {
    return this
  }

  next(): Promise<IteratorResult<CordisXConnectorEventPage>> {
    if (this.cancelled) return Promise.resolve({ done: true, value: undefined })
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

  /** Explicit cancellation never leaks queued replay/live pages. Terminal replacement uses closeAfterDrain(). */
  private cancel(): void {
    if (this.cancelled) return
    this.closed = true
    this.cancelled = true
    this.pending.length = 0
    this.remove()
    this.flush()
  }

  private flush(): void {
    if (this.pending.length !== 0) return
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined })
  }
}

export class BoundConnectorClient implements CordisXBoundConnectorClient {
  readonly $schema = CORDISX_BOUND_CONNECTOR_CLIENT_SCHEMA_V1
  readonly contract = 'cordisx.bound-connector-client/v1' as const
  readonly schemaVersion = 1 as const
  private readonly subscriptions = new Set<CordisXConnectorSubscription>()
  private closed = false
  private nextCall = 0

  constructor(
    private readonly broker: CordisXConnectorBroker,
    private readonly options: CordisXBoundConnectorClientOptions,
  ) {}

  async discover(): Promise<CordisXBoundConnectorClientResult<'discover'>> {
    const callId = this.callId()
    const authorization = await this.authorize('connector.discovery')
    if (authorization.state !== 'allowed') return this.refusal(callId, 'discover', authorization)
    return freeze({
      ...this.base(callId, 'discover', 'accepted', authorization),
      snapshot: await this.broker.clientSnapshot(),
    })
  }

  async execute(command: CordisXConnectorCommand): Promise<CordisXBoundConnectorClientResult<'execute'>> {
    const callId = this.callId()
    const authorization = await this.authorize('connector.command.execute', command.registration)
    if (authorization.state !== 'allowed') return this.refusal(callId, 'execute', authorization)
    const result = await this.broker.command(command, true)
    if (!result.ok) {
      return this.refusal(callId, 'execute', {
        capability: 'connector.command.execute',
        state: 'unavailable',
        code: 'unsupported',
      })
    }
    const execution: ConnectorExecution = command.type === 'conversation.open'
      ? { kind: 'conversation.opened', conversation: result.value.conversation }
      : command.type === 'message.send'
      ? { kind: 'message.sent', conversation: result.value.conversation, messageId: command.message.messageId }
      : command.type === 'run.stop'
      ? {
        kind: 'run.stopped',
        binding: { registration: clone(command.registration), conversation: command.conversation, run: command.run },
      }
      : { kind: 'conversation.closed', conversation: command.conversation }
    return freeze({ ...this.base(callId, 'execute', 'accepted', authorization), execution })
  }

  async subscribe(
    registration: CordisXConnectorRegistrationIdentity,
    afterSequence: number,
  ): Promise<CordisXConnectorSubscribeRuntimeResult> {
    const callId = this.callId()
    const authorization = await this.authorize('connector.events.subscribe', registration)
    if (authorization.state !== 'allowed') return { result: this.refusal(callId, 'subscribe', authorization) }
    const opened = await this.broker.openSubscription(registration, afterSequence)
    if (!opened.ok) {
      return {
        result: this.refusal(callId, 'subscribe', {
          capability: 'connector.events.subscribe',
          state: 'unavailable',
          code: 'unsupported',
        }),
      }
    }
    this.subscriptions.add(opened.value)
    const original = opened.value.unsubscribe.bind(opened.value)
    const handle: CordisXConnectorSubscription = Object.freeze({
      subscription: opened.value.subscription,
      pages: opened.value.pages,
      unsubscribe: () => {
        original()
        this.subscriptions.delete(opened.value)
      },
    })
    return {
      result: freeze({
        ...this.base(callId, 'subscribe', 'accepted', authorization),
        subscription: clone(opened.value.subscription),
      }),
      handle,
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const subscription of this.subscriptions) subscription.unsubscribe()
    this.subscriptions.clear()
  }

  private async authorize(
    capability: CordisXConnectorClientCapability,
    registration?: CordisXConnectorRegistrationIdentity,
  ): Promise<CordisXConnectorAuthorization> {
    if (this.closed || !this.options.active()) {
      return { capability, state: 'unavailable', code: 'principal-unavailable' }
    }
    return await this.options.authorize(capability, registration)
  }

  private callId(): string {
    return this.options.callId?.() ?? `cxcall:${this.nextCall++}`
  }
  private base<Type extends 'discover' | 'execute' | 'subscribe'>(
    callId: string,
    type: Type,
    status: 'accepted',
    authorization: Extract<CordisXConnectorAuthorization, { readonly state: 'allowed' }>,
  ) {
    return {
      $schema: CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1,
      contract: 'cordisx.bound-connector-client-result/v1' as const,
      schemaVersion: 1 as const,
      callId,
      type,
      status,
      authorization,
    }
  }
  private refusal<Type extends 'discover' | 'execute' | 'subscribe'>(
    callId: string,
    type: Type,
    authorization: Exclude<CordisXConnectorAuthorization, { readonly state: 'allowed' }>,
  ): BoundConnectorClientRefusal<Type> {
    return freeze({
      $schema: CORDISX_BOUND_CONNECTOR_CLIENT_RESULT_SCHEMA_V1,
      contract: 'cordisx.bound-connector-client-result/v1' as const,
      schemaVersion: 1 as const,
      callId,
      type,
      status: authorization.state === 'denied' ? 'denied' as const : 'unavailable' as const,
      authorization,
    }) as BoundConnectorClientRefusal<Type>
  }
}
