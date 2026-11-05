import { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'
import { managedBackendRuntimeServiceAccess } from '../launcher/packages/managed-backend-service-access.js'
import { activateManagedServiceCandidate } from '../launcher/managed-service-candidate.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import type { PluginActivationStore } from '../launcher/plugin-activation.js'

/** Owns production admission wiring; runtime remains the only service producer. */
export function createProductionManagedServiceLifecycle(input: {
  runtime: ConstructorParameters<typeof ManagedServicePluginLifecycleRuntime>[0]['runtime']
  homeDir: string
  profileId: string
  generation: string
  environment: NodeJS.ProcessEnv
  store: PluginActivationStore
  dryRun: boolean
  requireOwnedProcess?: true
}) {
  return new ManagedServicePluginLifecycleRuntime({
    runtime: input.runtime,
    homeDir: input.homeDir,
    profileId: input.profileId,
    runtimeGeneration: input.generation,
    activate: async (activation, options) => {
      if (input.dryRun) return undefined
      const plugins = await loadPluginComposition(input.store, activation)
      const accesses = await Promise.all(plugins.flatMap(plugin => {
        if (
          !plugin.enabled || !options.pluginIds.includes(plugin.id) || plugin.package === undefined
          || (plugin.manifest?.schemaVersion !== 14 && plugin.manifest?.schemaVersion !== 15)
        ) return []
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
              plugin.config,
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
