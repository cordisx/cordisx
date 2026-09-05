import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'

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
export const inject = ['i18n', 'commands', 'pages', 'routes', 'slots']

const message = (key: string, fallback: string) => ({ namespace: 'lifecycle-smoke', key, fallback } as const)

/** Observable immutable update candidate for real Manager import smoke. */
export function apply(ctx: Context): void {
  const counters = state()
  counters.apply += 1
  ctx.i18n.define({
    namespace: 'lifecycle-smoke',
    locale: 'en',
    default: true,
    messages: {
      'navigation.title': 'Lifecycle smoke update',
      'route.overview.title': 'Open lifecycle update candidate',
      'route.overview.description':
        'Open the staged replacement used to verify atomic local-package updates and rollback.',
      'page.overview.title': 'Lifecycle update candidate',
      'page.overview.description':
        'Shows the replacement generation used by the Manager update, rollback, and cleanup smoke.',
    },
  })
  ctx.i18n.define({
    namespace: 'lifecycle-smoke',
    locale: 'zh-CN',
    messages: {
      'navigation.title': '生命周期更新冒烟测试',
      'route.overview.title': '打开生命周期更新候选',
      'route.overview.description': '打开用于验证本地插件原子更新与回滚的待发布替换版本。',
      'page.overview.title': '生命周期更新候选',
      'page.overview.description': '展示 Manager 更新、回滚与清理冒烟测试所使用的替换 generation。',
    },
  })
  const label = message('navigation.title', 'Lifecycle smoke update')
  ctx.commands.register({ id: 'invoke', title: label }, () => {
    counters.invoke += 1
  })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'overview',
    title: message('page.overview.title', 'Lifecycle update candidate'),
    description: message('page.overview.description', 'Shows the replacement generation lifecycle state.'),
    icon: 'host:refresh',
    chrome: 'body-only',
  }, () => () => undefined)
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'overview',
    path: '/lifecycle-smoke',
    outlet: 'main',
    page: 'overview',
    title: message('route.overview.title', 'Open lifecycle update candidate'),
    description: message('route.overview.description', 'Open the staged local-package replacement.'),
  })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'open', group: 'utility', order: 95 }, {
    label,
    icon: 'host:refresh',
    route: { id: 'overview' },
  })
  ctx.effect(() => () => {
    counters.dispose += 1
  }, 'lifecycle smoke cleanup')
}
