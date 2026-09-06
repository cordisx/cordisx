import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MANAGER_PRODUCT_COPY, managerCopy } from '../packages/cli/src/renderer/ui-copy.js'

const managerPath = fileURLToPath(new URL('../packages/cli/src/renderer/manager.ts', import.meta.url))
const tracePath = fileURLToPath(new URL('../packages/agent-trace-showcase/src/react-view.tsx', import.meta.url))
const cliProxyPath = fileURLToPath(new URL('../packages/cli/src/plugins/cli-proxy-api/index.ts', import.meta.url))
const principlesPath = fileURLToPath(new URL('../.agents/docs/ui-copy-principles.md', import.meta.url))

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`missing copy section: ${start}`)
  return source.slice(from, to)
}

async function managerModule(name: string, factory?: string): Promise<string> {
  const manager = await readFile(managerPath, 'utf8')
  expect(manager).toContain(`from './manager-legacy/${name}.js'`)
  if (factory !== undefined) {
    const tree = ts.createSourceFile('manager.ts', manager, ts.ScriptTarget.Latest, true)
    const installation = tree.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'installCordisXManager'
    )
    const calls: string[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text)
      ts.forEachChild(node, visit)
    }
    if (installation !== undefined) visit(installation)
    expect(calls).toContain(factory)
  }
  if (name === 'styles') expect(manager).toContain('${MANAGER_STYLES}')
  return readFile(new URL(`../packages/cli/src/renderer/manager-legacy/${name}.ts`, import.meta.url), 'utf8')
}

function functionSource(source: string, name: string): string {
  const tree = ts.createSourceFile('manager-module.ts', source, ts.ScriptTarget.Latest, true)
  let result: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      result = node.initializer?.getText(tree)
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  if (result === undefined) throw new Error(`missing copy function: ${name}`)
  return result
}

