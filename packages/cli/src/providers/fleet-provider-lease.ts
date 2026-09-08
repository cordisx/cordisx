import type { CordisXPlatformResult } from '../contracts.js'
import type { ProviderConnection } from './contracts.js'
import { registryFailure } from './fleet-results.js'

/** Always release the exact provider lease, including a failed adapter call. */
export async function withFleetLease<Value>(
  acquire: () => { readonly adapter: ProviderConnection; release(): void },
  operation: (adapter: ProviderConnection) => Promise<CordisXPlatformResult<Value>>,
): Promise<CordisXPlatformResult<Value>> {
  try {
    const lease = acquire()
    try {
      return await operation(lease.adapter)
    } finally {
      lease.release()
    }
  } catch (error) {
    return registryFailure(error)
  }
}
