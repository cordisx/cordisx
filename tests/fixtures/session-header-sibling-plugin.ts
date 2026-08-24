import type { Context } from '@deepseek-ai/cordis'

export const name = 'session-header-sibling-fixture'
export const inject = ['pages', 'routes', 'slots']

export function apply(ctx: Context): void {
  const label = { namespace: 'session-header-sibling-fixture', key: 'action.run', fallback: 'Run sibling action' }
  ctx.pages.register({ id: 'session.sibling', title: label, icon: 'host:open', chrome: 'body-only' }, () => () => undefined)
  ctx.routes.register({ id: 'session.sibling', path: '/sessions/:sessionId/sibling', outlet: 'session.content', page: 'session.sibling' })
  ctx.slots.register({ name: 'session.header.actions', id: 'sibling', group: 'utility', order: 20 }, {
    label,
    ariaLabel: label,
    icon: 'host:open',
    route: { id: 'session.sibling' },
    routeBehavior: 'toggle',
  })
}
