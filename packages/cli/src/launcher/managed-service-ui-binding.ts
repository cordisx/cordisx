import type { ManagedServiceBindingV1 } from '@cordisx/protocol/managed-service/v1'

export function managedServiceUIBindingEqual(left: ManagedServiceBindingV1, right: ManagedServiceBindingV1): boolean {
  return left.bindingId === right.bindingId
    && left.identity.pluginId === right.identity.pluginId
    && left.identity.serviceId === right.identity.serviceId
    && left.identity.source === right.identity.source
    && left.scope.profileId === right.scope.profileId
    && left.scope.generation === right.scope.generation
}
