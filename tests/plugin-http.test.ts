import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginHttpAuthority } from '../packages/cli/src/launcher/plugin-http-authority.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { createPluginHttpClient } from '../packages/cli/src/renderer/plugin-http.js'

const secret = 'test-authority-secret-only'
const principal = {
  profileId: 'test',
  generation: 'g1',
  moduleGeneration: 'm1',
  identity: { pluginId: 'game', source: 'file:///game.ts' },
}
const token = issueOwnerDocumentPrincipalToken(secret, principal)
const connectionInput = { version: 1, requestId: 'request-test', token }
const active: (() => void)[] = []
afterEach(async () => {
  for (const close of active.splice(0)) await close()
})

async function fixture() {
  const seen: { url?: string; authorization?: string }[] = []
  const server = createServer((request, response) => {
    seen.push({ url: request.url, authorization: request.headers.authorization })
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/secret' })
      response.end()
      return
    }
    if (request.url === '/large') {
      response.end('x'.repeat(1_048_577))
      return
    }
    if (request.url === '/wait') return
    response.setHeader('set-cookie', 'private-cookie')
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  active.push(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = `http://127.0.0.1:${address.port}`
  const secrets = new Map<string, string>()
  let live = true
  const authority = new PluginHttpAuthority({
    secret,
    profileId: 'test',
    generation: 'g1',
    principalAllowed: () => live,
    keychain: {
      read: async (s, a) => {
        const v = secrets.get(`${s}:${a}`)
        if (v === undefined) throw new Error()
        return v
      },
      upsert: async (s, a, v) => {
        secrets.set(`${s}:${a}`, v)
      },
      remove: async (s, a) => {
        secrets.delete(`${s}:${a}`)
      },
      status: async (s, a) => secrets.has(`${s}:${a}`) ? 'set' : 'unset',
    },
  })
  active.push(() => authority.dispose())
  const granted = await authority.handle({
    ...connectionInput,
    operation: 'plugin-http-authorize',
    origin,
    credential: 'bearer',
    secret: 'test-bearer',
  })
  if (granted.status !== 'accepted') throw new Error('grant failed')
  const connection = granted.value as import('@cordisx/protocol/plugin-http/v1').HttpConnectionV1
  const send = (patch = {}) =>
    authority.handle({
      ...connectionInput,
      operation: 'plugin-http-request',
      operationId: crypto.randomUUID(),
      connection,
      path: '/',
      method: 'GET',
      deadline: Date.now() + 2000,
      ...patch,
    })
  return {
    authority,
    connection,
    send,
    origin,
    seen,
    secrets,
    retire: () => {
      live = false
    },
  }
}

describe('public plugin HTTP authority', () => {
  it('binds credentials to owner and origin, injects only launcher-side, and refuses escape paths and headers', async () => {
    const f = await fixture()
    expect(await f.send()).toEqual({
      status: 'accepted',
      value: { statusCode: 200, contentType: 'application/json', body: '{"ok":true}' },
    })
    expect(f.seen[0]?.authorization).toBe('Bearer test-bearer')
    expect(JSON.stringify(f.connection)).not.toContain('test-bearer')
    const other = issueOwnerDocumentPrincipalToken(secret, {
      ...principal,
      identity: { ...principal.identity, pluginId: 'other' },
    })
    expect(await f.send({ token: other })).toMatchObject({ status: 'unavailable', code: 'connection-unavailable' })
    for (
      const patch of [
        { path: '//other.invalid/' },
        { path: '/\\other.invalid/' },
        { path: '/#fragment' },
        { headers: { authorization: 'evil' } },
        { headers: { cookie: 'evil' } },
        { method: 'CONNECT' },
      ]
    ) {
      expect(await f.send(patch)).toMatchObject({ status: 'unavailable', code: 'invalid-request' })
    }
    expect(f.seen).toHaveLength(1)
  })
  it('rejects remote cleartext bearer before storing, accepts package-sized bodies and erases transient grants', async () => {
    const f = await fixture()
    expect(
      await f.authority.handle({
        ...connectionInput,
        operation: 'plugin-http-authorize',
        origin: 'http://remote.example',
        credential: 'bearer',
        secret: 'test-remote',
      }),
    ).toMatchObject({ code: 'invalid-request' })
    expect(f.secrets.size).toBe(1)
    expect(await f.send({ method: 'POST', body: 'x'.repeat(700_000) })).toMatchObject({ status: 'accepted' })
    expect(await f.send({ method: 'POST', body: 'x'.repeat(1_048_577) })).toMatchObject({ code: 'invalid-request' })
    await f.authority.handle({ ...connectionInput, operation: 'plugin-http-dispose' })
    expect(f.secrets.size).toBe(0)
    expect(await f.send()).toMatchObject({ code: 'connection-unavailable' })
  })
  it('does not follow redirects and bounds the real streamed response', async () => {
    const f = await fixture()
    expect(await f.send({ path: '/redirect' })).toMatchObject({ code: 'redirect-denied' })
    expect(f.seen.some(v => v.url === '/secret')).toBe(false)
    expect(await f.send({ path: '/large' })).toMatchObject({ code: 'response-too-large' })
  })
  it('aborts real transport on deadline, revoke and retired owner', async () => {
    const f = await fixture()
    expect(await f.send({ path: '/wait', deadline: Date.now() + 30 })).toMatchObject({ code: 'deadline-exceeded' })
    const pending = f.send({ path: '/wait' })
    await new Promise(resolve => setTimeout(resolve, 15))
    await f.authority.handle({ ...connectionInput, operation: 'plugin-http-revoke', connection: f.connection })
    expect(await pending).toMatchObject({ code: 'aborted' })
    expect(f.secrets.size).toBe(0)
    expect(await f.send()).toMatchObject({ code: 'connection-unavailable' })
    f.retire()
    expect(await f.send()).toMatchObject({ code: 'stale-generation' })
  })
  it('requires Host consent and keeps AbortSignal off the wire', async () => {
    const f = await fixture()
    const calls: unknown[] = []
    const client = createPluginHttpClient({
      principal: { ...principal.identity, moduleGeneration: 'm1', token },
      active: () => true,
      bridge: {
        request: async (_: string, value: Record<string, unknown>) => {
          calls.push(value)
          return await f.authority.handle({ ...connectionInput, ...value })
        },
      } as never,
      consent: async () => ({ approved: true, secret: 'test-bearer' }),
    })
    const connected = await client.authorize({ origin: f.origin, credential: 'bearer' })
    if (connected.status !== 'accepted') throw new Error('client consent failed')
    const abort = new AbortController()
    const pending = client.request({
      connection: connected.value,
      method: 'GET',
      path: '/wait',
      deadline: Date.now() + 2000,
      signal: abort.signal,
    })
    setTimeout(() => abort.abort(), 20)
    expect(await pending).toMatchObject({ code: 'aborted' })
    expect(calls.some(v => Object.hasOwn(v as object, 'signal'))).toBe(false)
    client.dispose()
  })
})
