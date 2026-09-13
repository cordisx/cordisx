import {
  binding,
  managedSourceFixture,
  origin,
  owner,
  principal,
  secret,
  snapshot,
} from './fixtures/managed-source-http.js'
import type { PluginHttpDiagnostic } from '../packages/cli/src/launcher/plugin-http-diagnostics.js'
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { managedSourceBytes } from '@cordisx/protocol/managed-source/v1'
import type { WorkUsageSnapshotV2 } from '@cordisx/protocol/usage/v2'
import { PluginHttpAuthority } from '../packages/cli/src/launcher/plugin-http-authority.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { MANAGED_SOURCE_KEYCHAIN_SERVICE } from '../packages/cli/src/launcher/managed-source-authority.js'
import { createPluginHttpClient } from '../packages/cli/src/renderer/plugin-http.js'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0)) await close()
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
function fixture(onDiagnostic?: (event: PluginHttpDiagnostic) => void) {
  return managedSourceFixture(cleanups, onDiagnostic)
}

it('same-owner renderer cleanup preserves sibling work continuity and real Native changes still retire sibling grants', async () => {
  const f = fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  let native = 'native-a'
  const makeClient = () => {
    const client = createPluginHttpClient({
      active: () => true,
      authorizeWork: async () => true,
      principal: { ...owner, moduleGeneration: 'm1', token },
      bridge: {
        request: async (_: string, input: Record<string, unknown>) =>
          f.authority.handle({ ...input, token }, async () => native, async () => snapshot),
      } as never,
    })
    cleanups.push(async () => client.dispose())
    return client
  }
  const a = makeClient(), b = makeClient(), c = makeClient()
  const first = await a.connectAccount(binding),
    second = await b.connectAccount(binding),
    third = await c.connectAccount(binding)
  if (first.status !== 'accepted' || second.status !== 'accepted' || third.status !== 'accepted') {
    throw new Error('renderer Native fixture')
  }
  expect(await b.submitWorkUsage({ ...binding, audience: 'work-income' })).toMatchObject({ status: 'accepted' })
  expect(await a.revoke(first.value.connection)).toEqual({ status: 'accepted', value: null })
  a.dispose()
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(await b.submitWorkUsage({ ...binding, audience: 'work-income' })).toMatchObject({ status: 'accepted' })
  expect(f.seen.filter(event => event.path === '/v1/income/work').map(event => event.body!.continuity)).toEqual([
    'baseline',
    'continuous',
  ])
  native = 'native-b'
  const exchange = (client: ReturnType<typeof makeClient>, connection: typeof second.value.connection) =>
    client.exchange({
      connection,
      path: '/v1/exchange',
      body: '{}',
      credentialField: 'token',
      deadline: Date.now() + 2000,
    })
  expect(await exchange(b, second.value.connection)).toMatchObject({ code: 'credential-unavailable' })
  expect(await exchange(c, third.value.connection)).toMatchObject({ code: 'connection-unavailable' })
})

