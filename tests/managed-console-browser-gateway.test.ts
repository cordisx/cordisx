import { createServer, type IncomingMessage, request, type ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'

const redeemPath = '/auth/browser'
const browserTicket = 'a'.repeat(32)
const cookie = '__Host-fixture=' + 'b'.repeat(32)
const cookieAttributes = '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90'
const iframe = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'cross-site' }
const sameOrigin = { 'sec-fetch-site': 'same-origin' }

async function fixture(
  redirect?: string,
  redemptionStatus = 303,
  issuedCookie: string | null = cookie + cookieAttributes,
  handle?: (req: IncomingMessage, res: ServerResponse) => boolean,
) {
  const seen = vi.fn<(request: IncomingMessage) => void>()
  const service = createServer((req, res) => {
    seen(req)
    if (req.url?.startsWith(redeemPath + '?')) {
      return res.writeHead(redemptionStatus, {
        Location: redirect ?? '/providers',
        ...(issuedCookie === null ? {} : { 'Set-Cookie': issuedCookie }),
      }).end()
    }
    if (req.url === '/logout') {
      return res.writeHead(204, {
        'Set-Cookie': '__Host-fixture=; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=0',
      }).end()
    }
    if (handle?.(req, res)) return
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
  if (!route?.admit(browserTicket)) throw new Error('Missing browser fixture route')
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
  it('preserves service-issued partitioned authorization state between start and poll', async () => {
    const pending = 'fakemodel_device_pending_embedded=' + 'c'.repeat(210) + '.' + 'd'.repeat(43)
    const attributes = '; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=None; Partitioned'
    const f = await fixture(undefined, 303, cookie + cookieAttributes, (req, res) => {
      if (req.url === '/auth/device/start') {
        res.writeHead(200, {
          'Set-Cookie': [
            'fakemodel_device_pending=ordinary; Path=/; HttpOnly; SameSite=Lax; Max-Age=600',
            pending + attributes,
          ],
        }).end('{"expires_in":600}')
        return true
      }
      if (req.url === '/auth/device/poll') {
        res.writeHead(req.headers.cookie?.split('; ').includes(pending) ? 202 : 410).end()
        return true
      }
      return false
    })
    try {
      await f.send(redeemPath + '?ticket=' + browserTicket, iframe)
      const start = await f.send('/auth/device/start', { ...sameOrigin, origin: f.route.origin, cookie }, 'POST')
      expect(start.status).toBe(200)
      const poll = await f.send('/auth/device/poll', { ...sameOrigin, cookie: cookie + '; ' + pending })
      expect({ pendingCookieDelivered: start.headers['set-cookie']?.includes(pending + attributes), poll: poll.status })
        .toEqual({ pendingCookieDelivered: true, poll: 202 })
      expect(start.headers['set-cookie']).toEqual([pending + attributes])
      expect(f.seen.mock.lastCall?.[0].headers.cookie).toBe(cookie + '; ' + pending)
      f.route.dispose()
      const next = new AbortController()
      expect(f.gateway.boundary.open({ ...f.routeInput, generation: 'two', signal: next.signal })).toBeDefined()
      expect(await f.send('/auth/device/poll', { ...sameOrigin, cookie: cookie + '; ' + pending }))
        .toMatchObject({ status: 410 })
      expect(f.seen.mock.lastCall?.[0].headers).not.toHaveProperty('cookie')
    } finally {
      await f.close()
    }
  })

  it('relays an exact iframe redemption and its clean 303 but only forwards the bound session', async () => {
    const f = await fixture()
    try {
      expect(await f.send(redeemPath + '?ticket=' + 'z'.repeat(32), iframe)).toMatchObject({ status: 410 })
      expect(f.seen).not.toHaveBeenCalled()
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
      expect(await f.send(redeemPath + '?ticket=' + browserTicket, iframe)).toMatchObject({ status: 410 })
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
      f.route.dispose()
      expect(await f.send('/providers', { ...sameOrigin, cookie })).toMatchObject({ status: 410 })
      const next = new AbortController()
      expect(f.gateway.boundary.open({ ...f.routeInput, generation: 'two', signal: next.signal })).toBeDefined()
      expect(await f.send('/providers', { ...sameOrigin, cookie })).toMatchObject({ status: 200 })
      expect(f.seen.mock.lastCall?.[0].headers).not.toHaveProperty('cookie')
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

  it.each([
    [302, '/providers'],
    [303, '/providers?wrong-name=' + browserTicket],
    [303, '/providers#' + browserTicket],
    [303, '/providers?value=' + '%61'.repeat(32)],
  ])(
    'rejects an unsafe redemption response (%s, %s) without forwarding a Location or cookie',
    async (status, location) => {
      const f = await fixture(location, status)
      try {
        const response = await f.send(redeemPath + '?ticket=' + browserTicket, iframe)
        expect(response.status).toBe(502)
        expect(response.headers).not.toHaveProperty('location')
        expect(response.headers).not.toHaveProperty('set-cookie')
      } finally {
        await f.close()
      }
    },
  )

  it('honors Max-Age=0, clears the forwarded cookie, and permits a fresh lease only for the same service', async () => {
    const f = await fixture()
    try {
      await f.send(redeemPath + '?ticket=' + browserTicket, iframe)
      await f.send('/providers', { ...iframe, cookie })
      const logout = await f.send('/logout', { ...sameOrigin, origin: f.route.origin, cookie }, 'POST')
      expect(logout).toMatchObject({
        status: 204,
        headers: {
          'set-cookie': [expect.stringContaining('Max-Age=0')],
        },
      })
      expect(f.seen.mock.lastCall?.[0].headers.cookie).toBe(cookie)
      await f.send('/providers', { ...sameOrigin, cookie })
      expect(f.seen.mock.lastCall?.[0].headers).not.toHaveProperty('cookie')
      f.route.dispose()
      const next = new AbortController()
      expect(f.gateway.boundary.open({ ...f.routeInput, service: 'other-service', signal: next.signal }))
        .toBeUndefined()
      const reopened = f.gateway.boundary.open({ ...f.routeInput, generation: 'two', signal: next.signal })
      expect(reopened?.admit(browserTicket)).toBe(true)
      expect(await f.send(redeemPath + '?ticket=' + browserTicket, iframe)).toMatchObject({ status: 303 })
    } finally {
      await f.close()
    }
  })

  it('accepts a clean browser error redirect without setting a session cookie', async () => {
    const errorPath = '/login?error=console-ticket-unavailable'
    const f = await fixture(errorPath, 303, null)
    try {
      const response = await f.send(redeemPath + '?ticket=' + browserTicket, iframe)
      expect(response).toMatchObject({ status: 303, headers: { location: errorPath } })
      expect(response.headers).not.toHaveProperty('set-cookie')
      expect(await f.send(errorPath, iframe)).toMatchObject({ status: 200 })
      expect(f.seen.mock.lastCall?.[0].headers).not.toHaveProperty('cookie')
    } finally {
      await f.close()
    }
  })

  it('fails closed when the redemption returns a cookie without partition isolation', async () => {
    const f = await fixture('/providers', 303, cookie + '; Path=/; Secure; HttpOnly; SameSite=None')
    try {
      const response = await f.send(redeemPath + '?ticket=' + browserTicket, iframe)
      expect(response.status).toBe(502)
      expect(response.headers).not.toHaveProperty('location')
      expect(response.headers).not.toHaveProperty('set-cookie')
      expect(await f.send('/providers', iframe)).toMatchObject({ status: 403 })
    } finally {
      await f.close()
    }
  })
})