describe('UI copy principles', () => {
  it('assembles every feature catalog key exactly once', () => {
    const modules = import.meta.glob('../packages/cli/src/renderer/ui-copy/*.ts', { eager: true })
    const featureKeys = Object.values(modules).flatMap(module =>
      Object.values(module as Record<string, Record<string, unknown>>).flatMap(catalog => Object.keys(catalog))
    )
    expect(new Set(featureKeys).size).toBe(featureKeys.length)
    expect(Object.keys(MANAGER_PRODUCT_COPY).sort()).toEqual(featureKeys.sort())
  })

  it('keeps configuration out of retired global placeholder pages', async () => {
    const manager = await readFile(managerPath, 'utf8')
    const primaryNavigation = section(manager, 'const tabs: readonly', 'let routeState')
    expect(await managerModule('presentation')).toContain(
      'CORDISX_BUILTIN_MANAGER_SETTINGS_TABS: readonly ManagerSettingsTabSnapshot[] = Object.freeze([])',
    )
    expect(manager).toContain("{ id: 'plugins', icon: 'plugins', label: copy('manager.nav.plugins') }")
    expect(manager).not.toContain("{ id: 'settings', label: '配置'")
    for (
      const source of [
        manager,
        await managerModule('settings', 'createSettings'),
        await managerModule('route-projection', 'createRouteProjection'),
      ]
    ) {
      expect(source).not.toContain('renderRuntimeSettings')
      expect(source).not.toContain('renderLauncherSettings')
      expect(source).not.toContain('renderDemoSettings')
      expect(source).not.toContain('renderProviderSettings')
    }
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
    const [pluginDetail, marketplaceDetailModule, trace, cliProxy, principles] = await Promise.all([
      managerModule('plugin-detail', 'createPluginDetail'),
      managerModule('marketplace-detail', 'createMarketplaceDetail'),
      readFile(tracePath, 'utf8'),
      readFile(cliProxyPath, 'utf8'),
      readFile(principlesPath, 'utf8'),
    ])
    const runtime = section(pluginDetail, 'const appendRuntimeDiagnostics', "if (activeFacet === 'logs')")
    const marketplaceDetail = functionSource(marketplaceDetailModule, 'renderMarketplaceDetail')

    expect(runtime).toContain('runtimeDiagnostics.append(diagnosticsBody)')
    expect(trace).toContain('Agent events are currently unavailable.')
    expect(trace).not.toContain('This plugin will not inspect a raw bridge or private adapter store.')
    expect(cliProxy).toContain("'navigation.description': 'Manage provider models and sessions'")
    expect(cliProxy).toContain("'navigation.description': '管理 Provider 模型和会话'")
    expect(marketplaceDetail).not.toContain('documentationLink(')
    expect(marketplaceDetail).not.toMatch(/verificationPolicy|reviewPolicy|canonical source|sha256|digest/iu)
    expect(principles).toContain('`fiber`, `generation`, `canonical identity`')
    expect(principles).toContain('`en` and `zh-CN`')
  })

  it('routes Manager primary headings and controls through locale-aware copy', async () => {
    const primaryUi = (await Promise.all([
      managerModule('plugin-list', 'createPluginList'),
      managerModule('permissions', 'createPermissions'),
      managerModule('configuration', 'createConfiguration'),
      managerModule('console', 'createConsole'),
      managerModule('plugin-detail', 'createPluginDetail'),
      managerModule('marketplace-list', 'createMarketplaceList'),
      managerModule('marketplace-detail', 'createMarketplaceDetail'),
    ])).join('\n')

    expect(primaryUi).not.toMatch(/setHeading\('[\p{Script=Han}]/u)
    expect(primaryUi).not.toMatch(/createTabPanel\((?:dependencies\.)?document, '[\p{Script=Han}]/u)
    expect(primaryUi).not.toMatch(/openLabel: `打开/u)
    expect(primaryUi).toContain("setHeading(dependencies.copy('plugins.heading')")
    expect(primaryUi).toContain("placeholder: dependencies.copy('plugins.search-placeholder')")
    expect(primaryUi).toContain("placeholder: dependencies.copy('marketplace.search-placeholder')")
  })

  it('keeps Console chrome locale-aware and leaves raw diagnostics out of its primary controls', async () => {
    const manager = await managerModule('plugin-detail', 'createPluginDetail')
    const consoleChrome = section(manager, "if (activeFacet === 'logs')", "if (activeFacet === 'extension-points')")

    expect(consoleChrome).not.toMatch(/[\p{Script=Han}]/u)
    expect(consoleChrome).toContain("copy('console.toolbar')")
    expect(consoleChrome).toContain("copy('console.entry-details')")
    expect(consoleChrome).toContain("copy('console.close-details')")
  })

  it('keeps every primary collection heading, search control, and demo card description locale-aware', async () => {
    const [extensions, routes, plugins] = await Promise.all([
      managerModule('extension-points', 'createExtensionPoints'),
      managerModule('routes', 'createRoutes'),
      managerModule('plugin-list', 'createPluginList'),
    ])
    const primaryCollections = [
      functionSource(extensions, 'renderExtensionPointList'),
      functionSource(routes, 'renderRouteList'),
      functionSource(plugins, 'renderPluginList'),
    ].join('\n')

    expect(primaryCollections).not.toMatch(/[\p{Script=Han}]/u)
    expect(primaryCollections).toContain("copy('extension.search-placeholder')")
    expect(primaryCollections).toContain("copy('routes.search-placeholder')")
    expect(primaryCollections).toContain("'plugins.demo.form-schema-gallery-description'")
    expect(managerCopy('en', 'plugins.demo.slot-showcase-description')).toBe(
      'Explore plugins, navigation, pages, and status.',
    )
    expect(managerCopy('zh-CN', 'plugins.demo.slot-showcase-description')).toBe('查看插件、导航、页面与状态。')
  })

  it('records shared overlay and official-control ownership instead of page-local exceptions', async () => {
    const principles = await readFile(principlesPath, 'utf8')
    expect(principles).toContain('one title, at most one concise')
    expect(principles).toContain('must not draw a second button, Select, or Input')
  })

  it('keeps plugin detail readability, compact icon controls, and raw failures out of the runtime overview', async () => {
    const [manager, styles] = await Promise.all([
      managerModule('plugin-detail', 'createPluginDetail'),
      managerModule('styles'),
    ])
    const runtime = section(manager, "if (activeFacet === 'runtime')", "if (activeFacet === 'logs')")
    expect(styles).toContain('.cxm-readme { inline-size: 100%; max-inline-size: 96rem;')
    expect(styles).toContain('.cxm-readme p, .cxm-readme li, .cxm-readme blockquote { max-inline-size: 76ch; }')
    expect(styles).toContain('.cxm-manager-icon-action, .cxm-plugin-icon-action, .cxm-plugin-menu-trigger')
    expect(styles).toContain('width: 32px; min-width: 32px; height: 32px; min-height: 32px;')
    expect(styles).toContain('.cxm-content[data-manager-list-page="true"] { display: flex; overflow: hidden; }')
    expect(styles).toContain('.cxm-fixed-list-collection .cxc-list { min-height: 0; flex: 1 1 auto; overflow: auto;')
    expect(styles).toContain(
      '.cxm-content:has(.cxm-console-panel) { display: flex; flex-direction: column; overflow: hidden; }',
    )
    expect(styles).toContain('.cxm-console-controls { grid-template-columns: repeat(2, minmax(0, 1fr)); }')
    expect(runtime).toContain("create(dependencies.document, 'section', 'cxm-runtime-overview')")
    expect(runtime).toContain("copy('runtime.status-details')")
    expect(runtime).not.toMatch(/create\((?:dependencies\.)?document, 'details', 'cxm-runtime-diagnostics'\)/u)
    expect(runtime).not.toContain("'cxm-error', plugin.error")
    expect(manager).toContain("panel.classList.add('cxm-console-panel')")
    expect(manager).not.toMatch(/create\((?:dependencies\.)?document, 'div', 'cxm-console-summary'\)/u)
    expect(manager).toContain('appendRuntimeDiagnostics(panel)')
  })

  it('keeps shared tabs complete when their content area becomes narrow', async () => {
    const manager = await managerModule('styles')
    const tabs = section(manager, '  .cxm-tabs {', '  .cxm-tab {')

    expect(tabs).toContain('flex-wrap: wrap;')
    expect(tabs).toContain('overflow: visible;')
    expect(tabs).not.toContain('overflow-x: auto;')
    expect(manager).toContain('.cxm-breadcrumb-item:last-child { flex: 1 1 auto; }')
  })
})