it('a managed login reply arriving after client disposal cannot leak a grant or revoke a live sibling', async () => {
  const f = fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  const makeClient = () => {
    const client = createPluginHttpClient({
      active: () => true,
      principal: { ...owner, moduleGeneration: 'm1', token },
      bridge: {
        request: async (_: string, input: Record<string, unknown>) =>
          f.authority.handle({ ...input, token }, async () => 'native-a'),
      } as never,
    })
    cleanups.push(async () => client.dispose())
    return client
  }
  const a = makeClient(), b = makeClient()
  const connected = await b.connectAccount(binding)
  if (connected.status !== 'accepted') throw new Error('sibling Native fixture')
  const held = deferred()
  f.hold(held.promise)
  const pending = a.connectAccount(binding)
  await vi.waitFor(() => expect(f.seen.filter(event => event.path === '/v1/auth/host/session')).toHaveLength(2))
  a.dispose()
  held.resolve()
  expect(await pending).toMatchObject({ status: 'unavailable', code: 'stale-generation' })
  f.hold()
  expect([...f.stored.keys()].filter(key => key.startsWith('cordisx/http/'))).toHaveLength(1)
  expect(
    await b.exchange({
      connection: connected.value.connection,
      path: '/v1/exchange',
      body: '{}',
      credentialField: 'token',
      deadline: Date.now() + 2000,
    }),
  )
    .toMatchObject({ status: 'accepted' })
})
it('uses signed native subject, stores only source bearer and strips it from public response', async () => {
  const f = fixture(), result = await f.invoke('plugin-http-connect-account', { ...binding, displayName: 'Player' })
  expect(result.status).toBe('accepted')
  expect(JSON.stringify(result)).not.toContain('test-source-secret')
  const assertion = f.seen[1]!.body!
  expect(assertion.subject).toBe(
    'codex:' + createHash('sha256').update(JSON.stringify(['account-A', 'user-A'])).digest('base64url'),
  )
  expect(assertion.displayName).toBe('Player')
  expect(assertion).not.toHaveProperty('accountId')
})
it.each(['null', 'throw'] as const)(
  'classifies initial Native %s as credential unavailable before any source request',
  async mode => {
    const f = fixture()
    if (mode === 'throw') f.nativeUnavailable(true)
    else f.account(null)
    expect(await f.invoke('plugin-http-connect-account', binding)).toEqual({
      status: 'unavailable',
      code: 'credential-unavailable',
    })
    expect(f.seen).toEqual([])
    expect(f.signerReads()).toBe(0)
    expect(f.stored.size).toBe(1)
  },
)
it.each(['source-account', 'work-income'] as const)(
  'classifies missing exact %s trust before any Native read',
  async audience => {
    const f = fixture()
    f.trusts(false)
    expect(
      await f.invoke(audience === 'source-account' ? 'plugin-http-connect-account' : 'plugin-http-submit-work', {
        ...binding,
        audience,
      }),
    ).toEqual({ status: 'unavailable', code: 'connection-unavailable' })
    expect(f.accountCalls()).toBe(0)
    expect(f.seen).toEqual([])
    expect(f.signerReads()).toBe(0)
    expect(f.stored.size).toBe(1)
  },
)
it('rejects unprovisioned owner and wrong challenge before any session POST', async () => {
  const f = fixture()
  expect(
    (await f.invoke('plugin-http-connect-account', binding, { ...principal, identity: { ...owner, pluginId: 'game' } }))
      .status,
  ).toBe('unavailable')
  expect(f.seen).toHaveLength(0)
  f.wrongChallenge()
  expect((await f.invoke('plugin-http-connect-account', binding)).status).toBe('unavailable')
  expect(f.seen).toHaveLength(1)
})
it('rejects PEM, foreign keys and noncanonical signer encodings before any session POST', async () => {
  for (const invalid of ['pem', 'foreign', 'padding', 'newline', 'trailing', 'invalid-der']) {
    const f = fixture(), ref = [...f.stored.keys()].find(key => key.startsWith(MANAGED_SOURCE_KEYCHAIN_SERVICE))!
    const encoded = f.stored.get(ref)!, bytes = Buffer.from(encoded, 'base64')
    const value = invalid === 'pem'
      ? createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' }).export({ type: 'pkcs8', format: 'pem' })
        .toString()
      : invalid === 'foreign'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'der' })
        .toString('base64')
      : invalid === 'padding'
      ? encoded + '='
      : invalid === 'newline'
      ? encoded + '\n'
      : invalid === 'trailing'
      ? Buffer.concat([bytes, Buffer.from([0])]).toString('base64')
      : Buffer.alloc(48).toString('base64')
    f.stored.set(ref, value)
    expect((await f.invoke('plugin-http-connect-account', binding)).status).toBe('unavailable')
    expect(f.seen).toHaveLength(1)
    expect(f.stored.size).toBe(1)
  }
})
it('rejects signed result with wrong subject and late account switch without storing a session', async () => {
  const bad = fixture()
  bad.wrongResult()
  expect((await bad.invoke('plugin-http-connect-account', binding)).status).toBe('unavailable')
  const f = fixture(), held = deferred()
  f.hold(held.promise)
  const pending = f.invoke('plugin-http-connect-account', binding)
  await vi.waitFor(() => expect(f.seen).toHaveLength(2))
  f.account(JSON.stringify(['account-B', 'user-B']))
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect([...f.stored.values()]).not.toContain('test-source-secret')
})
it('reads work internally and signs conservative first, continuous and explicit baseline leases', async () => {
  const f = fixture(), work = { ...binding, audience: 'work-income' }
  expect((await f.invoke('plugin-http-submit-work', { ...work, snapshot, amount: 1000 })).status).toBe('unavailable')
  expect(f.reads()).toBe(0)
  await f.invoke('plugin-http-submit-work', work)
  await f.invoke('plugin-http-submit-work', work)
  await f.invoke('plugin-http-submit-work', { ...work, baseline: true })
  const observations = f.seen.filter(x => x.body).map(x => x.body!)
  expect(observations.map(x => x.continuity)).toEqual(['baseline', 'continuous', 'baseline'])
  expect(observations[0]!.leaseId).toBe(observations[1]!.leaseId)
  expect(observations[2]!.leaseId).not.toBe(observations[0]!.leaseId)
  expect(observations[0]!.snapshot).toEqual(snapshot)
  expect(f.reads()).toBe(3)
})
it('forwards a valid old opaque source grant only to same-origin session and retires switched grant', async () => {
  const f = fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  const previous = await f.authority.handle({
    token,
    operation: 'plugin-http-authorize',
    origin,
    credential: 'bearer',
    secret: 'test-guest-secret',
  })
  if (previous.status !== 'accepted') throw new Error('guest fixture unavailable')
  const result = await f.invoke('plugin-http-connect-account', { ...binding, previousConnection: previous.value })
  expect(f.seen[1]!.authorization).toBe('Bearer test-guest-secret')
  expect(result.status).toBe('accepted')
  if (result.status !== 'accepted') return
  const connection = (result.value as { connection: unknown }).connection
  f.account(null)
  const request = await f.authority.handle({
    token,
    operation: 'plugin-http-request',
    connection,
    operationId: 'read-after-switch',
    path: '/v1/me',
    method: 'GET',
    deadline: Date.now() + 1000,
  }, async () => null)
  expect(request).toMatchObject({ status: 'unavailable', code: 'credential-unavailable' })
})
it('does not dispatch work when the public usage permission authorizer denies', async () => {
  const request = vi.fn(async () => undefined)
  const http = createPluginHttpClient({
    bridge: { request } as never,
    principal: { token: 'test', pluginId: 'wallet' } as never,
    active: () => true,
    authorizeWork: async () => false,
  })
  expect(await http.submitWorkUsage({ ...binding, audience: 'work-income' })).toMatchObject({
    status: 'unavailable',
    code: 'denied',
  })
  expect(request).not.toHaveBeenCalled()
  http.dispose()
})
it('cannot retain an A grant into the same org account with a different native user', async () => {
  const f = fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  const connected = await f.invoke('plugin-http-connect-account', binding)
  if (connected.status !== 'accepted') throw new Error('connection fixture unavailable')
  const connection = (connected.value as { connection: unknown }).connection
  f.account(JSON.stringify(['account-A', 'user-B']))
  expect(
    await f.authority.handle({
      token,
      operation: 'plugin-http-retain',
      connection,
      scope: { origin, sourceId: 'local', accountId: '' },
    }, async () => JSON.stringify(['account-A', 'user-B'])),
  )
    .toMatchObject({ status: 'unavailable', code: 'connection-unavailable' })
  expect([...f.stored.values()].some(x => x.includes('"nativeAccount"'))).toBe(false)
})
it('retains the full native pair privately and resumes only its original account partition', async () => {
  const f = fixture(),
    token = issueOwnerDocumentPrincipalToken(secret, principal),
    account = JSON.stringify(['account-A', 'user-A'])
  const connected = await f.invoke('plugin-http-connect-account', binding)
  if (connected.status !== 'accepted') throw new Error('connection fixture unavailable')
  const connection = (connected.value as { connection: unknown }).connection,
    scope = { origin, sourceId: 'local', accountId: '' }
  expect(
    (await f.authority.handle({ token, operation: 'plugin-http-retain', connection, scope }, async () => account))
      .status,
  ).toBe('accepted')
  const saved = [...f.stored.values()].filter(x => x.includes('"nativeAccount"'))
  expect(saved).toHaveLength(1)
  expect(JSON.parse(saved[0]!).nativeAccount).toBe(account)
  f.account(JSON.stringify(['account-A', 'user-B']))
  expect(
    await f.authority.handle(
      { token, operation: 'plugin-http-resume', scope },
      async () => JSON.stringify(['account-A', 'user-B']),
    ),
  )
    .toMatchObject({ status: 'accepted', value: null })
  f.account(account)
  expect((await f.authority.handle({ token, operation: 'plugin-http-resume', scope }, async () => account)).status)
    .toBe('accepted')
})
it('source logout retires an in-flight managed login before a late signed result', async () => {
  const f = fixture(), held = deferred(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  f.hold(held.promise)
  const pending = f.invoke('plugin-http-connect-account', binding)
  await vi.waitFor(() => expect(f.seen).toHaveLength(2))
  await f.authority.handle({
    token,
    operation: 'plugin-http-forget',
    scope: { origin, sourceId: 'local', accountId: '' },
  }, async () => JSON.stringify(['account-A', 'user-A']))
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect([...f.stored.values()]).not.toContain('test-source-secret')
})
it('a trusted work observation gap advances to a new baseline lease', async () => {
  const f = fixture(), work = { ...binding, audience: 'work-income' }
  let now = 100_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  await f.invoke('plugin-http-submit-work', work)
  now += 15_001
  await f.invoke('plugin-http-submit-work', work)
  const observations = f.seen.filter(x => x.body).map(x => x.body!)
  expect(observations.map(x => x.continuity)).toEqual(['baseline', 'baseline'])
  expect(observations[1]!.leaseId).not.toBe(observations[0]!.leaseId)
})
it('a native A to B to A change and unavailable usage both require fresh baselines', async () => {
  const f = fixture(), work = { ...binding, audience: 'work-income' }, nativeA = JSON.stringify(['account-A', 'user-A'])
  await f.invoke('plugin-http-submit-work', work)
  f.account(JSON.stringify(['account-A', 'user-B']))
  await f.invoke('plugin-http-submit-work', work)
  f.account(nativeA)
  await f.invoke('plugin-http-submit-work', work)
  f.usage({ schemaVersion: 2, status: 'unavailable', reason: 'source-unavailable', diagnostics: [] })
  expect((await f.invoke('plugin-http-submit-work', work)).status).toBe('unavailable')
  f.usage(snapshot)
  await f.invoke('plugin-http-submit-work', work)
  f.account(null)
  expect((await f.invoke('plugin-http-submit-work', work)).status).toBe('unavailable')
  f.account(nativeA)
  await f.invoke('plugin-http-submit-work', work)
  expect(f.seen.filter(x => x.body).map(x => x.body!.continuity)).toEqual(Array(5).fill('baseline'))
})
it('retirement during the final asynchronous trust fence prevents a signed session POST', async () => {
  const f = fixture(), held = deferred(), token = issueOwnerDocumentPrincipalToken(secret, principal)
  f.holdTrustAt(6, held.promise)
  const pending = f.invoke('plugin-http-connect-account', binding)
  await vi.waitFor(() => expect(f.trustCalls()).toBeGreaterThanOrEqual(6))
  await f.authority.handle({ token, operation: 'plugin-http-dispose' })
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect(f.seen).toHaveLength(1)
})
it('native switch during the final asynchronous trust fence prevents a signed session POST', async () => {
  const f = fixture(), held = deferred()
  f.holdTrustAt(6, held.promise)
  const pending = f.invoke('plugin-http-connect-account', binding)
  await vi.waitFor(() => expect(f.trustCalls()).toBeGreaterThanOrEqual(6))
  f.account(JSON.stringify(['account-A', 'user-B']))
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect(f.seen).toHaveLength(1)
})
it('native switch during bearer loading rejects before dispatching the authenticated mutation', async () => {
  const f = fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal), held = deferred()
  const connected = await f.invoke('plugin-http-connect-account', binding)
  if (connected.status !== 'accepted') throw new Error('connection fixture unavailable')
  const connection = (connected.value as { connection: unknown }).connection
  f.holdBearer(held.promise)
  const pending = f.authority.handle({
    token,
    operation: 'plugin-http-request',
    connection,
    operationId: 'held-mutation',
    path: '/v1/reserve',
    method: 'POST',
    body: '{}',
    deadline: Date.now() + 5000,
  }, async () => JSON.stringify(f.bearerReads() ? ['account-A', 'user-B'] : ['account-A', 'user-A']))
  await vi.waitFor(() => expect(f.bearerReads()).toBe(1))
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect(f.seen).toHaveLength(2)
})
it('new provisioning becomes available after an unprovisioned attempt, without Host replacement', async () => {
  const f = fixture()
  f.trusts(false)
  expect((await f.invoke('plugin-http-connect-account', binding)).status).toBe('unavailable')
  f.trusts(true)
  expect((await f.invoke('plugin-http-connect-account', binding)).status).toBe('accepted')
})
it('parent revocation during final native identity await retires a newly exchanged child', async () => {
  const f = fixture(), token = issueOwnerDocumentPrincipalToken(secret, principal), held = deferred()
  const connected = await f.invoke('plugin-http-connect-account', binding)
  if (connected.status !== 'accepted') throw new Error('connection fixture unavailable')
  const connection = (connected.value as { connection: unknown }).connection
  let reads = 0
  const account = JSON.stringify(['account-A', 'user-A'])
  const pending = f.authority.handle({
    token,
    operation: 'plugin-http-exchange',
    connection,
    operationId: 'exchange-child',
    path: '/v1/exchange',
    body: '{}',
    credentialField: 'token',
    deadline: Date.now() + 5000,
  }, async () => {
    reads++
    if (reads === 5) await held.promise
    return account
  })
  await vi.waitFor(() => expect(reads).toBe(5))
  await f.authority.handle({ token, operation: 'plugin-http-revoke', connection }, async () => account)
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect([...f.stored.values()]).not.toContain('test-child-secret')
})

