import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'
import { managerFixtureActivation, managerRendererGraphFixture } from './fixtures/manager-renderer-graph.js'

const secret = () => randomBytes(32).toString('hex')

it('projects owner stage graphs into isolated authenticated sessions and revokes stale owner reads', async () => {
  const fixture = await managerRendererGraphFixture()
  const lease = await fixture.lease('candidate')
  const gateway = { pid: 42, processStartedAt: 'fixture-start', instanceToken: secret() }
  const peers: ManagerRendererCommandPeer[] = []
  let ownerChecksUntilLoss = 0
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async value => JSON.stringify(value) === JSON.stringify(gateway),
    channels: new Map([['plugin-management', {
      prepare: () => {
        throw new Error('unused')
      },
    }]]),
    participant: {
      create({ browserSessionId, handle }) {
        const peer = new ManagerRendererCommandPeer({
          scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'fixture', generation: 'generation' },
          identity: {
            appId: 'codex',
            adapterId: 'manager',
            rendererId: handle.rendererId,
            pid: gateway.pid,
            processStartedAt: gateway.processStartedAt,
          },
          sessionId: browserSessionId,
          timeoutMs: 5_000,
        })
        peers.push(peer)
        return peer
      },
      attach: async () => {},
    },
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => ownerChecksUntilLoss === 0 || --ownerChecksUntilLoss > 0,
    request: async operation => await dispatchManagerRendererOperation(authority, operation),
  }, { rendererGateway: gateway })
  const origin = new URL(web.url).origin
  const exchange = async (link: string) => {
    const response = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: new URL(link).hash.slice(1) }),
    })
    expect(response.status).toBe(200)
    return (await response.json() as { token: string }).token
  }
  const post = async (token: string, route: string, input: unknown) => {
    const response = await fetch(`${origin}/api/renderer/${route}`, {
      method: 'POST',
      headers: { origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    return { status: response.status, body: await response.json() }
  }
  const get = async (token: string, url: string, method = 'GET') =>
    await fetch(url, { method, headers: { authorization: `Bearer ${token}` } })
  try {
    const tokens = [await exchange(web.url), await exchange(web.issueUrl())]
    const opened = [await post(tokens[0]!, 'open', {}), await post(tokens[1]!, 'open', {})]
    expect(opened.map(value => value.status)).toEqual([200, 200])
    const privateGraph = {
      leaseId: lease.leaseId,
      pluginId: lease.pluginId,
      moduleGeneration: lease.moduleGeneration,
      baseUrl: lease.baseUrl,
      entryUrl: lease.entryUrl,
      initialStyleUrls: [...lease.initialStyleUrls],
    }
    expect(await post(tokens[0]!, 'poll', { timeoutMs: 15_000, privateGraphs: [privateGraph] }))
      .toMatchObject({ status: 400 })
    const previous = managerFixtureActivation('active')
    const candidate = managerFixtureActivation('candidate', 'candidate')
    const pending = opened.map((value, index) =>
      peers[index]!.request('stage', {
        rendererId: value.body.rendererId,
        transactionId: 'transaction',
        transactionEpoch: 'transaction:epoch',
        expectedRegistryEpoch: 0,
        afterRegistryEpoch: 1,
        operation: 'install',
        previous,
        candidate,
        targetId: 'fixture',
        affectedPluginIds: ['fixture'],
        privateGraphs: [privateGraph],
      })
    )
    const commands = [
      await post(tokens[0]!, 'poll', { timeoutMs: 15_000 }),
      await post(tokens[1]!, 'poll', { timeoutMs: 15_000 }),
    ]
    expect(commands.map(value => value.status)).toEqual([200, 200])
    for (const [index, value] of commands.entries()) {
      const text = JSON.stringify(value.body)
      for (
        const hidden of [
          lease.leaseId,
          lease.baseUrl,
          new URL(lease.baseUrl).pathname.split('/')[2]!,
          gateway.instanceToken,
          tokens[index]!,
        ]
      ) expect(text).not.toContain(hidden)
      expect(value.body.command.payload).not.toHaveProperty('privateGraphs')
      expect(value.body.command.payload.graphs).toHaveLength(1)
    }
    const first = commands[0]!.body.command.payload.graphs[0]
    const second = commands[1]!.body.command.payload.graphs[0]
    expect(first.leaseId).not.toBe(lease.leaseId)
    expect(first.leaseId).not.toBe(second.leaseId)
    expect(first.baseUrl).not.toBe(second.baseUrl)
    expect(await (await get(tokens[0]!, first.entryUrl)).text()).toBe(fixture.source)
    expect((await get(tokens[1]!, first.entryUrl)).status).toBe(404)
    expect((await fetch(first.entryUrl)).status).toBe(401)
    const head = await get(tokens[0]!, first.entryUrl, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    for (let index = 0; index < 2; index++) {
      const current = commands[index]!.body.command
      expect(
        await post(tokens[index]!, 'acknowledge', {
          receipt: { id: current.id, sequence: current.sequence, ok: true, value: { staged: true } },
        }),
      ).toMatchObject({ status: 200, body: { accepted: true } })
      await expect(pending[index]).resolves.toEqual({ staged: true })
    }
    ownerChecksUntilLoss = 2
    expect((await get(tokens[0]!, first.entryUrl)).status).toBe(401)
    expect((await get(tokens[0]!, first.entryUrl)).status).toBe(401)
    expect((await get(tokens[1]!, second.entryUrl)).status).toBe(200)
  } finally {
    authority.dispose()
    await web.close()
    await fixture.close()
  }
}, 30_000)
