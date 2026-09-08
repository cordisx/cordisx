import type { CordisXExactProviderAdapter } from '../renderer/platform.js'
import type { ProviderAdapterRegistry } from '../renderer/provider-registry.js'
import type { ProviderConnection } from './contracts.js'

export function exactProviderAdapter(
  providerId: string,
  connection: ProviderConnection,
): CordisXExactProviderAdapter {
  return {
    listModels: async () => {
      const result = await connection.listModels()
      return result.ok
        ? {
          ok: true,
          value: {
            contract: 'cordisx.platform-model-page/v1',
            schemaVersion: 1,
            providerIds: [providerId],
            models: result.value,
          },
        }
        : result
    },
    readTask: async input => await connection.readSession(input.session),
    createTask: async input => await connection.createSession(input),
    controlTask: async input => await connection.controlSession(input),
    submitTurn: async input => await connection.submitTurn(input),
    controlTurn: async input => await connection.controlTurn(input),
  }
}

export async function withExactProviderGeneration<Value>(
  registry: ProviderAdapterRegistry<ProviderConnection>,
  providerId: string,
  operation: (adapter: CordisXExactProviderAdapter) => Promise<Value>,
): Promise<Value> {
  const lease = registry.acquire(providerId)
  try {
    return await operation(exactProviderAdapter(providerId, lease.adapter))
  } finally {
    lease.release()
  }
}
