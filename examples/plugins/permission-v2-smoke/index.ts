import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'
import { createElement, defineReactPage } from 'cordisx/react'

export const name = 'Permission V2 Smoke'
export const inject = ['i18n', 'commands', 'agentEvents', 'platform', 'pages', 'routes']

const message = (key: string, fallback: string) => ({ namespace: 'permission-v3-smoke', key, fallback } as const)

const domSmokePage = defineReactPage(() => createElement(
  'section',
  { 'data-permission-v3-smoke-page': 'true' },
  'Permission v3 controlled-rendering smoke',
))

/** Real-renderer probe: all authorization remains owned by the Host PermissionBroker. */
export function apply(ctx: Context): void {
  ctx.i18n.define({
    namespace: 'permission-v3-smoke',
    locale: 'en',
    default: true,
    messages: {
      'page.title': 'Permission v3 controlled rendering',
      'page.description': 'Exercises one exact Host-owned DOM permission scope.',
      'route.title': 'Open permission v3 smoke',
      'route.description': 'Requests the exact controlled main outlet through the Host broker.',
    },
  })
  ctx.i18n.define({
    namespace: 'permission-v3-smoke',
    locale: 'zh-CN',
    messages: {
      'page.title': '权限 v3 受控渲染',
      'page.description': '验证一个由 Host 管理的精确 DOM 权限范围。',
      'route.title': '打开权限 v3 冒烟测试',
      'route.description': '通过 Host Broker 请求精确的受控主区域。',
    },
  })
  const title = { key: 'permission-v2-smoke.events', fallback: 'Probe Agent event access' }
  ctx.commands.register({ id: 'probe-agent-events', title }, async () => (
    await ctx.agentEvents.query({ sessionId: 'permission-smoke-session' })
  ))
  ctx.commands.register({
    id: 'probe-tasks',
    title: { key: 'permission-v2-smoke.tasks', fallback: 'Probe task catalog access' },
  }, async () => (
    await ctx.platform.tasks.list({ providerIds: ['codex'], limit: 1 })
  ))
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'dom-smoke',
    title: message('page.title', 'Permission v3 controlled rendering'),
    description: message('page.description', 'Exercises one exact Host-owned DOM permission scope.'),
    icon: 'host:info',
    chrome: 'body-only',
  }, domSmokePage)
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'dom-smoke',
    path: '/permission-v3-smoke',
    outlet: 'main',
    page: 'dom-smoke',
    title: message('route.title', 'Open permission v3 smoke'),
    description: message('route.description', 'Requests the exact controlled main outlet through the Host broker.'),
  })
}
