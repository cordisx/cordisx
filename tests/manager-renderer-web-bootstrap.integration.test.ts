import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { encodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { managerRendererGraphFixture } from './fixtures/manager-renderer-graph.js'

const secret = () => randomBytes(32).toString('hex')

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
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
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
    expect((await fetch(`${origin}/api/renderer/bundle.js`)).status).toBe(401)
    expect(await post('/api/renderer/close', {}, first)).toMatchObject({ status: 200, body: { closed: true } })
    expect(await post('/api/renderer/close', {}, first)).toMatchObject({ status: 200, body: { closed: true } })
    expect((await fetchResource(first, firstGraph.entryUrl)).status).toBe(401)
    expect((await fetchResource(second, secondGraph.entryUrl)).status).toBe(200)
    ownerCurrent = false
    expect((await fetchResource(second, `${origin}/api/renderer/bundle.js`)).status).toBe(401)
  } finally {
    authority.dispose()
    await web.close()
    await fixture.close()
  }
}, 30_000)
