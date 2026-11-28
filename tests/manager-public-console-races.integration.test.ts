import { createServer, type IncomingMessage, request, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { startManagerPublicIngress } from '../packages/cli/src/cli/manager-public-ingress.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'

const managerOrigin = 'https://manager.example.test'
const template = 'https://{view}.console.example.test'
const ticket = 'a'.repeat(32)
const gatewayProof = { pid: 42, processStartedAt: 'fixture', instanceToken: 'b'.repeat(64) }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

async function send(input: {
  origin: string
  port: number
  path: string
  body?: unknown
  token?: string
  headers?: Record<string, string>
}) {
  return await new Promise<{ status: number | undefined; headers: IncomingMessage['headers']; body: string }>(
    (resolve, reject) => {
      const outgoing = request({
        hostname: '127.0.0.1',
        port: input.port,
        path: input.path,
        method: input.body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(10_000),
        headers: {
          host: new URL(input.origin).host,
          ...(input.body === undefined ? {} : { origin: input.origin, 'content-type': 'application/json' }),
          ...(input.token ? { authorization: 'Bearer ' + input.token } : {}),
          ...input.headers,
        },
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => body += chunk)
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
        response.on('error', reject)
      })
      outgoing.on('error', reject).end(input.body === undefined ? undefined : JSON.stringify(input.body))
    },
  )
}

it('cancels a late console issue while the same view is being retired', async () => {
  const issued = deferred()
  const releaseIssue = deferred()
  const retiring = deferred()
  const releaseRetire = deferred()
  const local = 'http://console-' + 'c'.repeat(32) + '.cordisx-console.localhost:49000'
  const owner = {
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    managerConsoleOrigins: [local],
    isCurrent: async () => true,
    request: async (operation: { action?: string; payload?: string }) => {
      if (operation.action === 'open') {
        return {
          status: 'ok',
          channels: ['plugin-management', 'managed-service-ui'],
          handle: { rendererId: 'd'.repeat(64), grant: 'e'.repeat(64), ownerGeneration: 'owner-1' },
        }
      }
      if (operation.action !== 'call') return { status: 'ok' }
      const payload = JSON.parse(operation.payload!)
      if (payload.request.action === 'retire') {
        retiring.resolve()
        await releaseRetire.promise
        return { status: 'ok', value: { requestId: payload.requestId, ok: true, value: { status: 'retired' } } }
      }
      if (payload.request.viewId === 'old-view') {
        issued.resolve()
        await releaseIssue.promise
      }
      return {
        status: 'ok',
        value: {
          requestId: payload.requestId,
          ok: true,
          value: { status: 'available', origin: local, url: local + '/auth/browser?ticket=' + ticket },
        },
      }
    },
  } as unknown as Parameters<typeof startManagerWeb>[0]
  const web = await startManagerWeb(owner, {
    rendererGateway: gatewayProof,
    publicOrigin: managerOrigin,
    publicConsoleOriginTemplates: [template],
  })
  try {
    const port = Number(new URL(web.localOrigin).port)
    const call = (path: string, body?: unknown, token?: string) =>
      send({ origin: managerOrigin, port, path, body, token })
    const session = await call('/api/session', { token: new URL(web.url).hash.slice(1) })
    const { token } = JSON.parse(session.body) as { token: string }
    expect((await call('/api/renderer/open', {}, token)).status).toBe(200)
    const binding = (action: 'issue' | 'retire', viewId: string) =>
      call('/api/renderer/binding', {
        channel: 'managed-service-ui',
        payload: JSON.stringify({
          requestId: action + '-' + viewId,
          operation: 'consoleBrowser',
          token: 'fixture-token',
          serviceId: 'fixture-service',
          request: { action, viewId },
        }),
      }, token)
    const pendingIssue = binding('issue', 'old-view')
    await issued.promise
    const pendingRetire = binding('retire', 'old-view')
    await retiring.promise
    releaseIssue.resolve()
    const cancelled = await pendingIssue
    expect(cancelled.status).toBe(200)
    expect(JSON.parse(cancelled.body).value).toEqual({ status: 'unavailable', reason: 'cancelled' })
    releaseRetire.resolve()
    expect((await pendingRetire).status).toBe(200)
    const next = await binding('issue', 'new-view')
    expect(JSON.parse(next.body).value).toMatchObject({ status: 'available' })
  } finally {
    releaseIssue.resolve()
    releaseRetire.resolve()
    await web.close()
  }
})

