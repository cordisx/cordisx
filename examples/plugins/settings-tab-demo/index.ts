import type { Context, Disposable } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXPageMountContext,
  type CordisXPluginManifestV1,
} from '../../../packages/cli/src/contracts.js'

export const name = 'settings-tab-demo'
export const inject = ['i18n', 'slots', 'pages', 'routes']
export const Config = Schema.object({
  demoValue: Schema.string().default('CordisX').min(1).max(64).pattern(/\S/u)
    .extra('extra', { label: { en: 'Demo value', 'zh-CN': '演示值' } })
    .description('Initial value shown inside the controlled settings page.')
    .i18n({
      en: 'Initial value shown inside the controlled settings page.',
      'zh-CN': '受控设置页面内显示的初始值。',
    }),
})
export type SettingsTabDemoConfig = Schemastery.TypeT<typeof Config>
export const configApplies = 'plugin-restart'
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'settings-tab-demo',
  name: 'Settings Tab Demo',
  capabilities: [],
} as const satisfies CordisXPluginManifestV1

interface Messages {
  'body.description': undefined
  'body.label': undefined
  'body.title': undefined
  'page.description': undefined
  'route.description': undefined
  'route.title': undefined
  'tab.title': undefined
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return {
    namespace: 'settings-demo',
    key,
    ...(args[0] === undefined ? {} : { params: args[0] }),
  }
}

function mountSettings(context: CordisXPageMountContext, config: SettingsTabDemoConfig): Disposable<void> {
  const section = context.document.createElement('section')
  section.dataset.settingsDemoContent = 'mounted'
  Object.assign(section.style, {
    display: 'grid',
    gap: '12px',
    maxWidth: '620px',
    padding: '24px',
    color: 'inherit',
    font: '14px/1.55 ui-sans-serif, system-ui, sans-serif',
  })

  const title = context.document.createElement('h2')
  title.dataset.settingsDemoBodyTitle = 'true'
  title.style.margin = '0'
  context.localization.bindText(title, message('body.title'))

  const description = context.document.createElement('p')
  description.style.margin = '0'
  description.style.opacity = '.72'
  context.localization.bindText(description, message('body.description'))

  const label = context.document.createElement('label')
  label.style.display = 'grid'
  label.style.gap = '6px'
  const labelText = context.document.createElement('span')
  context.localization.bindText(labelText, message('body.label'))
  const input = context.document.createElement('input')
  input.dataset.settingsDemoFocus = 'true'
  input.value = config.demoValue
  Object.assign(input.style, {
    width: 'min(320px, 100%)',
    boxSizing: 'border-box',
    border: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
    borderRadius: '8px',
    padding: '8px 10px',
    background: 'color-mix(in srgb, currentColor 4%, transparent)',
    color: 'inherit',
  })
  label.append(labelText, input)

  const diagnostic = context.document.createElement('code')
  diagnostic.dataset.settingsDemoRoute = context.routeId
  diagnostic.textContent = `${context.outlet} · ${context.routeId}`
  diagnostic.style.opacity = '.55'

  section.append(title, description, label, diagnostic)
  context.container.append(section)
  context.signal.addEventListener('abort', () => {
    section.dataset.settingsDemoAborted = 'true'
  }, { once: true })
  return () => section.remove()
}

/** Real manager-settings extension demo: structured tab header plus a controlled body-only page. */
export function apply(ctx: Context, config: SettingsTabDemoConfig = Config({})): void {
  ctx.i18n.define<Messages>({
    namespace: 'settings-demo',
    locale: 'en',
    default: true,
    messages: {
      'body.description': 'Settings for this demo plugin.',
      'body.label': 'Demo value',
      'body.title': 'Plugin settings content',
      'page.description': 'Shows the demo value editor in the CordisX settings area while the Host owns the tab header and panel chrome.',
      'route.description': 'Open from the Demo plugin settings tab and mount its controlled body-only settings page in manager.settings.content.',
      'route.title': 'Plugin settings content',
      'tab.title': 'Demo plugin',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'settings-demo',
    locale: 'zh-CN',
    messages: {
      'body.description': '此演示插件的设置。',
      'body.label': '演示值',
      'body.title': '插件设置内容',
      'page.description': '在 CordisX 配置区域展示演示值编辑器，Tab header 与 panel chrome 仍由 Host 所有。',
      'route.description': '从“演示插件”设置 Tab 进入，并在 manager.settings.content 中挂载受控的 body-only 设置页面。',
      'route.title': '插件设置内容',
      'tab.title': '演示插件',
    },
  })

  ctx.pages.register<Messages>({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'settings',
    title: message('body.title'),
    description: message('page.description'),
    chrome: 'body-only',
  }, context => mountSettings(context, config))
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'settings',
    path: '/manager/settings/settings-tab-demo',
    outlet: 'manager.settings.content',
    page: 'settings',
    title: message('route.title'),
    description: message('route.description'),
  })
  ctx.slots.register({
    name: 'manager.settings.tabs',
    id: 'settings',
    order: 150,
  }, {
    title: message('tab.title'),
    icon: 'host:settings',
    route: { id: 'settings' },
  })
}
