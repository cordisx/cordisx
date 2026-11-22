import { expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { reserveServiceRendererPackageConfig } from '../packages/cli/src/cli/service-renderer-package-config-handoff.js'

vi.mock('../packages/cli/src/cli/manager-origin-fence.js', () => ({
  isCurrentManagerOriginFence: () => true,
}))
vi.mock('../packages/cli/src/cli/service-renderer-profile-inputs.js', () => ({
  hasNoPackageServiceState: async () => true,
}))

const item = {
  id: 'demo',
  version: '1.0.0',
  digest: 'sha256:' + 'a'.repeat(64),
  moduleGeneration: 'demo-generation',
  enabled: true,
  dependencies: [],
}
const snapshot = { active: { profileId: 'work', runtimeGeneration: 'owner-1', plugins: [item] }, registryEpoch: 2 }
const plugin = {
  id: item.id,
  source: 'https://example.test/demo',
  enabled: true,
  revision: 1,
  package: { ...item },
  manifest: { $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1, schemaVersion: 1, capabilities: [] },
  config: { label: 'old' },
}
const operations = [{ op: 'set' as const, path: ['label'], value: 'new' }]
const proof = {
  snapshot,
  plugin: {
    id: item.id,
    source: plugin.source,
    package: { ...item, dependencies: [] },
    configuration: {
      namespace: item.id,
      schemaKind: 'schemastery',
      applies: 'live',
      writable: true,
      revision: 2,
      lastGoodRevision: 2,
      value: { label: 'new' },
      fields: [{ path: ['label'], type: 'string' }],
      secrets: [],
    },
  },
}

function fixture() {
  const makePeer = (id: string) => {
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
  }
  const first = makePeer('first')
  const second = makePeer('second')
  const config = { plugins: [] }
  const before = { config, plugins: [plugin], policies: [], inputs: new Map([['demo', 'old']]) }
  const after = {
    ...before,
    plugins: [{ ...plugin, revision: 2, config: { label: 'new' } }],
    inputs: new Map([['demo', 'new']]),
  }
  const entries = new Map([first, second].map(peer => [peer.identity.rendererId, {
    peer,
    bootstrapConfirmed: true,
    snapshot,
    config,
    plugins: before.plugins,
    policies: before.policies,
    packageInputs: new Map(before.inputs),
    projectedConfigs: new Map([['demo', { label: 'old' }]]),
    desktopPackageConfigPlugins: ['demo'],
    desktopLifecycleConfigPlugins: [] as string[],
    checks: new Set<Promise<boolean>>(),
    managedOwners: new Map(),
  }]))
  let currentInputs: any = before
  const drainCurrent = vi.fn(async (_id: string) => true)
  const input = {
    homeDir: '/synthetic-home',
    profileId: 'work',
    entries,
    participants: { ownerPeers: () => [first, second] },
    lifecycle: { snapshot: () => snapshot },
    readLifetimes: { drainCurrent },
    pluginFence: { runPackageMutation: async (_scope: unknown, action: () => Promise<unknown>) => await action() },
    rememberPluginConfig: vi.fn(() => true),
    canCoordinatePluginConfig: vi.fn(async () => true),
    readInputs: async () => currentInputs,
    current: (id: string, entry: any) => entries.get(id) === entry && !entry.peer.closed,
  }
  const origin = { rendererId: 'first', desktopConfiguration: {}, isCurrent: () => !first.closed && !second.closed }
  return {
    input,
    origin,
    first,
    second,
    entries,
    drainCurrent,
    apply: () => currentInputs = after,
    reserve: async () => await reserveServiceRendererPackageConfig(input as never, origin as never, 'demo'),
  }
}

it('drains both pages, adopts the authoritative snapshot and waits for each receipt', async () => {
  const f = fixture()
  let finish!: (value: boolean) => void
  const waiting = new Promise<boolean>(resolve => finish = resolve)
  f.drainCurrent.mockImplementation(async id => id === 'second' ? await waiting : true)
  const pending = f.reserve()
  await vi.waitFor(() => expect(f.drainCurrent).toHaveBeenCalledTimes(2))
  let reserved = false
  void pending.then(() => reserved = true)
  await Promise.resolve()
  expect(reserved).toBe(false)
  finish(true)
  const handoff = await pending
  const confirmation = handoff.prepareRendererConfirmation('request-1', 1, { label: 'new' }, operations)!
  f.apply()
  expect(await handoff.adopt({ label: 'new' }, proof as never, true)).toBe(true)
  expect(await confirmation.confirm()).toBe(true)
  expect(f.second.request).toHaveBeenCalledOnce()
  expect(f.first.request).toHaveBeenCalledOnce()
  expect(f.second.request.mock.calls[0]![1]).toMatchObject({ origin: false, operations })
  expect(f.first.request.mock.calls[0]![1]).toMatchObject({ origin: true, operations })
  expect(f.entries.get('first')?.plugins[0]?.revision).toBe(2)
  expect(f.entries.get('second')?.plugins[0]?.revision).toBe(2)
  expect(f.entries.get('first')?.desktopLifecycleConfigPlugins).toEqual(['demo'])
  expect(f.entries.get('second')?.desktopLifecycleConfigPlugins).toEqual(['demo'])
  expect(handoff.cancel()).toBe(true)
  expect(f.first.closed).toBe(false)
  expect(f.second.closed).toBe(false)
})

it('rejects an incomplete baseline before dispatch and fences the affected pages', async () => {
  const f = fixture()
  f.entries.get('second')!.packageInputs.set('demo', 'stale')
  await expect(f.reserve()).rejects.toThrow('renderer-package-config-unavailable')
  expect(f.first.closed).toBe(true)
  expect(f.second.closed).toBe(true)
  expect(f.first.request).not.toHaveBeenCalled()
  expect(f.second.request).not.toHaveBeenCalled()
})

it('refuses configuration writes while the owner-selected package is disabled', async () => {
  const f = fixture()
  for (const entry of f.entries.values()) entry.plugins = [{ ...plugin, enabled: false }]
  await expect(f.reserve()).rejects.toThrow('renderer-package-config-unavailable')
  expect(f.first.request).not.toHaveBeenCalled()
  expect(f.second.request).not.toHaveBeenCalled()
})

it('rejects an oversized confirmation before dispatch and never sends it', async () => {
  const f = fixture()
  const handoff = await f.reserve()
  expect(handoff.prepareRendererConfirmation('request-1', 1, { label: 'x'.repeat(250 * 1024) }, operations))
    .toBeUndefined()
  expect(handoff.cancel()).toBe(true)
  expect(f.first.request).not.toHaveBeenCalled()
  expect(f.second.request).not.toHaveBeenCalled()
})

it('does not confirm the writer when another page fails to adopt', async () => {
  const f = fixture()
  const handoff = await f.reserve()
  const confirmation = handoff.prepareRendererConfirmation('request-1', 1, { label: 'new' }, operations)!
  f.apply()
  expect(await handoff.adopt({ label: 'new' }, proof as never, true)).toBe(true)
  f.second.request.mockResolvedValueOnce({
    rendererId: 'second',
    ownerGeneration: 'owner-1',
    requestId: 'request-1',
    pluginId: 'demo',
    revision: 2,
    adopted: false,
  })
  expect(await confirmation.confirm()).toBe(false)
  expect(f.first.request).not.toHaveBeenCalled()
  handoff.fence()
  expect(f.first.closed).toBe(true)
  expect(f.second.closed).toBe(true)
})
