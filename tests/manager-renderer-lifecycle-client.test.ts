import { expect, it, vi } from 'vitest'
import { createManagerRendererLifecycleClient } from '../packages/cli/src/independent-manager/lifecycle-client.js'
import type { RendererPluginMutation } from '../packages/cli/src/renderer/runtime-shared.js'

const rendererId = 'a'.repeat(64)
const scope = { profileId: 'work', generation: 'owner-1', rendererId }
const base = {
  $schema: 'activation',
  schemaVersion: 1 as const,
  recordKind: 'active' as const,
  profileId: scope.profileId,
  runtimeGeneration: scope.generation,
  revision: 1,
  lastGoodRevision: 1,
  plugins: [],
}
const candidate = {
  ...base,
  recordKind: 'candidate' as const,
  transactionId: 'tx',
  revision: 2,
}
const mutation: RendererPluginMutation = {
  transactionId: 'tx',
  transactionEpoch: 'tx:epoch',
  expectedRegistryEpoch: 0,
  afterRegistryEpoch: 1,
  operation: 'install',
  previous: base,
  candidate,
  targetId: 'example',
  affectedPluginIds: ['example'],
}
const projection = { rendererId, ...mutation }
const command = (sequence: number, method: string, payload: unknown) => ({
  id: sequence.toString(16).padStart(64, '0'),
  sequence,
  method,
  payload,
})
const prepare = { transactionId: 'tx', transactionEpoch: 'tx:epoch', expectedRegistryEpoch: 0 }
const rollback = {
  transactionId: 'tx',
  transactionEpoch: 'tx:epoch',
  registryEpoch: 2,
  active: base,
  disposedAfter: candidate,
}

function fixture() {
  let current: typeof base | typeof candidate = structuredClone(base)
  let epoch = 0
  const events: string[] = []
  const runtime = {
    activePluginGeneration: vi.fn(() => structuredClone(current)),
    pluginRegistryEpoch: vi.fn(() => epoch),
    settleRegistryProjection: vi.fn(async () => {}),
    adoptRecoveredActivation: vi.fn(async (active: typeof base, registryEpoch: number) => {
      if (registryEpoch !== epoch) throw new Error('stale')
      current = active
    }),
    stagePluginMutation: vi.fn(async (value: RendererPluginMutation) => {
      events.push('stage')
      return {
        transactionId: value.transactionId,
        transactionEpoch: value.transactionEpoch!,
        expectedRegistryEpoch: value.expectedRegistryEpoch!,
        afterRegistryEpoch: value.afterRegistryEpoch!,
        affectedPluginIds: value.affectedPluginIds,
      }
    }),
    publishPluginMutation: vi.fn(async () => {
      events.push('publish')
      current = structuredClone(candidate)
      epoch = 1
      return {
        transactionId: 'tx',
        transactionEpoch: 'tx:epoch',
        registryEpoch: 1,
        active: candidate,
        retiring: base,
        notificationErrors: [],
      }
    }),
    completePluginMutation: vi.fn(async () => {
      events.push('complete')
      return {
        transactionId: 'tx',
        transactionEpoch: 'tx:epoch',
        registryEpoch: 1,
        active: candidate,
        disposedAfter: base,
      }
    }),
    finalizePluginMutation: vi.fn(async () => {
      events.push('finalize')
      current = { ...base, revision: 2, lastGoodRevision: 2 }
    }),
    rollbackPluginMutation: vi.fn(async () => {
      events.push('rollback')
      current = structuredClone(base)
      epoch = 2
      return rollback
    }),
    dispose: vi.fn(async () => events.push('dispose-runtime')),
  }
  const loaded = {
    mutation,
    publish: vi.fn(async () => events.push('publish-resources')),
    commit: vi.fn(async () => events.push('commit-resources')),
    retire: vi.fn(async () => events.push('retire-resources')),
  }
  const loader = { load: vi.fn(async () => loaded), dispose: vi.fn(async () => events.push('dispose-loader')) }
  return { runtime, loaded, loader, events }
}

it('uses actual runtime readbacks and existing lifecycle methods for a complete transaction', async () => {
  const { runtime, loader, events } = fixture()
  const client = createManagerRendererLifecycleClient({ runtime: runtime as never, scope, loader })
  try {
    expect(await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 })))
      .toMatchObject({ ok: true, value: { active: base, registryEpoch: 0 } })
    expect(await client.handle(command(2, 'prepare', prepare))).toMatchObject({ ok: true, value: prepare })
    expect(await client.handle(command(3, 'stage', projection)))
      .toMatchObject({
        ok: true,
        value: { ...prepare, afterRegistryEpoch: 1, observation: candidate, affectedPluginIds: ['example'] },
      })
    expect(await client.handle(command(4, 'publish', { transactionId: 'tx' }))).toMatchObject({ ok: true })
    expect(await client.handle(command(5, 'complete', { transactionId: 'tx' }))).toMatchObject({ ok: true })
    expect(await client.handle(command(6, 'finalize', { transactionId: 'tx' })))
      .toMatchObject({ ok: true, value: { transactionId: 'tx' } })
    expect(events).toEqual(['stage', 'publish-resources', 'publish', 'complete', 'finalize', 'commit-resources'])
    expect(runtime.activePluginGeneration).toHaveBeenCalled()
    expect(runtime.pluginRegistryEpoch).toHaveBeenCalled()
  } finally {
    await client.close()
  }
  expect(events.slice(-2)).toEqual(['dispose-runtime', 'dispose-loader'])
})