it('final outer native-account rejection retires work continuity before A returns', async () => {
  const f = fixture(), request = { ...binding, audience: 'work-income' }
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const callsPerSubmit = f.accountCalls(), held = deferred()
  f.holdAccountAt(callsPerSubmit * 2, held.promise)
  const pending = f.invoke('plugin-http-submit-work', request)
  await vi.waitFor(() => expect(f.accountCalls()).toBe(callsPerSubmit * 2))
  f.account(JSON.stringify(['account-B', 'user-B']))
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  f.account(JSON.stringify(['account-A', 'user-A']))
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const posts = f.seen.filter(entry => entry.path === '/v1/income/work')
  expect(posts.map(entry => entry.body!.continuity)).toEqual(['baseline', 'continuous', 'baseline'])
  expect(posts[2]!.body!.leaseId).not.toBe(posts[1]!.body!.leaseId)
})

it('trust withdrawal during the final native read prevents signed session dispatch', async () => {
  const f = fixture(), held = deferred()
  f.holdAccountAt(6, held.promise)
  const pending = f.invoke('plugin-http-connect-account', binding)
  await vi.waitFor(() => expect(f.accountCalls()).toBe(6))
  expect(f.seen.map(entry => entry.path)).toEqual(['/v1/auth/host/challenge'])
  f.trusts(false)
  held.resolve()
  expect((await pending).status).toBe('unavailable')
  expect(f.seen).toHaveLength(1)
})

