import {
  boundedString,
  CatalogError,
  catalogModels,
  type DiscoveryAdapter,
  type DiscoveryConnection,
  object,
} from './contracts.js'
import { withAbort } from './abort.js'

export function isDeepSeekOfficialEndpoint(endpoint: string): boolean {
  // Check spelling before URL normalization can discard dot segments or empty delimiters.
  if (!/^https:\/\/api\.deepseek\.com(?::443)?\/?$/u.test(endpoint)) return false
  const url = new URL(endpoint)
  return url.origin === 'https://api.deepseek.com' && url.pathname === '/'
}

function statusError(response: Response): CatalogError {
  const status = response.status
  if (status === 401) return new CatalogError('authentication')
  if (status === 403) return new CatalogError('permission')
  if (status === 402) return new CatalogError('account')
  if (status === 429) {
    const raw = response.headers.get('retry-after')
    const seconds = raw === null ? NaN : Number(raw)
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw ?? '') - Date.now()
    return new CatalogError('rate-limit', Number.isFinite(delay) ? Math.max(0, delay) : undefined)
  }
  return new CatalogError(status >= 500 ? 'temporary' : 'protocol')
}

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    throw new CatalogError('protocol')
  }
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > 1024 * 1024) throw new CatalogError('protocol')
      chunks.push(value)
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } catch {
      throw new CatalogError('protocol')
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    void reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export function deepSeekDiscoveryAdapter(): DiscoveryAdapter {
  return Object.freeze({
    id: 'deepseek-official',
    version: '2',
    pagination: 'none',
    matches: isDeepSeekOfficialEndpoint,
    async discover(connection: DiscoveryConnection, externalSignal: AbortSignal) {
      if (!isDeepSeekOfficialEndpoint(connection.endpoint)) throw new CatalogError('unsupported')
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), 10_000)
      timer.unref?.()
      const signal = AbortSignal.any([externalSignal, timeout.signal])
      try {
        signal.throwIfAborted()
        if (!connection.current()) throw new CatalogError('cancelled')
        const response = await withAbort(
          connection.request({ origin: 'https://api.deepseek.com', method: 'GET', path: '/models' }, signal),
          signal,
        )
        if (response.status !== 200) {
          void response.body?.cancel().catch(() => undefined)
          throw statusError(response)
        }
        if (response.redirected || (response.url && response.url !== 'https://api.deepseek.com/models')) {
          void response.body?.cancel().catch(() => undefined)
          throw new CatalogError('protocol')
        }
        const body = object(await readResponse(response, signal))
        if (
          !body || body.object !== 'list' || !Array.isArray(body.data) || body.data.length > 1000
          || body.has_more === true || body.nextCursor != null || body.next_cursor != null
        ) throw new CatalogError('protocol')
        const ids = body.data.map(item => {
          const model = object(item)
          if (!model || model.object !== 'model' || !boundedString(model.id) || !boundedString(model.owned_by, 256)) {
            throw new CatalogError('protocol')
          }
          return model.id
        })
        if (!connection.current()) throw new CatalogError('cancelled')
        // Official Codex integration documents these exact IDs. Unknown and legacy IDs stay unconfirmed.
        return Object.freeze(
          catalogModels(ids).map(model =>
            Object.freeze({
              ...model,
              protocolCapabilities: Object.freeze({
                responses: ['deepseek-flash', 'deepseek-v4-pro'].includes(model.id),
              }),
            })
          ),
        )
      } catch (error) {
        if (externalSignal.aborted) throw new CatalogError('cancelled')
        if (error instanceof CatalogError) throw error
        throw new CatalogError(signal.aborted || error instanceof TypeError ? 'temporary' : 'protocol')
      } finally {
        clearTimeout(timer)
      }
    },
  })
}
