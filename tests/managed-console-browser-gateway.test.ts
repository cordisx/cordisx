import { createServer, type IncomingMessage, request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'

const redeemPath = '/auth/browser'
const browserTicket = 'a'.repeat(32)
const cookie = '__Host-fixture=' + 'b'.repeat(32)
const cookieAttributes = '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90'
const iframe = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' }
const sameOrigin = { 'sec-fetch-site': 'same-origin' }

async function fixture(redirect?: string) {
  const seen = vi.fn<(request: IncomingMessage) => void>()
  const service = createServer((req, res) => {
    seen(req)
    if (req.url?.startsWith(redeemPath + '?')) {
      return res.writeHead(303, {
        Location: redirect ?? '/providers',
        'Set-Cookie': cookie + cookieAttributes,
      }).end()
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
  })
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
  const address = service.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener')
  const upstream = `http://127.0.0.1:${address.port}`
  const gateway = await openManagedConsoleBrowserGateway()
  const controller = new AbortController()
  const verify = vi.fn(async () => true)
  const routeInput = {
    service: 'owned-service',
    generation: 'one',
    upstream,
    redeemPath,
    signal: controller.signal,
    verify,
  }
  const route = gateway.boundary.open(routeInput)
  if (!route) throw new Error('Missing browser fixture route')
  const authority = new URL(route.origin)
  const send = async (path: string, headers: Record<string, string> = {}, method = 'GET') =>
    await new Promise<{ status: number | undefined; headers: IncomingMessage['headers']; body: string }>(
      (resolve, reject) => {
        const outgoing = request({
          hostname: '127.0.0.1',
          port: Number(authority.port),
          method,
          path,
          headers: { Host: authority.host, ...headers },
        }, response => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => body += chunk)
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
          response.on('error', reject)
        })
        outgoing.on('error', reject).end()
      },
    )
  const close = async () => {
    await gateway.close()
    await new Promise<void>((resolve, reject) => service.close(error => error ? reject(error) : resolve()))
  }
  return { upstream, gateway, controller, verify, routeInput, route, authority, send, seen, close }
}

describe('managed console browser gateway', () => {
  it('relays an exact iframe redemption and its clean 303 but only forwards the bound session', async () => {
    const f = await fixture()
    try {
      const issued = await f.send(redeemPath + '?ticket=' + browserTicket, {
        ...iframe,
        referer: 'https://other.invalid/',
      })
      expect(issued).toMatchObject({
        status: 303,
        headers: {
          location: '/providers',
          'referrer-policy': 'no-referrer',
          'set-cookie': [cookie + cookieAttributes],
        },
      })
      const clean = await f.send('/providers', { ...iframe, cookie: cookie + '; parent=not-for-this-service' })
      expect(clean).toMatchObject({ status: 200, body: 'ok' })
      expect(f.seen.mock.calls[0]![0].headers).not.toHaveProperty('referer')
      expect(f.seen.mock.calls[1]![0].headers.cookie).toBe(cookie)
      expect(await f.send('/providers', iframe)).toMatchObject({ status: 403 })
      expect(
        await f.send('/settings', {
          ...sameOrigin,
          origin: f.route.origin,
          cookie,
          authorization: 'Bearer browser-supplied',
          'x-forwarded-host': 'other.invalid',
        }, 'POST'),
      ).toMatchObject({ status: 200 })
      expect(f.seen.mock.calls[2]![0].headers).toMatchObject({
        host: new URL(f.upstream).host,
        origin: f.upstream,
        cookie,
      })
      expect(f.seen.mock.calls[2]![0].headers).not.toHaveProperty('authorization')
      expect(f.seen.mock.calls[2]![0].headers).not.toHaveProperty('x-forwarded-host')
    } finally {
      await f.close()
    }
  })

  it('rejects alternate authority, foreign Origin, and stale upstream before a request reaches the service', async () => {
    const f = await fixture()
    try {
      expect(await f.send('/providers', { ...sameOrigin, Host: f.authority.hostname + ':1234', cookie }))
        .toMatchObject({ status: 421 })
      expect(await f.send('/settings', { ...sameOrigin, origin: 'http://127.0.0.1:1234', cookie }, 'POST'))
        .toMatchObject({ status: 403 })
      f.verify.mockResolvedValueOnce(false)
      expect(await f.send('/providers', sameOrigin)).toMatchObject({ status: 410 })
      expect(f.seen).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })

  it('rejects off-origin redirects and never sends an old generation cookie to the current service', async () => {
    const f = await fixture('http://127.0.0.1:1234/off-origin')
    try {
      const response = await f.send(redeemPath + '?ticket=' + browserTicket, iframe)
      expect(response.status).toBe(502)
      expect(response.headers).not.toHaveProperty('location')
      expect(response.headers).not.toHaveProperty('set-cookie')
      f.controller.abort()
      expect(await f.send('/providers', { ...sameOrigin, cookie })).toMatchObject({ status: 410 })
      const current = new AbortController()
      expect(f.gateway.boundary.open({ ...f.routeInput, service: 'different-service', signal: current.signal }))
        .toBeUndefined()
      expect(f.gateway.boundary.open({ ...f.routeInput, generation: 'two', signal: current.signal })).toBeDefined()
      expect(await f.send('/providers', { ...sameOrigin, cookie })).toMatchObject({ status: 200 })
      expect(f.seen.mock.lastCall?.[0].headers).not.toHaveProperty('cookie')
    } finally {
      await f.close()
    }
  })
})