it('a native switch observed by a derived bearer request retires work continuity before A returns', async () => {
  const f = fixture(), request = { ...binding, audience: 'work-income' }
  const connected = await f.invoke('plugin-http-connect-account', binding)
  if (connected.status !== 'accepted') throw new Error('expected managed connection')
  const connection = (connected.value as { connection: { id: string } }).connection
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  f.account(JSON.stringify(['account-B', 'user-B']))
  const result = await f.authority.handle({
    operation: 'plugin-http-request',
    connection,
    path: '/v1/me',
    method: 'GET',
    operationId: 'observe-native-switch',
    deadline: Date.now() + 5000,
    token: issueOwnerDocumentPrincipalToken(secret, principal),
  }, async () => JSON.stringify(['account-B', 'user-B']))
  expect(result).toMatchObject({ status: 'unavailable', code: 'credential-unavailable' })
  f.account(JSON.stringify(['account-A', 'user-A']))
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const posts = f.seen.filter(entry => entry.path === '/v1/income/work')
  expect(posts.map(entry => entry.body!.continuity)).toEqual(['baseline', 'baseline'])
  expect(posts[1]!.body!.leaseId).not.toBe(posts[0]!.body!.leaseId)
})

it('managed deadline covers initial trust loading and fences a late continuation before any request', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = deferred()
  f.holdTrustAt(1, held.promise)
  const pending = f.invoke('plugin-http-connect-account', binding)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.trustCalls()).toBe(1)
  await vi.advanceTimersByTimeAsync(15001)
  expect((await pending).status).toBe('unavailable')
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.seen).toHaveLength(0)
})
it('managed deadline covers initial native reading and retires late work before challenge or POST', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = deferred(), request = { ...binding, audience: 'work-income' }
  f.holdAccountAt(1, held.promise)
  const pending = f.invoke('plugin-http-submit-work', request)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.accountCalls()).toBe(1)
  await vi.advanceTimersByTimeAsync(15001)
  expect((await pending).status).toBe('unavailable')
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.seen).toHaveLength(0)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  expect(f.seen.find(entry => entry.path === '/v1/income/work')!.body!.continuity).toBe('baseline')
})

