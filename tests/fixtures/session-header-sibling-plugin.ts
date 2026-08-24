import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'

export const name = 'session-header-sibling-fixture'
export const inject = ['i18n', 'pages', 'routes', 'slots']

const message = (key: string, fallback: string) => ({ namespace: 'session-header-sibling-fixture', key, fallback } as const)

export function apply(ctx: Context): void {
  ctx.i18n.define({
    namespace: 'session-header-sibling-fixture',
    locale: 'en',
    default: true,
    messages: {
      'action.open': 'Open sibling session view',
      'route.title': 'Open sibling session view',
      'route.description': 'Open from the active session header to exercise a second action beside Agent Trace.',
      'page.title': 'Sibling session view',
      'page.description': 'Shows the controlled session-body page owned by the sibling header-action fixture.',
    },
  })
  ctx.i18n.define({
    namespace: 'session-header-sibling-fixture',
    locale: 'zh-CN',
    messages: {
      'action.open': '打开同级会话视图',
      'route.title': '打开同级会话视图',
      'route.description': '从当前会话页头进入，以验证 Agent Trace 旁的第二个操作入口。',
      'page.title': '同级会话视图',
      'page.description': '展示由同级页头操作夹具所有的受控会话正文页面。',
    },
  })
  const label = message('action.open', 'Open sibling session view')
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'session.sibling',
    title: message('page.title', 'Sibling session view'),
    description: message('page.description', 'Shows the sibling fixture session page.'),
    icon: 'host:open',
    chrome: 'body-only',
  }, () => () => undefined)
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'session.sibling',
    path: '/sessions/:sessionId/sibling',
    outlet: 'session.content',
    page: 'session.sibling',
    title: message('route.title', 'Open sibling session view'),
    description: message('route.description', 'Open the sibling action page for the active session.'),
  })
  ctx.slots.register({ name: 'session.header.actions', id: 'sibling', group: 'utility', order: 20 }, {
    label,
    ariaLabel: label,
    icon: 'host:open',
    route: { id: 'session.sibling' },
    routeBehavior: 'toggle',
  })
}
