import type { ManagedBrowserConsoleBoundary } from './managed-service-browser-console-broker.js'
import type { NativeManagedConsoleAdapter } from '../shortcuts/managed-console-agent.js'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import { createManagedServiceUIBridgeHandler, type ManagedServiceUIBridgeHandler } from './managed-service-ui-rpc.js'

/** Keep the observation handler/token stable while the owner's component adopts. */
export function managedServiceLiveHandler(
  observation: ManagedServiceUIBridgeHandler,
  readSources: () => ManagedServiceNodeActivation['sources'],
  readNativeProviders: () => Promise<readonly unknown[]>,
  nativeManagedConsole?: () => NativeManagedConsoleAdapter | undefined,
  browserConsoleBoundary?: () => ManagedBrowserConsoleBoundary | undefined,
): ManagedServiceUIBridgeHandler {
  let execution: ManagedServiceUIBridgeHandler | undefined
  let disposed = false
  const activeExecution = () => {
    if (disposed) throw new Error('managed service owner disposed')
    const services = readSources()
    if (services.length === 0) throw new Error('managed service owner adoption pending or unavailable')
    execution ??= createManagedServiceUIBridgeHandler({
      token: observation.token,
      profileId: observation.profileId,
      generation: observation.generation,
      services,
      readNativeProviders,
      ...(nativeManagedConsole === undefined ? {} : { nativeManagedConsole }),
      ...(browserConsoleBoundary === undefined ? {} : { browserConsoleBoundary }),
    })
    return execution
  }
  return {
    token: observation.token,
    profileId: observation.profileId,
    generation: observation.generation,
    async handle(owner, request, documentSignal) {
      if (disposed) throw new Error('managed service owner disposed')
      if (String(request.operation).startsWith('startup')) return await observation.handle(owner, request)
      return await activeExecution().handle(owner, request, documentSignal)
    },
    async prepareAccountToggle(owner, request) {
      const handler = activeExecution()
      if (!handler.prepareAccountToggle) throw new Error('managed service UI account toggle plan is unavailable')
      return await handler.prepareAccountToggle(owner, request)
    },
    async disposeOwner(owner) {
      disposed = true
      await Promise.all([observation.disposeOwner(owner), execution?.disposeOwner(owner)])
    },
    async dispose() {
      disposed = true
      await Promise.all([observation.dispose(), execution?.dispose()])
    },
  }
}