it('confirms rollback against the runtime before accepting a durable activation revision', async () => {
  const { runtime, loader, loaded } = fixture()
  const client = createManagerRendererLifecycleClient({ runtime: runtime as never, scope, loader })
  try {
    await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 }))
    await client.handle(command(2, 'prepare', prepare))
    await client.handle(command(3, 'stage', projection))
    expect(await client.handle(command(4, 'rollback', { transactionId: 'tx', expected: rollback })))
      .toMatchObject({ ok: true, value: rollback })
    expect(loaded.retire).toHaveBeenCalledOnce()
    const restored = { ...base, revision: 3, lastGoodRevision: 1 }
    expect(await client.handle(command(5, 'synchronize', { active: restored, registryEpoch: 2 })))
      .toMatchObject({ ok: true, value: { active: restored, registryEpoch: 2 } })
    expect(runtime.adoptRecoveredActivation).toHaveBeenCalledOnce()
  } finally {
    await client.close()
  }
})

it.each([
  { actual: ['base', 'dependent'], ok: true },
  { actual: ['base', 'base'], ok: false },
  { actual: ['base', 'other'], ok: false },
])('accepts only the same unique affected plugins, independent of runtime order: $actual', async ({ actual, ok }) => {
  const { runtime, loader, loaded } = fixture()
  const affectedPluginIds = ['dependent', 'base']
  const expanded = { ...mutation, targetId: 'base', affectedPluginIds }
  loaded.mutation = expanded
  runtime.stagePluginMutation.mockImplementation(async value => ({
    transactionId: value.transactionId,
    transactionEpoch: value.transactionEpoch!,
    expectedRegistryEpoch: value.expectedRegistryEpoch!,
    afterRegistryEpoch: value.afterRegistryEpoch!,
    affectedPluginIds: actual,
  }))
  const client = createManagerRendererLifecycleClient({ runtime: runtime as never, scope, loader })
  try {
    await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 }))
    await client.handle(command(2, 'prepare', prepare))
    const result = await client.handle(command(3, 'stage', { rendererId, ...expanded }))
    if (ok) expect(result).toMatchObject({ ok: true, value: { affectedPluginIds } })
    else expect(result).toMatchObject({ ok: false })
  } finally {
    await client.close()
  }
})

it('rejects a stale owner snapshot without adopting or echoing it', async () => {
  const { runtime, loader } = fixture()
  const client = createManagerRendererLifecycleClient({ runtime: runtime as never, scope, loader })
  expect(await client.handle(command(1, 'synchronize', { active: { ...base, revision: 99 }, registryEpoch: 0 })))
    .toMatchObject({ ok: false })
  expect(client.closed).toBe(true)
  await client.close()
  expect(runtime.adoptRecoveredActivation).not.toHaveBeenCalled()
  expect(runtime.dispose).toHaveBeenCalledOnce()
})

it('rejects stage without a verified loader and never dispatches a runtime mutation', async () => {
  const { runtime } = fixture()
  const client = createManagerRendererLifecycleClient({ runtime: runtime as never, scope })
  await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 }))
  await client.handle(command(2, 'prepare', prepare))
  expect(await client.handle(command(3, 'stage', projection))).toMatchObject({ ok: false })
  await client.close()
  expect(runtime.stagePluginMutation).not.toHaveBeenCalled()
})

it('rejects a forged renderer or mismatched mutation before using the loader', async () => {
  const { runtime, loader } = fixture()
  const client = createManagerRendererLifecycleClient({ runtime: runtime as never, scope, loader })
  await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 }))
  await client.handle(command(2, 'prepare', prepare))
  expect(await client.handle(command(3, 'stage', { ...projection, rendererId: 'b'.repeat(64) })))
    .toMatchObject({ ok: false })
  await client.close()
  expect(loader.load).not.toHaveBeenCalled()
  expect(runtime.stagePluginMutation).not.toHaveBeenCalled()
})

it('closes on replay and disposes its owner-bound resources', async () => {
  const { runtime, loader } = fixture()
  const lost = vi.fn()
  const client = createManagerRendererLifecycleClient({
    runtime: runtime as never,
    scope,
    loader,
    onDisconnected: lost,
  })
  await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 }))
  expect(await client.handle(command(1, 'prepare', prepare))).toMatchObject({ ok: false })
  await client.close()
  expect(lost).toHaveBeenCalledOnce()
  expect(runtime.dispose).toHaveBeenCalledOnce()
  expect(loader.dispose).toHaveBeenCalledOnce()
})

it('retires a late graph when the owner disconnects while it loads', async () => {
  const { runtime, loader, loaded } = fixture()
  let finish!: (value: typeof loaded) => void
  loader.load = vi.fn(() => new Promise(resolve => finish = resolve))
  const controller = new AbortController()
  const client = createManagerRendererLifecycleClient({
    runtime: runtime as never,
    scope,
    loader,
    signal: controller.signal,
  })
  await client.handle(command(1, 'synchronize', { active: base, registryEpoch: 0 }))
  await client.handle(command(2, 'prepare', prepare))
  const result = client.handle(command(3, 'stage', projection))
  await vi.waitFor(() => expect(loader.load).toHaveBeenCalledOnce())
  controller.abort()
  finish(loaded)
  expect(await result).toMatchObject({ ok: false })
  await client.close()
  expect(loaded.retire).toHaveBeenCalledOnce()
  expect(runtime.stagePluginMutation).not.toHaveBeenCalled()
})
