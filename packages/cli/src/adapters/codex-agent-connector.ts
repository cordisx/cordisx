import type { CordisXAgentAdapter } from '../renderer/agent.js'
import { CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1, type CordisXHostConnector } from '../renderer/connectors.js'

/**
 * Built-in Connector boundary for the real Host Agent adapter only.
 *
 * The current Host has no audited current-connection command seat. This adapter
 * intentionally does not inspect renderer globals, create an app-server, or
 * project a raw bridge. Every native operation consequently remains typed
 * unavailable until an audited Host Agent connector operation exists.
 */
export function createCodexAgentConnector(agent: Pick<CordisXAgentAdapter, 'agentStatus'>): CordisXHostConnector {
  return {
    descriptor: Object.freeze({
      $schema: CORDISX_CONNECTOR_DESCRIPTOR_SCHEMA_V1,
      contract: 'cordisx.connector-service-descriptor/v1' as const,
      schemaVersion: 1 as const,
      connectorId: 'agent.connector',
      protocolVersion: 1 as const,
      capabilities: Object.freeze(
        [
          'conversation.open',
          'conversation.continue',
          'message.send',
          'events.receive',
          'run.stop',
          'conversation.close',
          'lifecycle.dispose',
        ] as const,
      ),
    }),
    async available() {
      const status = agent.agentStatus()
      const diagnostic = status.diagnostics.find(item => item.code === 'current-connection-client-unavailable')
      return {
        ok: false as const,
        error: {
          code: 'current-connection-client-unavailable' as const,
          message: diagnostic?.message ?? 'The Host Agent current connection is unavailable to the Connector broker',
          retryable: true,
        },
      }
    },
    async execute() {
      return {
        ok: false as const,
        error: {
          code: 'current-connection-client-unavailable' as const,
          message: 'The Host Agent Connector has no audited current-connection command seat',
          retryable: true,
        },
      }
    },
  }
}
