import path from 'node:path'
import { loadStagedPluginPackage, stagedPluginServiceModulePath } from '../plugin-package.js'
import type { PlatformProviderRuntimeServiceModuleAccess } from './authority-access.js'
import { PackageLifecycleError } from './types.js'

export async function platformProviderRuntimeServiceAccess(
  homeDir: string,
  item: {
    readonly id: string
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly moduleGeneration: string
  },
  serviceId: string,
  hostGeneration: string,
): Promise<PlatformProviderRuntimeServiceModuleAccess> {
  const staged = await loadStagedPluginPackage(homeDir, item.digest)
  const service = staged.serviceModules.find(module => module.declaration.id === serviceId)
  if (service === undefined || service.declaration.kind !== 'platform-provider') {
    throw new PackageLifecycleError(
      'service-not-found',
      `${item.id}:${serviceId} is not a Platform provider service`,
    )
  }
  const servicePath = stagedPluginServiceModulePath(homeDir, item.digest, serviceId)
  return {
    packageIdentity: { pluginId: item.id, version: item.version, integrity: item.digest },
    pluginIdentity: {
      source: staged.identitySource,
      pluginId: item.id,
      generation: item.moduleGeneration,
    },
    serviceId,
    hostGeneration,
    serviceKind: 'platform-provider',
    owner: service.declaration.owner,
    schema: service.declaration.schema,
    applicationMode: service.declaration.applicationMode,
    artifactDirectory: path.dirname(path.dirname(servicePath)),
    runtimeEntry: `./services/${serviceId}.mjs`,
  }
}
