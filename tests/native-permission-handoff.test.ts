import { expect, it, vi } from 'vitest'
import { fenceAdapterOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { ServiceOwnerPermissionConsumers } from '../packages/cli/src/cli/service-owner-permission-consumers.js'
import { reserveServiceRendererPermissionHandoff } from '../packages/cli/src/cli/service-renderer-permission-handoff.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

vi.mock('../packages/cli/src/cli/service-renderer-permission-inputs.js', () => ({
  serviceRendererPermissionInputsCurrent: async () => true,
}))

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

it.each([false, true])(
  'only skips an unavailable Web placeholder without a graph lease (lease: %s)',
  async hasLease => {
    const profileId = 'default', generation = 'owner-1', rendererId = 'a'.repeat(64), webId = 'd'.repeat(64)
    const identity = { id: 'demo', source: 'file:///demo.js' }
    const digest = `sha256:${'c'.repeat(64)}` as const
    const item = { id: identity.id, digest, enabled: true, moduleGeneration: 'module-1' }
    const snapshot = { active: { plugins: [item] }, registryEpoch: 1 }
    const [raw] = exactDomPermissionPolicies(profileId, [{
      id: identity.id,
      entry: '/demo.js',
      pointIds: ['manager.content'],
    }])
    const update = { ...raw!, key: { ...raw!.key, identity: { pluginId: identity.id, source: identity.source } } }
    const alias = `https://renderer.cordisx.invalid/plugin/${'e'.repeat(64)}`
    const webPeer = {
      identity: { rendererId: webId },
      closed: false,
      onDisconnect: () => () => {},
      close: vi.fn(),
      request: vi.fn(),
    }
    const nativePeer = {
      identity: { rendererId },
      scope: { homeDigest: 'b'.repeat(64), ownerAppId: 'codex', profileId, generation },
      closed: false,
      onDisconnect: () => () => {},
    }
    const binding = { rendererId: webId }
    const entry = {
      peer: webPeer,
      bootstrapConfirmed: true,
      policies: [] as unknown[],
      snapshot,
      checks: [],
      leases: hasLease ? [{ pluginId: identity.id }] : [],
      identityContext: binding,
      identityAliases: new Map([[identity.id, alias]]),
      identity: { resolveLifecycle: () => ({ source: identity.source, digest }) },
      unavailableInstalledPlugins: new Set([identity.id]),
    }
    const writes = { isCurrent: () => true, release: () => true, fence: vi.fn() }
    const lifecycle = {
      snapshot: () => snapshot,
      reserveExternalMutation: () => ({ isCurrent: () => true, release: () => true, fence: () => {} }),
      terminal: vi.fn(),
    }
    const participants = {
      isBoundTo: () => true,
      ownerPeers: () => [webPeer],
      peer: (id: string) => id === webId ? webPeer : undefined,
      isLive: () => true,
      disconnectAll: vi.fn(),
    }
    const origin = await fenceAdapterOrigin({
      sessions: { suspendMutations: async () => writes, hasAdmittedPeer: () => true } as never,
      participants: participants as never,
      lifecycle: lifecycle as never,
      originRendererId: rendererId,
      reserveAdditionalPeers: async () => ({ peers: [nativePeer], originRendererId: rendererId, ...writes }) as never,
    })
    const target = {
      kind: 'installed' as const,
      identity,
      ownerIdentity: identity,
      moduleGeneration: item.moduleGeneration,
      digest,
      artifact: { version: '1.0.0', integrity: digest },
      isCurrent: () => true,
      project: (records: readonly typeof update[]) => ({
        identity,
        moduleGeneration: item.moduleGeneration,
        policies: records,
      }),
      resolve: (records: readonly typeof update[]) => records,
    }
    let policies: readonly typeof update[] = []
    const consumers = {
      isCurrent: () => true,
      adopt: async (value: { requestId: string; candidate: readonly typeof update[] }) => ({
        profileId,
        ownerGeneration: generation,
        requestId: value.requestId,
        adopted: true,
        candidate: value.candidate,
      }),
      release: () => true,
      fence: vi.fn(),
    }
    const reserve = () =>
      reserveServiceRendererPermissionHandoff(
        {
          profileId,
          generation,
          channel: undefined,
          permissionFence: {
            runPolicyMutation: async (_input: unknown, action: () => Promise<unknown>) => await action(),
          },
          entries: new Map([[webId, entry]]),
          participants,
          lifecycle,
          readLifetimes: { drainCurrent: async () => true },
          policies: async () => policies,
          current: () => true,
          target: () => {
            throw new Error('placeholder must not receive policy')
          },
        } as never,
        origin,
        {
          profileId,
          ownerGeneration: generation,
          rendererId,
          signal: new AbortController().signal,
          admitted: true,
        },
        'native-request',
        [],
        [update],
        consumers as never,
        target as never,
      )
    if (hasLease) {
      await expect(reserve()).rejects.toThrow('renderer-permission-handoff-unavailable')
      expect(consumers.fence).toHaveBeenCalled()
      return
    }
    const barrier = await reserve()
    await barrier.run(async () => {
      policies = [update]
    })
    expect(await barrier.complete(policies)).toBe(true)
    expect(entry.policies).toEqual([update])
    expect(webPeer.request).not.toHaveBeenCalled()
  },
)
