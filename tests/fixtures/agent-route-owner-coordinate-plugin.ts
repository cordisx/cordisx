import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'

const message = (
  key: string,
  fallback: string,
) => ({ namespace: 'agent-route-owner-coordinate', key, fallback } as const)

export const inject = ['i18n', 'pages', 'routes']

export function apply(ctx: Context): void {
  ctx.i18n.define({
    namespace: 'agent-route-owner-coordinate',
    locale: 'en',
    default: true,
    messages: {
      'page.title': 'Room',
      'page.description': 'Agent Session route owner fixture.',
      'route.title': 'Open session',
      'route.description': 'Open the exact Room Agent Session.',
    },
  })
  ctx.i18n.define({
    namespace: 'agent-route-owner-coordinate',
    locale: 'zh-CN',
    messages: {
      'page.title': '房间',
      'page.description': 'Agent Session 路由所有者测试页面。',
      'route.title': '打开会话',
      'route.description': '打开指定房间中的 Agent Session。',
    },
  })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'room',
    title: message('page.title', 'Room'),
    description: message('page.description', 'Agent Session route owner fixture.'),
  }, () => () => undefined)
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'room-session-detail',
    path: '/main/chatroom/:roomId/session/:sessionId',
    outlet: 'main',
    page: 'room',
    title: message('route.title', 'Open session'),
    description: message('route.description', 'Open the exact Room Agent Session.'),
  })
}
