import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, request, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { ManagedBrowserConsoleBoundary } from './managed-service-browser-console-broker.js'

type RouteInput = Parameters<ManagedBrowserConsoleBoundary['open']>[0]

interface CookieBinding {
  readonly name: string
  readonly digest: string
}

interface GatewayRoute extends RouteInput {
  readonly upstreamURL: URL
  readonly dispose: () => void
  cookie?: CookieBinding
  cleanNavigation?: string
  redemption?: { readonly digest: string; readonly expiresAt: number }
}

const REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'if-modified-since',
  'if-none-match',
  'range',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
] as const
const RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-range',
  'content-security-policy',
  'cross-origin-resource-policy',
  'x-content-type-options',
  'x-frame-options',
] as const

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function headerProjection(headers: IncomingMessage['headers'], names: readonly string[]): OutgoingHttpHeaders {
  return Object.fromEntries(names.flatMap(name => {
    const value = headers[name]
    return typeof value === 'string' ? [[name, value]] : []
  }))
}

function browserCookie(
  value: string,
): { readonly name: string; readonly pair: string; readonly clearing: boolean } | undefined {
  const [pair, ...fields] = value.split(';').map(field => field.trim())
  const match = /^(__Host-[A-Za-z0-9_-]{1,80})=([A-Za-z0-9_-]{0,128})$/u.exec(pair!)
  if (!match) return undefined
  const attributes = new Set(fields.map(field => field.toLowerCase()))
  if (
    fields.length !== attributes.size || !['path=/', 'secure', 'httponly', 'partitioned', 'samesite=none']
      .every(field => attributes.has(field))
    || fields.some(field => /^domain(?:=|$)/iu.test(field))
  ) return undefined
  const clearing = match[2] === '' && attributes.has('max-age=0')
  if (!clearing && match[2]!.length < 24) return undefined
  return { name: match[1]!, pair: pair!, clearing }
}

function forwardedCookie(header: string | undefined, binding: CookieBinding | undefined): string | undefined {
  if (!header || !binding) return undefined
  return header.split(';').map(value => value.trim()).find(pair =>
    pair.startsWith(binding.name + '=') && digest(pair) === binding.digest
  )
}

