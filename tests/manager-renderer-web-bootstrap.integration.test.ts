import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { encodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { managerRendererGraphFixture } from './fixtures/manager-renderer-graph.js'

const secret = () => randomBytes(32).toString('hex')

it('yields observation HTTP requests while retaining one authenticated owner call', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  let calls = 0
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    channels: new Map([
      ['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }],
      ['managed-service-ui', {
        prepare(payload) {
          const request = JSON.parse(String(payload)) as { requestId: string }
          return {
            mode: 'read',
            longLivedRead: true,
            dispatch: async () => {
              calls++
              await pending
              return { requestId: request.requestId, ok: true, value: 'event' }
            },
          }
        },
      }],
    ]),
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => true,
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (route: string, data: unknown, token?: string) =>
    await fetch(origin + route, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(data),
    })
  try {
    const session = await post('/api/session', { token: new URL(web.url).hash.slice(1) })
    const token = (await session.json() as { token: string }).token
    expect((await post('/api/renderer/open', {}, token)).status).toBe(200)
    const input = { channel: 'managed-service-ui', payload: JSON.stringify({ requestId: 'watch', operation: 'next' }) }
    expect((await post('/api/renderer/binding', input, token)).status).toBe(202)
    expect((await post('/api/renderer/binding', input, token)).status).toBe(202)
    expect(calls).toBe(1)
    expect(
      (await post('/api/renderer/binding', {
        ...input,
        payload: JSON.stringify({ requestId: 'watch', operation: 'closed' }),
      }, token)).status,
    ).toBe(503)
    release()
    const completed = await post('/api/renderer/binding', input, token)
    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ requestId: 'watch', ok: true, value: 'event' })
    expect(calls).toBe(1)
  } finally {
    release()
    authority.dispose()
    await web.close()
  }
}, 15_000)

it.each(['authenticate', 'logout', 'toggleAccount'] as const)(
  'retires a browser session when a managed-service %s result is unknown',
  async operation => {
    const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
    const authority = new ManagerRendererSessions({
      profileId: 'fixture',
      ownerGeneration: 'generation',
      ownerCurrent: () => true,
      authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
      channels: new Map([['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }], ['managed-service-ui', {
        prepare: () => ({
          mode: 'write' as const,
          dispatch: async () => {
            throw new Error('response lost after dispatch')
          },
        }),
      }]]),
    })
    const web = await startManagerWeb({
      appId: 'codex',
      profileId: 'fixture',
      generation: 'generation',
      isCurrent: async () => true,
      request: async operation => await dispatchManagerRendererOperation(authority, operation),
    }, { rendererGateway: gateway })
    const origin = new URL(web.url).origin
    const post = async (route: string, data: unknown, token?: string) =>
      await fetch(origin + route, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(data),
      })
    try {
      const session = await post('/api/session', { token: new URL(web.url).hash.slice(1) })
      const token = (await session.json() as { token: string }).token
      expect((await post('/api/renderer/open', {}, token)).status).toBe(200)
      const input = {
        channel: 'managed-service-ui',
        payload: JSON.stringify({ requestId: 'action', operation }),
      }
      const result = await post('/api/renderer/binding', input, token)
      expect(result.status).toBe(503)
      expect(await result.json()).toEqual({ error: 'OPERATION_RESULT_UNKNOWN' })
      expect((await post('/api/renderer/binding', input, token)).status).toBe(401)
    } finally {
      authority.dispose()
      await web.close()
    }
  },
)

