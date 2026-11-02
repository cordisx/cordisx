import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import { managedBackendRuntimeServiceAccess } from '../packages/cli/src/launcher/packages/managed-backend-service-access.js'
import { snapshotManagedServiceConfigurations } from '../packages/cli/src/launcher/managed-service-instance-configuration.js'
import { declaration, deferred } from './managed-service-runtime-fixture.js'

const packageFixture = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../packages/cli/src/launcher/plugin-package.js', () => ({
  loadStagedPluginPackage: packageFixture.load,
  stagedPluginServiceModulePath: () => '/fixture/artifact/services/gateway.mjs',
}))
const item = { id: 'example', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` as const, moduleGeneration: 'one' }
function staged(legacy = false) {
  const service = declaration('gateway', 'example', [])
  return {
    identitySource: 'https://example.test/plugin',
    serviceModules: [{ declaration: service }],
    managedServiceResources: service.runtimeResources,
    manifest: {
      runtimeManifest: legacy
        ? {}
        : { startup: { contract: 'cordisx.startup-declaration/v1', pages: [], capabilities: [] } },
      dependencies: [],
    },
  }
}

describe('selected profile configuration access', () => {
  it('uses only the selected profile value, captures before package I/O and rejects divergent same-generation siblings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-selected-config-'))
    try {
      const work = new PackagePluginConfigStore(root, 'work', 'runtime')
      const other = new PackagePluginConfigStore(root, 'other', 'runtime')
      await work.stage('example', 0, { root: './work' }, 'owner')
      await work.commit('example', 1, 'owner')
      await other.stage('example', 0, { root: './other' }, 'owner')
      await other.commit('example', 1, 'owner')
      const selected = (await work.load('example')).config as { root: string }
      const loading = deferred<ReturnType<typeof staged>>()
      packageFixture.load.mockReturnValueOnce(loading.promise)
      const pending = managedBackendRuntimeServiceAccess(root, item, 'gateway', 'host', selected)
      selected.root = './late'
      loading.resolve(staged())
      const access = await pending
      expect(access.selectedConfiguration).toEqual({ root: './work' })
      const pair = snapshotManagedServiceConfigurations([access, { ...access, serviceId: 'status' }])
      expect(pair[0]!.selectedConfiguration).toBe(pair[1]!.selectedConfiguration)
      expect(() =>
        snapshotManagedServiceConfigurations([access, { ...access, selectedConfiguration: { root: './other' } }])
      ).toThrow('differs within one plugin generation')
      expect((await other.load('example')).config).toEqual({ root: './other' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('omits configuration for v14 even for invalid input, keeps empty/missing v15 selection compatible', async () => {
    packageFixture.load.mockResolvedValueOnce(staged(true))
    const legacy = await managedBackendRuntimeServiceAccess('/unused', item, 'gateway', 'host', { bad: () => {} })
    expect(legacy).not.toHaveProperty('selectedConfiguration')
    expect(legacy).not.toHaveProperty('startup')
    packageFixture.load.mockResolvedValueOnce(staged())
    const omitted = await managedBackendRuntimeServiceAccess('/unused', item, 'gateway', 'host')
    expect(omitted).not.toHaveProperty('selectedConfiguration')
    packageFixture.load.mockResolvedValueOnce(staged())
    expect((await managedBackendRuntimeServiceAccess('/unused', item, 'gateway', 'host', {})).selectedConfiguration)
      .toEqual({})
  })
})
