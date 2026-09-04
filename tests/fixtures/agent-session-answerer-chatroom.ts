import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@cordisx/protocol/agents/v1'
import type { ApprovalService } from '@cordisx/protocol/approval/v1'
import {
  CORDISX_PAGE_SCHEMA_V3,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  CORDISX_ROUTE_SCHEMA_V2,
} from 'cordisx/contracts'

const message = (key: string, fallback: string) => ({ namespace: 'agent-session-answerer-chatroom', key, fallback } as const)

export const manifest = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  schemaVersion: 6,
  id: 'agent-session-answerer-chatroom',
  services: [],
  capabilities: [{
    name: 'agents.create', required: false,
    scope: { sessionIds: ['cx-session.answerer-before-route'] },
  }, {
    name: 'approvals.request', required: false,
    scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
  }, {
    name: 'approvals.answer', required: false,
    scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
  }],
} as const

export const inject = ['i18n', 'pages', 'routes', 'agents', 'approvals']

export async function apply(ctx: Context & { readonly agents: AgentRegistry; readonly approvals: ApprovalService }): Promise<void> {
  ctx.i18n.define({
    namespace: 'agent-session-answerer-chatroom',
    locale: 'en',
    default: true,
    messages: {
      'page.title': 'Room',
      'page.description': 'Answerer registration fixture.',
      'route.title': 'Open session',
      'route.description': 'Open the exact Room Agent Session.',
    },
  })
  ctx.i18n.define({
    namespace: 'agent-session-answerer-chatroom',
    locale: 'zh-CN',
    messages: {
      'page.title': '房间',
      'page.description': '批准答复注册测试页面。',
      'route.title': '打开会话',
      'route.description': '打开指定房间中的 Agent Session。',
    },
  })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'room',
    title: message('page.title', 'Room'),
    description: message('page.description', 'Answerer registration fixture.'),
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
  const acquired = await ctx.agents.create({ sessionId: 'cx-session.answerer-before-route' })
  if (acquired.status !== 'accepted') throw new Error(`Agent acquire failed: ${acquired.status}`)
  const handle = await ctx.approvals.registerAnswerer(acquired.handle.agent, async () => 'allowed-once')
  ;(globalThis as typeof globalThis & { __cordisxAnswererRegisteredBeforeRoute?: boolean })
    .__cordisxAnswererRegisteredBeforeRoute = handle.agentId === acquired.sessionId
}
