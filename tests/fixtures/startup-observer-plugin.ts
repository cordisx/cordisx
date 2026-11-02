import type { Context } from '@deepseek-ai/cordis'
import type { StartupContextV1 } from '@cordisx/protocol/startup/v1'
import { CORDISX_PAGE_SCHEMA_V4 } from '../../packages/cli/src/contracts.js'

export const inject = ['i18n', 'pages', 'startup', 'modelProviders']

export function apply(ctx: Context & StartupContextV1): void {
  ctx.i18n.define({
    namespace: 'startup-fixture',
    locale: 'en',
    default: true,
    messages: { title: 'Startup status', description: 'Service preparation status' },
  })
  ctx.i18n.define({
    namespace: 'startup-fixture',
    locale: 'zh-CN',
    messages: { title: '启动状态', description: '服务准备状态' },
  })
  ctx.pages.register({
    $schema: CORDISX_PAGE_SCHEMA_V4,
    schemaVersion: 4,
    id: 'startup-status',
    title: { namespace: 'startup-fixture', key: 'title', fallback: 'Startup status' },
    description: { namespace: 'startup-fixture', key: 'description', fallback: 'Service preparation status' },
    icon: 'host:layers',
    chrome: 'standard',
  }, () => undefined) // No service get, prepare or await: navigation and observation register independently.
  ;(globalThis as unknown as { startupFixture?: unknown }).startupFixture = ctx.startup
  ;(globalThis as unknown as { startupModelProviders?: unknown }).startupModelProviders = ctx.modelProviders
}
