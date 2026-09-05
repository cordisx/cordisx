import type { Context } from '@deepseek-ai/cordis'
import { CORDISX_PAGE_SCHEMA_V3, CORDISX_ROUTE_SCHEMA_V2 } from 'cordisx/contracts'

interface State {
  apply: number
  dispose: number
}
function state(): State {
  const value = globalThis as typeof globalThis & { __cordisxGenerationBase?: State }
  return value.__cordisxGenerationBase ??= { apply: 0, dispose: 0 }
}

export const inject = ['i18n', 'pages', 'routes', 'slots']

const message = (key: string, fallback: string) => ({ namespace: 'generation-base', key, fallback } as const)

export function apply(ctx: Context): void {
  const value = state()
  value.apply += 1
  ctx.i18n.define({
    namespace: 'generation-base',
    locale: 'en',
    default: true,
    messages: {
      'navigation.title': 'Generation base',
      'route.title': 'Open generation base',
      'route.description': 'Open the dependency root used by renderer generation transaction tests.',
      'page.title': 'Generation base state',
      'page.description':
        'Shows the active base-plugin generation while dependent plugins are switched or rolled back.',
    },
  })
  ctx.i18n.define({
    namespace: 'generation-base',
    locale: 'zh-CN',
    messages: {
      'navigation.title': 'Generation 基础插件',
      'route.title': '打开 Generation 基础插件',
      'route.description': '打开 renderer generation 事务测试使用的依赖根插件。',
      'page.title': 'Generation 基础状态',
      'page.description': '在切换或回滚依赖插件时展示当前生效的基础插件 generation。',
    },
  })
  const label = message('navigation.title', 'Generation base')
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: 'generation-base',
    title: message('page.title', 'Generation base state'),
    description: message('page.description', 'Shows the active base-plugin generation.'),
    icon: 'host:open',
    chrome: 'body-only',
  }, () => () => undefined)
  ctx.routes.register({
    $schema: CORDISX_ROUTE_SCHEMA_V2,
    schemaVersion: 2,
    id: 'generation-base',
    path: '/generation-base',
    outlet: 'main.content',
    page: 'generation-base',
    title: message('route.title', 'Open generation base'),
    description: message('route.description', 'Open the renderer generation transaction dependency root.'),
  })
  ctx.slots.register({ name: 'sidebar.navigation.items', id: 'generation-base', group: 'utility', order: 50 }, {
    label,
    ariaLabel: label,
    icon: 'host:open',
    route: { id: 'generation-base' },
  })
  ctx.effect(() => () => {
    value.dispose += 1
  }, 'generation base fixture cleanup')
}
