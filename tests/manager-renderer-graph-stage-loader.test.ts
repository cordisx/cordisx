import { expect, it, vi } from 'vitest'
import { createManagerRendererGraphLoader } from '../packages/cli/src/independent-manager/graph-stage-loader.js'

const origin = 'http://127.0.0.1:43123'
const rendererId = 'a'.repeat(64)
const context = { rendererId, profileId: 'work', generation: 'owner-1', signal: new AbortController().signal }
function graph(pluginId: string, moduleGeneration: string, hex: string) {
  const baseUrl = `${origin}/api/renderer/graphs/${hex.repeat(64)}/`
  return {
    leaseId: hex.repeat(64),
    pluginId,
    moduleGeneration,
    baseUrl,
    entryUrl: `${baseUrl}module.js`,
    initialStyleUrls: [`${baseUrl}styles/base.css`],
  }
}
const old = graph('example', 'old-generation', 'b')
const dependent = graph('dependent', 'dependent-generation', 'c')
const replacement = graph('example', 'new-generation', 'd')
const previous = {
  profileId: 'work',
  runtimeGeneration: 'owner-1',
  plugins: [
    { id: 'example', enabled: true, moduleGeneration: 'old-generation' },
    { id: 'dependent', enabled: true, moduleGeneration: 'dependent-generation' },
  ],
}
const candidate = {
  ...previous,
  plugins: [
    { id: 'example', enabled: true, moduleGeneration: 'new-generation' },
    { id: 'dependent', enabled: true, moduleGeneration: 'dependent-generation' },
  ],
}
const projection = {
  rendererId,
  transactionId: 'tx',
  transactionEpoch: 'tx:epoch',
  expectedRegistryEpoch: 0,
  afterRegistryEpoch: 1,
  previous,
  candidate,
  operation: 'update',
  targetId: 'example',
  affectedPluginIds: ['example', 'dependent'],
  graphs: [replacement],
}
function fixture(initialGraphs = [old, dependent]) {
  const registry = {
    stage: vi.fn((input: { id: string }) => ({ id: input.id, ready: Promise.resolve() })),
    publish: vi.fn(() => true),
    retire: vi.fn(() => true),
  }
  const importModule = vi.fn(async (_url: string) => ({ apply: () => {} }))
  const loader = createManagerRendererGraphLoader({ origin, registry, initialGraphs, importModule })
  return { loader, registry, importModule }
}

it('uses the existing registry and native module loader, then retires the replaced graph at commit', async () => {
  const { loader, registry, importModule } = fixture()
  const loaded = (await loader.load(projection, context))!
  expect(registry.stage).toHaveBeenCalledWith({
    id: replacement.leaseId,
    baseUrl: replacement.baseUrl,
    initialStyles: replacement.initialStyleUrls,
  })
  expect(importModule).toHaveBeenCalledWith(replacement.entryUrl)
  expect(loaded.modules?.example).toEqual({ apply: expect.any(Function) })
  expect(loaded.mutation).toMatchObject({ transactionId: 'tx', targetId: 'example' })
  expect(loaded.mutation).not.toHaveProperty('graphs')
  await loaded.publish()
  expect(registry.publish).toHaveBeenCalledWith(replacement.leaseId)
  await loaded.commit()
  expect(registry.retire).toHaveBeenCalledWith(old.leaseId)
  expect(registry.retire).not.toHaveBeenCalledWith(dependent.leaseId)
  await loader.dispose()
  expect(registry.retire).toHaveBeenCalledWith(replacement.leaseId)
  expect(registry.retire).toHaveBeenCalledWith(dependent.leaseId)
})

it('retains the previous graph on rollback and retires only the staged replacement', async () => {
  const { loader, registry } = fixture()
  const loaded = (await loader.load(projection, context))!
  await loaded.publish()
  await loaded.retire()
  expect(registry.retire).toHaveBeenCalledWith(replacement.leaseId)
  expect(registry.retire).not.toHaveBeenCalledWith(old.leaseId)
  await loader.dispose()
  expect(registry.retire).toHaveBeenCalledWith(old.leaseId)
})

it.each([
  ['cross-origin entry', { ...replacement, entryUrl: 'http://127.0.0.1:9999/module.js' }],
  ['escaping path', { ...replacement, entryUrl: replacement.baseUrl + '../other.js' }],
  ['wrong generation', { ...replacement, moduleGeneration: 'unrelated' }],
  ['foreign plugin', { ...replacement, pluginId: 'other' }],
  ['query string', { ...replacement, entryUrl: replacement.entryUrl + '?x=1' }],
])('rejects %s before loading any module', async (_label, bad) => {
  const { loader, registry, importModule } = fixture()
  await expect(loader.load({ ...projection, graphs: [bad] }, context)).rejects.toThrow()
  expect(registry.stage).not.toHaveBeenCalled()
  expect(importModule).not.toHaveBeenCalled()
  await loader.dispose()
})

it('rejects missing replacement or missing active graph information', async () => {
  const complete = fixture()
  await expect(complete.loader.load({ ...projection, graphs: [] }, context))
    .rejects.toThrow('renderer-graph-projection-unavailable')
  await complete.loader.dispose()
  const incomplete = fixture([dependent])
  await expect(incomplete.loader.load(projection, context)).rejects.toThrow('renderer-graph-active-unavailable')
  await incomplete.loader.dispose()
})

it('retires a staged graph if the session is revoked during a native import', async () => {
  const registry = {
    stage: vi.fn((input: { id: string }) => ({ id: input.id, ready: Promise.resolve() })),
    publish: vi.fn(() => true),
    retire: vi.fn(() => true),
  }
  let finish!: (value: { apply: () => void }) => void
  const importModule = vi.fn(() => new Promise<{ apply: () => void }>(resolve => finish = resolve))
  const loader = createManagerRendererGraphLoader({ origin, registry, initialGraphs: [old, dependent], importModule })
  const controller = new AbortController()
  const result = loader.load(projection, { ...context, signal: controller.signal })
  await vi.waitFor(() => expect(importModule).toHaveBeenCalledOnce())
  controller.abort()
  await expect(result).rejects.toThrow('renderer-graph-session-revoked')
  expect(registry.retire).toHaveBeenCalledWith(replacement.leaseId)
  finish({ apply: () => {} })
  await loader.dispose()
})

it('rejects a projected profile mismatch and unrecognized authorization material', async () => {
  const { loader, importModule } = fixture()
  await expect(loader.load({ ...projection, previous: { ...previous, profileId: 'other' } }, context))
    .rejects.toThrow('renderer-graph-projection-stale')
  await expect(loader.load({ ...projection, isolatedArtifactSource: 'arbitrary code' }, context))
    .rejects.toThrow('renderer-graph-invalid')
  expect(importModule).not.toHaveBeenCalled()
  await loader.dispose()
})
