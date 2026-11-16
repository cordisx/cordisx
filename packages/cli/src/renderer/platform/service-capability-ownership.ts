import type { CordisXPluginIdentity } from '../../contracts.js'
import type { CordisXPermissionCapabilityV2 } from '../../permission-contracts.js'
import { normalizePermissionScopeV2 } from '../../permission-model-v2.js'
import type {
  RegisteredServiceCapabilityOwner,
  RuntimeServiceCapabilityOwner,
} from '../../service-capability-ownership.js'
import type { PluginGenerationEffectIdentity } from '../generation-visibility.js'

/** Only the Host constructs this registry from its successfully started services. */
export class ServiceCapabilityOwnership {
  private readonly owners: readonly RuntimeServiceCapabilityOwner[]

  constructor(owners: readonly RuntimeServiceCapabilityOwner[], private readonly runtimeGeneration: string) {
    this.owners = Object.freeze(owners.map(owner =>
      Object.freeze({
        ...owner,
        capabilities: Object.freeze(owner.capabilities.map(capability =>
          Object.freeze({
            name: capability.name,
            scope: normalizePermissionScopeV2(capability.scope),
          })
        )),
      })
    ))
  }

  bind(
    identity: CordisXPluginIdentity,
    generation: PluginGenerationEffectIdentity,
    manifest: { readonly services?: readonly { readonly id: string; readonly kind: string }[] },
    registrationToken: object,
  ): ReadonlyMap<CordisXPermissionCapabilityV2, RegisteredServiceCapabilityOwner> {
    const capabilities = new Map<CordisXPermissionCapabilityV2, RegisteredServiceCapabilityOwner>()
    if (!generation.moduleGeneration || generation.pluginId !== identity.id) return capabilities
    for (const owner of this.owners) {
      if (
        owner.runtimeGeneration !== this.runtimeGeneration || !owner.serviceGeneration
        || owner.source !== identity.source || owner.pluginId !== identity.id
        || owner.moduleGeneration !== generation.moduleGeneration
        || !manifest.services?.some(service => service.id === owner.serviceId && service.kind === owner.serviceKind)
      ) continue
      for (const capability of owner.capabilities) {
        // Two providers cannot silently claim the same management namespace.
        if (capabilities.has(capability.name)) throw new Error('Ambiguous service capability owner')
        capabilities.set(
          capability.name,
          Object.freeze({
            registrationToken,
            source: owner.source,
            pluginId: owner.pluginId,
            serviceId: owner.serviceId,
            serviceKind: owner.serviceKind,
            serviceGeneration: owner.serviceGeneration,
            runtimeGeneration: owner.runtimeGeneration,
            moduleGeneration: generation.moduleGeneration,
            scope: capability.scope,
          }),
        )
      }
    }
    return capabilities
  }
}
