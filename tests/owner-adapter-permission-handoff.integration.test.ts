import { expect, it } from 'vitest'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { OwnerAdapterSessions } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { ServiceOwnerPermissionConsumers } from '../packages/cli/src/cli/service-owner-permission-consumers.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { verifyOwnerPolicyPacket } from '../packages/cli/src/renderer/owner-policy-verification.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

it('fences both cohorts and applies an owner-signed policy before either can resume', async () => {
  const profileId = 'default'
  const generation = 'owner-1'
  const identity = { id: 'channel', source: 'https://example.com/channel' }
  const active = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active' as const,
    profileId,
    runtimeGeneration: generation,
    revision: 0,
    lastGoodRevision: 0,
    plugins: [],
  }
  const native = new OwnerAdapterSessions({
    scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId, generation },
    adapter: { appId: 'codex', adapterId: 'codex-desktop' },
    snapshot: () => ({ active, registryEpoch: 0 }),
    attach: async () => {},
    ownerCurrent: () => true,
    identify: async () => 'alive',
  })
  const managerPeer = { identity: { rendererId: 'manager' }, onDisconnect: () => () => {}, closed: false }
  const writes = { rendererId: 'manager', isCurrent: () => true, release: () => true, fence: () => {} }
  const lifecycle = {
    reserveExternalMutation: (peers: readonly unknown[]) => {
      expect(peers).toHaveLength(2)
      return { isCurrent: () => true, release: () => true, fence: () => {} }
    },
    terminal: () => {},
  }
  const participants = {
    isBoundTo: () => true,
    ownerPeers: () => [managerPeer],
    peer: () => managerPeer,
    isLive: () => true,
  }
  const sessions = { suspendMutationsForCurrentWrite: async () => writes, hasAdmittedPeer: () => true }
  const [raw] = exactDomPermissionPolicies(profileId, [{
    id: identity.id,
    entry: '/fixture.js',
    pointIds: ['manager.content'],
  }])
  const update = { ...raw!, key: { ...raw!.key, identity: { pluginId: identity.id, source: identity.source } } }
  const policies = [update]
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    profileId,
    generation,
  )
  broker.register(
    identity,
    normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: identity.id,
      capabilities: [],
      services: [],
    }, identity.id),
    { pluginId: identity.id, moduleGeneration: 'module-1' },
  )
  try {
    const opened = (await native.open({ pid: 123, processStartedAt: 'test' }))!
    expect(await native.admit(opened.sessionId, opened.grant)).toBe(true)
    const origin = await fenceManagerOrigin({
      sessions: sessions as never,
      participants: participants as never,
      lifecycle: lifecycle as never,
      reserveAdditionalPeers: async () => await native.reserveForLifecycle(),
    })
    const consumers = new ServiceOwnerPermissionConsumers({
      profileId,
      generation,
      participants: participants as never,
      lifecycle: lifecycle as never,
      nativeAdapters: native,
      ownerCurrent: () => true,
      loadPolicies: async () => policies,
    })
    const fence = consumers.reserve(origin, { identity, moduleGeneration: 'module-1', isCurrent: () => true })
    const adoption = fence.adopt({
      profileId,
      ownerGeneration: generation,
      requestId: 'review-1',
      expected: [],
      updates: policies,
      candidate: policies,
    }, new AbortController().signal)
    const polled = await native.poll(opened.sessionId, opened.grant, 1_000)
    const command = polled!.command!
    expect(command.method).toBe('permission-policy')
    const transition = await verifyOwnerPolicyPacket(command.payload, {
      profileId,
      generation,
      rendererId: opened.rendererId,
      key: opened.policyPublicKey,
    })
    expect(transition).toMatchObject({ identity, expected: [], updates: policies, candidate: policies })
    expect(await broker.adoptOwnerManagerPolicies(transition!)).toBe(true)
    expect(
      await native.acknowledge(opened.sessionId, opened.grant, {
        id: command.id,
        sequence: command.sequence,
        ok: true,
        value: {
          rendererId: opened.rendererId,
          ownerGeneration: generation,
          handoffId: transition!.handoffId,
          requestId: 'review-1',
          moduleGeneration: 'module-1',
          adopted: true,
        },
      }),
    ).toBe(true)
    expect(await adoption).toMatchObject({ adopted: true, candidate: policies })
    expect(broker.domAccess(identity, 'manager.content')).toMatchObject({ authorized: true, policy: 'allow' })
    expect(origin.release()).toBe(true)
    expect(fence.release()).toBe(true)
    consumers.close()
  } finally {
    broker.dispose()
    native.close()
  }
})
