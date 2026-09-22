import { deepSeekDiscoveryAdapter } from './deepseek.js'
import { openCodeGoDiscoveryAdapter } from './opencode-go.js'
import { openRouterDiscoveryAdapter } from './openrouter.js'
import { DiscoveryAdapterRegistry } from './registry.js'

/** Production registration is closed over built-in Host code, never plugin contributions. */
export function builtinDiscoveryRegistry(): DiscoveryAdapterRegistry {
  return new DiscoveryAdapterRegistry([
    deepSeekDiscoveryAdapter(),
    openCodeGoDiscoveryAdapter(),
    openRouterDiscoveryAdapter(),
  ])
}
