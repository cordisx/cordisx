import { randomBytes } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { ManagerRendererSessions } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { dispatchManagerRendererOperation } from '../packages/cli/src/cli/manager-renderer-rpc.js'

const secret = () => randomBytes(32).toString('hex')

it('binds lifecycle commands and receipts to one authenticated browser session', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture-start', instanceToken: secret() }
  const peers: ManagerRendererCommandPeer[] = []
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async input => JSON.stringify(input) === JSON.stringify(gateway),
    channels: new Map([
      ['plugin-management', {
        prepare: () => {
          throw new Error('unused')
        },
      }],
      ['manager-bootstrap', {
        prepare: () => ({ mode: 'read', dispatch: async () => ({ status: 'ok', current: true }) }),
      }],
    ]),
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
      async attach(peer) {
        const reply = await peer.request('synchronize', { active: 'fixture', registryEpoch: 0 })
        if (JSON.stringify(reply) !== JSON.stringify({ active: 'fixture', registryEpoch: 0 })) {
          throw new Error('snapshot mismatch')
        }
      },
    },
  })
  const web = await startManagerWeb({
    appId: 'codex',
    profileId: 'fixture',
    generation: 'generation',
    isCurrent: async () => true,
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
  try {
    const first = await exchange(web.url)
    const second = await exchange(web.issueUrl())
    const firstOpen = await post(first, 'open', {})
    const secondOpen = await post(second, 'open', {})
    expect(firstOpen.body).toMatchObject({ status: 'ok', commands: true, generation: 'generation' })
    expect(secondOpen.body.rendererId).not.toBe(firstOpen.body.rendererId)
    expect(firstOpen.body).not.toHaveProperty('grant')
    expect(firstOpen.body).not.toHaveProperty('gateway')
    expect(await post(first, 'poll', { timeoutMs: 10, gateway })).toMatchObject({ status: 400 })

    // Matches the production lifecycle pump's poll interval.
    const firstPoll = post(first, 'poll', { timeoutMs: 15_000, pollSequence: 1 })
    const secondPoll = post(second, 'poll', { timeoutMs: 2_000 })
    const firstAdmit = post(first, 'admit', {})
    const secondAdmit = post(second, 'admit', {})
    const firstCommand = (await firstPoll).body.command
    const secondCommand = (await secondPoll).body.command
    expect(firstCommand).toMatchObject({ method: 'synchronize', sequence: 1 })
    expect(secondCommand).toMatchObject({ method: 'synchronize', sequence: 1 })
    expect(firstCommand.id).not.toBe(secondCommand.id)
    const firstReceipt = {
      id: firstCommand.id,
      sequence: firstCommand.sequence,
      ok: true,
      value: firstCommand.payload,
    }
    expect(await post(second, 'acknowledge', { receipt: firstReceipt })).toMatchObject({ status: 503 })
    expect(await post(first, 'acknowledge', { receipt: firstReceipt })).toMatchObject({
      status: 200,
      body: { accepted: true },
    })
    expect(
      await post(second, 'acknowledge', {
        receipt: { id: secondCommand.id, sequence: secondCommand.sequence, ok: true, value: secondCommand.payload },
      }),
    ).toMatchObject({ status: 200, body: { accepted: true } })
    expect(await firstAdmit).toMatchObject({ status: 200, body: { admitted: true } })
    expect(await secondAdmit).toMatchObject({ status: 200, body: { admitted: true } })
    expect(await post(first, 'acknowledge', { receipt: firstReceipt })).toMatchObject({ status: 503 })

    // A request lost before reaching the sidecar is retired by sequence; a
    // late copy cannot accidentally dispatch a second owner poll.
    expect(await post(first, 'poll-recover', { pollSequence: 2 })).toMatchObject({
      status: 200,
      body: { recovered: true },
    })
    expect(await post(first, 'poll', { timeoutMs: 10, pollSequence: 2 })).toMatchObject({ status: 409 })
    const emptyPoll = post(first, 'poll', { timeoutMs: 100, pollSequence: 3 })
    const recovery = post(first, 'poll-recover', { pollSequence: 3 })
    expect(await emptyPoll).toMatchObject({ status: 200, body: { command: null } })
    expect(await recovery).toMatchObject({ status: 200, body: { recovered: true } })

    const pending = peers[0]!.request('prepare', {
      transactionId: 'fixture-tx',
      transactionEpoch: 'fixture-epoch',
      expectedRegistryEpoch: 0,
    })
    const rejected = expect(pending).rejects.toThrow('renderer-command-result-unknown')
    const command = (await post(first, 'poll', { timeoutMs: 2_000, pollSequence: 4 })).body.command
    expect(command).toMatchObject({ method: 'prepare', sequence: 2 })
    // A command was offered, so it must never be replayed by poll recovery.
    expect(await post(first, 'poll-recover', { pollSequence: 4 })).toMatchObject({
      status: 200,
      body: { recovered: false },
    })
    await web.close()
    await rejected
    expect(peers[0]!.closed).toBe(true)
    expect(peers[1]!.closed).toBe(true)
  } finally {
    authority.dispose()
    await web.close().catch(() => undefined)
    vi.restoreAllMocks()
  }
}, 30_000)

it('rejects an owner participant whose renderer identity does not match the authenticated session', async () => {
  const gateway = { pid: 42, processStartedAt: 'fixture-start', instanceToken: secret() }
  let created: ManagerRendererCommandPeer | undefined
  const authority = new ManagerRendererSessions({
    profileId: 'fixture',
    ownerGeneration: 'generation',
    ownerCurrent: () => true,
    authenticateGateway: async () => true,
    participant: {
      create({ browserSessionId }) {
        created = new ManagerRendererCommandPeer({
          scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'fixture', generation: 'generation' },
          identity: {
            appId: 'codex',
            adapterId: 'manager',
            rendererId: secret(),
            pid: gateway.pid,
            processStartedAt: gateway.processStartedAt,
          },
          sessionId: browserSessionId,
        })
        return created
      },
      attach: async () => {},
    },
  })
  try {
    expect(await authority.open(gateway, secret())).toBeUndefined()
    expect(created?.closed).toBe(true)
  } finally {
    authority.dispose()
  }
})