it('late initial native A after timeout cannot retire a healthy B work lease', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = deferred(), request = { ...binding, audience: 'work-income' }
  f.captureAccountAt(1, held.promise)
  const old = f.invoke('plugin-http-submit-work', request)
  await vi.advanceTimersByTimeAsync(15001)
  expect((await old).status).toBe('unavailable')
  f.account(JSON.stringify(['account-B', 'user-B']))
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const healthy = f.seen.find(entry => entry.path === '/v1/income/work')!.body!
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})
it('expired signer-loading cleanup cannot delete a replacement healthy work lease', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = deferred(), request = { ...binding, audience: 'work-income' }
  f.holdSignerAt(1, held.promise)
  const old = f.invoke('plugin-http-submit-work', request)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.signerReads()).toBe(1)
  await vi.advanceTimersByTimeAsync(15001)
  expect((await old).status).toBe('unavailable')
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const healthy = f.seen.find(entry => entry.path === '/v1/income/work')!.body!
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})
it('public managed work deadline also bounds the final outer native read', async () => {
  vi.useFakeTimers()
  const f = fixture(), request = { ...binding, audience: 'work-income' }, held = deferred()
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const perCall = f.accountCalls()
  f.holdAccountAt(perCall * 2, held.promise)
  const old = f.invoke('plugin-http-submit-work', request)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.accountCalls()).toBe(perCall * 2)
  await vi.advanceTimersByTimeAsync(15001)
  expect(await old).toMatchObject({ status: 'unavailable', code: 'deadline-exceeded' })
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const healthy = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})

