import type { StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { StartupPluginAdmission } from './managed-service-startup-admission.js'
import { ManagedServiceStartupAuthority } from './managed-service-startup-authority.js'
import { loadStagedPluginPackage } from './plugin-package.js'

/** Real package declarations are read without importing or preparing plugin code. */
export async function readStartupAdmissions(
  homeDir: string,
  record: CordisXPluginActivationRecordV1,
): Promise<readonly StartupPluginAdmission[]> {
  return (await Promise.all(
    record.plugins.filter(plugin => plugin.enabled).map(async plugin => {
      const staged = await loadStagedPluginPackage(homeDir, plugin.digest)
      const manifest = staged.manifest.runtimeManifest
      if (!('startup' in manifest)) return []
      if (manifest.schemaVersion !== 15) throw new Error('startup declaration requires manifest v15')
      return [
        {
          pluginId: plugin.id,
          pluginGeneration: plugin.moduleGeneration,
          source: staged.identitySource,
          sourceRevision: plugin.digest,
          startup: manifest.startup,
          dependencies: plugin.dependencies.map(dependency => dependency.id),
          services: staged.serviceModules.flatMap(module =>
            module.declaration.kind === 'managed-backend' ? [module.declaration] : []
          ),
        } as StartupPluginAdmission,
      ]
    }),
  )).flat()
}

export interface ManagedServiceStartupSession {
  readonly authority: ManagedServiceStartupAuthority
  /** Core launcher chooses when to await legacy/base adoption; navigation observes immediately. */
  readonly adopted: Promise<void>
  readonly observer: StartupObserverV1
}

export function startupRecordOwners(record: CordisXPluginActivationRecordV1) {
  return record.plugins.filter(plugin => plugin.enabled).map(plugin => ({
    pluginId: plugin.id,
    pluginGeneration: plugin.moduleGeneration,
  }))
}
