import { createHash, randomUUID } from 'node:crypto'
import type {
  PlatformProviderBrokerBindingV1,
  PlatformProviderBrokerDeclarationV1,
  PlatformProviderBrokerEventV1,
  PlatformProviderBrokerPolicyV1,
  PlatformProviderBrokerRequestV1,
  PlatformProviderBrokerResponseV1,
  PlatformProviderBrokerResultV1,
  PlatformProviderBrokerV1,
  PlatformProviderJsonValue,
  PlatformProviderOperationV1,
  PlatformProviderOwnerV1,
} from '@cordisx/protocol/platform-provider/v1'
import { immutable, METHOD, safeValue } from './platform-provider-validation.js'

function bindingTuple(binding: PlatformProviderBrokerBindingV1): readonly string[] {
  return binding.direction === 'request'
    ? [binding.direction, binding.operation, binding.method, binding.requestSchema, binding.resultSchema]
    : [binding.direction, binding.operation, binding.method, binding.eventSchema, binding.responseSchema]
}

function bindingsDigest(bindings: readonly PlatformProviderBrokerBindingV1[]): `sha256:${string}` {
  const tuples = bindings.map(bindingTuple)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  return `sha256:${createHash('sha256').update(JSON.stringify(tuples)).digest('hex')}`
}

function exactBinding(
  left: PlatformProviderBrokerBindingV1,
  right: PlatformProviderBrokerBindingV1,
): boolean {
  return JSON.stringify(bindingTuple(left)) === JSON.stringify(bindingTuple(right))
}

export interface HostPlatformProviderBrokerCatalogV1 {
  readonly catalogDigest: `sha256:${string}`
  readonly bindings: readonly PlatformProviderBrokerBindingV1[]
}

export function issuePlatformProviderBrokerPolicy(input: {
  readonly owner: PlatformProviderOwnerV1
  readonly providerId: string
  readonly providerGeneration: string
  readonly operations: readonly PlatformProviderOperationV1[]
  readonly request: PlatformProviderBrokerDeclarationV1
  readonly catalog: HostPlatformProviderBrokerCatalogV1
}): PlatformProviderBrokerPolicyV1 {
  const operations = new Set(input.operations)
  const seen = new Set<string>()
  const bindings = input.request.bindings.map(binding => {
    if (!operations.has(binding.operation)) throw new Error(`broker operation ${binding.operation} is undeclared`)
    if (!METHOD.test(binding.method)) throw new Error(`broker method ${binding.method} is invalid`)
    if (!input.catalog.bindings.some(candidate => exactBinding(candidate, binding))) {
      throw new Error(`broker binding ${binding.operation}:${binding.method} is unsupported by the Host catalog`)
    }
    const key = bindingTuple(binding).join('\0')
    if (seen.has(key)) throw new Error(`duplicate broker binding ${binding.operation}:${binding.method}`)
    seen.add(key)
    return immutable(binding)
  }) as [PlatformProviderBrokerBindingV1, ...PlatformProviderBrokerBindingV1[]]
  if (bindings.length === 0) throw new Error('provider broker request must not be empty')
  return immutable({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-policy.v1.schema.json',
    contract: 'cordisx.platform-provider-broker-policy/v1',
    schemaVersion: 1,
    catalogDigest: input.catalog.catalogDigest,
    policyDigest: bindingsDigest(bindings),
    brokerHandle: `ppb_${randomUUID()}`,
    owner: input.owner,
    providerId: input.providerId,
    providerGeneration: input.providerGeneration,
    bindings,
  })
}

export interface HostPlatformProviderBrokerTransportV1 {
  exchange(method: string, params: PlatformProviderJsonValue, signal?: AbortSignal): Promise<PlatformProviderJsonValue>
  subscribe(
    listener: (event: {
      readonly eventId: string
      readonly operation: PlatformProviderOperationV1
      readonly method: string
      readonly payload: PlatformProviderJsonValue
      readonly responseRequired: boolean
    }) => void | Promise<void>,
  ): () => void
  respond(eventId: string, method: string, value: PlatformProviderJsonValue): Promise<void>
  dispose(): Promise<void>
}

export class HostBoundPlatformProviderBrokerV1 implements PlatformProviderBrokerV1 {
  readonly policy: PlatformProviderBrokerPolicyV1
  private readonly subscriptions = new Map<string, () => void>()
  private readonly pending = new Map<string, PlatformProviderBrokerEventV1>()
  private sequence = 0
  private disposed = false
  readonly #transport: HostPlatformProviderBrokerTransportV1

