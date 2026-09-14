import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import { readNativeHttpAccount } from '../packages/cli/src/launcher/plugin-http-native-account.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { createPluginHttpClient } from '../packages/cli/src/renderer/plugin-http.js'
import type { PluginHttpDiagnostic } from '../packages/cli/src/launcher/plugin-http-diagnostics.js'
import { binding, managedSourceFixture, owner, principal, secret, snapshot } from './fixtures/managed-source-http.js'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanups.splice(0)) await close()
})
function fixture(onDiagnostic?: (event: PluginHttpDiagnostic) => void) {
  return managedSourceFixture(cleanups, onDiagnostic)
}
it('keeps normal HTTP reads usable after the first calling-context Native background revalidation', async () => {
  vi.useFakeTimers()
  const diagnostics: PluginHttpDiagnostic[] = []
  const f = fixture(event => diagnostics.push(event)), token = issueOwnerDocumentPrincipalToken(secret, principal)
  let typed: unknown = { status: 'ready', data: { accountId: 'fixture-account', userId: 'fixture-user' } }
  const reads: number[] = []
  const makeClient = (contextId: number) => {
    const session = {
      send: async (method: string, params: Record<string, unknown>) => {
        expect(method).toBe('Runtime.evaluate')
        expect(params.contextId).toBe(contextId)
        const source = String(params.expression).replace('await import(adapter.module)', 'await __loadNative()')
        const value = await runInNewContext(source, {
          AbortController,
          setTimeout,
          clearTimeout,
          location: { href: 'app://-/index.html' },
          codexWindowType: 'electron',
          electronBridge: {
            getSentryInitOptions: () => ({ appVersion: '26.908.40834', buildNumber: '8881', buildFlavor: 'prod' }),
          },
          __loadNative: async () => ({
            TW: {
              accessInputs: {
                readAccountInfo: async () => {
                  reads.push(contextId)
                  return typed
                },
              },
            },
          }),
        })
        return { result: { value } }
      },
    }
    const client = createPluginHttpClient({
      active: () => true,
      principal: { ...owner, moduleGeneration: 'm1', token },
      bridge: {
        request: async (_: string, input: Record<string, unknown>) =>
          f.authority.handle(
            { ...input, token },
            () =>
              readNativeHttpAccount(session, contextId, () =>
                true, reason =>
                f.authority.reportNativeAccountUnavailable({ ...input, token }, reason)),
          ),
      } as never,
    })
    cleanups.push(async () => client.dispose())
    return client
  }
  const a = makeClient(17), b = makeClient(23)
  const first = await a.connectAccount(binding), second = await b.connectAccount(binding)
  if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('calling-context fixture')
  const me = () =>
    b.request({ connection: second.value.connection, method: 'GET', path: '/v1/me', deadline: Date.now() + 2000 })
  expect(await me()).toMatchObject({ status: 'accepted', value: { body: '{"balance":0}' } })
  const before = reads.length
  await vi.advanceTimersByTimeAsync(1250)
  expect(reads.length).toBeGreaterThan(before)
  expect(new Set(reads.slice(before))).toEqual(new Set([17, 23]))
  expect(await me()).toMatchObject({ status: 'accepted', value: { body: '{"balance":0}' } })
  expect(
    await b.request({
      connection: second.value.connection,
      method: 'GET',
      path: '/v1/ledger',
      deadline: Date.now() + 2000,
    }),
  ).toMatchObject({
    status: 'accepted',
    value: { body: '{"entries":[]}' },
  })
  typed = { status: 'unavailable', reason: 'identity', private: 'fixture-private-error-payload' }
  await vi.advanceTimersByTimeAsync(1250)
  expect(await me()).toMatchObject({ code: 'connection-unavailable' })
  const failures = diagnostics.filter(event => event.event === 'native-account-read-unavailable')
  expect(failures.map(event => event.reason)).toEqual(['typed-identity', 'typed-identity'])
  expect(new Set(failures.map(event => event.client)).size).toBe(2)
  expect(diagnostics.filter(event => event.event === 'retired').map(event => event.reason)).toEqual([
    'native-account-unavailable',
    'native-account-unavailable',
  ])
  expect(JSON.stringify(diagnostics)).not.toMatch(
    /fixture-account|fixture-user|fixture-private-error-payload|test-source-secret/u,
  )
})

