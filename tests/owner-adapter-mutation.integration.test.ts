import { mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { loadOwnerAdapterMutation } from '../packages/cli/src/cli/owner-adapter-mutation.js'
import { removeStagedPluginPackage, stageLocalPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { localPackage } from './suites/plugin-lifecycle.fixtures.js'

it('loads only the owner-selected package and loopback graph for a native adapter', async () => {
  const root = await mkdtemp('/tmp/cx-adapter-mutation-')
  const homeDir = path.join(root, 'home')
  try {
    const staged = await stageLocalPluginPackage(homeDir, await localPackage({ root, id: 'native-fixture' }))
    const previous: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'default',
      runtimeGeneration: 'owner-1',
      revision: 0,
      lastGoodRevision: 0,
      plugins: [],
    }
    const candidate: CordisXPluginActivationRecordV1 = {
      ...previous,
      recordKind: 'candidate',
      transactionId: 'tx',
      revision: 1,
      plugins: [{
        id: staged.manifest.id,
        version: staged.manifest.version,
        digest: staged.digest,
        moduleGeneration: 'module-1',
        enabled: true,
        dependencies: staged.manifest.dependencies,
      }],
    }
    const leaseId = 'b'.repeat(64)
    const baseUrl = `http://127.0.0.1:4567/cordisx-plugin-artifacts/${'a'.repeat(64)}/${leaseId}/`
    const graph = {
      leaseId,
      pluginId: 'native-fixture',
      moduleGeneration: 'module-1',
      baseUrl,
      entryUrl: `${baseUrl}entry.js`,
      initialStyleUrls: [`${baseUrl}style.css`],
    }
    const value = {
      rendererId: 'c'.repeat(64),
      transactionId: 'tx',
      transactionEpoch: 'tx:epoch',
      expectedRegistryEpoch: 2,
      afterRegistryEpoch: 3,
      operation: 'install',
      previous,
      candidate,
      targetId: 'native-fixture',
      affectedPluginIds: ['native-fixture'],
      package: { manifest: staged.manifest, digest: staged.digest, identitySource: staged.identitySource },
      privateGraphs: [graph],
    }
    const input = { homeDir, profileId: 'default', generation: 'owner-1', rendererId: value.rendererId }
    const result = await loadOwnerAdapterMutation({ ...input, value })
    expect(result.package?.digest).toBe(staged.digest)
    expect(result.runtimeArtifactLeases?.[0]).toMatchObject({
      leaseId,
      pluginId: 'native-fixture',
      moduleGeneration: 'module-1',
      baseUrl,
    })
    await expect(loadOwnerAdapterMutation({
      ...input,
      value: { ...value, privateGraphs: [{ ...graph, entryUrl: 'https://example.com/entry.js' }] },
    })).rejects.toThrow('adapter-graph-invalid')
    await expect(loadOwnerAdapterMutation({
      ...input,
      value: { ...value, package: { ...value.package, identitySource: 'https://example.com/other' } },
    })).rejects.toThrow('adapter-mutation-invalid')
    await expect(loadOwnerAdapterMutation({
      ...input,
      value: { ...value, rendererId: 'd'.repeat(64) },
    })).rejects.toThrow('adapter-mutation-invalid')
  } finally {
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
