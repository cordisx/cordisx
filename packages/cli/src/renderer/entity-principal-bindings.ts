import type { EntityPrincipalBinding } from './entities.js'
import type { CordisXRuntimeMetadata } from './runtime-shared.js'

/** Collect the owner-proved entity principals for initial and later plugin generations. */
export function createEntityPrincipalBindings(initial: CordisXRuntimeMetadata['ownerDocumentBindings']) {
  const bindings = new Map<string, EntityPrincipalBinding>()
  const register = (values: CordisXRuntimeMetadata['ownerDocumentBindings']): void => {
    for (const binding of values ?? []) {
      if (binding.installationId !== undefined && binding.pluginGeneration !== undefined) {
        bindings.set(
          JSON.stringify([binding.source, binding.pluginId, binding.moduleGeneration]),
          binding as EntityPrincipalBinding,
        )
      }
    }
  }
  register(initial)
  return { bindings, register }
}