function redirect(
  response: IncomingMessage,
  upstream: URL,
  ticket: string | undefined,
): string | undefined {
  if (![301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) return undefined
  if (!response.headers.location) throw new Error('Managed console redirect has no destination')
  const target = new URL(response.headers.location, upstream)
  const location = target.pathname + target.search + target.hash
  if (
    target.origin !== upstream.origin || target.username || target.password
    || target.searchParams.has('ticket') || target.pathname.startsWith('//')
    || (ticket !== undefined && (location.includes(ticket) || location.includes('%') || target.hash !== ''))
  ) throw new Error('Managed console redirect left its verified origin')
  return location
}

function reply(res: ServerResponse, status: number) {
  if (res.headersSent) res.destroy()
  else res.writeHead(status, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end()
}

async function forward(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  route: GatewayRoute,
  origin: string,
) {
  const rawPath = incoming.url ?? ''
  if (!rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) return reply(outgoing, 400)
  const target = new URL(rawPath, route.upstreamURL)
  if (target.origin !== route.upstreamURL.origin) return reply(outgoing, 400)
  const requestOrigin = incoming.headers.origin
  if (requestOrigin !== undefined && requestOrigin !== origin) return reply(outgoing, 403)
  if (incoming.method !== 'GET' && incoming.method !== 'HEAD' && requestOrigin !== origin) return reply(outgoing, 403)
  const redeeming = target.pathname === route.redeemPath
  const presentedTicket = target.searchParams.get('ticket')
  if (
    (presentedTicket !== null && !redeeming)
    || (redeeming && (target.searchParams.size !== 1 || !/^[A-Za-z0-9_-]{32}$/u.test(presentedTicket ?? '')))
  ) return reply(outgoing, 400)
  if (
    redeeming && (
      incoming.method !== 'GET' || incoming.headers['sec-fetch-dest'] !== 'iframe'
      || incoming.headers['sec-fetch-mode'] !== 'navigate'
    )
  ) return reply(outgoing, 403)
  if (redeeming) {
    const issued = route.redemption
    if (!presentedTicket || !issued || issued.expiresAt <= Date.now() || issued.digest !== digest(presentedTicket)) {
      return reply(outgoing, 410)
    }
    delete route.redemption
  }
  const cleanNavigation = route.cleanNavigation === target.pathname + target.search && incoming.method === 'GET'
    && incoming.headers['sec-fetch-dest'] === 'iframe' && incoming.headers['sec-fetch-mode'] === 'navigate'
  if (cleanNavigation) delete route.cleanNavigation
  if (!redeeming && !cleanNavigation && incoming.headers['sec-fetch-site'] !== 'same-origin') {
    return reply(outgoing, 403)
  }
  const disconnected = new AbortController()
  const cancel = () => {
    if (!outgoing.writableFinished) disconnected.abort()
  }
  outgoing.once('close', cancel)
  const signal = AbortSignal.any([route.signal, disconnected.signal])
  let remote: IncomingMessage | undefined
  try {
    if (!await route.verify(signal)) return reply(outgoing, 410)
    signal.throwIfAborted()
    const headers = headerProjection(incoming.headers, REQUEST_HEADERS)
    if (requestOrigin === origin) headers.origin = route.upstream
    const cookie = forwardedCookie(incoming.headers.cookie, route.cookie)
    if (cookie) headers.cookie = cookie
    remote = await new Promise<IncomingMessage>((resolve, reject) => {
      const upstream = request(target, { method: incoming.method, headers, signal, agent: false }, resolve)
      upstream.once('error', reject)
      void pipeline(incoming, upstream, { signal }).catch(reject)
    })
    const outgoingHeaders = headerProjection(remote.headers, RESPONSE_HEADERS)
    outgoingHeaders['cache-control'] = 'no-store'
    outgoingHeaders['referrer-policy'] = 'no-referrer'
    const location = redirect(remote, route.upstreamURL, presentedTicket ?? undefined)
    if (redeeming && (remote.statusCode !== 303 || location === undefined)) {
      throw new Error('Managed console redemption did not return a clean 303')
    }
    if (location) outgoingHeaders.location = location
    if (remote.headers['set-cookie']) {
      const values = remote.headers['set-cookie']
      const credential = values.length === 1 ? browserCookie(values[0]!) : undefined
      if (redeeming) {
        if (!credential || credential.clearing || route.cookie) {
          throw new Error('Managed console redemption returned invalid cookie material')
        }
        route.cookie = { name: credential.name, digest: digest(credential.pair) }
        outgoingHeaders['set-cookie'] = values
      } else if (credential?.clearing && credential.name === route.cookie?.name) {
        delete route.cookie
        outgoingHeaders['set-cookie'] = values
      }
    }
    signal.throwIfAborted()
    if (redeeming && location) route.cleanNavigation = location.split('#', 1)[0]!
    outgoing.writeHead(remote.statusCode ?? 502, outgoingHeaders)
    await pipeline(remote, outgoing, { signal })
  } catch {
    remote?.destroy()
    reply(outgoing, 502)
  } finally {
    outgoing.removeListener('close', cancel)
  }
}

export interface ManagedConsoleBrowserGateway {
  readonly hostArgument: string
  readonly boundary: ManagedBrowserConsoleBoundary
  close(): Promise<void>
}

/** All logical ports of the random browser hostname resolve to this one owned listener. */
export async function openManagedConsoleBrowserGateway(): Promise<ManagedConsoleBrowserGateway> {
  const hostname = `console-${randomBytes(16).toString('hex')}.cordisx-console.localhost`
  let active: GatewayRoute | undefined
  let service: string | undefined
  let closed = false
  let authority: string
  let origin: `http://${string}`
  const server = createServer(
    { headersTimeout: 5_000, requestTimeout: 10_000, keepAliveTimeout: 1_000 },
    (req, res) => {
      if (req.headers.host !== authority) return reply(res, 421)
      const route = active
      if (!route || route.signal.aborted) return reply(res, 410)
      void forward(req, res, route, origin).catch(() => reply(res, 502))
    },
  )
  server.maxConnections = 64
  server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'))
  server.on('connect', (_, socket) => socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Managed browser console listener is unavailable')
  }
  const { port } = address
  authority = hostname + ':' + port
  origin = `http://${authority}`
  const close = async () => {
    if (closed) return
    closed = true
    active?.dispose()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
  server.on('error', () => void close().catch(() => undefined))
  return {
    hostArgument: `--host-resolver-rules=MAP ${hostname} 127.0.0.1:${port}, MAP ${hostname}. 127.0.0.1:${port}`,
    boundary: {
      open(input) {
        if (closed || active || input.signal.aborted || (service !== undefined && service !== input.service)) {
          return undefined
        }
        const upstreamURL = new URL(input.upstream)
        if (
          upstreamURL.protocol !== 'http:' || upstreamURL.origin !== input.upstream
          || !['127.0.0.1', '[::1]'].includes(upstreamURL.hostname)
        ) return undefined
        const retired = new AbortController()
        const dispose = () => {
          if (active === route) active = undefined
          delete route.cookie
          delete route.redemption
          delete route.cleanNavigation
          input.signal.removeEventListener('abort', dispose)
          retired.abort()
        }
        const route: GatewayRoute = {
          ...input,
          signal: AbortSignal.any([input.signal, retired.signal]),
          upstreamURL,
          dispose,
        }
        service = input.service
        active = route
        input.signal.addEventListener('abort', dispose, { once: true })
        let issued = false
        return {
          origin,
          admit(ticket) {
            if (issued || active !== route || route.signal.aborted || !/^[A-Za-z0-9_-]{32}$/u.test(ticket)) return false
            issued = true
            route.redemption = { digest: digest(ticket), expiresAt: Date.now() + 30_000 }
            return true
          },
          dispose,
        }
      },
    },
    close,
  }
}
