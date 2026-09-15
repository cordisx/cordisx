import type { Context } from '@deepseek-ai/cordis'

export const inject = ['i18n', 'slots', 'pages', 'routes', 'managerContent', 'platform', 'managedServices']

declare global {
  // eslint-disable-next-line no-var
  var __cordisxManagedServiceUIFixtures:
    | {
      readonly i18n: Context['i18n']
      readonly slots: Context['slots']
      readonly pages: Context['pages']
      readonly routes: Context['routes']
      readonly managerContent: Context['managerContent']
      readonly managedServices: Context['managedServices']
      readonly platform: Context['platform']
    }[]
    | undefined
}

export function apply(ctx: Context): void {
  globalThis.__cordisxManagedServiceUIFixtures ??= []
  globalThis.__cordisxManagedServiceUIFixtures.push({
    i18n: ctx.i18n,
    slots: ctx.slots,
    pages: ctx.pages,
    routes: ctx.routes,
    managerContent: ctx.managerContent,
    managedServices: ctx.managedServices,
    platform: ctx.platform,
  })
}
