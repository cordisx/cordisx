import { beforeEach, expect, it, vi } from 'vitest'
import { DesktopPackageConfigWriteGate } from '../packages/cli/src/cli/desktop-package-config-write.js'
import { createManagerRendererDesktopPackageConfig } from '../packages/cli/src/cli/manager-renderer-desktop-package-config.js'
import { fenceManagerOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'

vi.mock('../packages/cli/src/cli/manager-origin-fence.js', () => ({ fenceManagerOrigin: vi.fn() }))

const item = {
  id: 'demo',
  version: '1.0.0',
  digest: 'sha256:' + 'a'.repeat(64),
  moduleGeneration: 'demo-generation',
  enabled: true,
  dependencies: [],
}
const snapshot: any = { active: { profileId: 'work', revision: 3, plugins: [item] }, registryEpoch: 2 }
const plugin: any = {
  id: item.id,
  source: 'https://example.test/demo',
  enabled: true,
  revision: 1,
  package: { ...item },
  config: { label: 'old' },
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
      revision: 1,
      lastGoodRevision: 1,
      value: { label: 'old' },
      fields: [{ path: ['label'], type: 'string' }],
      secrets: [],
    },
  },
}
const payload = JSON.stringify({
  version: 1,
  token: 'renderer-binding-placeholder',
  requestId: 'request-1',
  operation: {
    kind: 'plugin-configuration',
    action: 'update',
    pluginId: 'demo',
    expectedRevision: 1,
    operations: [{ op: 'set', path: ['label'], value: 'new' }],
  },
})
const rejected = { requestId: 'request-1', ok: true, value: { status: 'rejected', reason: 'unavailable' } }

function setup() {
  const native = { seat: {}, proof: vi.fn(async () => proof), update: vi.fn(), confirm: vi.fn(() => true) }
  const origin = {
    rendererId: 'renderer',
    desktopConfiguration: native,
    isCurrent: () => true,
    release: vi.fn(() => true),
    fence: vi.fn(),
  }
  const handoff = {
    snapshot,
    plugin,
    isCurrent: () => true,
    run: async <T>(action: () => Promise<T>) => await action(),
    prepareRendererConfirmation: () => ({ confirm: async () => true }),
    cancel: vi.fn(() => true),
    fence: vi.fn(),
  }
  const reserve = vi.fn(async () => handoff)
  vi.mocked(fenceManagerOrigin).mockResolvedValue(origin)
  const channel = createManagerRendererDesktopPackageConfig({
    profileId: 'work',
    generation: 'owner-1',
    lifecycle: {} as never,
    participants: {} as never,
    bootstrap: { reservePackageConfig: reserve } as never,
    writes: new DesktopPackageConfigWriteGate(),
    sessions: () => ({}) as never,
  })
  const dispatch = () =>
    channel.prepare(payload, {
      profileId: 'work',
      rendererId: 'renderer',
      ownerGeneration: 'owner-1',
      signal: new AbortController().signal,
      admitted: true,
    }).dispatch()
  return { dispatch, handoff, native, origin, reserve }
}

beforeEach(() => vi.mocked(fenceManagerOrigin).mockReset())

it('reports a known rejection when reservation fails before dispatch even if the origin is fenced', async () => {
  const f = setup()
  f.reserve.mockRejectedValueOnce(new Error('stale before write'))
  f.origin.release.mockReturnValueOnce(false)
  await expect(f.dispatch()).resolves.toEqual(rejected)
  expect(f.native.update).not.toHaveBeenCalled()
  expect(f.origin.fence).toHaveBeenCalledOnce()
})

it('fences a failed pre-dispatch cleanup without reporting an unknown write', async () => {
  const f = setup()
  f.native.proof.mockResolvedValueOnce(undefined)
  f.handoff.cancel.mockReturnValueOnce(false)
  await expect(f.dispatch()).resolves.toEqual(rejected)
  expect(f.native.update).not.toHaveBeenCalled()
  expect(f.handoff.fence).toHaveBeenCalledOnce()
  expect(f.origin.fence).toHaveBeenCalledOnce()
})

it('releases a safe pre-dispatch rejection without fencing the session', async () => {
  const f = setup()
  f.native.proof.mockResolvedValueOnce(undefined)
  await expect(f.dispatch()).resolves.toEqual(rejected)
  expect(f.handoff.cancel).toHaveBeenCalledOnce()
  expect(f.origin.release).toHaveBeenCalledOnce()
  expect(f.handoff.fence).not.toHaveBeenCalled()
  expect(f.origin.fence).not.toHaveBeenCalled()
})

it('keeps a failure after native dispatch uncertain and fenced', async () => {
  const f = setup()
  f.native.update.mockRejectedValueOnce(new Error('native connection lost'))
  await expect(f.dispatch()).rejects.toThrow('DESKTOP_PACKAGE_CONFIG_RESULT_UNKNOWN')
  expect(f.native.update).toHaveBeenCalledOnce()
  expect(f.handoff.fence).toHaveBeenCalledOnce()
  expect(f.origin.fence).toHaveBeenCalledOnce()
})
