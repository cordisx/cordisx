import { createServer, type IncomingMessage, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { startManagerPublicIngress } from '../packages/cli/src/cli/manager-public-ingress.js'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'

const managerOrigin = 'https://192.0.2.1:8443'
const templates = ['https://{view}.console-1.example.test:8444', 'https://{view}.console-2.example.test:8445']
const cookie = '__Host-fixture=' + 'b'.repeat(32)
const attributes = '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90'
const tickets = ['c'.repeat(32), 'd'.repeat(32)]
const servicePolicy = "script-src 'self'; frame-ancestors https://manager.example.test"

it('routes Manager and isolated iframe sessions through one explicitly configured ingress', async () => {
  const seen: Array<{ url: string | undefined; cookie: string | undefined }> = []
  const service = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    if (req.url?.startsWith('/auth/browser?')) {
      res.writeHead(303, { location: '/providers', 'set-cookie': cookie + attributes }).end()
    } else res.writeHead(200, { 'content-type': 'text/plain', 'content-security-policy': servicePolicy }).end('ok')
  })
  const gateways: Awaited<ReturnType<typeof openManagedConsoleBrowserGateway>>[] = []
  const controllers: AbortController[] = []
  let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
  let ingress: Awaited<ReturnType<typeof startManagerPublicIngress>> | undefined
  try {
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
    const serviceOrigin = 'http://127.0.0.1:' + (service.address() as AddressInfo).port
    for (const ticket of tickets) {
      const gateway = await openManagedConsoleBrowserGateway()
      gateways.push(gateway)
      const controller = new AbortController()
      controllers.push(controller)
      const route = gateway.boundary.open({
        service: 'fixture',
        generation: 'one',
        upstream: serviceOrigin,
        redeemPath: '/auth/browser',
        signal: controller.signal,
        verify: async () => true,
      })
      expect(route?.admit(ticket)).toBe(true)
    }
    web = await startManagerWeb({
      appId: 'codex',
      profileId: 'work',
      generation: 'owner-1',
      managerConsoleOrigins: gateways.map(gateway => gateway.origin),
      isCurrent: async () => true,
      request: async () => ({ status: 'unavailable' }),
    }, { publicOrigin: managerOrigin, publicConsoleOriginTemplates: templates })
    const consoles = gateways.map((gateway, index) =>
      web!.consoleMapping!.issue(gateway.origin, 'view-' + index, controllers[index]!.signal)!.publicOrigin
    )
    ingress = await startManagerPublicIngress({
      manager: { publicOrigin: web.origin, localOrigin: web.localOrigin },
      consoles: web.consoleMapping!,
      listeners: [{ host: '127.0.0.1', port: 0 }],
    })
    const port = ingress.addresses[0]!.port
    const send = async (origin: string, route: string, extra: Record<string, string> = {}, method = 'GET') =>
      await new Promise<{ status: number | undefined; headers: IncomingMessage['headers']; body: string }>(
        (resolve, reject) => {
          const outgoing = request({
            hostname: '127.0.0.1',
            port,
            method,
            path: route,
            headers: { host: new URL(origin).host, ...extra },
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
    const page = await send(managerOrigin, '/')
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toContain(
      'frame-src https://*.console-1.example.test:8444 https://*.console-2.example.test:8445',
    )
    const iframe = { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' }
    const first = await send(consoles[0]!, '/auth/browser?ticket=' + tickets[0], iframe)
    const second = await send(consoles[1]!, '/auth/browser?ticket=' + tickets[1], iframe)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers['set-cookie']).toBeUndefined()
    expect(second.headers['set-cookie']).toBeUndefined()
    const one = /const password = "([A-Za-z0-9_-]+)";/u.exec(first.body)?.[1]
    const two = /const password = "([A-Za-z0-9_-]+)";/u.exec(second.body)?.[1]
    expect(one).toBeDefined()
    expect(two).toBeDefined()
    expect(one).not.toBe(two)
    const auth = (password: string) => 'Basic ' + Buffer.from('cx:' + password).toString('base64')
    const provider = await send(consoles[0]!, '/providers', { ...iframe, authorization: auth(one!) })
    expect(provider.status).toBe(200)
    expect(provider.headers['content-security-policy']).toBe(servicePolicy)
    expect((await send(consoles[1]!, '/providers', { ...iframe, authorization: auth(two!) })).status).toBe(200)
    expect((await send(consoles[0]!, '/providers', { ...iframe, authorization: auth(two!) })).status).toBe(403)
    expect(seen.slice(-2).map(item => item.cookie)).toEqual([cookie, cookie])
    const before = seen.length
    expect(
      (await send(consoles[0]!, '/settings', {
        'sec-fetch-site': 'same-origin',
        origin: 'https://other.example.test',
        authorization: auth(one!),
      }, 'POST')).status,
    ).toBe(403)
    expect((await send('https://unknown.example.test', '/')).status).toBe(421)
    expect(seen).toHaveLength(before)
  } finally {
    await ingress?.close()
    await web?.close()
    for (const controller of controllers) controller.abort()
    await Promise.all(gateways.map(async gateway => await gateway.close()))
    if (service.listening) await new Promise<void>(resolve => service.close(() => resolve()))
  }
})
