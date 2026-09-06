import { expect } from 'vitest'
import { managerCopy } from '../../packages/cli/src/renderer/ui-copy.js'
import { settle, TestTDesignSelect } from './bundle.fixtures.js'
import type { verifyManagerShell } from './bundle.manager-shell.js'

export async function verifyPluginDetails(context: Awaited<ReturnType<typeof verifyManagerShell>>) {
  const {
    sessionId,
    config,
    plugin,
    dom,
    native,
    nativeParent,
    runtime,
    snapshot,
    help,
    managerTrigger,
    managerModal,
    navigation,
    expectLocalTabLeadingSeat,
    managerHeadings,
    breadcrumbLabels,
    managerContent,
  } = context
  expect(managerContent.scrollTop).toBe(37)
  dom.window.document.querySelector<HTMLButtonElement>('[data-tab="routes"]')?.click()
  expect(managerHeadings()).toEqual(['路由'])
  expect(dom.window.document.querySelectorAll('[data-route-id]')).toHaveLength(3)
  expect(dom.window.document.querySelectorAll('[data-page-product-row]')).toHaveLength(3)
  expect(managerModal?.querySelector('[data-host-collection="routes"]')).not.toBeNull()
  expect(dom.window.document.querySelector('[role="list"] [role="listitem"] button[data-route-id]')).not.toBeNull()
  expect(managerModal?.textContent).not.toContain('/main/showcase')
  expect(
    managerModal?.querySelector('[data-route-product-row="slot-showcase:main.analytics"] .cxc-title')?.textContent,
  ).toBe('工作区分析')
  expect(
    managerModal?.querySelector('[data-route-product-row="slot-showcase:main.analytics"] .cxc-description')
      ?.textContent,
  )
    .toContain('从演示导航或工作区工具栏打开工作区分析')
  expect(
    managerModal?.querySelector('[data-route-product-row="slot-showcase:session.analytics"] .cxc-machine-id')
      ?.textContent,
  ).toBe('slot-showcase:session.analytics')
  expect(managerModal?.querySelector('.cxm-kind-badge')).toBeNull()
  const catalogRouteSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="routes"]')!
  catalogRouteSearch.value = '/sessions/:sessionId/analytics'
  catalogRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-route-product-row]')]
    .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(1)
  expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-page-product-row]')]
    .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(1)
  const resetCatalogRouteSearch = dom.window.document.querySelector<HTMLInputElement>(
    '[data-collection-search="routes"]',
  )!
  resetCatalogRouteSearch.value = ''
  resetCatalogRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  dom.window.document.querySelector<HTMLButtonElement>('[data-route-id="slot-showcase:main.analytics"]')?.click()
  expect(managerHeadings()).toEqual(['工作区分析'])
  expect(breadcrumbLabels()).toEqual(['路由', '工作区分析'])
  expect(managerModal?.textContent).toContain('slot-showcase:main.analytics')
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
  dom.window.document.querySelector<HTMLButtonElement>('[data-tab="plugins"]')?.click()
  const search = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="plugins"]')
  if (search !== null) {
    search.value = 'workspace.toolbar.items'
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }
  expect(managerModal?.textContent).toContain('slot-showcase')
  expect(managerModal?.textContent).not.toContain('插件配置')
  expect(dom.window.document.querySelector<HTMLElement>('.cxm-heading-icon')?.dataset.hostIconKey).toBe('plugins')
  expect(managerHeadings()).toEqual(['插件'])
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')?.click()
  const back = dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')
  expect(back?.textContent).toBe('')
  expect(back?.getAttribute('aria-label')).toBe('返回')
  expect(back?.classList.contains('cxm-heading-leading')).toBe(true)
  expect(back?.querySelector('[data-host-icon-key="back"]')).not.toBeNull()
  expect(dom.window.getComputedStyle(back as HTMLElement).width).toBe('var(--cx-manager-header-leading-seat)')
  expect(dom.window.getComputedStyle(back as HTMLElement).borderTopWidth).toBe('0px')
  expect(dom.window.getComputedStyle(back as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', 'README'])
  expect(dom.window.document.querySelector('.cxm-readme h1')?.textContent).toBe('Slot Showcase')
  expect(managerModal?.textContent).toContain('结构化 UI 端到端演示插件')
  expect(managerModal?.textContent).not.toContain('插件配置')
  expect(dom.window.document.querySelectorAll('[data-plugin-detail-tab]')).toHaveLength(7)
  const pluginDetailTabs = [...dom.window.document.querySelectorAll<HTMLElement>('[data-plugin-detail-tab]')]
  expect(pluginDetailTabs.every(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('aria-hidden') === 'true'))
    .toBe(true)
  expect(pluginDetailTabs.every(tab => tab.querySelector('.cxm-tab-icon svg') !== null)).toBe(true)
  expect(pluginDetailTabs.map(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('data-host-icon-key'))).toEqual(
    [
      'document',
      'configuration',
      'permissions',
      'runtime',
      'diagnostics',
      'outlets',
      'routes',
    ],
  )
  expect(pluginDetailTabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1])
  expect(pluginDetailTabs.map(tab => tab.textContent)).toEqual([
    'README',
    '配置管理',
    '权限',
    '运行状态',
    '日志与诊断',
    '扩展点位',
    '路由',
  ])
  expectLocalTabLeadingSeat('[data-plugin-detail-tab]')
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.click()
  expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('config')
  expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-plugin-detail-tab]')].map(tab => tab.tabIndex))
    .toEqual([-1, 0, -1, -1, -1, -1, -1])
  expect(managerModal?.textContent).not.toContain('插件配置')
  const configPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="配置管理"]')
  const sessionField = configPanel?.querySelector<HTMLElement>('[data-config-path="sessionId"]')
  expect(sessionField?.querySelector('.cxf-label')?.textContent).toBe('原生会话 ID')
  expect(sessionField?.querySelector('.cxf-help')?.textContent)
    .toBe('可选导航快捷操作使用的原生会话 ID；留空时隐藏该快捷操作。')
  expect(sessionField?.querySelector<HTMLElement & { value: string }>('t-input')?.value).toBe(sessionId)
  expect(configPanel?.querySelector('t-button[data-variant="primary"]')).toBeNull()
  expect(configPanel?.textContent).not.toContain('此插件未提供可编辑设置。')
  expect(configPanel?.textContent).not.toContain('{}')
  expect(configPanel?.textContent).not.toContain('Schema')
  expect(configPanel?.textContent).not.toContain('Revision')
  expect(configPanel?.textContent).not.toContain('应用方式')
  expect(configPanel?.querySelector('.cxm-detail-grid')).toBeNull()
  expect(configPanel?.querySelector('.cxm-config-path')).toBeNull()
  expect(managerHeadings()).toEqual(['配置管理'])
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '配置管理'])
  expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="配置管理"]')).not.toBeNull()
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="config"]')?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
  )
  expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('permissions')
  const permissionsPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="权限"]')
  expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected'))
    .toBe('true')
  expect(managerHeadings()).toEqual(['权限'])
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '权限'])
  expect(managerHeadings()).not.toContain('Platform 权限')
  expect(permissionsPanel?.textContent).not.toContain('Platform 权限')
  expect(permissionsPanel?.querySelector('.cxm-detail')).toBeNull()
  expect(permissionsPanel?.querySelector('.cxm-slot-card')).toBeNull()
  expect(permissionsPanel?.querySelector('[role="list"][data-manager-group="capability-declarations"]')).not
    .toBeNull()
  expect(
    permissionsPanel?.querySelector('[role="listitem"][data-permission-item="models.read"]')?.getAttribute(
      'aria-label',
    ),
  ).toBe('读取可用模型')
  expect(permissionsPanel?.textContent).not.toContain('models.read')
  expect(permissionsPanel?.textContent).toContain('读取可用模型')
  expect(managerModal?.textContent).toContain('显示当前宿主连接实际可用的模型')
  expect(permissionsPanel?.textContent).not.toContain('current-connection-client-unavailable')
  expect(permissionsPanel?.textContent).not.toContain('trusted renderer code 不是安全沙箱')
  expect(permissionsPanel?.textContent).not.toContain('二次连接')
  expect(permissionsPanel?.textContent).not.toContain('原始 bridge 暴露')
  expect(permissionsPanel?.textContent).not.toContain('不是安全沙箱')
  expect(permissionsPanel?.querySelector('[data-permission-availability="models.read"]')).toBeNull()
  expect(permissionsPanel?.querySelector('[data-permission-capability="models.read"]')).not.toBeNull()
  dom.window.document.documentElement.lang = 'zh-CN'
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(managerModal?.textContent).toContain('显示当前宿主连接实际可用的模型')
  dom.window.document.querySelector<HTMLButtonElement>('[data-permission-open="models.read"]')?.click()
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '权限', '读取可用模型'])
  expect(dom.window.document.querySelector('[data-breadcrumb-current]')?.textContent).toBe('读取可用模型')
  expect(dom.window.document.querySelector('[data-breadcrumb-current]')?.matches('button, a')).toBe(false)
  expect([...dom.window.document.querySelectorAll('[data-breadcrumb-target]')].map(item => item.textContent)).toEqual(
    ['插件', 'Slot Showcase', '权限'],
  )
  expect(dom.window.history.length).toBe(1)
  expect(dom.window.location.href).toBe('https://codex.local/native')
  expect(dom.window.document.querySelector('[data-permission-detail="models.read"]')?.textContent).toContain(
    'models.read',
  )
  expect(dom.window.document.querySelector('[data-permission-provider="desktop-current-connection"]')).not.toBeNull()
  const permissionPolicy = dom.window.document.querySelector<TestTDesignSelect>(
    't-select[data-permission-capability="models.read"]',
  )
  expect(permissionPolicy!.options.map(option => option.label)).toEqual(['不可用'])
  expect(permissionPolicy!.disabled).toBe(true)
  expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
  expect(dom.window.document.querySelector('[data-plugin-detail-tab="permissions"]')?.getAttribute('aria-selected'))
    .toBe('true')
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
  )
  expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('routes')
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="routes"]')?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }),
  )
  expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('readme')
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="readme"]')?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
  )
  expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('routes')
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  expect(dom.window.document.activeElement?.getAttribute('data-plugin-detail-tab')).toBe('runtime')
  expect(dom.window.document.querySelector('[data-plugin-runtime-status="slot-showcase"]')?.textContent).toContain(
    '运行中',
  )
  expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"]')?.textContent).not.toContain(
    'slot-showcase:main.analytics',
  )
  expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="运行状态"]')?.textContent).not.toContain(
    'controlled mount',
  )
  expect(managerHeadings()).toContain('运行状态')
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '运行状态'])
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="logs"]')?.click()
  expect(dom.window.document.querySelector('[role="tabpanel"][aria-label="日志与诊断"] [data-runtime-lifecycle]'))
    .toBeNull()
  expect(
    dom.window.document.querySelector('[role="tabpanel"][aria-label="日志与诊断"] [data-runtime-console-summary]'),
  ).toBeNull()
  const platformDiagnostics = dom.window.document.querySelector<HTMLDetailsElement>(
    'details[data-runtime-diagnostics="platform"]',
  )
  expect(platformDiagnostics?.open).toBe(false)
  expect(platformDiagnostics?.querySelector('summary')?.textContent).toBe('诊断')
  expect(platformDiagnostics?.querySelector('[data-config-diagnostics="slot-showcase"]')?.textContent)
    .toBe('配置: Schemastery · plugin-restart · 版本 0 · 最后可用 0 · 写入器 不可用')
  expect(platformDiagnostics?.textContent).toContain('current-connection-client-unavailable')
  expect(platformDiagnostics?.textContent).not.toContain('当前权限仅适用于 Host API 调用。')
  expect(platformDiagnostics?.textContent).not.toContain('查看权限说明')
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="runtime"]')?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  )
  await settle()
  const runtimeAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-plugin-runtime-action="slot-showcase"]',
  )
  expect(runtimeAction).not.toBeNull()
  runtimeAction?.click()
  for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'blocked'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(runtime?.snapshot().plugins[0]?.status).toBe('blocked')
  expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toContain(
    'slot-showcase',
  )
  expect(runtime!.snapshot().commands).toEqual([])
  expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-runtime-action="slot-showcase"]')?.click()
  await new Promise(resolve => setTimeout(resolve, 0))
  dom.window.document.querySelector<HTMLButtonElement>('[data-authorization-decision="allow"]')?.click()
  for (let attempt = 0; attempt < 20 && runtime?.snapshot().plugins[0]?.status !== 'active'; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await settle()
  expect(runtime?.snapshot().plugins[0]?.status).toBe('active')
  expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.blockedPlugins.v1') ?? '[]')).toEqual([])
  expect(runtime?.snapshot().extensionPoints.points.find(item => item.id === 'sidebar.navigation.items'))
    .toMatchObject({
      adapterSupport: 'supported',
      effectiveAdapterSupport: 'supported',
      currentContext: 'not-mounted',
      availabilityCode: 'context.not-mounted',
    })
  expect(runtime?.snapshot().registrations.find(item => item.surface === 'sidebar.navigation.items')).toMatchObject({
    currentContext: 'not-mounted',
    availabilityCode: 'context.not-mounted',
    valid: true,
    authorized: true,
    pending: true,
    rendered: false,
  })
  expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-close')?.click()
  await settle()
  expect(runtime?.snapshot().extensionPoints.points.find(item => item.id === 'sidebar.navigation.items'))
    .toMatchObject({
      adapterSupport: 'supported',
      effectiveAdapterSupport: 'supported',
      currentContext: 'active',
    })
  expect(runtime?.snapshot().registrations.find(item => item.surface === 'sidebar.navigation.items')).toMatchObject({
    currentContext: 'active',
    pending: false,
    rendered: true,
  })
  expect(dom.window.document.querySelector('.cordisx-nav-row')).not.toBeNull()
  managerTrigger?.click()
  await settle()
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="extension-points"]')?.click()
  expect(dom.window.document.querySelector('[data-host-collection="plugin-extension-points-slot-showcase"]')).not
    .toBeNull()
  expect(managerModal?.textContent).toContain('workspace.toolbar.items')
  expect(managerModal?.textContent).toContain('工作区工具栏')
  expect(managerModal?.textContent).not.toContain('/main/analytics')
  expect(managerHeadings()).toEqual(['扩展点位'])
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '扩展点位'])
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="routes"]')?.click()
  expect(dom.window.document.querySelector('[data-host-collection="plugin-routes-slot-showcase"]')).not.toBeNull()
  expect(managerModal?.textContent).not.toContain('/main/showcase')
  expect(managerModal?.textContent).toContain('slot-showcase:main.analytics')
  const pluginRoutePanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="路由"]')!
  expect(pluginRoutePanel.querySelector('[data-host-collection="plugin-routes-slot-showcase"]')).not.toBeNull()
  expect(pluginRoutePanel.querySelectorAll('[data-route-product-row]')).toHaveLength(3)
  expect(pluginRoutePanel.querySelectorAll('[data-page-product-row]')).toHaveLength(3)
  expect(
    pluginRoutePanel.querySelector('[data-route-product-row="slot-showcase:app.overview"] .cxc-description')
      ?.textContent,
  )
    .toContain('从侧栏底部或演示设置打开应用概览')
  expect(
    pluginRoutePanel.querySelector('[data-page-product-row="slot-showcase:session.analytics"] .cxc-description')
      ?.textContent,
  )
    .toContain('当前原生会话页头')
  expect(pluginRoutePanel.querySelector('.cxm-kind-badge')).toBeNull()
  expect(pluginRoutePanel.textContent).not.toContain('受控页面 mount')
  const pluginRouteSearch = pluginRoutePanel.querySelector<HTMLInputElement>(
    '[data-collection-search="plugin-routes-slot-showcase"]',
  )!
  pluginRouteSearch.value = '当前原生会话页头'
  pluginRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  expect([...pluginRoutePanel.querySelectorAll<HTMLElement>('[data-route-product-row]')]
    .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(0)
  expect([...pluginRoutePanel.querySelectorAll<HTMLElement>('[data-page-product-row]')]
    .filter(item => item.closest<HTMLElement>('[role="listitem"]')?.hidden === false)).toHaveLength(1)
  const resetPluginRouteSearch = dom.window.document.querySelector<HTMLInputElement>(
    '[data-collection-search="plugin-routes-slot-showcase"]',
  )!
  resetPluginRouteSearch.value = ''
  resetPluginRouteSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  expect(breadcrumbLabels()).toEqual(['插件', 'Slot Showcase', '路由'])
  dom.window.document.querySelector<HTMLButtonElement>('[data-breadcrumb-target="primary:plugins"]')?.click()
  const restoredSearch = dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="plugins"]')
  expect(restoredSearch?.value).toBe('workspace.toolbar.items')
  expect(managerModal?.textContent).not.toContain('插件配置')
  if (restoredSearch !== null) {
    restoredSearch.value = ''
    restoredSearch.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  }
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-id="configured-off"]')?.click()
  dom.window.document.querySelector<HTMLButtonElement>('[data-plugin-detail-tab="permissions"]')?.click()
  const emptyPermissionsPanel = dom.window.document.querySelector<HTMLElement>('[role="tabpanel"][aria-label="权限"]')
  expect(emptyPermissionsPanel?.textContent).toContain('该插件没有申请任何权限。')
  expect(emptyPermissionsPanel?.textContent).not.toContain('当前连接：')
  expect(emptyPermissionsPanel?.querySelector('[role="list"]')).toBeNull()
  expect(emptyPermissionsPanel?.querySelector('section section')).toBeNull()
  expect(managerHeadings()).toHaveLength(1)
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
  dom.window.document.querySelector<HTMLButtonElement>('[data-tab="marketplace"]')?.click()
  expect(dom.window.document.querySelector<HTMLElement>('.cxm-heading-icon')?.dataset.hostIconKey).toBe('marketplace')
  for (
    let attempt = 0;
    attempt < 20 && dom.window.document.querySelector('[data-marketplace-plugin="slot-showcase"]') === null;
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(managerModal?.textContent).toContain('发现插件')
  expect(managerModal?.textContent).toContain('点位展示目录')
  expect(managerModal?.textContent).not.toContain('Marketplace hierarchy fixture')
  expect(managerModal?.querySelector('.cxm-feed-summary')).toBeNull()
  expect(managerModal?.querySelector('.cxm-result-count')).toBeNull()
  expect(managerHeadings()).toEqual(['插件商店'])
  dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-plugin="slot-showcase"] .cxc-primary')
    ?.click()
  expect(managerHeadings()).toEqual(['概览', '关键词'])
  expect(breadcrumbLabels()).toEqual(['插件商店', '点位展示目录', '概览'])
  expect(managerModal?.textContent?.match(/点位展示目录/g)).toHaveLength(1)
  expect(managerModal?.textContent).toContain('插件商店层级夹具')
  const marketplaceTabs = [...dom.window.document.querySelectorAll<HTMLElement>('[data-marketplace-detail-tab]')]
  expect(marketplaceTabs.map(tab => tab.textContent)).toEqual(['概览', '作者与来源'])
  expect(marketplaceTabs.map(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('data-host-icon-key'))).toEqual([
    'overview',
    'authors-source',
  ])
  expect(marketplaceTabs.map(tab => tab.tabIndex)).toEqual([0, -1])
  expectLocalTabLeadingSeat('[data-marketplace-detail-tab]')
  expect(managerModal?.textContent).not.toContain('运行状态')
  expect(managerModal?.textContent).not.toContain('安装')
  dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-detail-tab="authors-source"]')?.click()
  expect(dom.window.document.activeElement?.getAttribute('data-marketplace-detail-tab')).toBe('authors-source')
  expect(breadcrumbLabels()).toEqual(['插件商店', '点位展示目录', '作者与来源'])
  const marketplaceLinks = [
    ...dom.window.document.querySelectorAll<HTMLAnchorElement>('[role="tabpanel"][aria-label="作者与来源"] a'),
  ]
  expect(marketplaceLinks.length).toBeGreaterThan(2)
  expect(marketplaceLinks.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true)
  const marketplaceExternalClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  expect(marketplaceLinks[0]?.dispatchEvent(marketplaceExternalClick)).toBe(true)
  expect(marketplaceExternalClick.defaultPrevented).toBe(false)
  expect(managerModal?.hidden).toBe(true)
  expect(managerTrigger?.getAttribute('aria-expanded')).toBe('false')
  managerTrigger?.click()
  expect(
    dom.window.document.querySelector('[data-marketplace-detail-tab="authors-source"]')?.getAttribute(
      'aria-selected',
    ),
  ).toBe('true')
  expect(managerModal?.querySelector('.cxm-detail')).toBeNull()
  dom.window.document.querySelector<HTMLButtonElement>('[data-breadcrumb-target="primary:marketplace"]')?.click()
  const sourceMenu = dom.window.document.querySelector<HTMLButtonElement>('[data-marketplace-source-menu]')!
  sourceMenu.click()
  expect(
    dom.window.document.querySelector(
      `[data-manager-action-menu="${managerCopy('zh-CN', 'marketplace.source-menu-label')}"]`,
    )?.parentElement,
  ).toBe(dom.window.document.body)
  dom.window.document.querySelector<HTMLButtonElement>('[data-manager-menu-action="manage"]')!.click()
  expect(dom.window.document.querySelector('[data-marketplace-source-page="index"]')).not.toBeNull()
  expect(dom.window.document.querySelector('[data-host-collection="marketplace-sources"]')).not.toBeNull()
  expect(managerModal?.textContent).not.toContain('重新加载')
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
  expect(dom.window.document.querySelector('[data-tab="settings"]')).toBeNull()
  expect(dom.window.document.querySelector('[data-settings-tab]')).toBeNull()
  expect(managerModal?.textContent).not.toContain('启动器配置由 cordisx.config.json 管理。')
  await runtime?.dispose()
  expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host]')).toBeNull()
  expect(dom.window.document.querySelector('[data-cordisx-page-outlet]')).toBeNull()
  expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
  expect(dom.window.document.querySelector('[data-cordisx-brand-mark]')).toBeNull()
  expect(dom.window.document.querySelectorAll<HTMLElement>('[data-test-id="header-shell-slot"]')[1]?.style.width)
    .toBe('0px')
  expect(dom.window.document.getElementById('cordisx-manager-style')).toBeNull()
  expect(native.parentElement).toBe(nativeParent)
  dom.window.close()
}
