import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'

const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_REDIRECTS = 4
const REQUEST_TIMEOUT_MS = 10_000

export interface MarketplaceFetchResult {
  readonly url: string
  readonly status: number
  readonly text: string
}

export function normalizeMarketplaceRequestUrl(value: string): URL {
  const url = new URL(value)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
  ) {
    throw new Error('marketplace feed must be an HTTP or HTTPS URL without credentials or fragment')
  }
  return url
}

interface RequestResult {
  readonly status: number
  readonly location?: string
  readonly body: Buffer
}

async function requestOnce(url: URL, signal?: AbortSignal): Promise<RequestResult> {
  const request = url.protocol === 'http:' ? requestHttp : requestHttps
  return await new Promise<RequestResult>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const operation = request(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent': 'CordisX-Marketplace/0.1',
      },
    }, (response) => {
      const status = response.statusCode ?? 0
      const length = Number(response.headers['content-length'] ?? 0)
      if (Number.isFinite(length) && length > MAX_FEED_BYTES) {
        response.destroy(new Error('marketplace feed exceeds 2 MiB'))
        return
      }
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.byteLength
        if (size > MAX_FEED_BYTES) {
          response.destroy(new Error('marketplace feed exceeds 2 MiB'))
          return
        }
        chunks.push(buffer)
      })
      response.once('end', () =>
        resolve({
          status,
          ...(typeof response.headers.location === 'string' ? { location: response.headers.location } : {}),
          body: Buffer.concat(chunks),
        }))
      response.once('error', reject)
    })
    operation.setTimeout(REQUEST_TIMEOUT_MS, () => operation.destroy(new Error('marketplace feed request timed out')))
    operation.once('error', reject)
    const abort = (): void => {
      operation.destroy(new Error('marketplace feed request aborted'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    operation.once('close', () => signal?.removeEventListener('abort', abort))
    if (signal?.aborted === true) abort()
    else operation.end()
  })
}

/** Fetch one display-only feed from a user-configured HTTP or HTTPS source. */
export async function fetchMarketplaceFeed(
  value: string,
  signal?: AbortSignal,
  redirects = 0,
): Promise<MarketplaceFetchResult> {
  const url = normalizeMarketplaceRequestUrl(value)
  const response = await requestOnce(url, signal)
  if ([301, 302, 303, 307, 308].includes(response.status) && response.location !== undefined) {
    if (redirects >= MAX_REDIRECTS) throw new Error('marketplace feed redirected too many times')
    const destination = new URL(response.location, url)
    normalizeMarketplaceRequestUrl(destination.href)
    return await fetchMarketplaceFeed(destination.href, signal, redirects + 1)
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(response.body)
  return { url: url.href, status: response.status, text }
}
