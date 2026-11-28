import { expect, it, vi } from 'vitest'
import { reserveServiceRendererPackageConfig } from '../packages/cli/src/cli/service-renderer-package-config-handoff.js'

vi.mock('../packages/cli/src/cli/manager-origin-fence.js', () => ({
  isCurrentManagerOriginFence: () => true,
}))

function fixture() {
  const snapshot = { active: { profileId: 'work', runtimeGeneration: 'owner-1', plugins: [] }, registryEpoch: 2 }
  const plugin = {
    id: 'demo',
    source: 'https://example.test/demo',
    enabled: true,
    revision: 0,
    configuredArchiveDigest: 'sha256:' + 'a'.repeat(64),
    distributionArtifact: { version: '1.0.0', integrity: 'sha256:' + 'b'.repeat(64) },
    config: { label: 'old', token: 'synthetic-private' },
  }
  const updated = { ...plugin, revision: 1, config: { label: 'new', token: 'synthetic-private' } }
  const proof = {
    snapshot,
    plugin: {
      id: plugin.id,
      source: plugin.source,
      configured: { ...plugin.distributionArtifact, moduleGeneration: 'archive-generation' },
      configuration: {
        namespace: plugin.id,
        schemaKind: 'schemastery',
        applies: 'live',
        writable: true,
        revision: 1,
        lastGoodRevision: 1,
        value: { label: 'new' },
        fields: [{ path: ['label'], type: 'string' }, { path: ['token'], type: 'string', role: 'secret' }],
        secrets: [{ path: ['token'], set: false }],
      },
    },
  }
  const other = { id: 'other', enabled: true, config: {} }
  const before: any = { config: { plugins: [plugin, other] }, plugins: [], policies: [], inputs: new Map() }
  const after: any = { ...before, config: { plugins: [updated, other] } }
  const peers = ['first', 'second'].map(id => {
    const peer = {
      identity: { rendererId: id },
      closed: false,
      close: vi.fn(() => peer.closed = true),
      request: vi.fn(async (_method: string, value: any) => ({
        rendererId: id,
        ownerGeneration: value.ownerGeneration,
        requestId: value.requestId,
        pluginId: value.pluginId,
        revision: value.revision,
        adopted: true,
      })),
    }
    return peer
  })
  const entries = new Map(peers.map(peer => [peer.identity.rendererId, {
    peer,
    bootstrapConfirmed: true,
    snapshot,
    config: before.config,
    plugins: [],
    policies: [],
    packageInputs: new Map(),
    projectedConfigs: new Map(),
    desktopPackageConfigPlugins: ['demo'],
    desktopLifecycleConfigPlugins: [],
    checks: new Set<Promise<boolean>>(),
    managedOwners: new Map(),
    configuredPlugins: [{
      pluginId: plugin.id,
      isCurrent: () => !peer.closed,
      permissionContext: () => ({}),
      permissionBinding: () => ({
        original: { source: plugin.source, digest: plugin.configuredArchiveDigest },
        digest: plugin.configuredArchiveDigest,
        artifact: plugin.distributionArtifact,
        lease: { pluginId: plugin.id },
      }),
    }],
  }]))
  let currentInputs = before
  const runConfiguredMutation = vi.fn(async (_scope: unknown, action: () => Promise<unknown>) => await action())
  const adoptSelectedConfiguredPlugins = vi.fn(() => true)
  const input = {
    homeDir: '/synthetic-home',
    profileId: 'work',
    entries,
    participants: { ownerPeers: () => peers },
    lifecycle: { snapshot: () => snapshot },
    readLifetimes: { drainCurrent: async () => true },
    pluginFence: { runConfiguredMutation },
    rememberPluginConfig: () => true,
    canCoordinatePluginConfig: async () => false,
    adoptSelectedConfiguredPlugins,
    readInputs: async () => currentInputs,
    current: (id: string, entry: any) => entries.get(id) === entry && !entry.peer.closed,
  }
  const origin = { rendererId: 'first', desktopConfiguration: {}, isCurrent: () => peers.every(peer => !peer.closed) }
  return {
    input,
    peers,
    entries,
    proof,
    plugin,
    after,
    runConfiguredMutation,
    adoptSelectedConfiguredPlugins,
    apply: (value: any = after) => currentInputs = value,
    reserve: async () => await reserveServiceRendererPackageConfig(input as never, origin as never, 'demo'),
  }
}

it('adopts one configured plugin edit across both Managers without disclosing its private value', async () => {
  const f = fixture()
  const handoff = await f.reserve()
  await handoff.run(async () => 'ok')
  expect(f.runConfiguredMutation).toHaveBeenCalledOnce()
  const confirmation = handoff.prepareRendererConfirmation('request-1', 0, { label: 'new' }, [
    { op: 'set', path: ['label'], value: 'new' },
  ])!
  f.apply()
  expect(await handoff.adopt({ label: 'new' }, f.proof as never, true, f.after.config.plugins[0].config)).toBe(true)
  expect(f.adoptSelectedConfiguredPlugins).toHaveBeenCalledOnce()
  expect(await confirmation.confirm()).toBe(true)
  for (const peer of f.peers) {
    expect(JSON.stringify(peer.request.mock.calls)).not.toContain('synthetic-private')
    expect(f.entries.get(peer.identity.rendererId)?.config).toEqual(f.after.config)
  }
  expect(handoff.cancel()).toBe(true)
})

it('refuses to adopt if an unrelated configured plugin changes during the edit', async () => {
  const f = fixture()
  const handoff = await f.reserve()
  f.apply({ ...f.after, config: { plugins: [f.after.config.plugins[0], { id: 'other', enabled: false, config: {} }] } })
  expect(await handoff.adopt({ label: 'new' }, f.proof as never, true, f.after.config.plugins[0].config)).toBe(false)
  expect(f.adoptSelectedConfiguredPlugins).not.toHaveBeenCalled()
  handoff.fence()
  expect(f.peers.every(peer => peer.closed)).toBe(true)
})

it('rejects a page whose archive no longer matches the Desktop selection', async () => {
  const f = fixture()
  f.entries.get('second')!.configuredPlugins[0]!.permissionBinding = () => ({
    original: { source: f.plugin.source, digest: 'sha256:' + 'c'.repeat(64) },
    digest: 'sha256:' + 'c'.repeat(64),
    artifact: f.plugin.distributionArtifact,
    lease: { pluginId: 'demo' },
  })
  await expect(f.reserve()).rejects.toThrow('renderer-package-config-unavailable')
  expect(f.runConfiguredMutation).not.toHaveBeenCalled()
})

it('does not confirm the writer when a peer cannot adopt the configured update', async () => {
  const f = fixture()
  const handoff = await f.reserve()
  const confirmation = handoff.prepareRendererConfirmation('request-1', 0, { label: 'new' }, [
    { op: 'set', path: ['label'], value: 'new' },
  ])!
  f.apply()
  expect(await handoff.adopt({ label: 'new' }, f.proof as never, true, f.after.config.plugins[0].config)).toBe(true)
  f.peers[1]!.request.mockResolvedValueOnce({
    rendererId: 'second',
    ownerGeneration: 'owner-1',
    requestId: 'request-1',
    pluginId: 'demo',
    revision: 1,
    adopted: false,
  })
  expect(await confirmation.confirm()).toBe(false)
  expect(f.peers[0]!.request).not.toHaveBeenCalled()
  handoff.fence()
  expect(f.peers.every(peer => peer.closed)).toBe(true)
})
