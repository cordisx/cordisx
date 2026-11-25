const schemas = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'

export const consoleOperations = [{
  operationId: 'console.info',
  method: 'GET',
  path: '/console',
  requestEncoding: 'query',
  responseSchema: schemas + 'managed-service-web-entry-source-result.v1.schema.json',
  timeoutMs: 2_000,
}, {
  operationId: 'console.browser-ticket',
  method: 'POST',
  path: '/private/issue',
  requestSchema: schemas + 'managed-service-browser-console-request.v1.schema.json',
  responseSchema: schemas + 'managed-service-browser-console-result.v1.schema.json',
  timeoutMs: 2_000,
}] as const

export const consoleExports = `
export const managedServiceWebEntry = {
  contract: 'cordisx.managed-service-web-entry-source/v1', serviceId: 'gateway', operationId: 'console.info',
  verification: { kind: 'shared-instance-hmac-sha256', path: '/proof' }
}
export const managedServiceBrowserConsole = {
  contract: 'cordisx.managed-service-browser-console-source/v1', serviceId: 'gateway',
  operationId: 'console.browser-ticket', redeemPath: '/auth/managed-console/browser'
}
`

/** A synthetic service with separate private API and verified console listeners. */
export const consoleBackend = String.raw`#!/usr/bin/env node
import { createServer } from 'node:http'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'

const secret = randomBytes(32)
const instance = randomUUID()
const tickets = new Set()
const sessions = new Set()
const proofContract = 'cordisx.managed-service-web-entry-proof/v1'
const proof = challenge => createHmac('sha256', secret)
  .update(JSON.stringify([proofContract, challenge, consoleOrigin, instance])).digest('hex')
const send = (response, value) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}
const consoleServer = createServer((request, response) => {
  const url = new URL(request.url, consoleOrigin)
  if (url.pathname === '/proof') {
    if (request.headers.authorization || url.searchParams.size !== 1) return response.writeHead(400).end()
    return send(response, { contract: proofContract, instance, proof: proof(url.searchParams.get('challenge')) })
  }
  if (url.pathname === '/auth/managed-console/browser') {
    if (!tickets.delete(url.searchParams.get('ticket'))) return response.writeHead(410).end()
    const session = randomBytes(24).toString('base64url')
    sessions.add(session)
    return response.writeHead(303, {
      location: '/view',
      'set-cookie': '__Host-fixture=' + session + '; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=90',
      'content-security-policy': "default-src 'none'; frame-ancestors *",
    }).end()
  }
  const session = (request.headers.cookie ?? '').split('; ').find(value => value.startsWith('__Host-fixture='))
  if (!session || !sessions.has(session.slice('__Host-fixture='.length))) return response.writeHead(401).end()
  if (url.pathname !== '/view') return response.writeHead(404).end()
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
    '<!doctype html><script>parent.postMessage("fixture-console-ready", "*");'
      + 'addEventListener("message", event => { if (event.data === "probe") '
      + 'parent.postMessage("fixture-console-probe", "*") });</script>'
  )
})
await new Promise(resolve => consoleServer.listen(0, '127.0.0.1', resolve))
const consoleOrigin = 'http://127.0.0.1:' + consoleServer.address().port
const api = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + process.env.SERVICE_TOKEN) return response.writeHead(401).end()
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/health') return response.writeHead(204).end()
  if (url.pathname === '/console') return send(response, {
    contract: 'cordisx.managed-service-web-entry-source-result/v1',
    status: 'available', origin: consoleOrigin,
    verification: { instance, proof: proof(url.searchParams.get('challenge')) },
  })
  if (url.pathname === '/private/issue' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    if (body.origin !== consoleOrigin || !/^[a-f0-9]{64}$/.test(body.binding)) return response.writeHead(400).end()
    const ticket = randomBytes(24).toString('base64url')
    tickets.add(ticket)
    return send(response, { status: 'issued', ticket })
  }
  response.writeHead(404).end()
})
api.listen(Number(process.argv[2]), '127.0.0.1')
process.on('SIGTERM', () => {
  api.closeAllConnections()
  consoleServer.closeAllConnections()
  api.close(() => consoleServer.close(() => process.exit(0)))
})
`

/** The browser plugin uses only the public managed-service console API. */
export const consoleBrowserPlugin = `
export const inject = ['pages', 'routes', 'slots', 'i18n', 'managedServices']
export async function apply(ctx) {
  ctx.i18n.define({ namespace: 'public-console-fixture', locale: 'en', default: true,
    messages: { title: 'Public console fixture', description: 'Synthetic managed console' } })
  const title = { namespace: 'public-console-fixture', key: 'title', fallback: 'Public console fixture' }
  const description = { namespace: 'public-console-fixture', key: 'description', fallback: 'Synthetic managed console' }
  ctx.pages.register({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/page.v4.schema.json',
    schemaVersion: 4, id: 'manager', title, description, icon: 'host:layers', chrome: 'standard'
  }, context => {
    const seat = context.document.createElement('div')
    seat.dataset.fixtureConsoleSeat = 'true'
    context.container.append(seat)
    return () => seat.remove()
  })
  ctx.routes.register({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/route.v2.schema.json',
    schemaVersion: 2, id: 'manager', path: '/manager/extensions/public-console-fixture',
    outlet: 'manager.content', page: 'manager', title, description
  })
  ctx.slots.register({
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/surface-contribution.v11.schema.json',
    schemaVersion: 11, name: 'manager.settings.navigation-items', id: 'manager', group: 'after-settings', order: 170
  }, { route: { id: 'manager' }, navigationGroup: { id: 'external-accounts' } })
  const controller = new AbortController()
  let frame
  let onMessage
  ctx.effect(() => () => {
    controller.abort()
    if (onMessage) removeEventListener('message', onMessage)
    frame?.remove()
    delete globalThis.__fixtureOpenConsole
  })
  globalThis.__fixtureOpenConsole = async () => {
    const managed = await ctx.managedServices.get({ serviceId: 'gateway' })
    globalThis.__fixtureConsoleStatus = managed.status
    globalThis.__fixtureConsoleHasHandle = !!managed.service?.authenticatedConsole?.readBrowserEntry
    if (managed.status !== 'available' || !managed.service.authenticatedConsole?.readBrowserEntry) return
    const entry = await managed.service.authenticatedConsole.readBrowserEntry({ signal: controller.signal })
    globalThis.__fixtureConsoleStatus = entry.status
    globalThis.__fixtureConsoleReason = entry.reason ?? null
    if (entry.status !== 'available') return
    globalThis.__fixtureConsoleOrigin = entry.origin
    globalThis.__fixtureConsoleSignals = []
    onMessage = event => {
      if (event.origin === entry.origin) globalThis.__fixtureConsoleSignals.push(event.data)
    }
    addEventListener('message', onMessage)
    frame = document.createElement('iframe')
    frame.dataset.fixtureConsole = 'true'
    frame.src = entry.url
    document.querySelector('[data-fixture-console-seat]').append(frame)
  }
  globalThis.__fixturePublicPlugin = 'active'
}
`
