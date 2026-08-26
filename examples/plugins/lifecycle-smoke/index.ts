import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'
import { defineReactPage } from 'cordisx/react'
import { createLifecyclePage } from './view.js'

interface LifecycleSmokeState {
  apply: number
  dispose: number
  invoke: number
}

function state(): LifecycleSmokeState {
  const scope = globalThis as typeof globalThis & { __cordisxLifecycleSmoke?: LifecycleSmokeState }
  return scope.__cordisxLifecycleSmoke ??= { apply: 0, dispose: 0, invoke: 0 }
}

export const name = 'Lifecycle Smoke'
export const inject = ['i18n', 'commands', 'pages', 'routes', 'slots']

const message = (key: string, fallback: string) => ({ namespace: 'lifecycle-smoke', key, fallback } as const)

/** Observable local-package fixture for install, reload, disable, and uninstall smoke. */
export function apply(ctx: Context): void {
  const counters = state()
  counters.apply += 1
  ctx.i18n.define({
    namespace: 'lifecycle-smoke',
    locale: 'en',
    default: true,
    messages: {
      'navigation.title': 'Lifecycle smoke',
      'route.overview.title': 'Open lifecycle management',
      'route.overview.description': 'Open from the sidebar to inspect the installed local-package lifecycle fixture.',
      'page.overview.title': 'Lifecycle management',
      'page.overview.description': 'Shows the apply, reload, disable, enable, and uninstall state of the lifecycle-smoke package.',
    },
  })
  ctx.i18n.define({
    namespace: 'lifecycle-smoke',
    locale: 'zh-CN',
    messages: {
      'navigation.title': '生命周期冒烟测试',
      'route.overview.title': '打开生命周期管理',
      'route.overview.description': '从侧栏进入并检查已安装的本地插件生命周期夹具。',
      'page.overview.title': '生命周期管理',
      'page.overview.description': '展示 lifecycle-smoke 插件的应用、重载、停用、启用与卸载状态。',
    },
  })
  const label = message('navigation.title', 'Lifecycle smoke')
  ctx.commands.register({ id: 'invoke', title: label }, () => { counters.invoke += 1 })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'overview',
    title: message('page.overview.title', 'Lifecycle management'),
    description: message('page.overview.description', 'Shows local-package lifecycle state.'),
    icon: 'host:refresh',
    chrome: 'body-only',
  }, defineReactPage(createLifecyclePage(counters)))
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'overview',
    path: '/lifecycle-smoke',
    outlet: 'main',
    page: 'overview',
    title: message('route.overview.title', 'Open lifecycle management'),
    description: message('route.overview.description', 'Open the installed local-package lifecycle fixture.'),
  })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'open', group: 'utility', order: 95 }, {
    label,
    icon: 'host:refresh',
    route: { id: 'overview' },
  })
  ctx.effect(() => () => { counters.dispose += 1 }, 'lifecycle smoke cleanup')
}
