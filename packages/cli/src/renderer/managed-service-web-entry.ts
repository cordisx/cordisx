import type {
  ManagedServiceWebEntryReadRequestV1,
  ManagedServiceWebEntryResultV1,
  ManagedServiceWebEntryUnavailableCodeV1,
  ManagedServiceWebEntryV1,
} from '@cordisx/protocol/managed-service-web-entry/v1'
import type { ManagedServiceWebEntryRPCRequest } from '../launcher/managed-service-web-entry-rpc.js'

export interface ManagedServiceWebEntryDescriptor {
  readonly contract: 'cordisx.managed-service-web-entry/v1'
  readonly binding: ManagedServiceWebEntryReadRequestV1['binding']
  readonly serviceGeneration: string
  readonly timeoutMs: number
}

/** The caller gets an immutable generation capture, never a URL-bearing request method. */
export function createBrowserManagedServiceWebEntry(
  descriptor: ManagedServiceWebEntryDescriptor,
  nextRequestId: () => string,
  invoke: (request: ManagedServiceWebEntryRPCRequest, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>,
): ManagedServiceWebEntryV1 {
  const binding = Object.freeze({
    bindingId: descriptor.binding.bindingId,
    identity: Object.freeze({ ...descriptor.binding.identity }),
    scope: Object.freeze({ ...descriptor.binding.scope }),
  })
  const request = Object.freeze({
    contract: 'cordisx.managed-service-web-entry-read/v1' as const,
    binding,
    serviceGeneration: descriptor.serviceGeneration,
  })
  const unavailable = (code: ManagedServiceWebEntryUnavailableCodeV1): ManagedServiceWebEntryResultV1 => ({
    contract: 'cordisx.managed-service-web-entry-result/v1',
    binding,
    serviceGeneration: request.serviceGeneration,
    status: 'unavailable',
    code,
  })
  const timeoutMs = Number.isSafeInteger(descriptor.timeoutMs) && descriptor.timeoutMs >= 1
      && descriptor.timeoutMs <= 300_000
    ? descriptor.timeoutMs + 1_000
    : 8_000
  return Object.freeze({
    contract: 'cordisx.managed-service-web-entry/v1',
    binding,
    serviceGeneration: request.serviceGeneration,
    async read(options?: { readonly signal?: AbortSignal }): Promise<ManagedServiceWebEntryResultV1> {
      if (options?.signal?.aborted) return unavailable('cancelled')
      const id = nextRequestId()
      let cancelled = false
      const cancel = () => {
        if (cancelled) return
        cancelled = true
        void invoke({
          requestId: nextRequestId(),
          operation: 'cancelWebEntry',
          serviceId: binding.identity.serviceId,
          binding,
          request,
          targetRequestId: id,
        }, 8_000).catch(() => undefined)
      }
      options?.signal?.addEventListener('abort', cancel, { once: true })
      try {
        const result = await invoke(
          { requestId: id, operation: 'readWebEntry', serviceId: binding.identity.serviceId, binding, request },
          timeoutMs,
          options?.signal,
        ) as ManagedServiceWebEntryResultV1
        if (options?.signal?.aborted) return unavailable('cancelled')
        if (
          result.contract !== 'cordisx.managed-service-web-entry-result/v1'
          || result.serviceGeneration !== request.serviceGeneration
          || JSON.stringify(result.binding) !== JSON.stringify(binding)
        ) return unavailable('binding-replaced')
        return result.status === 'available'
          ? {
            contract: result.contract,
            binding,
            serviceGeneration: request.serviceGeneration,
            status: 'available',
            origin: result.origin,
          }
          : unavailable(result.code)
      } catch (error) {
        cancel()
        return unavailable(
          options?.signal?.aborted
            ? 'cancelled'
            : error instanceof Error && error.message.includes('timed out')
            ? 'timeout'
            : 'owner-unavailable',
        )
      } finally {
        options?.signal?.removeEventListener('abort', cancel)
      }
    },
  })
}
