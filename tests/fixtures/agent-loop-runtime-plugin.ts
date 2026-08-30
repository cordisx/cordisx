import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type BoundAgentLoopClient,
  type CordisXPluginManifestV1,
} from '../../packages/cli/src/contracts.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'agent-loop-runtime',
  name: 'AgentLoop Runtime Fixture',
  capabilities: [
    { name: 'tasks.create', required: true, reason: { key: 'agent-loop.create', fallback: 'Create the AgentLoop task' }, scope: { providers: ['gateway-a'] } },
    { name: 'tasks.content.read', required: true, reason: { key: 'agent-loop.read', fallback: 'Read AgentLoop events' }, scope: { providers: ['gateway-a'] } },
    { name: 'turns.submit', required: true, reason: { key: 'agent-loop.send', fallback: 'Send AgentLoop turns' }, scope: { providers: ['gateway-a'] } },
  ],
} as const satisfies CordisXPluginManifestV1

export const inject = ['agentLoop']

declare global {
  // Test-only public-client capture. Product plugins consume the same fiber-bound service directly.
  // eslint-disable-next-line no-var
  var __cordisxAgentLoopRuntimeFixture: { readonly client: BoundAgentLoopClient } | undefined
}

export function apply(ctx: Context): void {
  globalThis.__cordisxAgentLoopRuntimeFixture = { client: ctx.agentLoop }
  ctx.effect(() => () => {
    delete globalThis.__cordisxAgentLoopRuntimeFixture
  })
}
