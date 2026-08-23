import type { Context, Disposable } from '@deepseek-ai/cordis'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  type CordisXPluginManifestV1,
  type CordisXEnvironmentRow,
  type CordisXLocalizedText,
  type CordisXMessageParams,
  type CordisXPageMountContext,
} from '../../../packages/cli/src/contracts.js'
import type {} from '../../../packages/cli/src/contracts.js'

export const name = 'structured-showcase'
export const inject = ['i18n', 'commands', 'slots', 'pages', 'routes']
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
  'command.quick': undefined
  'command.refresh': undefined
  'command.settings': undefined
  'environment.description': undefined
  'environment.section': undefined
  'environment.status': { readonly count: number }
  'navigation.description': undefined
  'navigation.title': undefined
  'page.app.body': undefined
  'page.app.title': undefined
  'page.main.body': undefined
  'page.main.title': undefined
  'page.session.body': { readonly sessionId: string }
  'page.session.title': undefined
  'page.tab.details': undefined
  'page.tab.overview': undefined
  'permission.models': undefined
}

interface Config {
  readonly sessionId?: string
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
    border: '1px solid color-mix(in srgb, #8b5cf6 55%, transparent)',
    borderRadius: '18px',
    background: 'linear-gradient(145deg, rgba(35, 27, 57, .98), rgba(15, 19, 31, .98))',
    color: '#f8fafc',
    boxShadow: '0 24px 80px rgba(0, 0, 0, .35)',
    font: '14px/1.55 ui-sans-serif, system-ui, sans-serif',
  })
  const eyebrow = context.document.createElement('strong')
  eyebrow.textContent = `CORDISX · ${context.outlet.toUpperCase()}`
  eyebrow.style.color = '#c4b5fd'
  const copy = context.document.createElement('p')
  copy.style.margin = '0'
  context.localization.bindText(copy, body)
  const route = context.document.createElement('code')
  route.textContent = `${context.routeId} · ${JSON.stringify(context.params)}`
  route.style.opacity = '.66'
  card.append(eyebrow, copy, route)
  context.container.append(card)
  return () => card.remove()
}

/** End-to-end demo for every structured shell surface and all three built-in page outlets. */
export function apply(ctx: Context, config: Config = {}): void {
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
      'command.quick': 'Run the independent navigation action',
      'command.refresh': 'Refresh environment snapshot',
      'command.settings': 'Open showcase settings',
      'environment.description': 'Dynamic structured rows never receive host DOM nodes.',
      'environment.section': 'CordisX runtime',
      'environment.status': 'Snapshot revision {count}',
      'navigation.description': 'Route-only primary activation with independent actions',
      'navigation.title': 'Structured UI showcase',
      'page.app.body': 'This controlled page covers the renderer application region without replacing the native React root.',
      'page.app.title': 'App outlet',
      'page.main.body': 'This controlled page covers only the region to the right of the sidebar.',
      'page.main.title': 'Main outlet',
      'page.session.body': 'Session content page for native session {sessionId}.',
      'page.session.title': 'Session analytics',
      'page.tab.details': 'Details',
      'page.tab.overview': 'Overview',
      'permission.models': 'Show models currently available through the host connection',
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
      'environment.description': '动态结构化行永远不会取得宿主 DOM 节点。',
      'environment.section': 'CordisX 运行时',
      'environment.status': '快照修订 {count}',
      'navigation.description': '主行为仅路由，右侧操作独立执行',
      'navigation.title': '结构化 UI 演示',
      'page.app.body': '受控页面覆盖 renderer 应用区域，但不会替换原生 React 根节点。',
      'page.app.title': '应用 outlet',
      'page.main.body': '受控页面只覆盖侧栏右侧主区域。',
      'page.main.title': '主区域 outlet',
      'page.session.body': '原生会话 {sessionId} 的正文分析页。',
      'page.session.title': '会话分析',
      'page.tab.details': '详情',
      'page.tab.overview': '概览',
      'permission.models': '显示当前宿主连接实际可用的模型',
    },
  })

  ctx.pages.register<Messages>({
    id: 'app.overview',
    title: message('page.app.title'),
    icon: 'host:layers',
    localeNamespace: 'showcase',
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
    id: 'main.analytics',
    title: message('page.main.title'),
    icon: 'host:analytics',
    localeNamespace: 'showcase',
    headerActions: [{
      id: 'refresh',
      label: message('action.refresh'),
      icon: 'host:refresh',
      command: { id: 'refresh' },
    }],
  }, context => mountCard(context, message('page.main.body')))
  ctx.pages.register<Messages>({
    id: 'session.analytics',
    title: message('page.session.title'),
    icon: 'host:analytics',
    localeNamespace: 'showcase',
  }, context => mountCard(context, message('page.session.body', { sessionId: String(context.params.sessionId) })))

  ctx.routes.register({ id: 'app.overview', path: '/showcase', outlet: 'app', page: 'app.overview' })
  ctx.routes.register({ id: 'main.analytics', path: '/main/showcase', outlet: 'main', page: 'main.analytics' })
  ctx.routes.register({
    id: 'session.analytics',
    path: '/sessions/:sessionId/analytics',
    outlet: 'session.content',
    page: 'session.analytics',
  })

  let revision = 1
  let rowHandle: ReturnType<Context['slots']['register']> | undefined
  ctx.commands.register({ id: 'open-app', title: message('command.open-app') }, () => ctx.routes.navigate({ id: 'app.overview' }))
  ctx.commands.register({ id: 'open-main', title: message('command.open-main') }, () => ctx.routes.navigate({ id: 'main.analytics' }))
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
      ...(config.sessionId === undefined ? [] : [{
        id: 'session',
        label: message('page.session.title'),
        icon: 'host:analytics' as const,
        command: { id: 'open-main' },
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
