import type { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_PAGE_SCHEMA_V4,
  CORDISX_ROUTE_SCHEMA_V2,
  CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V11,
} from '../../packages/cli/src/contracts.js'

export const inject = ['pages', 'routes', 'slots']

export function apply(ctx: Context): void {
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V4,
    schemaVersion: 4,
    id: 'manager',
    title: { key: 'page.title', fallback: 'Account' },
    description: { key: 'page.description', fallback: 'Authentication details' },
    icon: 'host:layers',
    chrome: 'standard',
  }, context => {
    const body = context.document.createElement('p')
    body.dataset.accountDetails = 'true'
    body.textContent = 'Authentication details'
    context.container.append(body)
    return () => body.remove()
  })
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'manager',
    path: '/manager/extensions/account-fixture',
    outlet: 'manager.content',
    page: 'manager',
    title: { key: 'route.title', fallback: 'Account' },
    description: { key: 'route.description', fallback: 'Open authentication details' },
  })
  ctx.slots.register({
    $schema: CORDISX_SURFACE_CONTRIBUTION_SCHEMA_V11,
    schemaVersion: 11,
    name: 'manager.settings.navigation-items',
    id: 'manager',
    group: 'after-settings',
    order: 170,
  }, { route: { id: 'manager' }, navigationGroup: { id: 'external-accounts' } })
}
