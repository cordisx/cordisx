import path from 'node:path'
import type { CordisXConfig } from '../launcher/config.js'
import { loadConfig } from '../launcher/config.js'
import { loadHomeConfig } from '../config/home-config.js'
import type { CdpPluginLifecycleRuntime, WatchInjectionOptions } from '../launcher/cdp.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import {
  assertProductionGraphBootstrapSnapshot,
  configuredPluginTopology,
  type RendererComposition,
  usesIsolatedPackageWorker,
} from './renderer-composition.js'

/** Rebuild a native document from the service owner's durable activation and the client's CDP leases. */
export function createOwnerAdapterGraphBootstrap(input: {
  readonly renderer: RendererComposition
  readonly configured: CordisXConfig
  readonly configPath: string
  readonly profileId: string
  readonly store: PluginActivationStore
  readonly cdp: CdpPluginLifecycleRuntime
  readonly current: () => boolean
}): NonNullable<WatchInjectionOptions['productionGraphBootstrap']> {
  const topology = configuredPluginTopology(input.configured)
  const read = async () => {
    if (!input.current()) throw new Error('adapter-owner-unavailable')
    const active = await input.store.loadActive()
    const registryEpoch = input.cdp.currentRegistryEpoch()
    const [configured, plugins, home] = await Promise.all([
      loadConfig(input.configPath, { profileId: input.profileId, projectRoot: path.dirname(input.configPath) }),
      loadPluginComposition(input.store, active),
      loadHomeConfig(input.configPath),
    ])
    if (configuredPluginTopology(configured) !== topology) throw new Error('adapter-configured-topology-changed')
    const currentPlugins = await Promise.all(plugins.map(async plugin => {
      if (!plugin.enabled || plugin.package === undefined || usesIsolatedPackageWorker(plugin)) return plugin
      const staged = await loadStagedPluginPackage(path.dirname(input.configPath), plugin.package.digest)
      if (!staged.browserArtifact) return plugin
      const graph = input.cdp.activeBrowserGraph(plugin.id, plugin.package.moduleGeneration)
      if (!graph) throw new Error('adapter-plugin-graph-unavailable')
      return { ...plugin, runtimeGraph: graph }
    }))
    if (!input.current()) throw new Error('adapter-owner-unavailable')
    const policies = home.permissions.filter(policy => policy.key.profileId === input.profileId)
    const composition = { ...configured, plugins: [...configured.plugins, ...currentPlugins] }
    return {
      active,
      registryEpoch,
      policies,
      composition,
      fingerprint: JSON.stringify({ active, registryEpoch, policies, composition }),
    }
  }
  return async (active, registryEpoch) => {
    const before = await read()
    assertProductionGraphBootstrapSnapshot(active, registryEpoch, before)
    const rebuilt = await input.renderer.rebuild(before.composition, before.active, registryEpoch, {
      permissionPolicies: before.policies,
    })
    const after = await read()
    if (before.fingerprint !== after.fingerprint) throw new Error('adapter-graph-bootstrap-changed')
    return rebuilt
  }
}
