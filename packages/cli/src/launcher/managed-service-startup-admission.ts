import type { StartupCapabilityRefV1, StartupDeclarationV1 } from '@cordisx/protocol/startup/v1'
import type { PluginManifestManagedBackendServiceV14 } from '@cordisx/protocol/plugin-manifest/v14'

export interface StartupPluginAdmission {
  readonly pluginId: string
  readonly pluginGeneration: string
  readonly source: string
  readonly sourceRevision: string
  readonly startup: StartupDeclarationV1
  readonly services: readonly PluginManifestManagedBackendServiceV14[]
  readonly dependencies: readonly string[]
}

export function startupCapabilityKey(ref: StartupCapabilityRefV1): string {
  return `${ref.pluginId}\u0000${ref.capabilityId}`
}

/** Graph checks supplement (never replace) manifest schema validation. */
export function validateStartupAdmissions(plugins: readonly StartupPluginAdmission[]): void {
  const owners = new Map(plugins.map(plugin => [plugin.pluginId, plugin]))
  if (owners.size !== plugins.length) throw new Error('duplicate startup plugin identity')
  const capabilities = new Map(
    plugins.flatMap(plugin =>
      plugin.startup.capabilities.map(capability =>
        [startupCapabilityKey({ pluginId: plugin.pluginId, capabilityId: capability.id }), {
          plugin,
          capability,
        }] as const
      )
    ),
  )
  const providers = new Set<string>()
  let count = 0
  const resolve = (ref: StartupCapabilityRefV1, consumer: StartupPluginAdmission) => {
    const target = capabilities.get(startupCapabilityKey(ref))
    if (target === undefined) throw new Error('startup capability dependency is unknown')
    if (
      target.plugin.pluginId !== consumer.pluginId && (!consumer.dependencies.includes(target.plugin.pluginId)
        || !target.plugin.services.find(service => service.id === target.capability.serviceId)?.consumerGrants
          .some(grant => grant.pluginId === consumer.pluginId))
    ) {
      throw new Error('startup dependency has no package dependency or service grant')
    }
    return target
  }
  for (const plugin of plugins) {
    for (const capability of plugin.startup.capabilities) {
      count += 1
      if (!plugin.services.some(service => service.id === capability.serviceId)) {
        throw new Error('startup service is unknown')
      }
      if (capability.kind === 'provider') {
        if (providers.has(capability.providerId)) throw new Error('duplicate startup provider identity')
        providers.add(capability.providerId)
      }
      const kinds = new Set(capability.success.allOf.map(condition => condition.kind))
      if (
        !kinds.has('service-ready') || (capability.kind === 'provider'
          && (!kinds.has('catalog-known') || !kinds.has('provider-published')))
      ) throw new Error('startup success conditions are incomplete')
      if (new Set(capability.milestones).size !== capability.milestones.length) {
        throw new Error('duplicate startup milestone')
      }
      for (const condition of capability.success.allOf) {
        if (condition.kind === 'milestone' && !capability.milestones.includes(condition.milestoneId)) {
          throw new Error('startup milestone is undeclared')
        }
        if (
          capability.kind !== 'provider'
          && (condition.kind === 'catalog-known' || condition.kind === 'provider-published')
        ) throw new Error('startup provider condition has no provider')
      }
      for (const ref of capability.dependsOn) resolve(ref, plugin)
    }
    const pageIds = new Set<string>()
    for (const page of plugin.startup.pages) {
      if (
        pageIds.has(page.pageId) || new Set(page.actions.map(action => action.actionId)).size !== page.actions.length
      ) throw new Error('duplicate startup page or action')
      pageIds.add(page.pageId)
      for (const ref of [...page.observes, ...page.actions.flatMap(action => action.requires)]) resolve(ref, plugin)
    }
  }
  if (capabilities.size !== count) throw new Error('duplicate startup capability identity')
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error('startup dependency cycle')
    if (visited.has(key)) return
    visiting.add(key)
    for (const ref of capabilities.get(key)!.capability.dependsOn) visit(startupCapabilityKey(ref))
    visiting.delete(key)
    visited.add(key)
  }
  for (const key of capabilities.keys()) visit(key)
}
