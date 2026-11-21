import { expect, it, vi } from 'vitest'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const active = {
  $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  schemaVersion: 1 as const,
  recordKind: 'active' as const,
  profileId: 'work',
  revision: 0,
  lastGoodRevision: 0,
  runtimeGeneration: 'g',
  plugins: [],
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => resolve = done)
  return { promise, resolve }
}

it('hands the externally created fence to the first-browser-graph admission without minting a second epoch', async () => {
  const cdp = new CdpPluginLifecycleRuntime()
  const session = { send: async () => ({}) } as never
  const unregister = cdp.register(session)
  const entered = deferred()
  const release = deferred()
  const commit = vi.fn()
  const rollback = vi.fn(async () => {})
  cdp.setBrowserGraphAdmission(async input => {
    expect(input).toEqual({ transactionId: 'tx', active, expectedRegistryEpoch: 0, sessions: [session] })
    entered.resolve()
    await release.promise
    return { commit, rollback }
  })
  const admission = cdp.beginSharedAdmission('tx')
  const fence = { transactionEpoch: 'tx:shared-fence', expectedRegistryEpoch: 0 }
  const pending = admission.prepareBrowserGraph(active, fence)
  await entered.promise
  expect(() => cdp.prepare('other')).toThrow('another plugin generation transaction')
  expect(() => cdp.beginJoin(session)).toThrow('cannot join')
  release.resolve()
  await pending
  expect(commit).toHaveBeenCalledTimes(1)
  expect(rollback).not.toHaveBeenCalled()
  expect(() => admission.release()).toThrow('active CDP shared transaction')
  expect(() => cdp.cancelPreparation('tx')).toThrow('requires its owner capability')
  await expect(cdp.abort('tx')).rejects.toThrow('requires its owner capability')
  await expect(cdp.publish('tx')).rejects.toThrow('requires its owner capability')
  await expect(cdp.adoptRecoveredActivation(active, 0)).rejects.toThrow('requires its owner capability')
  admission.cancelPreparation('tx')
  admission.release()
  expect(() => cdp.prepare('next')).not.toThrow()
  cdp.cancelPreparation('next')
  unregister()
})

it('rolls back a graph admission when a frozen Desktop document leaves while it is pending', async () => {
  const cdp = new CdpPluginLifecycleRuntime()
  const session = { send: async () => ({}) } as never
  const unregister = cdp.register(session)
  const entered = deferred()
  const release = deferred()
  const commit = vi.fn()
  const rollback = vi.fn(async () => {})
  cdp.setBrowserGraphAdmission(async () => {
    entered.resolve()
    await release.promise
    return { commit, rollback }
  })
  const admission = cdp.beginSharedAdmission('tx')
  const invalidated = vi.fn()
  admission.onInvalidated(invalidated)
  const pending = admission.prepareBrowserGraph(active, {
    transactionEpoch: 'tx:shared-fence',
    expectedRegistryEpoch: 0,
  })
  await entered.promise
  unregister()
  release.resolve()
  await expect(pending).rejects.toThrow('stale')
  expect(invalidated).toHaveBeenCalledTimes(1)
  expect(rollback).toHaveBeenCalledTimes(1)
  expect(commit).not.toHaveBeenCalled()
  admission.release()
})

it('does not start a shared fence while an earlier Desktop reload is still in flight', async () => {
  const cdp = new CdpPluginLifecycleRuntime()
  const entered = deferred()
  const release = deferred()
  const unregister = cdp.register({
    async send() {
      entered.resolve()
      await release.promise
      return { result: { value: { ok: true } } }
    },
  } as never)
  const reload = cdp.reload({ pluginId: 'test', moduleGeneration: 'v1', runtimeGeneration: 'g' })
  await entered.promise
  expect(() => cdp.beginSharedAdmission('tx')).toThrow('unavailable')
  release.resolve()
  await reload
  const admission = cdp.beginSharedAdmission('tx')
  admission.release()
  unregister()
})

it('notifies the owner only when the final admitted Desktop seat leaves', () => {
  const cdp = new CdpPluginLifecycleRuntime()
  const first = { send: async () => ({}) } as never
  const second = { send: async () => ({}) } as never
  const closed = vi.fn()
  const unsubscribe = cdp.onNoReadySessions(closed)
  cdp.onNoReadySessions(() => {
    throw new Error('observer failure')
  })
  const removeFirst = cdp.register(first)
  const removeSecond = cdp.register(second)
  removeFirst()
  expect(closed).not.toHaveBeenCalled()
  removeSecond()
  removeSecond()
  expect(closed).toHaveBeenCalledTimes(1)
  const join = cdp.beginJoin(first)
  const removeRejoined = join.commit(0)!
  removeRejoined()
  expect(closed).toHaveBeenCalledTimes(2)
  unsubscribe()
  cdp.register(second)()
  expect(closed).toHaveBeenCalledTimes(2)
})