it('returns a definite busy response when an account toggle has not been dispatched', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let writes = 0
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    channels: new Map([['plugin-management', {
      prepare: () => {
        throw new Error('unused')
      },
    }], ['managed-service-ui', {
      prepare: payload => ({
        mode: 'write' as const,
        dispatch: async () => {
          writes++
          const request = JSON.parse(String(payload)) as { requestId: string }
          return { requestId: request.requestId, ok: true, value: { status: 'accepted' } }
        },
      }),
    }]]),
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => true,
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (route: string, data: unknown, token?: string) =>
    await fetch(origin + route, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(data),
    })
  try {
    const session = await post('/api/session', { token: new URL(web.url).hash.slice(1) })
    const token = (await session.json() as { token: string }).token
    expect((await post('/api/renderer/open', {}, token)).status).toBe(200)
    const fence = await authority.suspendMutations()
    const payload = {
      channel: 'managed-service-ui',
      payload: JSON.stringify({ requestId: 'toggle-1', operation: 'toggleAccount' }),
    }
    const blocked = await post('/api/renderer/binding', payload, token)
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toEqual({ requestId: 'toggle-1', ok: false, code: 'owner-unavailable' })
    expect(writes).toBe(0)
    expect(fence.release()).toBe(true)
    const retried = await post('/api/renderer/binding', payload, token)
    expect(retried.status).toBe(200)
    expect(writes).toBe(1)
  } finally {
    authority.dispose()
    await web.close()
  }
}, 15_000)

it('returns a known Desktop configuration rejection when the owner blocks a write before dispatch', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let writes = 0
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    channels: new Map([['plugin-management', {
      prepare: () => {
        throw new Error('unused')
      },
    }], ['desktop-package-config', {
      prepare: payload => ({
        mode: 'write' as const,
        dispatch: async () => {
          writes++
          const request = JSON.parse(String(payload)) as { requestId: string }
          return { requestId: request.requestId, ok: true, value: { status: 'applied', revision: 2 } }
        },
      }),
    }]]),
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => true,
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (route: string, data: unknown, token?: string) =>
    await fetch(origin + route, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: JSON.stringify(data),
    })
  try {
    const session = await post('/api/session', { token: new URL(web.url).hash.slice(1) })
    const token = (await session.json() as { token: string }).token
    expect((await post('/api/renderer/open', {}, token)).status).toBe(200)
    const fence = await authority.suspendMutations()
    const payload = { channel: 'desktop-package-config', payload: JSON.stringify({ requestId: 'config-1' }) }
    const blocked = await post('/api/renderer/binding', payload, token)
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toEqual({
      requestId: 'config-1',
      ok: true,
      value: { status: 'rejected', reason: 'busy' },
    })
    expect(writes).toBe(0)
    expect(fence.release()).toBe(true)
    const retried = await post('/api/renderer/binding', payload, token)
    expect(retried.status).toBe(200)
    expect(writes).toBe(1)
  } finally {
    authority.dispose()
    await web.close()
  }
}, 15_000)

