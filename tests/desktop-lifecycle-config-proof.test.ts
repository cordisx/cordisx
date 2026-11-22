import { expect, it, vi } from 'vitest'
import { revalidateDesktopLifecycleConfig } from '../packages/cli/src/cli/desktop-lifecycle-config-proof.js'

function fixture() {
  const item = {
    id: 'demo',
    version: '1.0.0',
    digest: 'sha256:' + 'a'.repeat(64),
    moduleGeneration: 'demo-2',
    enabled: true,
    dependencies: [],
  }
  const snapshot: any = {
    active: { profileId: 'default', runtimeGeneration: 'owner', plugins: [item] },
    registryEpoch: 2,
  }
  const plugin: any = {
    id: item.id,
    source: 'https://example.test/demo',
    enabled: true,
    revision: 3,
    package: { ...item },
    config: { label: 'kept' },
  }
  const proof: any = {
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
        revision: 3,
        lastGoodRevision: 3,
        value: { label: 'kept' },
        fields: [{ path: ['label'], type: 'string' }],
        secrets: [],
      },
    },
  }
  const entries = ['first', 'second'].map(id => ({
    peer: { identity: { rendererId: id } },
    projectedConfigs: new Map([['demo', { label: 'kept' }]]),
    packageInputs: new Map([['demo', 'same-input']]),
    desktopLifecycleConfigPlugins: ['demo'],
  }))
  let current = true
  const lease = {
    isCurrent: () => current,
    release: vi.fn(() => true),
    fence: vi.fn(),
    desktopConfiguration: { proof: vi.fn(async () => proof) },
  }
  const remember = vi.fn(() => true)
  const canCoordinate = vi.fn(async () => true)
  const input = {
    snapshot,
    entries: entries as never,
    current: () => current,
    reserve: vi.fn(async () => lease as never),
    read: async () => ({ plugins: [plugin], inputs: new Map([['demo', 'same-input']]) }),
    remember,
    canCoordinate,
  }
  return { input, entries, lease, proof, remember, canCoordinate, disconnect: () => current = false }
}

it('reproves every page against one native seat before releasing the handoff', async () => {
  const f = fixture()
  expect(await revalidateDesktopLifecycleConfig(f.input)).toBe(true)
  expect(f.input.reserve).toHaveBeenCalledOnce()
  expect(f.lease.desktopConfiguration.proof).toHaveBeenCalledExactlyOnceWith('demo')
  expect(f.remember).toHaveBeenCalledOnce()
  expect(f.lease.release).toHaveBeenCalledOnce()
  expect(f.lease.fence).not.toHaveBeenCalled()
})

it('fences a mismatched page or native proof without adopting the configuration', async () => {
  const f = fixture()
  f.entries[1]!.projectedConfigs.set('demo', { label: 'stale' })
  expect(await revalidateDesktopLifecycleConfig(f.input)).toBe(false)
  expect(f.remember).not.toHaveBeenCalled()
  expect(f.lease.release).not.toHaveBeenCalled()
  expect(f.lease.fence).toHaveBeenCalledOnce()
  const native = fixture()
  native.proof.plugin.configuration.value.label = 'different'
  expect(await revalidateDesktopLifecycleConfig(native.input)).toBe(false)
  expect(native.remember).not.toHaveBeenCalled()
  expect(native.lease.fence).toHaveBeenCalledOnce()
  const missing = fixture()
  missing.entries[0]!.packageInputs.delete('demo')
  expect(await revalidateDesktopLifecycleConfig(missing.input)).toBe(false)
  expect(missing.lease.fence).toHaveBeenCalledOnce()
})

it('does not cache a late proof after the Desktop seat or a Manager is lost', async () => {
  const f = fixture()
  let finish!: (value: any) => void
  f.lease.desktopConfiguration.proof.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
  const pending = revalidateDesktopLifecycleConfig(f.input)
  await vi.waitFor(() => expect(f.lease.desktopConfiguration.proof).toHaveBeenCalledOnce())
  f.disconnect()
  finish(f.proof)
  expect(await pending).toBe(false)
  expect(f.remember).not.toHaveBeenCalled()
  expect(f.lease.fence).toHaveBeenCalledOnce()
})

it('removes lifecycle eligibility when the new proof no longer supports it', async () => {
  const f = fixture()
  f.canCoordinate.mockResolvedValue(false)
  expect(await revalidateDesktopLifecycleConfig(f.input)).toBe(true)
  expect(f.entries.map(entry => entry.desktopLifecycleConfigPlugins)).toEqual([[], []])
})