it('aborts a proxied console request on retirement and isolates the next view', async () => {
  const slowStarted = deferred()
  const slowClosed = deferred()
  let slow: ServerResponse | undefined
  const service = createServer((incoming, outgoing) => {
    if (incoming.url?.startsWith('/auth/browser?')) {
      return outgoing.writeHead(303, {
        location: '/view',
        'set-cookie': '__Host-fixture=' + 'f'.repeat(32)
          + '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90',
      }).end()
    }
    if (incoming.url === '/slow') {
      slow = outgoing
      outgoing.on('close', slowClosed.resolve)
      slowStarted.resolve()
      return
    }
    outgoing.writeHead(200).end('new-view')
  })
  const controller = new AbortController()
  const nextController = new AbortController()
  let gateway: Awaited<ReturnType<typeof openManagedConsoleBrowserGateway>> | undefined
  let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
  let ingress: Awaited<ReturnType<typeof startManagerPublicIngress>> | undefined
  try {
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve))
    const upstream = 'http://127.0.0.1:' + (service.address() as AddressInfo).port
    gateway = await openManagedConsoleBrowserGateway()
    const open = (signal: AbortSignal) =>
      gateway!.boundary.open({
        service: 'fixture',
        generation: 'one',
        upstream,
        redeemPath: '/auth/browser',
        signal,
        verify: async () => true,
      })
    expect(open(controller.signal)?.admit(ticket)).toBe(true)
    web = await startManagerWeb({
      appId: 'codex',
      profileId: 'work',
      generation: 'owner-1',
      managerConsoleOrigins: [gateway.origin],
      isCurrent: async () => true,
      request: async () => ({ status: 'unavailable' }),
    }, { publicOrigin: managerOrigin, publicConsoleOriginTemplates: [template] })
    const first = web.consoleMapping!.issue(gateway.origin, 'first-view', controller.signal)!
    ingress = await startManagerPublicIngress({
      manager: { publicOrigin: web.origin, localOrigin: web.localOrigin },
      consoles: web.consoleMapping!,
      listeners: [{ host: '127.0.0.1', port: 0 }],
    })
    const port = ingress.addresses[0]!.port
    const redeem = async (origin: string) => {
      const result = await send({
        origin,
        port,
        path: '/auth/browser?ticket=' + ticket,
        headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site' },
      })
      expect(result.status).toBe(200)
      const password = /const password = "([A-Za-z0-9_-]+)";/u.exec(result.body)?.[1]
      expect(password).toBeDefined()
      return 'Basic ' + Buffer.from('cx:' + password).toString('base64')
    }
    const firstAuth = await redeem(first.publicOrigin)
    const pending = send({
      origin: first.publicOrigin,
      port,
      path: '/slow',
      headers: { authorization: firstAuth, 'sec-fetch-site': 'same-origin' },
    })
    await slowStarted.promise
    web.consoleMapping!.retire('first-view')
    expect((await pending).status).toBe(410)
    await slowClosed.promise
    expect((await send({ origin: first.publicOrigin, port, path: '/view' })).status).toBe(421)
    controller.abort()
    expect(open(nextController.signal)?.admit(ticket)).toBe(true)
    const next = web.consoleMapping!.issue(gateway.origin, 'next-view', nextController.signal)!
    expect(next.publicOrigin).not.toBe(first.publicOrigin)
    const nextAuth = await redeem(next.publicOrigin)
    expect(
      (await send({
        origin: next.publicOrigin,
        port,
        path: '/view',
        headers: { authorization: nextAuth, 'sec-fetch-site': 'same-origin' },
      })).body,
    ).toBe('new-view')
    expect(
      (await send({
        origin: next.publicOrigin,
        port,
        path: '/view',
        headers: { authorization: firstAuth, 'sec-fetch-site': 'same-origin' },
      })).status,
    ).toBe(403)
  } finally {
    slow?.destroy()
    controller.abort()
    nextController.abort()
    await ingress?.close()
    await web?.close()
    await gateway?.close()
    service.closeAllConnections()
    if (service.listening) await new Promise<void>(resolve => service.close(() => resolve()))
  }
})
