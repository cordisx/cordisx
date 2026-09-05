import { describe, expect, it } from 'vitest'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import type { BuildRendererBundleOptions } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { playgroundPluginBundleSnapshot } from '../packages/cli/src/playground/plugin-bundle-fixture.js'

describe('production plugin bundle composition', () => {
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
})
