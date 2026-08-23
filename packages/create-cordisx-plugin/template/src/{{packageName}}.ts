import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
} from 'cordisx/contracts'
import type {} from 'cordisx/contracts'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: '{{pluginId}}',
  name: '{{packageName}}',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

export const inject = ['i18n', 'commands', 'slots']

export function apply(ctx: Context): void {
  ctx.i18n.define({
    namespace: '{{pluginId}}',
    locale: 'en',
    default: true,
    messages: { 'command.hello': 'Say hello from {{packageName}}' },
  })
  ctx.commands.register({
    id: 'hello',
    title: {
      namespace: '{{pluginId}}',
      key: 'command.hello',
      fallback: 'Say hello from {{packageName}}',
    },
  }, () => console.info('[{{pluginId}}] hello'))
  ctx.slots.register({
    name: 'workspace.toolbar.items',
    id: 'hello',
    order: 10,
  }, {
    anchor: 'workspace.primary',
    placement: 'after',
    label: {
      namespace: '{{pluginId}}',
      key: 'command.hello',
      fallback: 'Say hello from {{packageName}}',
    },
    icon: 'host:open',
    command: { id: 'hello' },
  })
}
