import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from '../../../packages/cli/src/contracts.js'
import type {} from '../../../packages/cli/src/contracts.js'

export const name = 'Plugin Console Showcase'
export const inject = ['platform', 'settings']
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'console-showcase',
  name,
  capabilities: [{
    name: 'models.read',
    required: false,
    reason: { key: 'console.models', fallback: 'Exercise one permissioned Host API call in the Console showcase' },
    scope: {},
  }],
} as const satisfies CordisXPluginManifestV1

export function apply(ctx: Context): void {
  // These are ordinary Console calls. The launcher supplies a lexical owner-scoped facade.
  console.debug('debug=%d', 1)
  console.log('object and array', { nested: { ok: true } }, [1, 2, 3])
  console.info('bigint=%s', 42n, new Error('inspectable error'))
  console.warn('warning', { circular: (() => { const value: Record<string, unknown> = {}; value.self = value; return value })() })
  console.error('showcase failure payload', new Error('expected demo error'))

  // Host instrumentation records both calls independently of the messages above.
  ctx.settings.get()
  void ctx.platform.models.list()
}
