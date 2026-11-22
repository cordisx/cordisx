import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  DesktopPackageConfigWrite,
  DesktopPackageConfigWriteGate,
} from '../packages/cli/src/cli/desktop-package-config-write.js'
import { SharedProfilePluginConfigFence } from '../packages/cli/src/config/profile-plugin-config-fence.js'
import type { ConfigBindingRequest } from '../packages/cli/src/launcher/config-rpc.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'

const unsupported = process.platform !== 'darwin' && process.platform !== 'linux'
const token = 'a'.repeat(64)
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
const operation: any = {
  kind: 'plugin-configuration',
  action: 'update',
  pluginId: 'demo',
  expectedRevision: 1,
  operations: [{ op: 'set', path: ['label'], value: 'new' }],
}
const request = (value: Partial<ConfigBindingRequest>): ConfigBindingRequest => ({
  requestId: 'request-1',
  operation: 'stage',
  identity: { source: plugin.source, pluginId: 'demo' },
  scope: { profileId: 'work', generation: 'renderer-1' },
  expectedRevision: 1,
  config: { label: 'new' },
  ...value,
})

it.skipIf(unsupported)(
  'allows only the intended native seat and staged package value under the held fence',
  async () => {
    const root = await mkdtemp('/tmp/cx-desktop-config-write-')
    const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
    const store = new PackagePluginConfigStore(root, 'work', 'owner-1')
    const seat = {}
    try {
      const seed = await store.stage('demo', 0, { label: 'old' }, token)
      await store.commit('demo', seed.candidateRevision, token)
      const release = await fence.acquire()
      const write = new DesktopPackageConfigWrite({
        snapshot,
        plugin,
        proof,
        operation,
        profileId: 'work',
        rendererGeneration: 'renderer-1',
        seat,
        current: () => true,
        run: async action => await fence.runPackageMutation({ pluginId: 'demo', isCurrent: () => true }, action),
      })
      const dispatch = vi.fn(async (value: ConfigBindingRequest) => {
        if (value.operation === 'stage') return await store.stage('demo', value.expectedRevision!, value.config!, token)
        if (value.operation === 'commit') return await store.commit('demo', value.candidateRevision!, token)
        return await store.abort('demo', value.candidateRevision!, token)
      })
      await expect(write.handle({}, request({}), dispatch)).rejects.toThrow('desktop-package-config-unavailable')
      await expect(write.handle(seat, request({ config: { label: 'other' } }), dispatch))
        .rejects.toThrow('desktop-package-config-unavailable')
      await expect(write.handle(seat, request({ identity: { source: plugin.source, pluginId: 'other' } }), dispatch))
        .rejects.toThrow('desktop-package-config-unavailable')
      expect(dispatch).not.toHaveBeenCalled()
      expect(await write.handle(seat, request({}), dispatch)).toEqual({ candidateRevision: 2 })
      await expect(store.loadStable('demo')).rejects.toThrow('candidate is pending')
      expect(await write.handle(seat, request({ operation: 'commit', candidateRevision: 2 }), dispatch))
        .toEqual({ revision: 2 })
      expect(write.outcome()).toBe('committed')
      expect(await store.loadStable('demo')).toEqual({ revision: 2, config: { label: 'new' } })
      await expect(write.handle(seat, request({ operation: 'commit', candidateRevision: 2 }), dispatch))
        .rejects.toThrow('desktop-package-config-unavailable')
      write.close()
      await release()
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('refuses stale, sensitive, undeclared, disabled and non-live configuration intents', () => {
  const base = {
    snapshot,
    plugin,
    proof,
    operation,
    profileId: 'work',
    rendererGeneration: 'renderer-1',
    seat: {},
    current: () => true,
    run: async <T>(action: () => Promise<T>) => await action(),
  }
  const stale = structuredClone(proof)
  stale.plugin.package.moduleGeneration = 'stale'
  expect(() => new DesktopPackageConfigWrite({ ...base, proof: stale })).toThrow('desktop-manager-config-unavailable')
  const sensitivePlugin = { ...plugin, config: { ...plugin.config, secret: 'synthetic-secret' } }
  const sensitiveProof = structuredClone(proof)
  sensitiveProof.plugin.configuration.fields.push({ path: ['secret'], type: 'string', role: 'secret' })
  sensitiveProof.plugin.configuration.secrets.push({ path: ['secret'], set: false })
  expect(() => new DesktopPackageConfigWrite({ ...base, plugin: sensitivePlugin, proof: sensitiveProof }))
    .toThrow('desktop-package-config-unavailable')
  expect(() =>
    new DesktopPackageConfigWrite({
      ...base,
      operation: { ...operation, operations: [{ op: 'set', path: ['unknown'], value: 'x' }] },
    })
  ).toThrow('desktop-package-config-unavailable')
  const disabled = structuredClone(proof)
  disabled.plugin.configuration.fields[0].disabled = true
  expect(() => new DesktopPackageConfigWrite({ ...base, proof: disabled })).toThrow(
    'desktop-package-config-unavailable',
  )
  const restart = structuredClone(proof)
  restart.plugin.configuration.applies = 'plugin-restart'
  expect(() => new DesktopPackageConfigWrite({ ...base, proof: restart })).toThrow('desktop-package-config-unavailable')
})

it.skipIf(unsupported)(
  'stages and commits a bounded non-sensitive primitive array through the Desktop write gate',
  async () => {
    const root = await mkdtemp('/tmp/cx-desktop-config-array-')
    const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
    const store = new PackagePluginConfigStore(root, 'work', 'owner-1')
    const seat = {}
    const arrayPlugin = { ...plugin, config: { labels: ['old'] } }
    const arrayProof = structuredClone(proof)
    arrayProof.plugin.configuration.value = { labels: ['old'] }
    arrayProof.plugin.configuration.fields = [{ path: ['labels'], type: 'array', arrayItemType: 'string' }]
    const arrayOperation = { ...operation, operations: [{ op: 'set', path: ['labels'], value: ['one', 'two'] }] }
    try {
      const seed = await store.stage('demo', 0, { labels: ['old'] }, token)
      await store.commit('demo', seed.candidateRevision, token)
      const release = await fence.acquire()
      const write = new DesktopPackageConfigWrite({
        snapshot,
        plugin: arrayPlugin,
        proof: arrayProof,
        operation: arrayOperation,
        profileId: 'work',
        rendererGeneration: 'renderer-1',
        seat,
        current: () => true,
        run: async action => await fence.runPackageMutation({ pluginId: 'demo', isCurrent: () => true }, action),
      })
      expect(write.expectedValue()).toEqual({ labels: ['one', 'two'] })
      expect(() =>
        new DesktopPackageConfigWrite({
          snapshot,
          plugin: arrayPlugin,
          proof: arrayProof,
          operation: { ...arrayOperation, operations: [{ op: 'set', path: ['labels'], value: ['one', 2] }] },
          profileId: 'work',
          rendererGeneration: 'renderer-1',
          seat,
          current: () => true,
          run: async action => await action(),
        })
      ).toThrow('desktop-package-config-unavailable')
      const stage = request({ config: { labels: ['one', 'two'] } })
      await write.handle(seat, stage, async value => await store.stage('demo', 1, value.config!, token))
      await write.handle(
        seat,
        request({ operation: 'commit', candidateRevision: 2 }),
        async () => await store.commit('demo', 2, token),
      )
      expect(await store.loadStable('demo')).toEqual({ revision: 2, config: { labels: ['one', 'two'] } })
      await release()
    } finally {
      await fence.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it('does not accept a late stage receipt after the write authority closes', async () => {
  const seat = {}
  let finish!: (value: unknown) => void
  const wait = new Promise<unknown>(resolve => finish = resolve)
  const write = new DesktopPackageConfigWrite({
    snapshot,
    plugin,
    proof,
    operation,
    profileId: 'work',
    rendererGeneration: 'renderer-1',
    seat,
    current: () => true,
    run: async action => await action(),
  })
  const pending = write.handle(seat, request({}), async () => await wait)
  write.close()
  finish({ candidateRevision: 2 })
  await expect(pending).rejects.toThrow('desktop-package-config-result-uncertain')
  expect(write.outcome()).toBeUndefined()
})

it('invalidates the active write on a seat change and permits a later fresh reservation', () => {
  const gate = new DesktopPackageConfigWriteGate()
  const makeWrite = () =>
    new DesktopPackageConfigWrite({
      snapshot,
      plugin,
      proof,
      operation,
      profileId: 'work',
      rendererGeneration: 'renderer-1',
      seat: {},
      current: () => true,
      run: async action => await action(),
    })
  const first = gate.begin(makeWrite())
  expect(first.isCurrent()).toBe(true)
  gate.invalidate()
  expect(first.isCurrent()).toBe(false)
  const second = gate.begin(makeWrite())
  expect(second.isCurrent()).toBe(true)
  first.release()
  expect(second.isCurrent()).toBe(true)
  gate.close()
  expect(second.isCurrent()).toBe(false)
  expect(() => gate.begin(makeWrite())).toThrow('desktop-package-config-unavailable')
})

it.skipIf(unsupported)('does not confirm a commit if the owner becomes stale during publication', async () => {
  const root = await mkdtemp('/tmp/cx-desktop-config-uncertain-')
  const fence = new SharedProfilePluginConfigFence(path.join(root, 'config.json'), 'work')
  const store = new PackagePluginConfigStore(root, 'work', 'owner-1')
  const seat = {}
  let current = true
  try {
    const seed = await store.stage('demo', 0, { label: 'old' }, token)
    await store.commit('demo', seed.candidateRevision, token)
    const release = await fence.acquire()
    const write = new DesktopPackageConfigWrite({
      snapshot,
      plugin,
      proof,
      operation,
      profileId: 'work',
      rendererGeneration: 'renderer-1',
      seat,
      current: () => current,
      run: async action => await fence.runPackageMutation({ pluginId: 'demo', isCurrent: () => current }, action),
    })
    await write.handle(seat, request({}), async value => await store.stage('demo', 1, value.config!, token))
    await expect(write.handle(seat, request({ operation: 'commit', candidateRevision: 2 }), async () => {
      const result = await store.commit('demo', 2, token)
      current = false
      return result
    })).rejects.toThrow('desktop-package-config-result-uncertain')
    expect(write.outcome()).toBeUndefined()
    expect(await store.loadStable('demo')).toEqual({ revision: 2, config: { label: 'new' } })
    await release()
  } finally {
    await fence.close()
    await rm(root, { recursive: true, force: true })
  }
})
