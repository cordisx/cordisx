import { ManagedServiceNodeHost } from './managed-service-node-host.js'
import { ManagedServiceRuntime } from './managed-service-runtime.js'
import type { ManagedBackendRuntimeServiceModuleAccess } from './packages/authority-access.js'

/** Same production candidate activation path for cold startup and durable mutations. */
export async function activateManagedServiceCandidate(
  accesses: readonly ManagedBackendRuntimeServiceModuleAccess[],
  options: {
    readonly homeDir: string
    readonly environment: NodeJS.ProcessEnv
    readonly profileId: string
    readonly runtimeGeneration: string
    readonly isolateStartupFailures: boolean
    readonly reservedLoopbackPorts?: readonly number[]
    readonly reservedServiceKeys?: readonly string[]
  },
) {
  const host = new ManagedServiceNodeHost(
    new ManagedServiceRuntime(options),
    options.profileId,
    options.runtimeGeneration,
  )
  try {
    return await host.replace(accesses, options)
  } catch (error) {
    await host.dispose().catch(() => undefined)
    throw error
  }
}
