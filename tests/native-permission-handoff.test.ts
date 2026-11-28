import { expect, it, vi } from 'vitest'
import { fenceAdapterOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { ServiceOwnerPermissionConsumers } from '../packages/cli/src/cli/service-owner-permission-consumers.js'
import { reserveServiceRendererPermissionHandoff } from '../packages/cli/src/cli/service-renderer-permission-handoff.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

it.each([false, true])('checks native-only policy inputs through the write (changed: %s)', async changed => {
  const profileId = 'default'
  const generation = 'owner-1'
  const rendererId = 'a'.repeat(64)
  const identity = { id: 'demo', source: 'file:///demo.js' }
  const [record] = exactDomPermissionPolicies(profileId, [{
    id: identity.id,
    entry: '/demo.js',
    pointIds: ['manager.content'],
  }])
  const update = { ...record!, key: { ...record!.key, identity: { pluginId: identity.id, source: identity.source } } }
  let policies: typeof update[] = []
  let configuredCurrent = true
  const peer = {
    identity: { rendererId },
    scope: { homeDigest: 'b'.repeat(64), ownerAppId: 'codex', profileId, generation },
    closed: false,
    onDisconnect: () => () => {},
  }
  const writes = { isCurrent: () => true, release: vi.fn(() => true), fence: vi.fn() }
  const adapters = { peers: [peer], originRendererId: rendererId, ...writes }
  const lifecycle = {
    snapshot: () => ({ active: 'current' }),
    reserveExternalMutation: () => ({ isCurrent: () => true, release: () => true, fence: () => {} }),
    terminal: vi.fn(),
  }
  const participants = {
    isBoundTo: () => true,
    ownerPeers: () => [],
    peer: () => undefined,
    isLive: () => true,
    disconnectAll: vi.fn(),
  }
  const sessions = { suspendMutations: async () => writes, hasAdmittedPeer: () => true }
  const origin = await fenceAdapterOrigin({
    sessions: sessions as never,
    participants: participants as never,
    lifecycle: lifecycle as never,
    originRendererId: rendererId,
    reserveAdditionalPeers: async () => adapters as never,
  })
  const target = {
    kind: 'configured-plugin' as const,
    identity,
    ownerIdentity: identity,
    moduleGeneration: 'module-1',
    digest: `sha256:${'c'.repeat(64)}` as const,
    artifact: { version: '1.0.0', integrity: `sha256:${'c'.repeat(64)}` as const },
    isCurrent: () => true,
    verifyCurrent: async () => configuredCurrent,
    project: (records: readonly typeof update[]) => ({ identity, moduleGeneration: 'module-1', policies: records }),
    resolve: (records: readonly typeof update[]) => records,
  }
  const consumers = {
    isCurrent: () => true,
    adopt: async (input: { candidate: readonly typeof update[]; requestId: string }) => ({
      profileId,
      ownerGeneration: generation,
      requestId: input.requestId,
      adopted: true,
      candidate: input.candidate,
    }),
    release: vi.fn(() => true),
    fence: vi.fn(),
  }
  const barrier = await reserveServiceRendererPermissionHandoff(
    {
      profileId,
      generation,
      channel: undefined,
      permissionFence: { runPolicyMutation: async (_input: unknown, action: () => Promise<unknown>) => await action() },
      entries: new Map(),
      participants,
      lifecycle,
      readLifetimes: {},
      policies: async () => policies,
      current: () => true,
      target: () => target,
    } as never,
    origin,
    { profileId, ownerGeneration: generation, rendererId, signal: new AbortController().signal, admitted: true },
    'native-request',
    [],
    [update],
    consumers as never,
    target as never,
  )
  const writing = barrier.run(async () => {
    policies = [update]
    if (changed) configuredCurrent = false
  })
  if (changed) {
    await expect(writing).rejects.toThrow('renderer-permission-handoff-unavailable')
    expect(consumers.fence).toHaveBeenCalledOnce()
    return
  }
  await writing
  expect(await barrier.complete(policies)).toBe(true)
  expect(writes.release).toHaveBeenCalled()
  expect(consumers.release).toHaveBeenCalledOnce()
  expect(consumers.fence).not.toHaveBeenCalled()
})

it.each([false, true])('checks the configured native writer graph (mismatch: %s)', async mismatch => {
  const rendererId = 'a'.repeat(64)
  const identity = { id: 'channel', source: 'https://example.test/channel' }
  const artifact = { version: '1.0.0', integrity: `sha256:${'c'.repeat(64)}` as const }
  const snapshot = { active: 'current', registryEpoch: 1 }
  const peer = {
    identity: { rendererId },
    closed: false,
    onDisconnect: () => () => {},
    request: async () => ({
      available: true,
      rendererId,
      ownerGeneration: 'owner-1',
      snapshot,
      identity,
      artifact,
      moduleGeneration: 'other-graph',
    }),
  }
  const writes = { isCurrent: () => true, release: () => true, fence: () => {} }
  const lifecycle = {
    snapshot: () => snapshot,
    reserveExternalMutation: () => ({ isCurrent: () => true, release: () => true, fence: () => {} }),
    terminal: () => {},
  }
  const participants = { isBoundTo: () => true, ownerPeers: () => [], peer: () => undefined, isLive: () => true }
  const origin = await fenceAdapterOrigin({
    sessions: { suspendMutations: async () => writes, hasAdmittedPeer: () => true } as never,
    participants: participants as never,
    lifecycle: lifecycle as never,
    originRendererId: rendererId,
    reserveAdditionalPeers: async () => ({ peers: [peer], originRendererId: rendererId, ...writes }) as never,
  })
  const consumers = new ServiceOwnerPermissionConsumers({
    profileId: 'default',
    generation: 'owner-1',
    participants: participants as never,
    lifecycle: lifecycle as never,
    nativeAdapters: {} as never,
    ownerCurrent: () => true,
    loadPolicies: async () => [],
  })
  const reservation = consumers.reserve(origin, {
    identity,
    moduleGeneration: mismatch ? 'signed-graph' : 'other-graph',
    kind: 'configured-channel',
    artifact,
    isCurrent: () => true,
  })
  if (mismatch) {
    await expect(reservation.prepare()).rejects.toThrow('service-permission-consumers-unavailable')
    expect(reservation.isCurrent()).toBe(false)
  } else {
    await reservation.prepare()
    expect(reservation.isCurrent()).toBe(true)
    reservation.fence()
  }
  origin.fence()
  consumers.close()
})