it('bootstraps two authenticated renderer sessions without exposing private graphs or grants', async () => {
  const fixture = await managerRendererGraphFixture()
  const lease = await fixture.lease('generation')
  const privateGraph = {
    leaseId: lease.leaseId,
    pluginId: lease.pluginId,
    moduleGeneration: lease.moduleGeneration,
    baseUrl: lease.baseUrl,
    entryUrl: lease.entryUrl,
    initialStyleUrls: lease.initialStyleUrls,
  }
  const bundle = await encodeManagerRendererBundle(Buffer.from('export const ready = true'))
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  let ownerCurrent = true
  let interruptNextStatus = false
  let interruptedStatuses = 0
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => ownerCurrent,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    channels: new Map([
      ['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }],
      ['channel-credentials', {
        prepare(payload) {
          const request = JSON.parse(String(payload)) as { requestId: string; operation: string }
          return {
            mode: 'write',
            dispatch: async () => {
              if (request.operation === 'commit') throw new Error('synthetic unknown result')
              return { requestId: request.requestId, ok: true, value: { status: 'applied', code: 'CAPTURED' } }
            },
          }
        },
      }],
      ['manager-bootstrap', {
        prepare(payload) {
          const input = payload as { action: string; graphs?: unknown[] }
          return {
            mode: 'read',
            dispatch: async () =>
              input.action === 'status'
                ? { status: 'ok', current: true }
                : input.action === 'prepare'
                ? { status: 'ok', snapshot: {}, privateGraphs: [privateGraph] }
                : { status: 'ok', bundle, initialGraphs: input.graphs },
          }
        },
      }],
    ]),
    participant: {
      create({ handle, browserSessionId }) {
        return new ManagerRendererCommandPeer({
          scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'fixture', generation: 'generation' },
          identity: {
            appId: 'codex',
            adapterId: 'manager',
            rendererId: handle.rendererId,
            pid: gateway.pid,
            processStartedAt: gateway.processStartedAt,
          },
          sessionId: browserSessionId,
        })
      },
      attach: async () => {},
    },
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => ownerCurrent,
    request: async operation => {
      if (
        interruptNextStatus && operation.kind === 'manager-renderer' && operation.action === 'call'
        && operation.channel === 'manager-bootstrap' && operation.payload !== null
        && typeof operation.payload === 'object' && 'action' in operation.payload
        && operation.payload.action === 'status'
      ) {
        interruptNextStatus = false
        interruptedStatuses++
        throw new Error('temporary owner RPC transport failure')
      }
      return await dispatchManagerRendererOperation(authority, operation)
    },
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (route: string, data: unknown, token?: string) => {
    const response = await fetch(`${origin}${route}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    })
    return { status: response.status, body: await response.json() }
  }
  const open = async (url: string) => {
    const token = (await post('/api/session', { token: new URL(url).hash.slice(1) })).body.token as string
    const opened = await post('/api/renderer/open', {}, token)
    expect(opened.body).toMatchObject({ status: 'ok', commands: true })
    expect(await post('/api/renderer/session', {}, token)).toMatchObject({
      status: 200,
      body: { current: true, rendererId: opened.body.rendererId },
    })
    return token
  }
  try {
    const html = await (await fetch(`${origin}/?host=1`)).text()
    expect(html).toContain('/manager-standalone.js')
    expect(html).not.toContain('/manager.js')
    expect((await fetch(`${origin}/manager-resource-worker.js`)).status).toBe(200)
    const first = await open(web.url)
    const second = await open(web.issueUrl())
    expect(await post('/api/renderer/bootstrap', { graphs: [privateGraph] }, first)).toMatchObject({ status: 400 })
    const firstBootstrap = await post('/api/renderer/bootstrap', {}, first)
    const secondBootstrap = await post('/api/renderer/bootstrap', {}, second)
    expect(firstBootstrap.status).toBe(200)
    expect(secondBootstrap.status).toBe(200)
    const firstGraph = firstBootstrap.body.initialGraphs[0]
    const secondGraph = secondBootstrap.body.initialGraphs[0]
    expect(firstGraph.baseUrl).not.toBe(secondGraph.baseUrl)
    for (const hidden of [lease.baseUrl, lease.leaseId, gateway.instanceToken, first]) {
      expect(JSON.stringify(firstBootstrap.body)).not.toContain(hidden)
    }
    const fetchResource = (token: string, url: string) => fetch(url, { headers: { authorization: `Bearer ${token}` } })
    expect(await (await fetchResource(first, `${origin}/api/renderer/bundle.js`)).text())
      .toBe('export const ready = true')
    expect(await (await fetchResource(first, firstGraph.entryUrl)).text()).toBe(fixture.source)
    expect((await fetchResource(second, firstGraph.entryUrl)).status).toBe(404)
    interruptNextStatus = true
    expect(await post('/api/renderer/session', {}, second)).toMatchObject({
      status: 200,
      body: { current: true },
    })
    expect(interruptedStatuses).toBe(1)
    expect((await fetchResource(second, secondGraph.entryUrl)).status).toBe(200)
    expect((await fetch(`${origin}/api/renderer/bundle.js`)).status).toBe(401)
    expect(await post('/api/renderer/close', {}, first)).toMatchObject({ status: 200, body: { closed: true } })
    expect(await post('/api/renderer/close', {}, first)).toMatchObject({ status: 200, body: { closed: true } })
    expect((await fetchResource(first, firstGraph.entryUrl)).status).toBe(401)
    expect((await fetchResource(second, secondGraph.entryUrl)).status).toBe(200)
    const credentialSession = await open(web.issueUrl())
    expect(
      await post('/api/renderer/binding', {
        channel: 'channel-credentials',
        payload: JSON.stringify({ requestId: 'capture', operation: 'capture' }),
      }, credentialSession),
    ).toMatchObject({ status: 200, body: { value: { status: 'applied' } } })
    expect(
      await post('/api/renderer/binding', {
        channel: 'channel-credentials',
        payload: JSON.stringify({ requestId: 'commit', operation: 'commit' }),
      }, credentialSession),
    ).toMatchObject({ status: 503, body: { error: 'OPERATION_RESULT_UNKNOWN' } })
    expect((await post('/api/renderer/session', {}, credentialSession)).status).toBe(401)
    ownerCurrent = false
    expect((await fetchResource(second, `${origin}/api/renderer/bundle.js`)).status).toBe(401)
  } finally {
    authority.dispose()
    await web.close()
    await fixture.close()
  }
}, 30_000)

it('retires a Manager when a credential write loses its browser response', async () => {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => entered = resolve)
  const finished = new Promise<void>(resolve => release = resolve)
  const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    channels: new Map([
      ['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }],
      ['channel-credentials', {
        prepare: () => ({
          mode: 'write' as const,
          dispatch: async () => {
            entered()
            await finished
            return { requestId: 'capture', ok: true }
          },
        }),
      }],
    ]),
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => true,
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const post = async (route: string, data: unknown, token?: string, signal?: AbortSignal) =>
    await fetch(`${origin}${route}`, {
      method: 'POST',
      signal,
      headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data),
    })
  try {
    const session = await post('/api/session', { token: new URL(web.url).hash.slice(1) })
    const token = (await session.json() as { token: string }).token
    expect((await post('/api/renderer/open', {}, token)).status).toBe(200)
    const abort = new AbortController()
    const pending = post(
      '/api/renderer/binding',
      {
        channel: 'channel-credentials',
        payload: JSON.stringify({ requestId: 'capture', operation: 'capture' }),
      },
      token,
      abort.signal,
    ).catch(() => undefined)
    await started
    abort.abort()
    await pending
    await expect.poll(() => authority.mutationAvailability(), { timeout: 5_000 }).not.toBe('available')
    release()
    expect((await post('/api/renderer/session', {}, token)).status).toBe(401)
  } finally {
    release()
    authority.dispose()
    await web.close()
  }
}, 15_000)

it.each(['channel-credentials', 'desktop-package-config'] as const)(
  'retires a Manager when the owner transport fails during a %s write',
  async channel => {
    const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: secret() }
    const authority = new ManagerRendererSessions({
      profileId: 'fixture',
      ownerGeneration: 'generation',
      ownerCurrent: () => true,
      authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
      channels: new Map([
        ['plugin-management', {
          prepare: () => {
            throw new Error('unused')
          },
        }],
        [channel, { prepare: () => ({ mode: 'write' as const, dispatch: async () => ({}) }) }],
      ]),
    })
    const web = await startManagerWeb({
      appId: 'codex',
      profileId: 'fixture',
      generation: 'generation',
      isCurrent: async () => true,
      request: async operation => {
        if (operation.kind === 'manager-renderer' && operation.action === 'call') {
          throw new Error('synthetic transport failure')
        }
        return await dispatchManagerRendererOperation(authority, operation)
      },
    }, { rendererGateway: gateway })
    const origin = new URL(web.url).origin
    const post = async (route: string, data: unknown, token?: string) =>
      await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(data),
      })
    try {
      const session = await post('/api/session', { token: new URL(web.url).hash.slice(1) })
      const token = (await session.json() as { token: string }).token
      expect((await post('/api/renderer/open', {}, token)).status).toBe(200)
      const result = await post('/api/renderer/binding', {
        channel,
        payload: JSON.stringify({ requestId: 'commit', operation: 'commit' }),
      }, token)
      expect(result.status).toBe(503)
      expect(await result.json()).toEqual({ error: 'OPERATION_RESULT_UNKNOWN' })
      expect((await post('/api/renderer/session', {}, token)).status).toBe(401)
    } finally {
      authority.dispose()
      await web.close()
    }
  },
  15_000,
)
