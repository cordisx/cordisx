import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP } from 'node:net'

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
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('marketplace feed must be an HTTPS URL without credentials or fragment')
  }
  return url
}

function publicIpv4(value: string): boolean {
  const octets = value.split('.').map(Number)
  const first = octets[0]
  const second = octets[1]
  if (
    octets.length !== 4 || first === undefined || second === undefined
    || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) return false
  if (first === 0 || first === 10 || first === 127 || first >= 224) return false
  if (first === 100 && second >= 64 && second <= 127) return false
  if (first === 169 && second === 254) return false
  if (first === 172 && second >= 16 && second <= 31) return false
  if (first === 192 && (second === 0 || second === 168)) return false
  if (first === 198 && (second === 18 || second === 19 || (second === 51 && octets[2] === 100))) return false
  if (first === 203 && second === 0 && octets[2] === 113) return false
  return true
}

function syntheticProxyIpv4(value: string): boolean {
  const [first, second] = value.split('.').map(Number)
  return first === 198 && (second === 18 || second === 19)
}

function publicIpv6(value: string): boolean {
  const address = value.toLowerCase()
  if (address === '::' || address === '::1' || address.startsWith('::ffff:')) return false
  const firstText = address.split(':', 1)[0]
  const first = Number.parseInt(firstText ?? '', 16)
  if (!Number.isFinite(first)) return false
  if (first >= 0xfc00 && first <= 0xfdff) return false
  if (first >= 0xfe80 && first <= 0xfebf) return false
  if (first >= 0xff00) return false
  if (address.startsWith('2001:db8:') || address === '2001:db8::') return false
  if (address.startsWith('2002:') || address.startsWith('64:ff9b:')) return false
  return true
}

/** Reject loopback, private, link-local, documentation, multicast, and other non-public destinations. */
export function isPublicMarketplaceAddress(value: string): boolean {
  const family = isIP(value)
  if (family === 4) return publicIpv4(value)
  if (family === 6) return publicIpv6(value)
  return false
}

async function resolvePublicAddress(hostname: string): Promise<{ readonly address: string; readonly family: 4 | 6 }> {
  const lowered = hostname.toLowerCase()
  if (lowered === 'localhost' || lowered.endsWith('.localhost') || lowered.endsWith('.local')) {
    throw new Error('marketplace feed hostname is not public')
  }
  const literalFamily = isIP(hostname)
  const addresses = literalFamily === 0
    ? await lookup(hostname, { all: true, verbatim: true })
    : [{ address: hostname, family: literalFamily }]
  const resolvedHostname = literalFamily === 0
  if (
    addresses.length === 0 || addresses.some(item => {
      return !isPublicMarketplaceAddress(item.address)
        && !(resolvedHostname && syntheticProxyIpv4(item.address))
    })
  ) {
    throw new Error('marketplace feed resolved to a non-public address')
  }
  const selected = addresses[0]
  if (selected === undefined || (selected.family !== 4 && selected.family !== 6)) {
    throw new Error('marketplace feed address family is unsupported')
  }
  return { address: selected.address, family: selected.family }
}

interface HttpsResult {
  readonly status: number
  readonly location?: string
  readonly body: Buffer
}

async function requestOnce(url: URL, signal?: AbortSignal): Promise<HttpsResult> {
  const target = await resolvePublicAddress(url.hostname)
  return await new Promise<HttpsResult>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const operation = request({
      protocol: 'https:',
      hostname: target.address,
      family: target.family,
      port: url.port === '' ? 443 : Number(url.port),
      servername: url.hostname,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: {
        accept: 'application/json',
        'accept-encoding': 'identity',
        host: url.host,
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

/** Fetch one display-only feed through a public-HTTPS-only launcher boundary. */
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
