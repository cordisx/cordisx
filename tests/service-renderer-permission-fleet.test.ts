import { expect, it, vi } from 'vitest'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'
import { synchronizeServiceRendererPolicies } from '../packages/cli/src/cli/service-renderer-permission-fleet.js'
import type { CordisXPersistedPermissionPolicyRecord } from '../packages/cli/src/permission-persistence.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
const originalSource = 'file:///fixture-private/channel'
function fixture(pluginId = 'channel') {
  const [policy] = exactDomPermissionPolicies(scope.profileId, [{
    id: pluginId,
    entry: '/fixture.js',
    pointIds: ['manager.content'],
  }])
  const candidate = [{
    ...policy!,
    key: { ...policy!.key, identity: { ...policy!.key.identity, source: originalSource } },
  }]
  const peers = ['1', '2'].map((digit) =>
    new ManagerRendererCommandPeer({
      scope,
      identity: {
        appId: 'manager',
        adapterId: 'independent-manager',
        rendererId: digit.repeat(64),
        pid: 42,
        processStartedAt: 'fixture',
      },
      sessionId: digit.repeat(64),
    })
  )
  let current = true
  const fence = vi.fn(() => {
    current = false
    for (const peer of peers) peer.close()
  })
  const targets = peers.map((peer, index) => {
    const identity = {
      id: pluginId,
      source: `https://renderer.cordisx.invalid/plugin/${String(index + 3).repeat(64)}`,
    }
    return {
      peer,
      origin: false,
      project: (records: readonly CordisXPersistedPermissionPolicyRecord[]) => ({
        identity,
        moduleGeneration: `channel-${index + 1}`,
        policies: records.map(record => ({
          ...record,
          key: { ...record.key, identity: { ...record.key.identity, source: identity.source } },
        })),
      }),
    }
  })
  const run = () =>
    synchronizeServiceRendererPolicies({
      scope,
      peers: targets,
      requestId: 'request-1',
      expected: [],
      updates: candidate,
      candidate,
      isCurrent: () => current,
      fence,
    })
  return { peers, targets, fence, run, invalidate: () => current = false }
}

function acknowledge(peer: ManagerRendererCommandPeer, command: NonNullable<Awaited<ReturnType<typeof peer.next>>>) {
  const payload = command.payload as { handoffId: string; moduleGeneration: string }
  return peer.acknowledge({
    id: command.id,
    sequence: command.sequence,
    ok: true,
    value: {
      rendererId: peer.identity.rendererId,
      ownerGeneration: scope.generation,
      handoffId: payload.handoffId,
      requestId: 'request-1',
      moduleGeneration: payload.moduleGeneration,
      adopted: true,
    },
  })
}

it('waits for each scoped Manager receipt and never sends the owner source', async () => {
  const f = fixture()
  try {
    let settled = false
    const pending = f.run().then(result => {
      settled = true
      return result
    })
    const commands = await Promise.all(f.peers.map(async peer => await peer.next()))
    expect(commands.map(command => command?.method)).toEqual(['permission-policy', 'permission-policy'])
    expect(JSON.stringify(commands)).not.toContain(originalSource)
    expect((commands[0]!.payload as { identity: unknown }).identity).not.toEqual(
      (commands[1]!.payload as { identity: unknown }).identity,
    )
    expect(acknowledge(f.peers[0]!, commands[0]!)).toBe(true)
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(acknowledge(f.peers[1]!, commands[1]!)).toBe(true)
    expect(await pending).toBe(true)
    expect(f.fence).not.toHaveBeenCalled()
  } finally {
    for (const peer of f.peers) peer.close()
  }
})

it('delivers an installed plugin decision through each renderer alias and waits for both receipts', async () => {
  const f = fixture('fixture-service')
  try {
    const pending = f.run()
    const commands = await Promise.all(f.peers.map(async peer => await peer.next()))
    expect(commands.map(command => (command?.payload as { identity: { id: string } }).identity.id))
      .toEqual(['fixture-service', 'fixture-service'])
    expect(JSON.stringify(commands)).not.toContain(originalSource)
    expect(acknowledge(f.peers[0]!, commands[0]!)).toBe(true)
    expect(acknowledge(f.peers[1]!, commands[1]!)).toBe(true)
    expect(await pending).toBe(true)
  } finally {
    for (const peer of f.peers) peer.close()
  }
})

it('fences the reservation when a peer reports the wrong policy generation', async () => {
  const f = fixture()
  const pending = f.run()
  const commands = await Promise.all(f.peers.map(async peer => await peer.next()))
  expect(acknowledge(f.peers[0]!, commands[0]!)).toBe(true)
  const command = commands[1]!
  expect(f.peers[1]!.acknowledge({
    id: command.id,
    sequence: command.sequence,
    ok: true,
    value: {
      rendererId: f.peers[1]!.identity.rendererId,
      ownerGeneration: scope.generation,
      handoffId: (command.payload as { handoffId: string }).handoffId,
      requestId: 'request-1',
      moduleGeneration: 'wrong-generation',
      adopted: true,
    },
  })).toBe(true)
  expect(await pending).toBe(false)
  expect(f.fence).toHaveBeenCalledOnce()
  expect(f.peers.every(peer => peer.closed)).toBe(true)
})

it('fences an invalidated reservation even after both pages acknowledge', async () => {
  const f = fixture()
  const pending = f.run()
  const commands = await Promise.all(f.peers.map(async peer => await peer.next()))
  expect(acknowledge(f.peers[0]!, commands[0]!)).toBe(true)
  f.invalidate()
  expect(acknowledge(f.peers[1]!, commands[1]!)).toBe(true)
  expect(await pending).toBe(false)
  expect(f.fence).toHaveBeenCalledOnce()
})
