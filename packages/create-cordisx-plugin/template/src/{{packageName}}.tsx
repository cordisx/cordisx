import type { Context } from '@deepseek-ai/cordis'
import { defineReactPage } from 'cordisx/react'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXPluginManifestV1,
} from 'cordisx/contracts'
import { type Messages, OverviewPage } from './overview-page.js'

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: '{{pluginId}}',
  name: '{{packageName}}',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

export const inject = ['i18n', 'pages', 'routes', 'slots']

const page = {
  $schema: CORDISX_PAGE_SCHEMA_V3,
  schemaVersion: 3,
  id: 'overview',
  title: { key: 'page.title', fallback: '{{packageName}}' },
  description: { key: 'page.description', fallback: 'A React page rendered by the shared CordisX Host runtime.' },
  icon: 'host:info',
} as const

const route = {
  $schema: CORDISX_ROUTE_SCHEMA_V2,
  schemaVersion: 2,
  id: 'overview',
  path: '/app/{{pluginId}}',
  outlet: 'app',
  page: 'overview',
  title: { key: 'route.title', fallback: '{{packageName}}' },
  description: { key: 'route.description', fallback: 'Open the plugin React example.' },
} as const

const mountOverview = defineReactPage<Messages>(OverviewPage)

export function apply(ctx: Context): void {
  ctx.i18n.define<Messages>({
    namespace: '{{pluginId}}',
    locale: 'en',
    default: true,
    messages: {
      'command.open': 'Open {{packageName}}',
      'page.title': '{{packageName}}',
      'page.description': 'This page uses the React singleton and components provided by CordisX.',
      'route.title': '{{packageName}}',
      'route.description': 'Open the plugin React example.',
      'counter.label': 'Clicked {count, number} times',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: '{{pluginId}}',
    locale: 'zh-CN',
    messages: {
      'command.open': '打开 {{packageName}}',
      'page.title': '{{packageName}}',
      'page.description': '此页面复用 CordisX 提供的 React 单例与组件。',
      'route.title': '{{packageName}}',
      'route.description': '打开插件的 React 示例。',
      'counter.label': '已点击 {count, number} 次',
    },
  })
  ctx.pages.register<Messages>(page, mountOverview)
  ctx.routes.register(route)
  ctx.slots.register({
    name: 'workspace.toolbar.items',
    id: 'open',
    order: 10,
  }, {
    anchor: 'workspace.primary',
    placement: 'after',
    label: { key: 'command.open', fallback: 'Open {{packageName}}' },
    icon: 'host:open',
    route: { id: 'overview' },
  })
}
