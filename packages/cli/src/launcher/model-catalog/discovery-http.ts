import { CatalogError, type DiscoveryConnection, MAX_DISCOVERY_RESPONSE_BYTES } from './contracts.js'
import { withAbort } from './abort.js'

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

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
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
      if (size > MAX_DISCOVERY_RESPONSE_BYTES) throw new CatalogError('protocol')
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

export async function discoverJson(
  connection: DiscoveryConnection,
  baseUrl: string,
  externalSignal: AbortSignal,
): Promise<unknown> {
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 10_000)
  timer.unref?.()
  const signal = AbortSignal.any([externalSignal, timeout.signal])
  try {
    signal.throwIfAborted()
    if (!connection.current()) throw new CatalogError('cancelled')
    const response = await withAbort(
      connection.request({ origin: baseUrl, method: 'GET', path: '/models' }, signal),
      signal,
    )
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined)
      throw statusError(response)
    }
    if (response.redirected || (response.url && response.url !== `${baseUrl}/models`)) {
      void response.body?.cancel().catch(() => undefined)
      throw new CatalogError('protocol')
    }
    const body = await readJson(response, signal)
    if (!connection.current()) throw new CatalogError('cancelled')
    return body
  } catch (error) {
    if (externalSignal.aborted) throw new CatalogError('cancelled')
    if (error instanceof CatalogError) throw error
    throw new CatalogError(signal.aborted || error instanceof TypeError ? 'temporary' : 'protocol')
  } finally {
    clearTimeout(timer)
  }
}