it('renderer-created absolute deadline fences delayed bridge delivery before any source request', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = deferred()
  const http = createPluginHttpClient({
    active: () => true,
    principal: {
      ...principal.identity,
      moduleGeneration: principal.moduleGeneration,
      token: issueOwnerDocumentPrincipalToken(secret, principal),
    },
    bridge: {
      request: async (_token: string, raw: unknown) => {
        await held.promise
        return f.authority.handle(
          { ...(raw as object), token: issueOwnerDocumentPrincipalToken(secret, principal) },
          async () => JSON.stringify(['account-A', 'user-A']),
        )
      },
    } as unknown as import('../packages/cli/src/renderer/owner-documents.js').BrowserOwnerDocumentBridge,
  })
  const pending = http.connectAccount(binding)
  await vi.advanceTimersByTimeAsync(35001)
  expect(await pending).toMatchObject({ status: 'unavailable', code: 'deadline-exceeded' })
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.seen).toHaveLength(0)
  http.dispose()
})

it('a polling native read failure retires work continuity after the login operation completed', async () => {
  vi.useFakeTimers()
  const f = fixture(), request = { ...binding, audience: 'work-income' }
  expect((await f.invoke('plugin-http-connect-account', binding)).status).toBe('accepted')
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  f.nativeUnavailable(true)
  await vi.advanceTimersByTimeAsync(1250)
  f.nativeUnavailable(false)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const posts = f.seen.filter(entry => entry.path === '/v1/income/work')
  expect(posts.map(entry => entry.body!.continuity)).toEqual(['baseline', 'baseline'])
  expect(posts[1]!.body!.leaseId).not.toBe(posts[0]!.body!.leaseId)
})
it('an older login deadline cannot retire newer-account work that became healthy before timeout', async () => {
  vi.useFakeTimers()
  const probe = fixture()
  expect((await probe.invoke('plugin-http-connect-account', binding)).status).toBe('accepted')
  const lastAccountRead = probe.accountCalls()
  const f = fixture(), held = deferred(), request = { ...binding, audience: 'work-income' }
  f.captureAccountAt(lastAccountRead, held.promise)
  const old = f.invoke('plugin-http-connect-account', binding)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.accountCalls()).toBe(lastAccountRead)
  f.account(JSON.stringify(['account-B', 'user-B']))
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const healthy = f.seen.find(entry => entry.path === '/v1/income/work')!.body!
  await vi.advanceTimersByTimeAsync(5000)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  await vi.advanceTimersByTimeAsync(5000)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  await vi.advanceTimersByTimeAsync(5001)
  expect((await old).status).toBe('unavailable')
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})

