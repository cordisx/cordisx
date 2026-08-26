import type { Context, Disposable } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXPageMountContext,
  type CordisXPluginManifestV1,
} from '../../../packages/cli/src/contracts.js'

export const name = 'settings-tab-demo'
export const inject = ['i18n', 'slots', 'pages', 'routes', 'managerContent']
export const Config = Schema.object({
  demoValue: Schema.string().default('CordisX').min(1).max(64).pattern(/\S/u)
    .extra('extra', { label: { en: 'Demo value', 'zh-CN': '演示值' } })
    .description('Initial value shown inside the controlled settings page.')
    .i18n({ en: 'Initial value shown inside the controlled settings page.', 'zh-CN': '受控设置页面内显示的初始值。' }),
})
export type SettingsTabDemoConfig = Schemastery.TypeT<typeof Config>
export const configApplies = 'plugin-restart'
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'settings-tab-demo',
  name: 'Settings Navigation Demo',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

interface Messages {
  'body.label': undefined
  'page.description': undefined
  'page.title': undefined
  'route.description': undefined
  'route.title': undefined
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return { namespace: 'settings-demo', key, ...(args[0] === undefined ? {} : { params: args[0] }) }
}

function mountSettingsNavigation(context: CordisXPageMountContext, config: SettingsTabDemoConfig): Disposable<void> {
  const section = context.document.createElement('section')
  section.dataset.settingsNavigationDemoContent = 'mounted'
  Object.assign(section.style, {
    display: 'grid', gap: '12px', maxWidth: '620px', padding: '24px', color: 'inherit',
    font: '14px/1.55 ui-sans-serif, system-ui, sans-serif',
  })
  const label = context.document.createElement('label')
  label.style.display = 'grid'
  label.style.gap = '6px'
  const labelText = context.document.createElement('span')
  context.localization.bindText(labelText, message('body.label'))
  const input = context.document.createElement('input')
  input.dataset.settingsNavigationDemoFocus = 'true'
  input.value = config.demoValue
  Object.assign(input.style, {
    width: 'min(320px, 100%)', boxSizing: 'border-box',
    border: '1px solid color-mix(in srgb, currentColor 12%, transparent)', borderRadius: '8px', padding: '8px 10px',
    background: 'color-mix(in srgb, currentColor 4%, transparent)', color: 'inherit',
  })
  label.append(labelText, input)
  const diagnostic = context.document.createElement('code')
  diagnostic.dataset.settingsNavigationDemoRoute = context.routeId
  diagnostic.textContent = `${context.outlet} · ${context.routeId}`
  diagnostic.style.opacity = '.55'
  section.append(label, diagnostic)
  context.container.append(section)
  context.signal.addEventListener('abort', () => { section.dataset.settingsNavigationDemoAborted = 'true' }, { once: true })
  return () => section.remove()
}

/** Real first-level Manager navigation demo: the Host owns navigation and page chrome. */
export function apply(ctx: Context, config: SettingsTabDemoConfig = Config({})): void {
  ctx.i18n.define<Messages>({
    namespace: 'settings-demo', locale: 'en', default: true,
    messages: {
      'body.label': 'Demo value',
      'page.description': 'Edit the example value for this demo plugin.',
      'page.title': 'Demo plugin settings',
      'route.description': 'Open the demo plugin settings and edit its example value.',
      'route.title': 'Demo plugin settings',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'settings-demo', locale: 'zh-CN',
    messages: {
      'body.label': '演示值',
      'page.description': '编辑此演示插件的示例值。',
      'page.title': '演示插件设置',
      'route.description': '打开“演示插件设置”并编辑示例值。',
      'route.title': '演示插件设置',
    },
  })
  ctx.pages.register<Messages>({
    $schema: CORDISX_PAGE_SCHEMA_V3, schemaVersion: 3, id: 'navigation', title: message('page.title'),
    description: message('page.description'), icon: 'host:settings', chrome: 'standard',
  }, context => mountSettingsNavigation(context, config))
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2, schemaVersion: 2, id: 'navigation', path: '/manager/extensions/settings-tab-demo',
    outlet: 'manager.content', page: 'navigation', title: message('route.title'), description: message('route.description'),
  })
  ctx.managerContent.register({
    $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V1, schemaVersion: 1,
    id: 'root', route: { id: 'navigation' }, header: { title: { kind: 'route' } },
  })
  ctx.slots.register({
    name: 'manager.settings.navigation-items', id: 'navigation', group: 'after-settings', order: 160,
  }, { route: { id: 'navigation' } })
}