function productionClient(f: ReturnType<typeof fixture>, contextId: number, options: {
  windowType?: () => string
  url?: () => string
  active?: () => boolean
  account?: () => unknown
} = {}) {
  const token = issueOwnerDocumentPrincipalToken(secret, principal)
  const session = {
    send: async (_: string, params: Record<string, unknown>) => {
      expect(params.contextId).toBe(contextId)
      const expression = String(params.expression).replace('await import(adapter.module)', 'await __loadNative()')
      const value = await runInNewContext(expression, {
        AbortController,
        setTimeout,
        clearTimeout,
        codexWindowType: options.windowType?.() ?? 'electron',
        location: { href: options.url?.() ?? 'app://-/index.html' },
        electronBridge: {
          getSentryInitOptions: () => ({ appVersion: '26.908.40834', buildNumber: '8881', buildFlavor: 'prod' }),
        },
        __loadNative: async () => ({
          TW: {
            accessInputs: {
              readAccountInfo: async () =>
                options.account?.() ?? {
                  status: 'ready',
                  data: { accountId: 'fixture-account', userId: 'fixture-user' },
                },
            },
          },
        }),
      })
      return { result: { value } }
    },
  }
  const client = createPluginHttpClient({
    active: () => true,
    authorizeWork: async () => true,
    principal: { ...owner, moduleGeneration: 'm1', token },
    bridge: {
      request: async (_: string, input: Record<string, unknown>) =>
        f.authority.handle({ ...input, token }, () =>
          readNativeHttpAccount(
            session,
            contextId,
            options.active ?? (() => true),
            reason => f.authority.reportNativeAccountUnavailable({ ...input, token }, reason),
          ), async () => snapshot),
    } as never,
  })
  cleanups.push(async () => client.dispose())
  return client
}
const work = { ...binding, audience: 'work-income' as const }
it('fails a timed-out Native read closed, then accepts a fresh connection without reviving old handles or late reads', async () => {
  vi.useFakeTimers()
  const diagnostics: PluginHttpDiagnostic[] = []
  const f = fixture(event => diagnostics.push(event))
  let finish!: (value: unknown) => void
  const held = new Promise(resolve => {
    finish = resolve
  })
  let typed: unknown = { status: 'ready', data: { accountId: 'fixture-account', userId: 'fixture-user' } }
  const client = productionClient(f, 17, { account: () => typed })
  const first = await client.connectAccount(binding)
  if (first.status !== 'accepted') throw new Error('initial Native fixture')
  const read = (connection: typeof first.value.connection) =>
    client.request({
      connection,
      method: 'GET',
      path: '/v1/me',
      deadline: Date.now() + 2000,
    })
  typed = held
  await vi.advanceTimersByTimeAsync(6500)
  expect(await read(first.value.connection)).toMatchObject({ code: 'connection-unavailable' })
  expect(diagnostics.filter(event => event.event === 'native-account-read-unavailable').map(event => event.reason))
    .toContain('native-read-timeout')
  expect(diagnostics.filter(event => event.event === 'retired').map(event => event.reason))
    .toEqual(['native-account-unavailable'])
  typed = { status: 'ready', data: { accountId: 'fixture-account', userId: 'fixture-user' } }
  const fresh = await client.connectAccount(binding)
  if (fresh.status !== 'accepted') throw new Error('fresh Native recovery fixture')
  expect(fresh.value.connection.id).not.toBe(first.value.connection.id)
  expect(await read(fresh.value.connection)).toMatchObject({ status: 'accepted' })
  finish({ status: 'ready', data: { accountId: 'late-obsolete-account', userId: 'fixture-user' } })
  await vi.advanceTimersByTimeAsync(0)
  expect(await read(first.value.connection)).toMatchObject({ code: 'connection-unavailable' })
  expect(await read(fresh.value.connection)).toMatchObject({ status: 'accepted' })
  typed = { status: 'ready', data: { accountId: 'changed-account', userId: 'fixture-user' } }
  await vi.advanceTimersByTimeAsync(1250)
  expect(await read(fresh.value.connection)).toMatchObject({ code: 'connection-unavailable' })
  expect(diagnostics.filter(event => event.event === 'retired').map(event => event.reason))
    .toEqual(['native-account-unavailable', 'native-account-changed'])
})
it.each(['window-type', 'url'] as const)(
  'preserves healthy Native reads when a sibling %s calling context is rejected',
  async mode => {
    vi.useFakeTimers()
    const diagnostics: PluginHttpDiagnostic[] = []
    const f = fixture(event => diagnostics.push(event))
    const a = productionClient(f, 17)
    const rejected = productionClient(
      f,
      23,
      mode === 'window-type'
        ? { windowType: () => 'browser' }
        : { url: () => 'https://fixture.invalid/' },
    )
    const connection = await a.connectAccount(binding)
    if (connection.status !== 'accepted') throw new Error('healthy Native fixture')
    const read = (path: string) =>
      a.request({ connection: connection.value.connection, method: 'GET', path, deadline: Date.now() + 2000 })
    expect(await read('/v1/me')).toMatchObject({ status: 'accepted', value: { body: '{"balance":0}' } })
    expect(await a.submitWorkUsage(work)).toMatchObject({ status: 'accepted' })
    const before = f.seen.length
    expect(await rejected.connectAccount(binding)).toMatchObject({
      status: 'unavailable',
      code: 'credential-unavailable',
    })
    expect(await rejected.submitWorkUsage(work)).toMatchObject({
      status: 'unavailable',
      code: 'credential-unavailable',
    })
    expect(
      await rejected.request({
        connection: connection.value.connection,
        method: 'GET',
        path: '/v1/me',
        deadline: Date.now() + 2000,
      }),
    ).toMatchObject({ code: 'connection-unavailable' })
    expect(f.seen.length).toBe(before)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1250)
      expect(await read('/v1/me')).toMatchObject({ status: 'accepted' })
      expect(await read('/v1/ledger')).toMatchObject({ status: 'accepted' })
    }
    expect(await a.submitWorkUsage(work)).toMatchObject({ status: 'accepted' })
    expect(f.seen.filter(event => event.path === '/v1/income/work').map(event => event.body!.continuity)).toEqual([
      'baseline',
      'continuous',
    ])
    expect(diagnostics.filter(event => event.event === 'native-account-read-unavailable').map(event => event.reason))
      .toEqual(['context-rejected'])
    expect(diagnostics.filter(event => event.event === 'retired')).toEqual([])
  },
)
it('retires a closed calling client alone and still retires live grants on a real Native account change', async () => {
  vi.useFakeTimers()
  const diagnostics: PluginHttpDiagnostic[] = []
  const f = fixture(event => diagnostics.push(event))
  let active = true, accountId = 'fixture-account'
  const account = () => ({ status: 'ready', data: { accountId, userId: 'fixture-user' } })
  const a = productionClient(f, 17, { account }), b = productionClient(f, 23, { account, active: () => active })
  const first = await a.connectAccount(binding), second = await b.connectAccount(binding)
  if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('Native closure fixture')
  active = false
  await vi.advanceTimersByTimeAsync(1250)
  const read = () =>
    a.request({ connection: first.value.connection, method: 'GET', path: '/v1/me', deadline: Date.now() + 2000 })
  expect(await read()).toMatchObject({ status: 'accepted' })
  expect(
    await b.request({
      connection: second.value.connection,
      method: 'GET',
      path: '/v1/me',
      deadline: Date.now() + 2000,
    }),
  ).toMatchObject({ code: 'connection-unavailable' })
  expect(diagnostics.filter(event => event.event === 'retired').map(event => event.reason)).toEqual([
    'native-calling-context-unavailable',
  ])
  const c = productionClient(f, 31, { account }), third = await c.connectAccount(binding)
  if (third.status !== 'accepted') throw new Error('Native change fixture')
  accountId = 'fixture-account-changed'
  await vi.advanceTimersByTimeAsync(1250)
  expect(await read()).toMatchObject({ code: 'connection-unavailable' })
  expect(
    await c.request({
      connection: third.value.connection,
      method: 'GET',
      path: '/v1/ledger',
      deadline: Date.now() + 2000,
    }),
  ).toMatchObject({ code: 'connection-unavailable' })
  expect(diagnostics.filter(event => event.event === 'retired').slice(1).map(event => event.reason)).toEqual([
    'native-account-changed',
    'native-account-changed',
  ])
})