it('a captured old-account read released before deadline cannot observe into newer healthy work', async () => {
  vi.useFakeTimers()
  const probe = fixture()
  expect((await probe.invoke('plugin-http-connect-account', binding)).status).toBe('accepted')
  const f = fixture(), held = deferred(), request = { ...binding, audience: 'work-income' }
  f.captureAccountAt(probe.accountCalls(), held.promise)
  const old = f.invoke('plugin-http-connect-account', binding)
  await vi.advanceTimersByTimeAsync(0)
  f.account(JSON.stringify(['account-B', 'user-B']))
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const healthy = f.seen.find(entry => entry.path === '/v1/income/work')!.body!
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await old).status).toBe('unavailable')
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})
it('an earlier absolute deadline in a queued call cannot open the queue before its predecessor settles', async () => {
  vi.useFakeTimers()
  const f = fixture(), request = { ...binding, audience: 'work-income' }, held = deferred()
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const perCall = f.accountCalls()
  f.captureAccountAt(perCall * 2, held.promise)
  const a = f.invoke('plugin-http-submit-work', request)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.accountCalls()).toBe(perCall * 2)
  const q = f.invoke('plugin-http-submit-work', request, principal, Date.now() + 14_000)
  await vi.advanceTimersByTimeAsync(14_001)
  expect(await q).toMatchObject({ status: 'unavailable', code: 'deadline-exceeded' })
  const b = f.invoke('plugin-http-submit-work', request)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.accountCalls()).toBe(perCall * 2)
  await vi.advanceTimersByTimeAsync(1000)
  expect((await a).status).toBe('unavailable')
  expect((await b).status).toBe('accepted')
  const healthy = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})

it('a stale initial account read returning before deadline cannot retire newer healthy work', async () => {
  vi.useFakeTimers()
  const f = fixture(), held = deferred(), request = { ...binding, audience: 'work-income' }
  f.captureAccountAt(1, held.promise)
  const old = f.invoke('plugin-http-connect-account', binding)
  await vi.advanceTimersByTimeAsync(0)
  f.account(JSON.stringify(['account-B', 'user-B']))
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const healthy = f.seen.find(entry => entry.path === '/v1/income/work')!.body!
  held.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect((await old).status).toBe('unavailable')
  expect((await f.invoke('plugin-http-submit-work', request)).status).toBe('accepted')
  const next = f.seen.filter(entry => entry.path === '/v1/income/work').at(-1)!.body!
  expect(next.continuity).toBe('continuous')
  expect(next.leaseId).toBe(healthy.leaseId)
})
