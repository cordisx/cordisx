export const name = 'channel-runtime'
export const inject = ['channel']

function validateConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || value.contract !== 'cordisx.channel-service-config/v1' || value.schemaVersion !== 1
    || !Array.isArray(value.connections)) {
    throw new TypeError('Channel service configuration is invalid')
  }
  return value
}
function simulatorDefinition(connection) {
  const sent = new Map()
  return {
    descriptor: {
      ref: connection.ref,
      kind: 'simulator',
      implementationStatus: 'verified',
      configurationRevision: 1,
      secretState: 'unavailable',
    },
    start: async () => ({
      send: async delivery => {
        const prior = sent.get(delivery.deliveryId)
        if (prior !== undefined) return prior
        const result = { externalMessageId: `simulated-${delivery.deliveryId}` }
        sent.set(delivery.deliveryId, result)
        return result
      },
      stop: async () => {},
    }),
  }
}

/**
 * The immutable service artifact owns the simulator only. Official Feishu/Lark
 * definitions are constructed by the launcher-private adapter loader so the
 * Node module never receives a credential value or a secret resolver.
 */
export async function apply(ctx, input) {
  const config = validateConfig(input)
  for (const connection of config.connections) {
    if (!connection.enabled) continue
    if (connection.adapterKind === 'simulator' && connection.transport?.mode === 'simulator') {
      await ctx.channel.adapters.register(simulatorDefinition(connection))
    }
  }
}
