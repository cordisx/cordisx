import type { Context } from '@deepseek-ai/cordis'

interface State { apply: number; dispose: number }
function state(): State {
  const value = globalThis as typeof globalThis & { __cordisxGenerationBase?: State }
  return value.__cordisxGenerationBase ??= { apply: 0, dispose: 0 }
}

export const inject = ['pages', 'routes', 'slots']

export function apply(ctx: Context): void {
  const value = state()
  value.apply += 1
  const label = { key: 'generation-base', fallback: 'Generation base' }
  ctx.pages.register({ id: 'generation-base', title: label, icon: 'host:open', chrome: 'body-only' }, () => () => undefined)
  ctx.routes.register({ id: 'generation-base', path: '/generation-base', outlet: 'main.content', page: 'generation-base' })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'generation-base', group: 'utility', order: 50 }, {
    label,
    ariaLabel: label,
    icon: 'host:open',
    route: { id: 'generation-base' },
  })
  ctx.effect(() => () => { value.dispose += 1 }, 'generation base fixture cleanup')
}
