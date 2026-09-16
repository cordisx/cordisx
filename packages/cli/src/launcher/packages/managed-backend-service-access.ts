import path from 'node:path'
import { managedServiceResourceMatchesTarget } from '../managed-service-package-resources.js'
import { loadStagedPluginPackage, stagedPluginServiceModulePath } from '../plugin-package.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from './authority-access.js'
import { PackageLifecycleError } from './types.js'

export async function managedBackendRuntimeServiceAccess(
  homeDir: string,
  item: {
    readonly id: string
    readonly version: string
    readonly digest: `sha256:${string}`
    readonly moduleGeneration: string
  },
  serviceId: string,
  hostGeneration: string,
): Promise<ManagedBackendRuntimeServiceModuleAccess> {
  const staged = await loadStagedPluginPackage(homeDir, item.digest)
  const service = staged.serviceModules.find(module => module.declaration.id === serviceId)
  if (service === undefined || service.declaration.kind !== 'managed-backend') {
    throw new PackageLifecycleError(
      'service-not-found',
      `${item.id}:${serviceId} is not a managed backend service`,
    )
  }
  const servicePath = stagedPluginServiceModulePath(homeDir, item.digest, serviceId)
  const selected = service.declaration.runtimeResources.filter(resource =>
    managedServiceResourceMatchesTarget(resource)
  )
  const runtimeResources = selected.map(declaration => {
    const resource = staged.managedServiceResources.find(candidate => candidate.path === declaration.path)
    if (
      resource === undefined || resource.mode !== declaration.mode || resource.byteLength !== declaration.byteLength
      || resource.digest !== declaration.digest
    ) throw new Error(`managed backend resource ${declaration.path} failed service authority readback`)
    return { path: resource.path, mode: resource.mode, byteLength: resource.byteLength, digest: resource.digest }
  })
  return {
    packageIdentity: { pluginId: item.id, version: item.version, integrity: item.digest },
    pluginIdentity: {
      source: staged.identitySource,
      pluginId: item.id,
      generation: item.moduleGeneration,
    },
    serviceId,
    hostGeneration,
    serviceKind: 'managed-backend',
    declaration: service.declaration,
    artifactDirectory: path.dirname(path.dirname(servicePath)),
    runtimeEntry: `./services/${serviceId}.mjs`,
    runtimeResources,
  }
}
