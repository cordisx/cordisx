import type {
  ManagedServiceNodeModuleV1,
  ManagedServiceNodeUISourceExtensionV1,
} from '@cordisx/protocol/managed-service-context/v1'
import type { ManagedServiceIdentityV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceWebEntryNodeModuleV1 } from '@cordisx/protocol/managed-service-web-entry-runtime/v1'
import type { ManagedServiceActivationBinding, ManagedServiceRuntime } from './managed-service-runtime.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from './packages/authority-access.js'
import { createManagedServiceSource, type ManagedServiceNodeSourceBinding } from './managed-service-ui-source.js'

/** Sources become visible only at their complete component's adoption boundary. */
export function adoptedManagedServiceSource(
  state: {
    readonly access: ManagedBackendRuntimeServiceModuleAccess
    readonly binding: ManagedServiceActivationBinding
    readonly module: ManagedServiceNodeModuleV1 | undefined
  },
  runtime: ManagedServiceRuntime,
  profileId: string,
  runtimeGeneration: string,
): ManagedServiceNodeSourceBinding | undefined {
  const identity: ManagedServiceIdentityV1 = {
    source: state.access.pluginIdentity.source as `https://${string}`,
    pluginId: state.access.pluginIdentity.pluginId,
    serviceId: state.access.declaration.id,
  }
  const handle = runtime.getRegistrationHandle(identity)
  if (handle === undefined) return undefined
  const authMode = runtime.getAuthenticationMode(identity) ?? 'none'
  const declaration = state.access.declaration
  const sourceOptions = {
    profileId,
    runtimeGeneration,
    registrationHandle: handle,
    healthIntervalMs: runtime.getHealthIntervalMs(identity) ?? 30_000,
    displayName: declaration.id,
    serviceKind: 'managed-backend',
    pluginId: identity.pluginId,
    pluginGeneration: state.access.pluginIdentity.generation,
    serviceId: identity.serviceId,
    source: identity.source,
    authenticationMode: authMode,
    logoutAvailable: runtime.supportsLogout(identity),
    ...(state.module!.managedServiceUI === undefined
      ? {}
      : {
        extensionFactory: (
          binding: Parameters<
            NonNullable<ManagedServiceNodeModuleV1['managedServiceUI']>['create']
          >[0]['binding'],
        ) => {
          const ui = state.module!.managedServiceUI!
          if (ui.serviceId !== identity.serviceId || typeof ui.create !== 'function') {
            throw new Error('managed service UI source declaration is invalid')
          }
          const extension: ManagedServiceNodeUISourceExtensionV1 = ui.create({
            binding,
            registration: handle,
            client: state.binding.client,
            signal: state.binding.signal,
          })
          if (extension === null || typeof extension !== 'object') {
            throw new Error('managed service UI source extension is invalid')
          }
          return extension
        },
      }),
  }
  const source = createManagedServiceSource(sourceOptions)
  const module = state.module as
    | (ManagedServiceWebEntryNodeModuleV1 & {
      readonly managedServiceConsole?: unknown
      readonly managedServiceBrowserConsole?: unknown
    })
    | undefined
  const webEntryDeclaration = module?.managedServiceWebEntry
  const webEntry = webEntryDeclaration === undefined
    ? undefined
    : runtime.bindWebEntry(
      identity,
      state.binding.owner,
      webEntryDeclaration,
      state.binding.signal,
      module?.managedServiceConsole,
      module?.managedServiceBrowserConsole,
    )
  const loginTimeoutMs = runtime.getLoginTimeoutMs(identity)
  return Object.freeze({
    pluginId: identity.pluginId,
    pluginGeneration: state.access.pluginIdentity.generation,
    serviceId: identity.serviceId,
    ...(loginTimeoutMs === undefined ? {} : { loginTimeoutMs }),
    source,
    ...(webEntry === undefined ? {} : { webEntry }),
  })
}
