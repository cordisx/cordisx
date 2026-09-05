import { describe, expect, it } from 'vitest'
import { assertProductionGraphLaunchOwnership, buildRendererComposition } from '../packages/cli/src/cli/run.js'
import type { BuildRendererBundleOptions } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { playgroundPluginBundleSnapshot } from '../packages/cli/src/playground/plugin-bundle-fixture.js'

describe('production plugin bundle composition', () => {
  it('requires launcher ownership for a production graph before attach can report readiness', () => {
    expect(() => assertProductionGraphLaunchOwnership(true, true)).toThrow(
      'production browser graphs require a launcher-owned native Host; --attach is unsupported',
    )
    expect(() => assertProductionGraphLaunchOwnership(true, false)).not.toThrow()
    expect(() => assertProductionGraphLaunchOwnership(false, true)).not.toThrow()
  })

  it('publishes the Host snapshot and lifecycle bridge token through initial and rebuilt renderer bundles', async () => {
    const generation = 'production-bundle-generation'
    const activation: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 4,
      lastGoodRevision: 4,
      runtimeGeneration: generation,
      plugins: [],
    }
    const bundles = { ...playgroundPluginBundleSnapshot(generation), profileId: 'work', operationsAvailable: true }
    const config: CordisXConfig = {
      version: 1,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }
    const calls: BuildRendererBundleOptions[] = []
    const composition = await buildRendererComposition(config, () => undefined, {
      profileId: 'work',
      generation,
      pluginLifecycle: { token: 'bundle-lifecycle-token', activation },
      pluginBundles: bundles,
      internalBuildRendererBundle: async (_config, options) => {
        calls.push(options)
        return `bundle-${calls.length}`
      },
    })
    expect(composition.source).toBe('bundle-1')
    expect(composition.hasLoopbackGraph).toBe(false)
    expect(calls[0]).toMatchObject({
      generation,
      pluginLifecycleBridgeToken: 'bundle-lifecycle-token',
      pluginBundleSnapshot: { profileId: 'work', runtimeGeneration: generation, operationsAvailable: true },
    })
    await composition.rebuild(config, activation, 9)
    expect(calls[1]).toMatchObject({
      pluginLifecycleBridgeToken: 'bundle-lifecycle-token',
      pluginBundleSnapshot: { profileId: 'work' },
      pluginActivation: { revision: 4 },
      initialRegistryEpoch: 9,
    })
  })

  it('rebuilds current production metadata with the stable certified document channel', async () => {
    const generation = 'current-production-generation'
    const activation: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 7,
      lastGoodRevision: 7,
      runtimeGeneration: generation,
      plugins: [],
    }
    const config: CordisXConfig = {
      version: 1,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }
    const calls: BuildRendererBundleOptions[] = []
    const composition = await buildRendererComposition(config, () => undefined, {
      profileId: 'work',
      generation,
      permission: { profileId: 'work', policies: [], persistent: true },
      pluginLifecycle: { token: 'lifecycle-token', activation },
      pluginBundles: { ...playgroundPluginBundleSnapshot(generation), profileId: 'work' },
      channelManager: { revision: 1, marker: 'cold-channel-projection' } as never,
      certifiedPermissionChannelToken: 'certified-document-token',
      internalBuildRendererBundle: async (_config, options) => {
        calls.push(options)
        return `bundle-${calls.length}`
      },
    })
    expect(calls).toHaveLength(2)
    const currentBundles = { ...playgroundPluginBundleSnapshot(generation), profileId: 'work', revision: 3 }
    const rebuilt = await composition.rebuild(config, activation, 11, {
      permissionPolicies: [],
      pluginBundles: currentBundles,
    })
    expect(rebuilt).toEqual({ source: 'bundle-3', newDocumentSource: 'bundle-4' })
    expect(calls[2]).toMatchObject({
      pluginActivation: { revision: 7 },
      initialRegistryEpoch: 11,
      pluginBundleSnapshot: { revision: 3 },
      permission: { profileId: 'work', policies: [] },
    })
    expect(calls[2]?.certifiedPermissionChannelToken).toBeUndefined()
    expect(calls[2]?.channelManager).toBeUndefined()
    expect(calls[3]).toMatchObject({
      pluginActivation: { revision: 7 },
      initialRegistryEpoch: 11,
      pluginBundleSnapshot: { revision: 3 },
      certifiedPermissionChannelToken: 'certified-document-token',
    })
  })

  it('reports whether the cold composition contains an enabled loopback graph', async () => {
    const baseConfig: CordisXConfig = {
      version: 1,
      rootDir: process.cwd(),
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id: 'graph-plugin',
        entry: '/fixture/graph-plugin.js',
        enabled: true,
        config: {},
        runtimeGraph: {
          moduleGeneration: 'fixture-generation',
          loadSource: 'Promise.resolve({})',
          publishSource: 'undefined',
          retireSource: 'undefined',
        },
      }],
    }
    const build = async (): Promise<string> => 'fixture-bundle'
    expect(
      (await buildRendererComposition(baseConfig, () => undefined, {
        internalBuildRendererBundle: build,
      })).hasLoopbackGraph,
    ).toBe(true)
    expect(
      (await buildRendererComposition(
        {
          ...baseConfig,
          plugins: baseConfig.plugins.map(plugin => ({ ...plugin, enabled: false })),
        },
        () => undefined,
        { internalBuildRendererBundle: build },
      )).hasLoopbackGraph,
    ).toBe(false)
  })
})
