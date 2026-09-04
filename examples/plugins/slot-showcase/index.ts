import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineReactPage } from 'cordisx/react'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXPluginManifestV1,
  type CordisXPluginPresentation,
  type CordisXEnvironmentRow,
  type CordisXLocalizedText,
  type CordisXMessageParams,
} from '../../../packages/cli/src/contracts.js'
import type {} from '../../../packages/cli/src/contracts.js'
import { ShowcasePage } from './view.js'

export const name = 'structured-showcase'
export const inject = ['i18n', 'commands', 'slots', 'pages', 'routes']
export const Config = Schema.object({
  sessionId: Schema.string().default('').max(128).pattern(/^(?:|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u)
    .extra('extra', { label: { en: 'Native session ID', 'zh-CN': '原生会话 ID' } })
    .description('Selected native session ID used by the optional navigation shortcut. Leave empty to hide that shortcut.')
    .i18n({
      en: 'Selected native session ID used by the optional navigation shortcut. Leave empty to hide that shortcut.',
      'zh-CN': '可选导航快捷操作使用的原生会话 ID；留空时隐藏该快捷操作。',
    }),
  welcomePage: Schema.boolean().default(false).role('switch')
    .extra('extra', { label: { en: 'Branded welcome page', 'zh-CN': '品牌欢迎页' } })
    .description('Enable the optional CordisX welcome destination for demos and product capture.')
    .i18n({
      en: 'Enable the optional CordisX welcome destination for demos and product capture.',
      'zh-CN': '启用用于演示和产品录制的可选 CordisX 品牌欢迎页。',
    }),
})
export type SlotShowcaseConfig = Schemastery.TypeT<typeof Config>
export const configApplies = 'plugin-restart'
export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'slot-showcase',
  name: 'Slot Showcase',
  capabilities: [
    {
      name: 'models.read',
      required: false,
      reason: {
        namespace: 'slot-showcase',
        key: 'permission.models',
        fallback: 'Display models available through the Host connection in the Slot Showcase diagnostics view',
      },
      scope: {},
    },
  ],
} as const satisfies CordisXPluginManifestV1

interface Messages {
  'plugin.name': undefined
  'plugin.description': undefined
  'action.open-app': undefined
  'action.open-main': undefined
  'action.quick': undefined
  'action.refresh': undefined
  'action.session-analytics': undefined
  'action.settings': undefined
  'command.open-app': undefined
  'command.open-main': undefined
  'command.open-session': undefined
  'command.quick': undefined
  'command.refresh': undefined
  'command.settings': undefined
  'environment.description': undefined
  'environment.section': undefined
  'environment.status': undefined
  'navigation.description': undefined
  'navigation.title': undefined
  'navigation.welcome.title': undefined
  'page.app.body': undefined
  'page.app.description': undefined
  'page.app.title': undefined
  'page.main.body': undefined
  'page.main.description': undefined
  'page.main.title': undefined
  'page.welcome.description': undefined
  'page.welcome.eyebrow': undefined
  'page.welcome.title': undefined
  'page.session.body': { readonly sessionId: string }
  'page.session.description': undefined
  'page.session.title': undefined
  'page.tab.details': undefined
  'page.tab.overview': undefined
  'permission.models': undefined
  'route.app.description': undefined
  'route.app.title': undefined
  'route.main.description': undefined
  'route.main.title': undefined
  'route.welcome.description': undefined
  'route.welcome.title': undefined
  'route.session.description': undefined
  'route.session.title': undefined
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return {
    namespace: 'slot-showcase',
    key,
    ...(args[0] === undefined ? {} : { params: args[0] }),
  }
}

export const presentation = {
  name: message('plugin.name'),
  description: message('plugin.description'),
} satisfies CordisXPluginPresentation

