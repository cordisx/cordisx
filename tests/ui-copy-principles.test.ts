import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MANAGER_PRODUCT_COPY, managerCopy } from '../packages/cli/src/renderer/ui-copy.js'

const managerPath = fileURLToPath(new URL('../packages/cli/src/renderer/manager.ts', import.meta.url))
const tracePath = fileURLToPath(new URL('../packages/agent-trace-showcase/src/view.ts', import.meta.url))
const cliProxyPath = fileURLToPath(new URL('../packages/cli/src/plugins/cli-proxy-api/index.ts', import.meta.url))
const principlesPath = fileURLToPath(new URL('../.agents/docs/ui-copy-principles.md', import.meta.url))

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`missing copy section: ${start}`)
  return source.slice(from, to)
}

describe('UI copy principles', () => {
  it('keeps configuration out of retired global placeholder pages', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const primaryNavigation = section(manager, 'const tabs: readonly', 'let routeState')
    expect(manager).toContain('CORDISX_BUILTIN_MANAGER_SETTINGS_TABS: readonly ManagerSettingsTabSnapshot[] = Object.freeze([])')
    expect(manager).toContain("{ id: 'plugins', icon: 'plugins', label: copy('manager.nav.plugins') }")
    expect(manager).not.toContain("{ id: 'settings', label: '配置'")
    expect(manager).not.toContain('renderRuntimeSettings')
    expect(manager).not.toContain('renderLauncherSettings')
    expect(manager).not.toContain('renderDemoSettings')
    expect(manager).not.toContain('renderProviderSettings')
    expect(primaryNavigation).not.toMatch(/id: '(?:runtime|launcher|demo|providers?)'/u)
  })

  it('keeps the Host catalog complete and locale-first for every governed primary state', () => {
    for (const [key, messages] of Object.entries(MANAGER_PRODUCT_COPY)) {
      expect(messages.en, `${key}: en`).toMatch(/\S/u)
      expect(messages['zh-CN'], `${key}: zh-CN`).toMatch(/\S/u)
      expect(managerCopy('en-US', key as keyof typeof MANAGER_PRODUCT_COPY)).toBe(messages.en)
      expect(managerCopy('zh-Hans-CN', key as keyof typeof MANAGER_PRODUCT_COPY)).toBe(messages['zh-CN'])
    }
    expect(managerCopy('en', 'marketplace.failed')).toBe('Failed to load')
    expect(managerCopy('zh-CN', 'status.file-not-found')).toBe('文件不存在')
    expect(managerCopy('en', 'status.restart-required')).toBe('Restart required')
    expect(managerCopy('en', 'manager.trigger.manage')).toBe('Manage CordisX plugins')
    expect(managerCopy('zh-CN', 'manager.trigger.manage')).toBe('管理 CordisX 插件')
  })

  it('keeps diagnostics and documentation as the home for developer terminology', async () => {
    const [manager, trace, cliProxy, principles] = await Promise.all([
      readFile(managerPath, 'utf8'), readFile(tracePath, 'utf8'), readFile(cliProxyPath, 'utf8'), readFile(principlesPath, 'utf8'),
    ])
    const runtime = section(manager, 'const appendRuntimeLifecycle', "if (activeFacet === 'logs')")
    const marketplaceDetail = section(manager, 'const renderMarketplaceDetail', 'const marketplaceSourceState')

    expect(runtime).toContain('runtimeDiagnostics.append(diagnosticsBody)')
    expect(trace).toContain("'Agent events are currently unavailable.'")
    expect(trace).not.toContain('This plugin will not inspect a raw bridge or private adapter store.')
    expect(cliProxy).toContain("'navigation.description': 'Manage provider models and sessions'")
    expect(cliProxy).toContain("'navigation.description': '管理 Provider 模型和会话'")
    expect(marketplaceDetail).not.toContain('documentationLink(')
    expect(marketplaceDetail).not.toMatch(/verificationPolicy|reviewPolicy|canonical source|sha256|digest/iu)
    expect(principles).toContain('`fiber`, `generation`, `canonical identity`')
    expect(principles).toContain('`en` and `zh-CN`')
  })

  it('routes Manager primary headings and controls through locale-aware copy', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const primaryUi = [
      section(manager, 'const renderPluginList', 'const renderMarketplaceList'),
      section(manager, 'const renderPluginDetail', 'const marketplaceSourceState'),
    ].join('\n')

    expect(primaryUi).not.toMatch(/setHeading\('[\p{Script=Han}]/u)
    expect(primaryUi).not.toMatch(/createTabPanel\(document, '[\p{Script=Han}]/u)
    expect(primaryUi).not.toMatch(/openLabel: `打开/u)
    expect(primaryUi).toContain("setHeading(copy('plugins.heading')")
    expect(primaryUi).toContain("placeholder: copy('plugins.search-placeholder')")
    expect(primaryUi).toContain("placeholder: copy('marketplace.search-placeholder')")
  })

  it('keeps Console chrome locale-aware and leaves raw diagnostics out of its primary controls', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const consoleChrome = section(manager, "if (activeFacet === 'logs')", "if (activeFacet === 'extension-points')")

    expect(consoleChrome).not.toMatch(/[\p{Script=Han}]/u)
    expect(consoleChrome).toContain("copy('console.toolbar')")
    expect(consoleChrome).toContain("copy('console.entry-details')")
    expect(consoleChrome).toContain("copy('console.close-details')")
  })

  it('keeps every primary collection heading, search control, and demo card description locale-aware', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const primaryCollections = [
      section(manager, 'const renderExtensionPointList', 'const renderExtensionPointDetail'),
      section(manager, 'const renderRouteList', 'const renderRouteDetail'),
      section(manager, 'const renderPluginList', 'const commitPermissionPolicy'),
    ].join('\n')

    expect(primaryCollections).not.toMatch(/[\p{Script=Han}]/u)
    expect(primaryCollections).toContain("copy('extension.search-placeholder')")
    expect(primaryCollections).toContain("copy('routes.search-placeholder')")
    expect(primaryCollections).toContain("'plugins.demo.form-schema-gallery-description'")
    expect(managerCopy('en', 'plugins.demo.slot-showcase-description')).toBe('Explore plugins, navigation, pages, and status.')
    expect(managerCopy('zh-CN', 'plugins.demo.slot-showcase-description')).toBe('查看插件、导航、页面与状态。')
  })

  it('records shared overlay and official-control ownership instead of page-local exceptions', async () => {
    const principles = await readFile(principlesPath, 'utf8')
    expect(principles).toContain('one title, at most one concise')
    expect(principles).toContain('must not draw a second button, Select, or Input')
  })

  it('keeps plugin detail readability, compact icon controls, and raw failures out of the runtime overview', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const runtime = section(manager, "if (activeFacet === 'runtime')", "if (activeFacet === 'logs')")
    expect(manager).toContain('.cxm-readme { inline-size: 100%; max-inline-size: 96rem;')
    expect(manager).toContain('.cxm-readme p, .cxm-readme li, .cxm-readme blockquote { max-inline-size: 76ch; }')
    expect(manager).toContain('.cxm-manager-icon-action, .cxm-plugin-icon-action, .cxm-plugin-menu-trigger')
    expect(manager).toContain('width: 32px; min-width: 32px; height: 32px; min-height: 32px;')
    expect(manager).toContain('.cxm-content[data-manager-list-page="true"] { display: flex; overflow: hidden; }')
    expect(manager).toContain('.cxm-fixed-list-collection .cxc-list { min-height: 0; flex: 1 1 auto; overflow: auto;')
    expect(manager).toContain('.cxm-content:has(.cxm-console-panel) { display: flex; flex-direction: column; overflow: hidden; }')
    expect(manager).toContain('.cxm-console-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }')
    expect(runtime).toContain("create(document, 'section', 'cxm-runtime-overview')")
    expect(runtime).toContain("copy('runtime.status-details')")
    expect(runtime).toContain("create(document, 'details', 'cxm-runtime-diagnostics')")
    expect(runtime).not.toContain("'cxm-error', plugin.error")
    expect(manager).toContain("panel.classList.add('cxm-console-panel')")
    expect(manager).not.toContain("create(document, 'div', 'cxm-console-summary')")
    expect(manager).toContain("appendRuntimeLifecycle(overview)")
  })

  it('keeps shared tabs complete when their content area becomes narrow', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const tabs = section(manager, '  .cxm-tabs {', '  .cxm-tab {')

    expect(tabs).toContain('flex-wrap: wrap;')
    expect(tabs).toContain('overflow: visible;')
    expect(tabs).not.toContain('overflow-x: auto;')
    expect(manager).toContain('.cxm-breadcrumb-item:last-child { flex: 1 1 auto; }')
  })
})
