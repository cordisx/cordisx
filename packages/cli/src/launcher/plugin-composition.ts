import type { CordisXConfigPlugin } from './config.js'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import { PluginActivationStore, topologicalPluginOrder } from './plugin-activation.js'
import { loadStagedPluginPackage, stagedPluginModulePath } from './plugin-package.js'
import { PackagePluginConfigStore } from './package-plugin-config.js'

/** Load and integrity-check the durable package set for initial renderer composition. */
export async function loadActivatedPluginComposition(
  store: PluginActivationStore,
): Promise<readonly CordisXConfigPlugin[]> {
  const active = await store.bindRuntimeGeneration()
  return await loadPluginComposition(store, active)
}

/** Compose an authority-selected activation tuple without publishing it durable. */
export async function loadPluginComposition(
  store: PluginActivationStore,
  active: CordisXPluginActivationRecordV1,
): Promise<readonly CordisXConfigPlugin[]> {
  const configs = new PackagePluginConfigStore(store.homeDir, store.profileId, store.runtimeGeneration)
  const byId = new Map(active.plugins.map(item => [item.id, item]))
  const output: CordisXConfigPlugin[] = []
  for (const id of topologicalPluginOrder(active.plugins)) {
    const item = byId.get(id)!
    const staged = await loadStagedPluginPackage(store.homeDir, item.digest)
    const configuration = await configs.load(item.id)
    if (
      staged.manifest.id !== item.id
      || staged.manifest.version !== item.version
      || JSON.stringify(staged.manifest.dependencies) !== JSON.stringify(item.dependencies)
    ) {
      throw new Error(`active plugin package metadata failed readback for ${item.id}`)
    }
    output.push({
      id: item.id,
      entry: stagedPluginModulePath(store.homeDir, item.digest),
      source: staged.identitySource,
      enabled: item.enabled,
      config: configuration.config,
      revision: configuration.revision,
      manifest: staged.manifest.runtimeManifest,
      package: {
        version: item.version,
        digest: item.digest,
        moduleGeneration: item.moduleGeneration,
        dependencies: item.dependencies,
        ...(item.canonicalSource === undefined ? {} : { canonicalSource: item.canonicalSource }),
      },
      ...(staged.readme === undefined ? {} : { readme: staged.readme }),
    })
  }
  return output
}
