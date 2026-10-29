import type { CordisXPluginActivationRecordV1 } from '../plugin-lifecycle-contracts.js'
import type { ManagedServiceNodeActivation, ManagedServiceNodeActivationGroup } from './managed-service-node-host.js'

/** Every fleet holds a lease on its shared dependency components. */
export interface ManagedServiceFleetLease {
  readonly activation: ManagedServiceNodeActivationGroup
  readonly plugins: CordisXPluginActivationRecordV1['plugins']
}

export function managedServiceLeases(
  activation: ManagedServiceNodeActivation | undefined,
  record: CordisXPluginActivationRecordV1,
): readonly ManagedServiceFleetLease[] {
  if (activation === undefined) return []
  const groups = activation.groups ?? [{
    ...activation,
    pluginIds: record.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id),
    activeLoopbackPorts: [],
    exclusiveServiceKeys: [],
  }]
  return groups.map(group => ({
    activation: group,
    plugins: record.plugins.filter(plugin => group.pluginIds.includes(plugin.id)),
  }))
}

export function unchangedManagedServiceLease(
  lease: ManagedServiceFleetLease,
  candidate: CordisXPluginActivationRecordV1,
): boolean {
  return lease.plugins.every(previous => {
    const next = candidate.plugins.find(plugin => plugin.id === previous.id)
    return next !== undefined && next.enabled && previous.enabled
      && next.moduleGeneration === previous.moduleGeneration
      && next.digest === previous.digest && next.version === previous.version
      && next.canonicalSource === previous.canonicalSource
      && JSON.stringify(next.dependencies) === JSON.stringify(previous.dependencies)
  })
}

export function managedServiceFleetActivation(
  leases: readonly ManagedServiceFleetLease[],
): ManagedServiceNodeActivation | undefined {
  if (leases.length === 0) return undefined
  const groups = leases.map(lease => lease.activation)
  return {
    hostGeneration: groups[0]!.hostGeneration,
    groups,
    authorities: groups.flatMap(group => group.authorities),
    sources: groups.flatMap(group => group.sources),
    get nativeProviderIds() {
      const ids = groups.flatMap(group => group.nativeProviderIds)
      if (new Set(ids).size !== ids.length) throw new Error('managed native provider is duplicated across generations')
      return ids
    },
    subscribeNativeProviders(listener) {
      const unsubscribe = groups.map(group => group.subscribeNativeProviders(listener))
      return () => {
        for (const stop of unsubscribe) stop()
      }
    },
    prepareNativeConnection(providerId) {
      const owners = groups.filter(group => group.nativeProviderIds.includes(providerId))
      if (owners.length !== 1) throw new Error('native managed provider is unavailable or duplicated')
      return owners[0]!.prepareNativeConnection(providerId)
    },
    async dispose() {
      await Promise.all(groups.map(group => group.dispose()))
    },
  }
}
