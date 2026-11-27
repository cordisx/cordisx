import { expect, it } from 'vitest'
import { RendererLifecycleFederation } from '../packages/cli/src/launcher/renderer-lifecycle-federation.js'
import type { AttachedRendererPeer } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

it('preflights the full dependency closure while requiring the target to change', async () => {
  const base = {
    id: 'base',
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}` as const,
    moduleGeneration: 'base-1',
    enabled: false,
    dependencies: [],
  }
  const dependent = {
    id: 'dependent',
    version: '1.0.0',
    digest: `sha256:${'b'.repeat(64)}` as const,
    moduleGeneration: 'dependent-1',
    enabled: false,
    dependencies: [{ id: 'base', version: '1.0.0' }],
  }
  const active = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: 'active' as const,
    profileId: 'default',
    revision: 3,
    lastGoodRevision: 3,
    runtimeGeneration: 'owner',
    plugins: [base, dependent],
  }
  const candidate = {
    ...active,
    recordKind: 'candidate' as const,
    transactionId: 'enable-1',
    revision: 4,
    plugins: [{ ...base, enabled: true, moduleGeneration: 'base-2' }, dependent],
  }
  const scope = { homeDigest: 'c'.repeat(64), ownerAppId: 'codex', profileId: 'default', generation: 'owner' }
  const impacts: string[][] = []
  const federation = new RendererLifecycleFederation({
    scope,
    active,
    registryEpoch: 0,
    projectMutation: mutation => {
      impacts.push([...mutation.affectedPluginIds])
      return {}
    },
  })
  const peer: AttachedRendererPeer = {
    scope,
    identity: { appId: 'codex', adapterId: 'manager', rendererId: 'seat', pid: 1, processStartedAt: 'fixture' },
    sessionId: 'd'.repeat(64),
    closed: false,
    request: async (_method, payload) => payload,
    onDisconnect: () => () => {},
    close: () => {},
  }
  await federation.attach(peer)
  await federation.preflight({
    transactionId: 'enable-1',
    operation: 'enable',
    previous: active,
    candidate,
    targetId: 'base',
  })
  expect(impacts).toEqual([['base', 'dependent']])
  federation.cancelPreflight('enable-1')
  await expect(federation.preflight({
    transactionId: 'enable-1',
    operation: 'enable',
    previous: active,
    candidate: { ...candidate, plugins: [base, { ...dependent, moduleGeneration: 'dependent-2' }] },
    targetId: 'base',
  })).rejects.toThrow('candidate has no target change')
})