  constructor(
    policy: PlatformProviderBrokerPolicyV1,
    transport: HostPlatformProviderBrokerTransportV1,
  ) {
    this.policy = immutable(policy)
    this.#transport = transport
  }

  async exchange(
    request: PlatformProviderBrokerRequestV1,
    signal?: AbortSignal,
  ): Promise<PlatformProviderBrokerResultV1> {
    const base = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-result.v1.schema.json' as const,
      contract: 'cordisx.platform-provider-broker-result/v1' as const,
      schemaVersion: 1 as const,
      requestId: request.requestId,
      operation: request.operation,
      method: request.method,
    }
    if (this.disposed) return { ...base, status: 'unavailable', code: 'disposed' }
    const binding = this.policy.bindings.find((candidate): candidate is Extract<
      PlatformProviderBrokerBindingV1,
      { direction: 'request' }
    > =>
      candidate.direction === 'request'
      && candidate.operation === request.operation
      && candidate.method === request.method
    )
    if (binding === undefined) return { ...base, status: 'rejected', code: 'method-not-declared' }
    if (request.requestSchema !== binding.requestSchema) {
      return { ...base, status: 'rejected', code: 'schema-mismatch' }
    }
    try {
      const value = safeValue(await this.#transport.exchange(request.method, safeValue(request.params), signal))
      return immutable({ ...base, status: 'accepted', resultSchema: binding.resultSchema, value })
    } catch (error) {
      return {
        ...base,
        status: signal?.aborted ? 'unavailable' : 'rejected',
        code: signal?.aborted ? 'stale-generation' : 'invalid-request',
      }
    }
  }

  subscribe(
    operations: readonly [PlatformProviderOperationV1, ...PlatformProviderOperationV1[]],
    listener: (event: PlatformProviderBrokerEventV1) => void | Promise<void>,
  ): { readonly subscriptionId: `ppbs_${string}`; unsubscribe(): void } {
    if (this.disposed) throw new Error('Platform provider broker is disposed')
    const allowed = new Set(operations)
    for (const operation of allowed) {
      if (!this.policy.bindings.some(binding => binding.direction === 'event' && binding.operation === operation)) {
        throw new Error(`broker event operation ${operation} is undeclared`)
      }
    }
    const subscriptionId = `ppbs_${randomUUID()}` as const
    const dispose = this.#transport.subscribe(async candidate => {
      if (this.disposed || !allowed.has(candidate.operation)) return
      const binding = this.policy.bindings.find((item): item is Extract<
        PlatformProviderBrokerBindingV1,
        { direction: 'event' }
      > => item.direction === 'event' && item.operation === candidate.operation && item.method === candidate.method)
      if (binding === undefined) return
      this.sequence += 1
      const event = immutable({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/platform-provider-broker-event.v1.schema.json' as const,
        contract: 'cordisx.platform-provider-broker-event/v1' as const,
        schemaVersion: 1 as const,
        eventId: candidate.eventId,
        sequence: this.sequence,
        operation: candidate.operation,
        method: candidate.method,
        eventSchema: binding.eventSchema,
        payload: safeValue(candidate.payload),
        responseRequired: candidate.responseRequired,
      })
      if (event.responseRequired) this.pending.set(event.eventId, event)
      await listener(event)
    })
    this.subscriptions.set(subscriptionId, dispose)
    let unsubscribed = false
    return Object.freeze({
      subscriptionId,
      unsubscribe: () => {
        if (unsubscribed) return
        unsubscribed = true
        this.subscriptions.get(subscriptionId)?.()
        this.subscriptions.delete(subscriptionId)
      },
    })
  }

  async respond(response: PlatformProviderBrokerResponseV1): Promise<'accepted' | 'stale' | 'rejected'> {
    if (this.disposed) return 'stale'
    const event = this.pending.get(response.eventId)
    if (event === undefined) return 'stale'
    const binding = this.policy.bindings.find((item): item is Extract<
      PlatformProviderBrokerBindingV1,
      { direction: 'event' }
    > => item.direction === 'event' && item.operation === response.operation && item.method === response.method)
    if (
      binding === undefined || event.operation !== response.operation || event.method !== response.method
      || binding.responseSchema !== response.responseSchema
    ) return 'rejected'
    this.pending.delete(response.eventId)
    await this.#transport.respond(response.eventId, response.method, safeValue(response.value))
    return 'accepted'
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.subscriptions.values()) dispose()
    this.subscriptions.clear()
    this.pending.clear()
    await this.#transport.dispose()
  }
}
