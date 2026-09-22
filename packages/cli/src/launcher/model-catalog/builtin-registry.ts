import { deepSeekDiscoveryAdapter } from './deepseek.js'
import { DiscoveryAdapterRegistry } from './registry.js'

/** Production registration is closed over built-in Host code, never plugin contributions. */
export function builtinDiscoveryRegistry(): DiscoveryAdapterRegistry {
  return new DiscoveryAdapterRegistry([deepSeekDiscoveryAdapter()])
}
