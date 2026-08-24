import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from '../../packages/cli/src/contracts.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'platform-required',
  name: 'Platform Required Fixture',
  capabilities: [
    {
      name: 'models.read',
      required: true,
      reason: { key: 'permission.required', fallback: 'Models are required for this fixture' },
      scope: {},
    },
    {
      name: 'tasks.catalog.read',
      required: false,
      reason: { key: 'permission.optional', fallback: 'Task catalog access is optional for this fixture' },
      scope: {},
    },
  ],
} as const satisfies CordisXPluginManifestV1

export function apply(ctx: Context): void {
  document.documentElement.dataset.platformRequiredMounted = 'true'
  ctx.effect(() => () => {
    delete document.documentElement.dataset.platformRequiredMounted
  })
}