/** End-to-end demo for every structured shell surface and all three built-in page outlets. */
export function apply(ctx: Context, config: SlotShowcaseConfig = Config({})): void {
  ctx.i18n.define<Messages>({
    namespace: 'slot-showcase',
    locale: 'en',
    default: true,
    messages: {
      'plugin.name': 'Slot Showcase',
      'plugin.description': 'Demonstrates CordisX extension points, navigation, pages, and state interactions.',
      'action.open-app': 'Open app page',
      'action.open-main': 'Open main page',
      'action.quick': 'Quick action',
      'action.refresh': 'Refresh snapshot',
      'action.session-analytics': 'Toggle session analytics',
      'action.settings': 'Showcase settings',
      'command.open-app': 'Open the full-app showcase',
      'command.open-main': 'Open the main-area showcase',
      'command.open-session': 'Open analytics for the configured native session',
      'command.quick': 'Run the independent navigation action',
      'command.refresh': 'Refresh environment snapshot',
      'command.settings': 'Open showcase settings',
      'environment.description': 'Current runtime status.',
      'environment.section': 'CordisX runtime',
      'environment.status': 'Snapshot revision',
      'navigation.description': 'Open showcase pages.',
      'navigation.title': 'Structured UI showcase',
      'navigation.welcome.title': 'CordisX',
      'page.app.body': 'Showcase page for the application area.',
      'page.app.description': 'Presents the complete structured UI showcase as an application overview.',
      'page.app.title': 'Application overview',
      'page.main.body': 'Showcase page for the main area.',
      'page.main.description': 'Presents the showcase analytics content beside the native sidebar while preserving the surrounding application shell.',
      'page.main.title': 'Workspace analytics',
      'page.welcome.description': 'A CordisX-owned welcome page rendered inside the native Codex workspace shell.',
      'page.welcome.eyebrow': 'CORDISX · EXTENSIBLE WORKSPACE',
      'page.welcome.title': 'What should we extend?',
      'page.session.body': 'Session content page for native session {sessionId}.',
      'page.session.description': 'Presents analytics for the currently selected native session below its persistent session header.',
      'page.session.title': 'Session analytics',
      'page.tab.details': 'Details',
      'page.tab.overview': 'Overview',
      'permission.models': 'Display models available through the Host connection in the Slot Showcase diagnostics view',
      'route.app.description': 'Open the application overview from the sidebar footer or showcase settings.',
      'route.app.title': 'Application overview',
      'route.main.description': 'Open workspace analytics from showcase navigation or the workspace toolbar.',
      'route.main.title': 'Workspace analytics',
      'route.welcome.description': 'Open the optional branded welcome destination from showcase navigation.',
      'route.welcome.title': 'CordisX welcome',
      'route.session.description': 'Toggle analytics for the current session from its header, or open the configured session from showcase navigation.',
      'route.session.title': 'Session analytics',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'slot-showcase',
    locale: 'zh-CN',
    messages: {
      'plugin.name': '点位展示',
      'plugin.description': '展示 CordisX 扩展点、导航、页面和状态交互。',
      'action.open-app': '打开应用页',
      'action.open-main': '打开主区域页',
      'action.quick': '独立快捷操作',
      'action.refresh': '刷新快照',
      'action.session-analytics': '切换会话分析',
      'action.settings': '演示设置',
      'environment.description': '当前运行状态。',
      'environment.section': 'CordisX 运行时',
      'environment.status': '快照修订',
      'navigation.description': '打开演示页面。',
      'navigation.title': '结构化 UI 演示',
      'navigation.welcome.title': 'CordisX',
      'page.app.body': '应用区域的演示页面。',
      'page.app.description': '以应用概览展示完整的结构化 UI 演示。',
      'page.app.title': '应用概览',
      'page.main.body': '主区域的演示页面。',
      'page.main.description': '在保留原生侧栏和应用外壳的同时，于主区域展示演示分析内容。',
      'page.main.title': '工作区分析',
      'page.welcome.description': '由 CordisX 提供、在原生 Codex 工作区外壳内渲染的欢迎页面。',
      'page.welcome.eyebrow': 'CORDISX · 可扩展工作区',
      'page.welcome.title': '今天想扩展什么？',
      'page.session.body': '原生会话 {sessionId} 的正文分析页。',
      'page.session.description': '在保留当前原生会话页头的前提下，于会话正文区域展示该会话的分析内容。',
      'page.session.title': '会话分析',
      'page.tab.details': '详情',
      'page.tab.overview': '概览',
      'permission.models': '用于在点位展示的诊断视图中显示当前宿主连接实际可用的模型',
      'command.open-session': '打开已配置原生会话的分析页',
      'route.app.description': '从侧栏底部或演示设置打开应用概览。',
      'route.app.title': '应用概览',
      'route.main.description': '从演示导航或工作区工具栏打开工作区分析。',
      'route.main.title': '工作区分析',
      'route.welcome.description': '从演示导航打开可选的品牌欢迎页。',
      'route.welcome.title': 'CordisX 欢迎页',
      'route.session.description': '从会话页头切换当前会话分析，或从演示导航打开已配置会话的分析内容。',
      'route.session.title': '会话分析',
    },
  })

  ctx.pages.register<Messages>({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'app.overview',
    title: message('page.app.title'),
    description: message('page.app.description'),
    icon: 'host:layers',
    headerActions: [{
      id: 'refresh',
      label: message('action.refresh'),
      icon: 'host:refresh',
      command: { id: 'refresh' },
    }],
    tabs: [
      { id: 'overview', label: message('page.tab.overview'), icon: 'host:layers' },
      { id: 'details', label: message('page.tab.details'), icon: 'host:info' },
    ],
  }, defineReactPage<Messages>(ShowcasePage))
  if (config.welcomePage) {
    ctx.pages.register<Messages>({
      $schema: CORDISX_PAGE_SCHEMA_V3,
      schemaVersion: 3,
      id: 'main.welcome',
      title: message('page.welcome.title'),
      description: message('page.welcome.description'),
      icon: 'host:layers',
    }, defineReactPage<Messages>(ShowcasePage))
  }
  ctx.pages.register<Messages>({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'main.analytics',
    title: message('page.main.title'),
    description: message('page.main.description'),
    icon: 'host:analytics',
    headerActions: [{
      id: 'refresh',
      label: message('action.refresh'),
      icon: 'host:refresh',
      command: { id: 'refresh' },
    }],
  }, defineReactPage<Messages>(ShowcasePage))
  ctx.pages.register<Messages>({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'session.analytics',
    title: message('page.session.title'),
    description: message('page.session.description'),
    icon: 'host:analytics',
  }, defineReactPage<Messages>(ShowcasePage))

  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'app.overview',
    path: '/showcase',
    outlet: 'app',
    page: 'app.overview',
    title: message('route.app.title'),
    description: message('route.app.description'),
  })
  if (config.welcomePage) {
    ctx.routes.register({
      $schema: CORDISX_ROUTE_SCHEMA_V2,
      schemaVersion: 2,
      id: 'main.welcome',
      path: '/main/welcome',
      outlet: 'main',
      page: 'main.welcome',
      title: message('route.welcome.title'),
      description: message('route.welcome.description'),
    })
  }
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'main.analytics',
    path: '/main/showcase',
    outlet: 'main',
    page: 'main.analytics',
    title: message('route.main.title'),
    description: message('route.main.description'),
  })
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'session.analytics',
    path: '/sessions/:sessionId/analytics',
    outlet: 'session.content',
    page: 'session.analytics',
    title: message('route.session.title'),
    description: message('route.session.description'),
  })

  let revision = 1
  let rowHandle: ReturnType<Context['slots']['register']> | undefined
  ctx.commands.register({ id: 'open-app', title: message('command.open-app') }, () => ctx.routes.navigate({ id: 'app.overview' }))
  ctx.commands.register({ id: 'open-main', title: message('command.open-main') }, () => ctx.routes.navigate({ id: 'main.analytics' }))
  if (config.sessionId !== '') {
    ctx.commands.register({ id: 'open-session', title: message('command.open-session') }, () => ctx.routes.navigate({
      id: 'session.analytics',
      params: { sessionId: config.sessionId },
    }))
  }
  ctx.commands.register({ id: 'quick', title: message('command.quick') }, () => { revision += 1 })
  ctx.commands.register({ id: 'settings', title: message('command.settings') }, () => ctx.routes.navigate({ id: 'app.overview' }))
  ctx.commands.register({ id: 'refresh', title: message('command.refresh') }, () => {
    revision += 1
    const row: CordisXEnvironmentRow = {
      sectionId: 'runtime',
      rowId: 'revision',
      label: message('environment.status'),
      value: revision,
      status: 'host:success',
    }
    rowHandle?.update(row)
  })

  const action = (label: CordisXLocalizedText, command: string, icon: 'host:open' | 'host:settings' | 'host:refresh') => ({
    label,
    icon,
    command: { id: command },
  } as const)
  ctx.slots.register({ name: 'sidebar.footer.before-control', id: 'open-app', order: 10 }, action(message('action.open-app'), 'open-app', 'host:open'))
  ctx.slots.register({ name: 'sidebar.footer.after-control', id: 'settings', order: 20 }, action(message('action.settings'), 'settings', 'host:settings'))
  ctx.slots.register({ name: 'sidebar.footer.menu', id: 'refresh', order: 10 }, action(message('action.refresh'), 'refresh', 'host:refresh'))
  ctx.slots.register({ name: 'sidebar.account.menu', id: 'settings', order: 10 }, action(message('action.settings'), 'settings', 'host:settings'))
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'main-page', order: 10 }, {
    label: message(config.welcomePage ? 'navigation.welcome.title' : 'navigation.title'),
    description: message('navigation.description'),
    icon: 'host:layers',
    route: { id: config.welcomePage ? 'main.welcome' : 'main.analytics' },
    actions: [
      { id: 'quick', ...action(message('action.quick'), 'quick', 'host:refresh') },
      ...(config.sessionId === '' ? [] : [{
        id: 'session',
        label: message('page.session.title'),
        icon: 'host:analytics' as const,
        command: { id: 'open-session' },
      }]),
    ],
  })
  ctx.slots.register({ name: 'workspace.toolbar.items', id: 'before', order: 10 }, {
    anchor: 'workspace.primary', placement: 'before', ...action(message('action.open-main'), 'open-main', 'host:open'),
  })
  ctx.slots.register({ name: 'workspace.toolbar.items', id: 'after', order: 20 }, {
    anchor: 'workspace.primary', placement: 'after', ...action(message('action.refresh'), 'refresh', 'host:refresh'),
  })
  ctx.slots.register({ name: 'workspace.toolbar.items', id: 'menu', order: 30 }, {
    anchor: 'workspace.primary', placement: 'menu', ...action(message('action.settings'), 'settings', 'host:settings'),
  })
  ctx.slots.register({ name: 'session.header.actions', id: 'trace', group: 'action', order: 10 }, {
    label: message('action.session-analytics'),
    ariaLabel: message('action.session-analytics'),
    icon: 'host:analytics',
    route: { id: 'session.analytics' },
    routeBehavior: 'toggle',
  })
  ctx.slots.register({ name: 'composer.toolbar.items', id: 'submit-before', group: 'action', order: 10 }, {
    anchor: 'submit', placement: 'before', ...action(message('action.refresh'), 'refresh', 'host:refresh'),
  })
  ctx.slots.register({ name: 'environment.panel.header-actions', id: 'refresh', order: 10 }, action(message('action.refresh'), 'refresh', 'host:refresh'))
  ctx.slots.register({ name: 'environment.panel.sections', id: 'runtime', order: 10 }, {
    sectionId: 'runtime', title: message('environment.section'), description: message('environment.description'), icon: 'host:info',
  })
  ctx.slots.register({ name: 'environment.section.actions', id: 'settings', order: 10 }, {
    sectionId: 'runtime', ...action(message('action.settings'), 'settings', 'host:settings'),
  })
  rowHandle = ctx.slots.register({ name: 'environment.section.rows', id: 'revision', order: 10 }, {
    sectionId: 'runtime', rowId: 'revision', label: message('environment.status'), value: revision, status: 'host:success',
  })
  ctx.slots.register({ name: 'environment.row.trailing-actions', id: 'refresh', order: 10 }, {
    rowId: 'revision', ...action(message('action.refresh'), 'refresh', 'host:refresh'),
  })
}
