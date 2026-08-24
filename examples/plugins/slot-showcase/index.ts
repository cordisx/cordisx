import type { Context, Disposable } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_ROUTE_SCHEMA_V2,
  type CordisXPluginManifestV1,
  type CordisXEnvironmentRow,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXPageMountContext,
} from '../../../packages/cli/src/contracts.js'
import type {} from '../../../packages/cli/src/contracts.js'

export const name = 'structured-showcase'
export const inject = ['i18n', 'commands', 'slots', 'pages', 'routes']
export const Config = Schema.object({
  sessionId: Schema.string().default('').max(128).pattern(/^(?:|[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/u)
    .extra('extra', { label: { en: 'Native session ID', 'zh-CN': '原生会话 ID' } })
    .description('Selected native session ID used by the optional session analytics action. Leave empty to hide it.')
    .i18n({
      en: 'Selected native session ID used by the optional session analytics action. Leave empty to hide it.',
      'zh-CN': '可选会话分析操作使用的当前原生会话 ID；留空时隐藏该操作。',
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
        namespace: 'showcase',
        key: 'permission.models',
        fallback: 'Show models currently available through the host connection',
      },
      scope: {},
    },
  ],
} as const satisfies CordisXPluginManifestV1

interface Messages {
  'action.open-app': undefined
  'action.open-main': undefined
  'action.quick': undefined
  'action.refresh': undefined
  'action.settings': undefined
  'command.open-app': undefined
  'command.open-main': undefined
  'command.open-session': undefined
  'command.quick': undefined
  'command.refresh': undefined
  'command.settings': undefined
  'environment.description': undefined
  'environment.section': undefined
  'environment.status': { readonly count: number }
  'navigation.description': undefined
  'navigation.title': undefined
  'page.app.body': undefined
  'page.app.description': undefined
  'page.app.title': undefined
  'page.main.body': undefined
  'page.main.description': undefined
  'page.main.title': undefined
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
  'route.session.description': undefined
  'route.session.title': undefined
}

function message<Key extends keyof Messages>(
  key: Key,
  ...args: Messages[Key] extends CordisXMessageParams ? [params: Messages[Key]] : [params?: undefined]
): CordisXLocalizedText {
  return {
    namespace: 'showcase',
    key,
    ...(args[0] === undefined ? {} : { params: args[0] }),
  }
}

function mountCard(context: CordisXPageMountContext, body: CordisXLocalizedText): Disposable<void> {
  const card = context.document.createElement('article')
  card.dataset.cordisxDemoMarker = context.outlet
  Object.assign(card.style, {
    display: 'grid',
    gap: '14px',
    margin: '24px',
    padding: '24px',
    border: '1px solid var(--color-border, rgba(255, 255, 255, .084))',
    borderRadius: '14px',
    background: 'var(--color-background-elevated-secondary, rgba(255, 255, 255, .032))',
    color: 'var(--color-text, #dfdfdf)',
    font: '14px/1.55 ui-sans-serif, system-ui, sans-serif',
  })
  const eyebrow = context.document.createElement('strong')
  eyebrow.textContent = `CORDISX · ${context.outlet.toUpperCase()}`
  eyebrow.style.color = 'var(--color-text-secondary, rgba(255, 255, 255, .71))'
  const copy = context.document.createElement('p')
  copy.style.margin = '0'
  context.localization.bindText(copy, body)
  const route = context.document.createElement('code')
  route.textContent = `${context.routeId} · ${JSON.stringify(context.params)}`
  route.style.color = 'var(--color-text-tertiary, rgba(255, 255, 255, .498))'
  card.append(eyebrow, copy, route)
  context.container.append(card)
  return () => card.remove()
}

/** End-to-end demo for every structured shell surface and all three built-in page outlets. */
export function apply(ctx: Context, config: SlotShowcaseConfig = Config({})): void {
  ctx.i18n.define<Messages>({
    namespace: 'showcase',
    locale: 'en',
    default: true,
    messages: {
      'action.open-app': 'Open app page',
      'action.open-main': 'Open main page',
      'action.quick': 'Quick action',
      'action.refresh': 'Refresh snapshot',
      'action.settings': 'Showcase settings',
      'command.open-app': 'Open the full-app showcase',
      'command.open-main': 'Open the main-area showcase',
      'command.open-session': 'Open analytics for the configured native session',
      'command.quick': 'Run the independent navigation action',
      'command.refresh': 'Refresh environment snapshot',
      'command.settings': 'Open showcase settings',
      'environment.description': 'Current runtime status.',
      'environment.section': 'CordisX runtime',
      'environment.status': 'Snapshot revision {count}',
      'navigation.description': 'Open showcase pages.',
      'navigation.title': 'Structured UI showcase',
      'page.app.body': 'Showcase page for the application area.',
      'page.app.description': 'Presents the complete structured UI showcase in the application-wide outlet, including its overview and details chrome.',
      'page.app.title': 'App outlet',
      'page.main.body': 'Showcase page for the main area.',
      'page.main.description': 'Presents the showcase analytics content beside the native sidebar while preserving the surrounding application shell.',
      'page.main.title': 'Main outlet',
      'page.session.body': 'Session content page for native session {sessionId}.',
      'page.session.description': 'Presents analytics for the currently selected native session below its persistent session header.',
      'page.session.title': 'Session analytics',
      'page.tab.details': 'Details',
      'page.tab.overview': 'Overview',
      'permission.models': 'Show models currently available through the host connection',
      'route.app.description': 'Open from the sidebar footer or showcase settings action to replace the CordisX application region with the app-outlet overview.',
      'route.app.title': 'App outlet',
      'route.main.description': 'Open from the showcase navigation row, workspace toolbar, or session-header action to show analytics in the main outlet.',
      'route.main.title': 'Main outlet',
      'route.session.description': 'Open from the showcase navigation shortcut when a native session ID is configured to show analytics in that session content outlet.',
      'route.session.title': 'Session analytics',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'showcase',
    locale: 'zh-CN',
    messages: {
      'action.open-app': '打开应用页',
      'action.open-main': '打开主区域页',
      'action.quick': '独立快捷操作',
      'action.refresh': '刷新快照',
      'action.settings': '演示设置',
      'environment.description': '当前运行状态。',
      'environment.section': 'CordisX 运行时',
      'environment.status': '快照修订 {count}',
      'navigation.description': '打开演示页面。',
      'navigation.title': '结构化 UI 演示',
      'page.app.body': '应用区域的演示页面。',
      'page.app.description': '在应用级 outlet 中展示完整的结构化 UI 演示，包括概览与详情页头。',
      'page.app.title': '应用 outlet',
      'page.main.body': '主区域的演示页面。',
      'page.main.description': '在保留原生侧栏和应用外壳的同时，于主区域展示演示分析内容。',
      'page.main.title': '主区域 outlet',
      'page.session.body': '原生会话 {sessionId} 的正文分析页。',
      'page.session.description': '在保留当前原生会话页头的前提下，于会话正文区域展示该会话的分析内容。',
      'page.session.title': '会话分析',
      'page.tab.details': '详情',
      'page.tab.overview': '概览',
      'permission.models': '显示当前宿主连接实际可用的模型',
      'command.open-session': '打开已配置原生会话的分析页',
      'route.app.description': '从侧栏底部或演示设置操作进入，在 app outlet 中打开覆盖 CordisX 应用区域的概览页。',
      'route.app.title': '应用 outlet',
      'route.main.description': '从演示导航行、工作区工具栏或会话页头操作进入，在 main outlet 中展示分析内容。',
      'route.main.title': '主区域 outlet',
      'route.session.description': '配置原生会话 ID 后，从演示导航快捷操作进入，在当前 session.content outlet 中展示会话分析。',
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
  }, context => mountCard(context, message('page.app.body')))
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
  }, context => mountCard(context, message('page.main.body')))
  ctx.pages.register<Messages>({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'session.analytics',
    title: message('page.session.title'),
    description: message('page.session.description'),
    icon: 'host:analytics',
  }, context => mountCard(context, message('page.session.body', { sessionId: String(context.params.sessionId) })))

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
      label: message('environment.status', { count: revision }),
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
    label: message('navigation.title'),
    description: message('navigation.description'),
    icon: 'host:layers',
    route: { id: 'main.analytics' },
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
  ctx.slots.register({ name: 'session.header.actions', id: 'trace', group: 'action', order: 10 },
    action(message('action.open-main'), 'open-main', 'host:open'))
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
    sectionId: 'runtime', rowId: 'revision', label: message('environment.status', { count: revision }), value: revision, status: 'host:success',
  })
  ctx.slots.register({ name: 'environment.row.trailing-actions', id: 'refresh', order: 10 }, {
    rowId: 'revision', ...action(message('action.refresh'), 'refresh', 'host:refresh'),
  })
}
