import {
  createServer as createHttpServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isManagerBrowserOrigin } from '../independent-manager/manager-browser-origin.js'
import { canonicalManagedConsoleBrowserOrigin } from '../launcher/managed-console-browser-gateway.js'
import { MANAGER_CONSOLE_AUTH_PATH, managerPublicConsoleBootstrap } from './manager-public-console-bootstrap.js'
import type { ManagerPublicConsoleMapping, ManagerPublicConsoleRoute } from './manager-public-console.js'

export interface ManagerPublicIngressListener {
  readonly host: string
  readonly port: number
  readonly tls?: { readonly certificate: string | Buffer; readonly privateKey: string | Buffer }
}

function localManagerOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.origin === value && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
      && !url.username && !url.password
  } catch {
    return false
  }
}

function reply(response: ServerResponse, status: number): void {
  if (response.headersSent) response.destroy()
  else response.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end()
}

/** Forward only configured authorities to their owner-issued loopback listeners. */
export async function startManagerPublicIngress(input: {
  readonly manager: { readonly publicOrigin: string; readonly localOrigin: string }
  readonly consoles?: Pick<ManagerPublicConsoleMapping, 'resolve' | 'close'>
  readonly listeners: readonly ManagerPublicIngressListener[]
  readonly onUnavailable?: () => void
}) {
  if (!isManagerBrowserOrigin(input.manager.publicOrigin) || !localManagerOrigin(input.manager.localOrigin)) {
    throw new Error('MANAGER_INGRESS_INVALID')
  }
  if (
    input.consoles !== undefined && (typeof input.consoles.resolve !== 'function'
        || typeof input.consoles.close !== 'function')
    || !Array.isArray(input.listeners) || input.listeners.length === 0
  ) {
    throw new Error('MANAGER_INGRESS_INVALID')
  }
  const managerAuthority = new URL(input.manager.publicOrigin).host
  const handler = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const authority = incoming.headers.host
    const consoleRoute: ManagerPublicConsoleRoute | undefined = typeof authority === 'string'
      ? input.consoles?.resolve(authority)
      : undefined
    const route = authority === managerAuthority ? input.manager : consoleRoute
    if (!route) return reply(outgoing, 421)
    if (consoleRoute && route === consoleRoute) {
      try {
        if (
          !isManagerBrowserOrigin(consoleRoute.publicOrigin)
          || new URL(consoleRoute.publicOrigin).host !== authority
          || canonicalManagedConsoleBrowserOrigin(consoleRoute.localOrigin) !== consoleRoute.localOrigin
        ) return reply(outgoing, 421)
      } catch {
        return reply(outgoing, 421)
      }
      if (consoleRoute.signal.aborted) return reply(outgoing, 410)
    }
    const path = incoming.url ?? ''
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.length > 8_192) {
      return reply(outgoing, 400)
    }
    const headers = { ...incoming.headers }
    for (const name of Object.keys(headers)) {
      if (
        name === 'connection' || name === 'forwarded' || name === 'proxy-authorization'
        || name === 'proxy-connection' || name.startsWith('x-forwarded-')
      ) {
        delete headers[name]
      }
    }
    const local = new URL(route.localOrigin)
    let redemption = false
    const authorization = incoming.headers.authorization
    if (consoleRoute && route === consoleRoute) {
      const consoleCookies = consoleRoute.cookies
      const origin = incoming.headers.origin
      if (origin !== undefined && origin !== route.publicOrigin) return reply(outgoing, 403)
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD' && origin !== route.publicOrigin) {
        return reply(outgoing, 403)
      }
      if (path === MANAGER_CONSOLE_AUTH_PATH && incoming.method === 'GET') {
        if (consoleCookies.incoming(authorization)) return reply(outgoing, 204)
        return outgoing.writeHead(401, {
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
          'www-authenticate': 'Basic realm="CordisX Console"',
        }).end()
      }
      const target = new URL(path, route.publicOrigin)
      const ticket = target.searchParams.get('ticket')
      redemption = incoming.method === 'GET' && incoming.headers['sec-fetch-dest'] === 'iframe'
        && incoming.headers['sec-fetch-mode'] === 'navigate' && [...target.searchParams.keys()].join(',') === 'ticket'
        && /^[A-Za-z0-9_-]{32}$/u.test(ticket ?? '')
      headers.host = local.host
      if (origin !== undefined) headers.origin = route.localOrigin
      const cookie = redemption ? undefined : consoleCookies.incoming(authorization)
      if (!redemption && !cookie) return reply(outgoing, 403)
      if (cookie) headers.cookie = cookie
      else delete headers.cookie
      delete headers.authorization
    } else headers.host = new URL(route.publicOrigin).host
    const upstream = request({
      hostname: '127.0.0.1',
      port: Number(local.port),
      method: incoming.method,
      path,
      headers,
      agent: false,
    }, response => {
      if (consoleRoute && route === consoleRoute && consoleRoute.signal.aborted) {
        response.resume()
        return reply(outgoing, 410)
      }
      const projected = { ...response.headers }
      delete projected.connection
      if (consoleRoute && route === consoleRoute) {
        const consoleCookies = consoleRoute.cookies
        const cookies = projected['set-cookie'] ?? []
        delete projected['set-cookie']
        if (redemption) {
          const password = response.statusCode === 303 ? consoleCookies.begin(cookies) : undefined
          try {
            if (!password || typeof projected.location !== 'string') throw new Error('MANAGER_CONSOLE_INVALID')
            const bootstrap = managerPublicConsoleBootstrap({
              managerOrigin: input.manager.publicOrigin,
              publicOrigin: route.publicOrigin,
              location: projected.location,
              password,
              serviceHeaders: response.headers,
            })
            response.resume()
            return outgoing.writeHead(200, bootstrap.headers).end(bootstrap.body)
          } catch {
            consoleCookies.clear()
            response.resume()
            return reply(outgoing, 502)
          }
        }
        consoleCookies.update(authorization, cookies)
      }
      outgoing.writeHead(response.statusCode ?? 502, projected)
      response.pipe(outgoing)
    })
    const abort = () => upstream.destroy()
    if (consoleRoute && route === consoleRoute) {
      consoleRoute.signal.addEventListener('abort', abort, { once: true })
      upstream.once('close', () => consoleRoute.signal.removeEventListener('abort', abort))
      if (consoleRoute.signal.aborted) abort()
    }
    upstream.on('error', () => reply(outgoing, consoleRoute?.signal.aborted ? 410 : 502))
    outgoing.on('close', () => {
      if (!outgoing.writableFinished) upstream.destroy()
    })
    incoming.on('error', () => upstream.destroy())
    incoming.pipe(upstream)
  }
  const servers: Server[] = []
  let closing: Promise<void> | undefined
  const close = () => {
    return closing ??= (async () => {
      input.consoles?.close()
      const results = await Promise.allSettled(servers.map(async server => {
        if (!server.listening) return
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      }))
      if (results.some(result => result.status === 'rejected')) throw new Error('MANAGER_INGRESS_CLOSE_FAILED')
    })()
  }
  try {
    for (const listener of input.listeners) {
      if (
        typeof listener.host !== 'string' || listener.host.length === 0 || listener.host.length > 255
        || !Number.isInteger(listener.port) || listener.port < 0 || listener.port > 65_535
      ) throw new Error('MANAGER_INGRESS_INVALID')
      const server = listener.tls
        ? createHttpsServer({ cert: listener.tls.certificate, key: listener.tls.privateKey }, handler)
        : createHttpServer(handler)
      servers.push(server)
      server.headersTimeout = 5_000
      server.requestTimeout = 30_000
      server.keepAliveTimeout = 1_000
      server.maxConnections = 256
      server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'))
      server.on('connect', (_, socket) => socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\n\r\n'))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(listener.port, listener.host, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      server.on('error', () => {
        void close().finally(() => input.onUnavailable?.()).catch(() => undefined)
      })
    }
    return {
      addresses: servers.map(server => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('MANAGER_INGRESS_INVALID')
        return { host: address.address, port: address.port }
      }),
      close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
