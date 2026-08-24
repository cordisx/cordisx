import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from '../../packages/cli/src/contracts.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'agent-events-required',
  name: 'Agent Events Required Fixture',
  capabilities: [
    {
      name: 'agent.events.read',
      required: true,
      reason: { key: 'permission.required', fallback: 'Agent events are required for this fixture' },
      scope: {},
    },
    {
      name: 'agent.history.read',
      required: false,
      reason: { key: 'permission.optional', fallback: 'Agent history is optional for this fixture' },
      scope: {},
    },
  ],
} as const satisfies CordisXPluginManifestV1

export function apply(ctx: Context): void {
  document.documentElement.dataset.agentEventsRequiredMounted = 'true'
  ctx.effect(() => () => {
    delete document.documentElement.dataset.agentEventsRequiredMounted
  })
}
