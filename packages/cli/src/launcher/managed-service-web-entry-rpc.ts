import type {
  ManagedServiceWebEntryReadRequestV1,
  ManagedServiceWebEntryResultV1,
  ManagedServiceWebEntryUnavailableCodeV1,
} from '@cordisx/protocol/managed-service-web-entry/v1'
import type { ManagedServiceUIOwner, ManagedServiceUISourceBinding } from './managed-service-ui-rpc.js'
import { managedServiceUIBindingEqual } from './managed-service-ui-binding.js'
import { randomUUID } from 'node:crypto'

export type ManagedServiceWebEntryRPCRequest =
  & {
    readonly requestId: string
    readonly serviceId: string
    readonly binding: ManagedServiceWebEntryReadRequestV1['binding']
    readonly request: ManagedServiceWebEntryReadRequestV1
  }
  & ({ readonly operation: 'readWebEntry' } | {
    readonly operation: 'cancelWebEntry'
    readonly targetRequestId: string
  })

export function webEntryUnavailable(
  request: ManagedServiceWebEntryReadRequestV1,
  code: ManagedServiceWebEntryUnavailableCodeV1,
): ManagedServiceWebEntryResultV1 {
  return {
    contract: 'cordisx.managed-service-web-entry-result/v1',
    binding: request.binding,
    serviceGeneration: request.serviceGeneration,
    status: 'unavailable',
    code,
  }
}

function ownerKey(owner: ManagedServiceUIOwner): string {
  return JSON.stringify([owner.pluginId, owner.pluginGeneration])
}
function serviceKey(owner: ManagedServiceUIOwner, serviceId: string): string {
  return `${ownerKey(owner)}:${serviceId}`
}

/** Owns pending read cancellation independently of subscriptions and business actions. */
export class ManagedServiceWebEntryRPC {
  private readonly sources = new Map<string, ManagedServiceUISourceBinding>()
  private readonly issued = new Map<string, ManagedServiceWebEntryReadRequestV1>()
  private readonly pending = new Map<string, {
    readonly owner: string
    readonly request: ManagedServiceWebEntryReadRequestV1
    readonly controller: AbortController
  }>()
  private readonly revoked = new Set<string>()
  private disposed = false

  constructor(sources: readonly ManagedServiceUISourceBinding[]) {
    this.add(sources)
  }

  private add(sources: readonly ManagedServiceUISourceBinding[]) {
    for (const source of sources) this.sources.set(serviceKey(source, source.serviceId), source)
  }

  descriptor(owner: ManagedServiceUIOwner, serviceId: string) {
    const key = serviceKey(owner, serviceId)
    const source = this.sources.get(key)
    if (!source?.webEntry || this.disposed || this.revoked.has(ownerKey(owner))) return undefined
    let capture = this.issued.get(key)
    if (!capture || capture.serviceGeneration !== source.webEntry.serviceGeneration) {
      capture = Object.freeze({
        contract: 'cordisx.managed-service-web-entry-read/v1',
        binding: Object.freeze({ ...source.source.binding, bindingId: randomUUID() }),
        serviceGeneration: source.webEntry.serviceGeneration,
      })
      this.issued.set(key, capture)
    }
    return {
      contract: 'cordisx.managed-service-web-entry/v1' as const,
      binding: capture.binding,
      serviceGeneration: capture.serviceGeneration,
      timeoutMs: source.webEntry.timeoutMs,
    }
  }

  replace(owner: ManagedServiceUIOwner, sources: readonly ManagedServiceUISourceBinding[]) {
    this.remove(owner)
    this.add(sources)
  }

  private remove(owner: ManagedServiceUIOwner) {
    const key = ownerKey(owner)
    for (const [id, pending] of this.pending) {
      if (pending.owner === key) {
        pending.controller.abort()
        this.pending.delete(id)
      }
    }
    for (const [id, source] of this.sources) {
      if (ownerKey(source) === key) {
        this.sources.delete(id)
        this.issued.delete(id)
      }
    }
  }

  disposeOwner(owner: ManagedServiceUIOwner) {
    this.revoked.add(ownerKey(owner))
    this.remove(owner)
  }
  dispose() {
    this.disposed = true
    for (const pending of this.pending.values()) pending.controller.abort()
    this.pending.clear()
    this.sources.clear()
    this.issued.clear()
  }

  async handle(
    owner: ManagedServiceUIOwner,
    input: ManagedServiceWebEntryRPCRequest,
  ): Promise<ManagedServiceWebEntryResultV1> {
    const request = input.request
    const unavailable = (code: ManagedServiceWebEntryUnavailableCodeV1) => webEntryUnavailable(request, code)
    const key = serviceKey(owner, input.serviceId)
    const source = this.sources.get(key)
    const captured = this.issued.get(key)
    const invalid = (): ManagedServiceWebEntryUnavailableCodeV1 | undefined => {
      if (this.disposed) return 'disposed'
      if (this.revoked.has(ownerKey(owner))) return 'owner-unavailable'
      if (!source || this.sources.get(key) !== source) return 'binding-replaced'
      if (!source.webEntry) return 'unsupported'
      if (source.webEntry.serviceGeneration !== request.serviceGeneration) return 'stale-generation'
      if (
        !captured || this.issued.get(key) !== captured || captured.serviceGeneration !== request.serviceGeneration
        || !managedServiceUIBindingEqual(captured.binding, request.binding)
        || !managedServiceUIBindingEqual(input.binding, request.binding)
      ) return 'binding-replaced'
      return undefined
    }
    const initial = invalid()
    if (initial) return unavailable(initial)
    const pendingKey = JSON.stringify([
      ownerKey(owner),
      input.operation === 'cancelWebEntry' ? input.targetRequestId : input.requestId,
    ])
    if (input.operation === 'cancelWebEntry') {
      const pending = this.pending.get(pendingKey)
      if (
        pending && managedServiceUIBindingEqual(pending.request.binding, request.binding)
        && pending.request.serviceGeneration === request.serviceGeneration
      ) pending.controller.abort()
      return unavailable('cancelled')
    }
    if (this.pending.has(pendingKey)) return unavailable('invalid-source')
    const controller = new AbortController()
    this.pending.set(pendingKey, { owner: ownerKey(owner), request, controller })
    try {
      const result = await source!.webEntry!.read(request.serviceGeneration, controller.signal)
      const stale = invalid()
      if (stale) return unavailable(stale)
      if (controller.signal.aborted) return unavailable('cancelled')
      return result.status === 'available'
        ? {
          contract: 'cordisx.managed-service-web-entry-result/v1',
          binding: request.binding,
          serviceGeneration: request.serviceGeneration,
          status: 'available',
          origin: result.origin,
        }
        : unavailable(result.code)
    } catch {
      return unavailable(invalid() ?? 'service-unavailable')
    } finally {
      if (this.pending.get(pendingKey)?.controller === controller) this.pending.delete(pendingKey)
    }
  }
}
