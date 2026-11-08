import { createStartupCdpTransport } from '../launcher/startup-cdp-transport.js'
import { diagnostic } from '../diagnostics/context.js'
import { createStartupHostUIBridgeHandler } from '../launcher/startup-host-ui-rpc.js'
import type { ManagedServicePluginLifecycleRuntime } from '../launcher/managed-service-plugin-lifecycle.js'

/** Host and plugin observation share a CDP binding, never an authority token. */
export function createStartupHostBridge(
  lifecycle: ManagedServicePluginLifecycleRuntime,
  profileId: string,
  generation: string,
) {
  const capability = lifecycle.hostStartupCapability()
  const host = createStartupHostUIBridgeHandler({ ...capability, profileId, generation })
  return {
    capability: { token: capability.token },
    transport: createStartupCdpTransport({
      token: capability.token,
      profileId,
      generation,
      onDisconnected: () => diagnostic({ event: 'startup-transport-disconnected' }),
    }),
    async handleBindingValue(payload: string, documentSignal?: AbortSignal): Promise<Record<string, unknown>> {
      let token: unknown
      try {
        token = JSON.parse(payload).token
      } catch { /* Existing route validates malformed requests. */ }
      return token === capability.token
        ? await host.handleBindingValue(payload)
        : await lifecycle.managedServiceUI.handleBindingValue(payload, documentSignal)
    },
    close: () => host.dispose(),
  }
}
