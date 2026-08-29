import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from '../../packages/cli/src/contracts.js'

export const inject = ['connectors']

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'connector-public-client',
  name: 'Connector Public Client Fixture',
  capabilities: [{
    name: 'agent.events.read',
    required: false,
    reason: { key: 'connector.events.read', fallback: 'Read Connector discovery and events for this fixture' },
    scope: {},
  }],
} as const satisfies CordisXPluginManifestV1

interface FixtureState {
  readonly client: Context['connectors']
}

declare global {
  var __cordisxConnectorPublicClientFixture: FixtureState | undefined
}

export function apply(ctx: Context): void {
  document.documentElement.dataset.connectorPublicClientMounted = 'true'
  globalThis.__cordisxConnectorPublicClientFixture = { client: ctx.connectors }
  ctx.effect(() => () => {
    delete document.documentElement.dataset.connectorPublicClientMounted
    ctx.connectors.dispose()
  })
}
