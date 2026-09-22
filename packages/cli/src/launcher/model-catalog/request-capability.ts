import { boundedString, CatalogError, type DiscoveryConnection, type DiscoveryRequest } from './contracts.js'
import { withAbort } from './abort.js'

export type DiscoveryFetch = (url: string, init: RequestInit) => Promise<Response>

/** Host-only credential use. Adapters cannot supply headers, a body or a destination. */
export function createDiscoveryRequestCapability(input: {
  readonly operation: DiscoveryRequest
  readonly current: () => boolean
  readonly bearer: (signal: AbortSignal) => Promise<string | undefined>
  readonly fetcher?: DiscoveryFetch
}): DiscoveryConnection['request'] {
  const allowed = Object.freeze({ ...input.operation })
  return async (operation, signal) => {
    if (
      !operation || Object.keys(operation).some(key => !['origin', 'method', 'path'].includes(key))
      || operation.origin !== allowed.origin || operation.method !== allowed.method || operation.path !== allowed.path
    ) throw new CatalogError('permission')
    signal.throwIfAborted()
    if (!input.current()) throw new CatalogError('cancelled')
    try {
      const bearer = await withAbort(input.bearer(signal), signal)
      if (!input.current() || signal.aborted) throw new CatalogError('cancelled')
      if (!boundedString(bearer, 16_384) || /\s/u.test(bearer)) throw new CatalogError('credential-unavailable')
      const response = await withAbort(
        (input.fetcher ?? fetch)(`${allowed.origin}${allowed.path}`, {
          method: allowed.method,
          redirect: 'error',
          headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
          signal,
        }),
        signal,
      )
      if (!input.current() || signal.aborted) {
        void response.body?.cancel().catch(() => undefined)
        throw new CatalogError('cancelled')
      }
      if (response.redirected || (response.url && response.url !== `${allowed.origin}${allowed.path}`)) {
        void response.body?.cancel().catch(() => undefined)
        throw new CatalogError('protocol')
      }
      // Keep the short lease alive through body completion, not just response headers.
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined)
        return new Response(null, {
          status: response.status,
          headers: { 'retry-after': response.headers.get('retry-after') ?? '' },
        })
      }
      const reader = response.body?.getReader()
      if (!reader) throw new CatalogError('protocol')
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const value = await withAbort(reader.read(), signal)
          if (!input.current() || signal.aborted) throw new CatalogError('cancelled')
          if (value.done) break
          length += value.value.byteLength
          if (length > 1024 * 1024) throw new CatalogError('protocol')
          chunks.push(value.value)
        }
        return new Response(Buffer.concat(chunks), {
          headers: { 'content-type': response.headers.get('content-type') ?? '' },
        })
      } finally {
        void reader.cancel().catch(() => undefined)
        reader.releaseLock()
      }
    } catch (error) {
      if (error instanceof CatalogError) throw error
      throw new CatalogError(signal.aborted ? 'cancelled' : 'temporary')
    }
  }
}
