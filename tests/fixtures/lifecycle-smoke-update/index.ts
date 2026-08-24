import type { Context } from '@deepseek-ai/cordis'

interface LifecycleSmokeState {
  apply: number
  dispose: number
  invoke: number
}

function state(): LifecycleSmokeState {
  const scope = globalThis as typeof globalThis & { __cordisxLifecycleSmoke?: LifecycleSmokeState }
  return scope.__cordisxLifecycleSmoke ??= { apply: 0, dispose: 0, invoke: 0 }
}

export const name = 'Lifecycle Smoke Update'
export const inject = ['commands', 'pages', 'routes', 'slots']

/** Observable immutable update candidate for real Manager import smoke. */
export function apply(ctx: Context): void {
  const counters = state()
  counters.apply += 1
  const label = { key: 'lifecycle-smoke', fallback: 'Lifecycle smoke' }
  ctx.commands.register({ id: 'invoke', title: label }, () => { counters.invoke += 1 })
  ctx.pages.register({ id: 'overview', title: label, icon: 'host:refresh', chrome: 'body-only' }, () => () => undefined)
  ctx.routes.register({ id: 'overview', path: '/lifecycle-smoke', outlet: 'main', page: 'overview' })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'open', group: 'utility', order: 95 }, {
    label,
    icon: 'host:refresh',
    route: { id: 'overview' },
  })
  ctx.effect(() => () => { counters.dispose += 1 }, 'lifecycle smoke cleanup')
}
