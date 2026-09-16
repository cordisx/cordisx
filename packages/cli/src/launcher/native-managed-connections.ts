import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import type { NativeManagedGatewayConnection } from './managed-service-native-connection.js'

export interface NativeManagedProviderConnection {
  readonly providerId: string
  readonly connection: NativeManagedGatewayConnection
}

export async function withNativeManagedConnections<Value>(
  activation: Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>,
  run: (connections: readonly NativeManagedProviderConnection[]) => Promise<Value>,
): Promise<Value> {
  const sessions: Array<ReturnType<typeof activation.prepareNativeConnection>> = []
  try {
    const connections = activation.nativeProviderIds.map(providerId => {
      const session = activation.prepareNativeConnection(providerId)
      sessions.push(session)
      return { providerId, connection: session.value }
    })
    return await run(connections)
  } finally {
    for (const session of sessions) session.dispose()
  }
}
