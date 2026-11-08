import type { HomeConfigProfile } from '../config/home-config.js'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import { loadStagedPluginPackage } from '../launcher/plugin-package.js'
import { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import { managedBackendRuntimeServiceAccess } from '../launcher/packages/managed-backend-service-access.js'
import { activateManagedServiceCandidate } from '../launcher/managed-service-candidate.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'

function supportsStartupConfiguration(manifest: CordisXConfigPlugin['manifest']): boolean {
  return manifest?.schemaVersion === 15 && manifest.services.some(service => service.kind === 'managed-backend')
}

/** Owns production admission wiring; runtime remains the only service producer. */
export function createProductionManagedServiceLifecycle(input: {
  runtime: ConstructorParameters<typeof ManagedServicePluginLifecycleRuntime>[0]['runtime']
  homeDir: string
  profileId: string
  generation: string
  environment: NodeJS.ProcessEnv
  store: PluginActivationStore
  dryRun: boolean
  startupConfig?: HomeConfigProfile['managedServiceStartupConfig']
  requireOwnedProcess?: true
  nativeManagedConsole?: ConstructorParameters<typeof ManagedServicePluginLifecycleRuntime>[0]['nativeManagedConsole']
}) {
  const startupConfig = new Map(Object.entries(input.startupConfig ?? {}))
  return new ManagedServicePluginLifecycleRuntime({
    runtime: input.runtime,
    homeDir: input.homeDir,
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    ...(input.nativeManagedConsole === undefined ? {} : { nativeManagedConsole: input.nativeManagedConsole }),
    ...(input.dryRun || startupConfig.size === 0 ? {} : {
      validateInitialActivation: async (activation) => {
        for (const pluginId of startupConfig.keys()) {
          const item = activation.plugins.find(plugin => plugin.id === pluginId)
          if (item === undefined) {
            throw new Error(`managed service startup configuration requires installed plugin ${pluginId}`)
          }
          const staged = await loadStagedPluginPackage(input.homeDir, item.digest)
          if (!supportsStartupConfiguration(staged.manifest.runtimeManifest)) {
            throw new Error(`managed service startup configuration requires a v15 managed backend for ${pluginId}`)
          }
        }
      },
    }),
    activate: async (activation, options) => {
      if (input.dryRun) return undefined
      const plugins = await loadPluginComposition(input.store, activation)
      const accesses = await Promise.all(plugins.flatMap(plugin => {
        if (!plugin.enabled || !options.pluginIds.includes(plugin.id) || plugin.package === undefined) return []
        const explicitConfig = startupConfig.get(plugin.id)
        if (explicitConfig !== undefined && !supportsStartupConfiguration(plugin.manifest)) {
          throw new Error(`managed service startup configuration requires a v15 managed backend for ${plugin.id}`)
        }
        if (plugin.manifest?.schemaVersion !== 14 && plugin.manifest?.schemaVersion !== 15) return []
        return plugin.manifest.services.flatMap(service =>
          service.kind === 'managed-backend'
            ? [managedBackendRuntimeServiceAccess(
              input.homeDir,
              {
                id: plugin.id,
                version: plugin.package!.version,
                digest: plugin.package!.digest,
                moduleGeneration: plugin.package!.moduleGeneration,
              },
              service.id,
              input.generation,
              explicitConfig ?? plugin.config,
            )]
            : []
        )
      }))
      if (accesses.length === 0) return undefined
      return await activateManagedServiceCandidate(accesses, {
        homeDir: input.homeDir,
        environment: input.environment,
        profileId: input.profileId,
        runtimeGeneration: input.generation,
        ...options,
        ...(input.requireOwnedProcess ? { requireOwnedProcess: true as const } : {}),
      })
    },
  })
}
