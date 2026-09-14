import { HttpNativeCallingContextUnavailableError } from '../packages/cli/src/launcher/plugin-http-native-account-diagnostics.js'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginHttpAuthority } from '../packages/cli/src/launcher/plugin-http-authority.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { createPluginHttpClient } from '../packages/cli/src/renderer/plugin-http.js'
import {
  HTTP_NATIVE_ACCOUNT_EXPRESSION,
  readNativeHttpAccount,
} from '../packages/cli/src/launcher/plugin-http-native-account.js'
import type { LauncherKeychainBackend } from '../packages/cli/src/launcher/secret-store.js'
import type { HttpConnectionV1 } from '@cordisx/protocol/plugin-http/v1'
import type { OwnerDocumentPrincipal } from '../packages/cli/src/launcher/owner-document-rpc.js'

const secret = 'test-sessions-authority'
const principal = {
  profileId: 'test',
  generation: 'g1',
  moduleGeneration: 'm1',
  identity: { source: 'file:///game.ts', pluginId: 'game' },
}
const close: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of close.splice(0)) await fn()
})
async function fixture() {
  const seen: string[] = []
  let respond: (() => void) | undefined
  const server = createServer((request, response) => {
    seen.push(request.headers.authorization ?? '')
    const send = () => {
      response.setHeader('content-type', 'application/json')
      response.end('{"guest":true}')
    }
    if (request.url === '/wait') respond = send
    else send()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  close.push(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const secrets = new Map<string, string>()
  let unavailable = false
  const backend: LauncherKeychainBackend = {
    read: async (s, a) => {
      if (unavailable || !secrets.has(`${s}:${a}`)) throw new Error()
      return secrets.get(`${s}:${a}`)!
    },
    upsert: async (s, a, v) => {
      if (unavailable) throw new Error()
      secrets.set(`${s}:${a}`, v)
    },
    remove: async (s, a) => {
      if (unavailable) throw new Error()
      secrets.delete(`${s}:${a}`)
    },
    status: async (s, a) => {
      if (unavailable) throw new Error()
      return secrets.has(`${s}:${a}`) ? 'set' : 'unset'
    },
  }
  let account: string | null = 'native-account-a'
  const readAccount = async () => account
  const make = (p: OwnerDocumentPrincipal = principal) => {
    let live = true
    const authority = new PluginHttpAuthority({
      secret,
      profileId: p.profileId,
      generation: p.generation,
      principalAllowed: () => live,
      keychain: backend,
    })
    close.push(() => authority.dispose())
    const token = issueOwnerDocumentPrincipalToken(secret, p)
    const call = (operation: string, input: Record<string, unknown> = {}) =>
      authority.handle({ token, operation, ...input }, readAccount)
    return {
      authority,
      call,
      token,
      p,
      retire: () => {
        live = false
      },
    }
  }
  const scope = { origin, sourceId: 'game-source', accountId: '' }
  const first = make()
  const authorized = await first.call('plugin-http-authorize', {
    origin,
    credential: 'bearer',
    secret: 'original-guest-token',
  })
  if (authorized.status !== 'accepted') throw new Error('fixture authorize')
  const connection = authorized.value as HttpConnectionV1
  const retain = () => first.call('plugin-http-retain', { connection, scope })
  const request = (f: ReturnType<typeof make>, descriptor: HttpConnectionV1, path = '/me') =>
    f.call('plugin-http-request', {
      connection: descriptor,
      path,
      method: 'GET',
      deadline: Date.now() + 5000,
      operationId: crypto.randomUUID(),
    })
  return {
    ...first,
    first,
    make,
    scope,
    connection,
    retain,
    request,
    seen,
    secrets,
    backend,
    setAccount: (value: string | null) => {
      account = value
    },
    setUnavailable: () => {
      unavailable = true
    },
    respond: () => respond?.(),
  }
}
async function resumed(f: Awaited<ReturnType<typeof fixture>>, owner: ReturnType<typeof f.make> = f.first) {
  const result = await owner.call('plugin-http-resume', { scope: f.scope })
  if (result.status !== 'accepted' || result.value === null) throw new Error('missing resumed session')
  return result.value as HttpConnectionV1
}
describe('durable HTTP sessions', () => {
  it('renderer disposal preserves sibling retained copies while explicit logout invalidates the shared revision', async () => {
    const f = await fixture()
    const diagnostics: string[] = []
    const makeClient = () => {
      const client = createPluginHttpClient({
        active: () => true,
        principal: { ...principal.identity, moduleGeneration: 'm1', token: f.token },
        bridge: {
          request: async (_: string, value: Record<string, unknown>) => f.call(String(value.operation), value),
        } as never,
        consent: async () => ({ approved: true, secret: 'original-guest-token' }),
        diagnostic: code => diagnostics.push(code),
      })
      close.push(() => client.dispose())
      return client
    }
    const a = makeClient(), b = makeClient(), c = makeClient()
    const authorized = await a.authorize({ origin: f.scope.origin, credential: 'bearer' })
    if (authorized.status !== 'accepted') throw new Error('renderer grant')
    expect(await a.retain(authorized.value, { sourceId: f.scope.sourceId, accountId: '' })).toEqual({
      status: 'accepted',
      value: null,
    })
    const second = await b.resume(f.scope)
    if (second.status !== 'accepted' || !second.value) throw new Error('sibling retained grant')
    a.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await b.request({ connection: second.value, path: '/me', method: 'GET', deadline: Date.now() + 2000 }))
      .toMatchObject({ status: 'accepted' })
    const third = await c.resume(f.scope)
    if (third.status !== 'accepted' || !third.value) throw new Error('third retained grant')
    expect(await b.revoke(second.value)).toEqual({ status: 'accepted', value: null })
    expect(await c.request({ connection: third.value, path: '/me', method: 'GET', deadline: Date.now() + 2000 }))
      .toMatchObject({ code: 'connection-unavailable' })
    expect(diagnostics).toEqual(['launcher-connection-unavailable'])
    expect(await c.resume(f.scope)).toEqual({ status: 'accepted', value: null })
  })
  it('preserves exactly the original bearer across renderer, module and launcher generation retirement', async () => {
    const f = await fixture()
    expect(await f.retain()).toEqual({ status: 'accepted', value: null })
    expect(JSON.stringify(await f.call('plugin-http-resume', { scope: f.scope }))).not.toContain('original-guest-token')
    f.retire()
    await f.authority.dispose()
    expect(f.secrets.size).toBe(1)
    const next = f.make({ ...principal, generation: 'g2', moduleGeneration: 'm2' })
    const descriptor = await resumed(f, next)
    expect(descriptor.id).not.toBe(f.connection.id)
    expect(await f.request(next, f.connection)).toMatchObject({ code: 'connection-unavailable' })
    expect(await f.request(next, descriptor)).toMatchObject({ status: 'accepted' })
    expect(f.seen.at(-1)).toBe('Bearer original-guest-token')
  })
  it('does not persist ordinary transient credentials', async () => {
    const f = await fixture()
    await f.authority.dispose()
    expect(f.secrets.size).toBe(0)
    expect(await f.make().call('plugin-http-resume', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
  })
  it('isolates Host profiles, native accounts, plugin IDs, plugin sources, origin and configured account partitions', async () => {
    const f = await fixture()
    await f.retain()
    for (
      const patch of [{ profileId: 'other' }, { identity: { ...principal.identity, pluginId: 'other' } }, {
        identity: { ...principal.identity, source: 'file:///other.ts' },
      }]
    ) {
      expect(await f.make({ ...principal, ...patch }).call('plugin-http-resume', { scope: f.scope })).toEqual({
        status: 'accepted',
        value: null,
      })
    }
    for (const patch of [{ origin: 'https://other.example' }, { sourceId: 'other' }, { accountId: 'other' }]) {
      expect(await f.call('plugin-http-resume', { scope: { ...f.scope, ...patch } })).toEqual({
        status: 'accepted',
        value: null,
      })
    }
    f.setAccount('native-account-b')
    expect(await f.call('plugin-http-resume', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
    expect(await f.call('plugin-http-forget', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
    f.setAccount('native-account-a')
    expect(await resumed(f)).toMatchObject({ credential: 'bearer' })
  })
  it('fails closed for signed-out/native unavailable/storage unavailable rather than implying an empty partition', async () => {
    const f = await fixture()
    await f.retain()
    f.setAccount(null)
    expect(await f.call('plugin-http-resume', { scope: f.scope })).toMatchObject({ status: 'unavailable' })
    f.setAccount('native-account-a')
    f.setUnavailable()
    expect(await f.call('plugin-http-resume', { scope: f.scope })).toMatchObject({ code: 'credential-unavailable' })
    expect(await f.call('plugin-http-forget', { scope: f.scope })).toMatchObject({ code: 'credential-unavailable' })
    expect(await f.retain()).toMatchObject({ code: 'credential-unavailable' })
  })
  it('explicit logout forgets without a live handle, retires requests and does not resurrect on a new generation', async () => {
    const f = await fixture()
    await f.retain()
    const pending = f.request(f.first, f.connection, '/wait')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await f.call('plugin-http-forget', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
    expect(await pending).toMatchObject({ code: 'aborted' })
    expect(await f.make({ ...principal, generation: 'g2' }).call('plugin-http-resume', { scope: f.scope })).toEqual({
      status: 'accepted',
      value: null,
    })
    expect(f.secrets.size).toBe(0)
  })
  it('cannot re-retain a pre-logout transient bearer after forgetting its partition', async () => {
    const f = await fixture()
    expect(await f.call('plugin-http-forget', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
    expect(await f.retain()).toMatchObject({ code: 'credential-unavailable' })
    expect(await f.call('plugin-http-resume', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
    const newGrant = await f.call('plugin-http-authorize', {
      origin: f.scope.origin,
      credential: 'bearer',
      secret: 'new-login-token',
    })
    if (newGrant.status !== 'accepted') throw new Error('new login')
    expect(await f.call('plugin-http-retain', { connection: newGrant.value, scope: f.scope })).toEqual({
      status: 'accepted',
      value: null,
    })
  })
  it('explicit revoke removes the retained revision, and an older grant cannot remove a newer token', async () => {
    const f = await fixture()
    await f.retain()
    const newGrant = await f.call('plugin-http-authorize', {
      origin: f.scope.origin,
      credential: 'bearer',
      secret: 'replacement-token',
    })
    if (newGrant.status !== 'accepted') throw new Error('new grant')
    await f.call('plugin-http-retain', { connection: newGrant.value, scope: f.scope })
    await f.call('plugin-http-revoke', { connection: f.connection })
    const descriptor = await resumed(f)
    await f.request(f.first, descriptor)
    expect(f.seen.at(-1)).toBe('Bearer replacement-token')
    await f.call('plugin-http-revoke', { connection: descriptor })
    expect(await f.call('plugin-http-resume', { scope: f.scope })).toEqual({ status: 'accepted', value: null })
  })
  it('fences native account change before request and late response without destroying the former account session', async () => {
    const f = await fixture()
    await f.retain()
    f.setAccount('native-account-b')
    expect(await f.request(f.first, f.connection)).toMatchObject({ code: 'credential-unavailable' })
    expect(f.seen).toHaveLength(0)
    f.setAccount('native-account-a')
    const descriptor = await resumed(f)
    const pending = f.request(f.first, descriptor, '/wait')
    await new Promise(resolve => setTimeout(resolve, 20))
    f.setAccount('native-account-b')
    f.respond()
    expect(await pending).toMatchObject({ code: 'credential-unavailable' })
    f.setAccount('native-account-a')
    expect(await resumed(f)).toMatchObject({ credential: 'bearer' })
  })
  it('uses the public renderer lifecycle to retain, reacquire a new grant and forget without a token getter', async () => {
    const f = await fixture()
    const makeClient = () =>
      createPluginHttpClient({
        active: () => true,
        principal: { ...principal.identity, moduleGeneration: 'm1', token: f.token },
        bridge: {
          request: async (_: string, value: Record<string, unknown>) => await f.call(String(value.operation), value),
        } as never,
        consent: async () => ({ approved: true, secret: 'original-guest-token' }),
      })
    const client = makeClient()
    const grant = await client.authorize({ origin: f.scope.origin, credential: 'bearer' })
    if (grant.status !== 'accepted') throw new Error('client grant')
    expect(await client.retain(grant.value, { sourceId: f.scope.sourceId, accountId: '' })).toEqual({
      status: 'accepted',
      value: null,
    })
    client.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    const next = makeClient()
    const restored = await next.resume(f.scope)
    expect(restored).toMatchObject({ status: 'accepted', value: { credential: 'bearer' } })
    expect(JSON.stringify(restored)).not.toContain('original-guest-token')
    expect(await next.forget(f.scope)).toEqual({ status: 'accepted', value: null })
    next.dispose()
  })
  it('rejects copied grants and malformed scope labels', async () => {
    const f = await fixture()
    for (
      const scope of [{ ...f.scope, sourceId: '' }, { ...f.scope, accountId: '\n' }, {
        ...f.scope,
        origin: 'http://remote.example',
      }]
    ) {
      expect(await f.call('plugin-http-retain', { connection: f.connection, scope })).toMatchObject({
        status: 'unavailable',
      })
    }
    const other = f.make({ ...principal, identity: { ...principal.identity, pluginId: 'other' } })
    expect(await other.call('plugin-http-retain', { connection: f.connection, scope: f.scope })).toMatchObject({
      code: 'connection-unavailable',
    })
  })
  it('production Native account reader fails closed for destroyed contexts, timeout and late retirement', async () => {
    const send = vi.fn(async () => ({ result: { value: 'private-native-account' } }))
    expect(await readNativeHttpAccount({ send }, undefined, () => true)).toMatchObject({ reason: 'context-missing' })
    expect(send).not.toHaveBeenCalled()
    expect(await readNativeHttpAccount({ send }, 73, () => true)).toBe('private-native-account')
    expect(send).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({
        contextId: 73,
        expression: HTTP_NATIVE_ACCOUNT_EXPRESSION,
        awaitPromise: true,
        timeout: 6000,
      }),
      6500,
    )
    const exception = { send: async () => ({ exceptionDetails: { text: 'secret must never be projected' } }) }
    expect(await readNativeHttpAccount(exception, 73, () => true)).toBeNull()
    const failed = {
      send: async () => {
        throw new Error('private error')
      },
    }
    expect(await readNativeHttpAccount(failed, 73, () => true)).toBeNull()
    let live = true
    const retired = {
      send: async () => {
        live = false
        return { result: { value: 'private-native-account' } }
      },
    }
    expect(await readNativeHttpAccount(retired, 73, () => live)).toBeInstanceOf(
      HttpNativeCallingContextUnavailableError,
    )
  })
  it('keeps native lookup exact-build guarded and independent of profile endpoint readiness', () => {
    expect(HTTP_NATIVE_ACCOUNT_EXPRESSION).toContain('8378')
    expect(HTTP_NATIVE_ACCOUNT_EXPRESSION).toContain('8881')
    expect(HTTP_NATIVE_ACCOUNT_EXPRESSION).toContain('vscode://codex/account-info')
    expect(HTTP_NATIVE_ACCOUNT_EXPRESSION).not.toContain('/wham/profiles/me')
    expect(HTTP_NATIVE_ACCOUNT_EXPRESSION).not.toContain('displayName')
  })
})
