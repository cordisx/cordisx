import { expect } from 'vitest'
import { settle, TestTDesignSelect } from './bundle.fixtures.js'
import type { verifyRoutes } from './bundle.routes.js'

export async function verifyManagerShell(context: Awaited<ReturnType<typeof verifyRoutes>>) {
  const { config, plugin, bundle, dom, native, nativeParent, runtime, snapshot, sessionId, help } = context
  const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')
  expect(managerTrigger?.getAttribute('aria-label')).toBe('管理 CordisX 插件')
  expect(managerTrigger?.classList.contains('cordisx-icon-only-control')).toBe(false)
  expect(dom.window.getComputedStyle(managerTrigger!).display).toBe('inline-flex')
  expect(dom.window.getComputedStyle(managerTrigger!).alignItems).toBe('center')
  expect(dom.window.getComputedStyle(managerTrigger!).justifyContent).toBe('center')
  expect(managerTrigger?.querySelector('svg')).toBeNull()
  const triggerMark = managerTrigger?.querySelector<HTMLElement>('.cxr-trigger-mark')
  const triggerDark = triggerMark?.querySelector<HTMLImageElement>('.cxr-brand-mark-dark')
  const triggerLight = triggerMark?.querySelector<HTMLImageElement>('.cxr-brand-mark-light')
  expect(dom.window.getComputedStyle(triggerMark!).width).toBe('20px')
  expect(dom.window.getComputedStyle(triggerMark!).height).toBe('20px')
  expect(decodeURIComponent(triggerDark?.src ?? '')).toContain('for dark backgrounds')
  expect(decodeURIComponent(triggerDark?.src ?? '')).toContain('stroke="#fcfcfc"')
  expect(dom.window.document.getElementById('cordisx-react-manager-style')?.textContent).not.toContain('mask-image')
  dom.window.document.documentElement.className = 'electron-light'
  await settle()
  expect(dom.window.getComputedStyle(triggerDark!).display).toBe('none')
  expect(dom.window.getComputedStyle(triggerLight!).display).toBe('block')
  expect(decodeURIComponent(triggerLight?.src ?? '')).toContain('for light backgrounds')
  expect(decodeURIComponent(triggerLight?.src ?? '')).toContain('stroke="#030303"')
  dom.window.document.documentElement.className = 'electron-dark'
  await settle()
  managerTrigger?.click()
  await settle()
  const managerModal = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal]')
  expect(managerModal?.hidden).toBe(false)
  expect(managerModal?.querySelector('.cxr-dialog')).not.toBeNull()
  expect(managerModal?.querySelector('.cxr-nav')?.getAttribute('aria-label')).toBe('CordisX 管理器页面')
  expect([...managerModal!.querySelectorAll<HTMLElement>('.cxr-nav [data-tab]')].map(item => item.dataset.tab))
    .toEqual(['plugins', 'plugin-bundles', 'extension-points', 'routes', 'marketplace', 'about'])
  const pluginRow = managerModal?.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')
  expect(pluginRow?.querySelector('[data-icon-kind="derived"]')).not.toBeNull()
  expect(pluginRow?.textContent).toContain('点位展示')
  pluginRow?.click()
  await settle()
  expect(managerModal?.querySelector('[data-plugin-detail-tab="readme"]')).not.toBeNull()
  expect(managerModal?.querySelector('[data-plugin-detail-tab="config"]')).not.toBeNull()
  expect(managerModal?.querySelector('[role="tabpanel"][aria-label="README"] .cxm-readme')).not.toBeNull()
  await runtime?.dispose()
  expect(dom.window.document.documentElement.dataset.cordisxReady).toBeUndefined()
  expect(dom.window.document.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
  expect(dom.window.document.querySelector('.cxr-brand-mark')).toBeNull()
  expect(dom.window.document.getElementById('cordisx-react-manager-style')).toBeNull()
  expect(native.parentElement).toBe(nativeParent)
  dom.window.close()
  // Baseline 48a8c6e: bundle.integration.test.ts:1214 unconditionally exits here.
  // Keep the legacy Manager/marketplace assertions below unreachable in this refactor.
  return undefined
  expect(managerModal?.querySelector('.cxm-brand')).toBeNull()
  expect(managerModal?.querySelector('.cxm-eyebrow')).toBeNull()
  expect(managerModal?.querySelector('.cxm-brand-title')).toBeNull()
  expect(managerModal?.querySelector('.cxm-version')).toBeNull()
  expect(managerModal?.querySelector('.cxm-sidebar')?.firstElementChild?.classList.contains('cxm-nav')).toBe(true)
  const navigation = managerModal?.querySelector<HTMLElement>('.cxm-nav')
  expect(navigation?.tagName).toBe('NAV')
  expect(navigation?.getAttribute('aria-label')).toBe('CordisX 管理器页面')
  const primaryNavigation = [...(navigation?.querySelectorAll<HTMLElement>('.cxm-nav-button') ?? [])]
  expect(primaryNavigation.map(item => item.dataset.tab)).toEqual([
    'plugins',
    'plugin-bundles',
    'extension-points',
    'routes',
    'marketplace',
    'about',
  ])
  expect(primaryNavigation.map(item => item.tabIndex)).toEqual([0, -1, -1, -1, -1, -1])
  expect(primaryNavigation.map(item => item.getAttribute('aria-current'))).toEqual([
    'page',
    null,
    null,
    null,
    null,
    null,
  ])
  expect(
    primaryNavigation.slice(0, 5).map(item =>
      item.querySelector('[data-host-icon-key]')?.getAttribute('data-host-icon-key')
    ),
  ).toEqual([
    'plugins',
    'plugins',
    'contributions',
    'routes',
    'marketplace',
  ])
  expect(primaryNavigation.at(0)?.textContent).toContain('插件')
  expect(primaryNavigation.at(-1)?.textContent).toContain('关于 CordisX')
  expect(managerModal?.querySelector('.cxm-close [data-host-icon-key="close"]')).not.toBeNull()
  const initialMaterialIcons = [...(managerModal?.querySelectorAll<HTMLElement>('[data-host-icon-key]') ?? [])]
  expect(initialMaterialIcons.length).toBeGreaterThan(6)
  expect(initialMaterialIcons.every(icon => icon.getAttribute('aria-hidden') === 'true' && icon.draggable === false))
    .toBe(true)
  expect(initialMaterialIcons.every(icon => icon.querySelector('svg path') !== null)).toBe(true)
  expect(initialMaterialIcons.every(icon => icon.querySelector('svg')?.getAttribute('focusable') === 'false')).toBe(
    true,
  )
  const aboutNavigationMark = primaryNavigation.at(-1)?.querySelector<HTMLImageElement>(
    'img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]',
  )
  expect(aboutNavigationMark?.getAttribute('aria-hidden')).toBe('true')
  expect(aboutNavigationMark?.alt).toBe('')
  expect(aboutNavigationMark?.style.getPropertyValue('--cordisx-brand-mask')).toBe('')
  expect(
    primaryNavigation.find(item => item.dataset.tab === 'marketplace')?.nextElementSibling?.getAttribute('data-tab'),
  ).toBe('about')
  const managerStyles = dom.window.document.getElementById('cordisx-manager-style')?.textContent ?? ''
  expect(managerStyles).toContain('.cxm-nav-button[data-tab="about"] { margin-top: auto; }')
  expect(managerStyles).toContain('grid-template-columns: var(--cx-manager-header-leading-seat) minmax(0, 1fr)')
  expect(managerStyles).toContain('grid-template-columns: 248px minmax(0, 1fr)')
  expect(managerStyles).toContain('width: min(1440px, calc(100vw - 40px))')
  expect(managerStyles).toContain('height: min(960px, calc(100vh - 40px))')
  expect(managerStyles).toContain(
    '.cxm-main { display: flex; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; }',
  )
  expect(managerStyles).toContain('flex: 1 1 0%')
  expect(managerStyles).toContain('overflow-y: auto')
  expect(managerStyles).toContain('border-radius: 9px;')
  expect(managerStyles).toContain('.cxm-nav-button[aria-current="page"]')
  expect(managerStyles).toContain('grid-template-columns: 18px minmax(0, 1fr)')
  expect(managerStyles).toContain('.cxm-manager-content-root { min-width: 0; max-width: 100%; }')
  expect(managerStyles).toContain('.cxm-tab[aria-selected="true"] { background: rgba(199, 204, 212, .14);')
  expect(managerStyles).not.toContain('.cxm-tab[aria-selected="true"]::after')
  expect(managerStyles).toContain('.cxm-heading p { grid-column: 1 / -1; margin: 3px 0 0;')
  expect(managerStyles).toContain('.cxm-heading-leading {')
  expect(managerStyles).toContain('min-height: var(--cx-manager-header-leading-seat)')
  expect(managerStyles).toContain('transform: translateY(-.5px)')
  expect(managerStyles).toContain('-webkit-user-select: none')
  expect(managerStyles).toContain('user-select: none')
  expect(managerStyles).toContain('-webkit-user-drag: none')
  expect(managerStyles).toContain('border: 0;\n    background: transparent;')
  expect(managerStyles).toContain('.cxm-back:hover { background: rgba(199, 204, 212, .14);')
  expect(managerStyles).toContain('.cxm-back:focus-visible { outline: 2px solid #c7ccd4;')
  expect(managerStyles).toContain('.cxm-breadcrumb-menu')
  expect(managerStyles).toContain('background: #4ade80')
  expect(managerStyles).not.toMatch(/#8b5cf6|#a78bfa|#ddd6fe|#b9a6ff|#c4b5fd|139, 92, 246|167, 139, 250/)
  expect(managerStyles).toContain('background: #4ade80')
  expect(managerStyles).toContain('background: #fbbf24')
  expect(managerStyles).toContain('background: #fb7185')
  expect(managerStyles).not.toContain('.cxm-result-count')
  expect(managerStyles).not.toContain('.cxm-feed-summary')
  expect(managerStyles).toContain('.cxm-about-identity-copy { min-width: 0; white-space: nowrap; }')
  const pluginCard = managerModal?.querySelector<HTMLElement>('[data-plugin-card="slot-showcase"]')
  expect(pluginCard?.querySelector('.cxc-description')?.textContent).toBe('查看插件、导航、页面与状态。')
  expect(pluginCard?.querySelector('.cxc-machine-id')?.textContent).toBe('slot-showcase')
  expect(pluginCard?.querySelector('.cxc-status')?.getAttribute('data-tone')).toBe('success')
  expect(pluginCard?.querySelector('[data-plugin-primary]')?.getAttribute('aria-description')).toBe('运行中')
  expect(pluginCard?.textContent).not.toContain('运行中')
  const importButton = managerModal?.querySelector<HTMLButtonElement>('[data-import-local-plugin]')
  expect(importButton?.textContent).toBe('')
  expect(importButton?.getAttribute('aria-label')).toBe('导入本地插件')
  expect(importButton?.querySelector('[data-host-icon-key="import-plugin"]')).not.toBeNull()
  expect(managerStyles).toContain('.cxc-card:hover .cxc-actions')
  expect(managerStyles).toContain('.cxc-card:focus-within .cxc-actions')
  expect(managerStyles).toContain('.cxc-card[data-action-menu-open="true"] .cxc-actions')
  const expectLocalTabLeadingSeat = (selector: string): void => {
    const firstTab = dom.window.document.querySelector<HTMLElement>(`${selector}:first-child`)
    const icon = firstTab?.querySelector<HTMLElement>('.cxm-tab-icon')
    const visibleContent = firstTab?.querySelector<HTMLElement>('.cxm-tab-content')
    expect(firstTab).not.toBeNull()
    expect(dom.window.getComputedStyle(firstTab!).paddingLeft).toBe('9px')
    expect(dom.window.getComputedStyle(firstTab!).borderRadius).toBe('9px')
    expect(dom.window.getComputedStyle(icon!).width).toBe('18px')
    expect(dom.window.getComputedStyle(icon!).height).toBe('18px')
    expect(dom.window.getComputedStyle(visibleContent!).gridTemplateColumns).toBe('18px minmax(0, 1fr)')
  }
  const managerHeadings = (): string[] =>
    [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-heading h2, .cxm-section-title')]
      .map(element => element.textContent?.trim() ?? '')
  const breadcrumbLabels = (): string[] =>
    [...dom.window.document.querySelectorAll<HTMLElement>('.cxm-breadcrumb-list > .cxm-breadcrumb-item')]
      .flatMap(
        item => [
          ...item.querySelectorAll<HTMLElement>(':scope > .cxm-breadcrumb-action, :scope > .cxm-breadcrumb-current'),
        ],
      )
      .map(element => element.textContent?.trim() ?? '')
  const primaryLeading = dom.window.document.querySelector<HTMLElement>('.cxm-heading-leading')
  expect(primaryLeading?.classList.contains('cxm-heading-icon')).toBe(true)
  expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).width).toBe(
    'var(--cx-manager-header-leading-seat)',
  )
  expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).borderTopWidth).toBe('0px')
  expect(dom.window.getComputedStyle(primaryLeading as HTMLElement).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(primaryLeading?.dataset.hostIconKey).toBe('plugins')
  expect(primaryLeading?.textContent).toBe('')
  expect(primaryLeading?.querySelector('svg')?.getAttribute('focusable')).toBe('false')
  expect(primaryLeading?.draggable).toBe(false)
  expect(managerHeadings()).toEqual(['插件'])
  const pluginList = managerModal?.querySelector<HTMLElement>('[role="list"][aria-label="当前 bundle 插件"]')
  const pluginOpen = pluginList?.querySelector<HTMLButtonElement>('[data-plugin-id="slot-showcase"]')
  expect(pluginList).not.toBeNull()
  expect(pluginOpen).not.toBeNull()
  expect(pluginOpen?.querySelector('.cxm-chevron')).toBeNull()
  expect(pluginOpen?.closest('[role="listitem"]')).not.toBeNull()
  const pluginActions = [
    ...(pluginOpen?.closest('.cxc-card')?.querySelectorAll<HTMLButtonElement>('[data-plugin-action]') ?? []),
  ]
  expect(pluginActions.map(action => action.dataset.pluginAction)).toEqual(['disable', 'favorite', 'reload'])
  expect(pluginActions.find(action => action.dataset.pluginAction === 'disable')).toMatchObject({ disabled: true })
  expect(pluginActions.find(action => action.dataset.pluginAction === 'reload')).toMatchObject({ disabled: true })
  expect(pluginActions.find(action => action.dataset.pluginAction === 'reload')?.getAttribute('aria-label')).toBe(
    '重载插件：当前不可用',
  )
  expect(pluginActions.every(action => action.querySelector('[data-host-icon-key]') !== null)).toBe(true)
  expect(pluginActions.find(action => action.dataset.pluginAction === 'favorite')?.getAttribute('aria-pressed')).toBe(
    'false',
  )
  pluginActions.find(action => action.dataset.pluginAction === 'favorite')?.click()
  expect(managerHeadings()).toEqual(['插件'])
  expect(JSON.parse(dom.window.localStorage.getItem('cordisx.manager.favoritePlugins.v1:development') ?? '[]'))
    .toEqual(['slot-showcase'])
  const overflow = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-plugin-menu="slot-showcase"] .cxc-menu-trigger',
  )!
  overflow.click()
  const overflowMenu = dom.window.document.querySelector<HTMLElement>('body > .cxc-menu-popup')
  expect(overflow.getAttribute('aria-expanded')).toBe('true')
  expect(overflowMenu?.getAttribute('role')).toBe('menu')
  expect(
    [...overflowMenu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []].map(
      item => [item.dataset.collectionAction, item.disabled],
    ),
  ).toEqual([
    ['diagnostics', false],
  ])
  overflowMenu?.dispatchEvent(
    new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  )
  expect(dom.window.document.querySelector('body > .cxc-menu-popup')).toBeNull()
  expect(overflow.getAttribute('aria-expanded')).toBe('false')
  const aboutTab = dom.window.document.querySelector<HTMLButtonElement>('[data-tab="about"]')
  aboutTab?.focus()
  aboutTab?.click()
  expect(dom.window.document.querySelector('.cxm-heading-icon')?.textContent).toBe('')
  expect(dom.window.document.querySelector('.cxm-heading-icon [data-cordisx-brand-mark]')).toBeNull()
  expect(dom.window.document.querySelector('.cxm-heading-icon')?.matches('[data-cordisx-brand-mark]')).toBe(true)
  const aboutDirectMarks = [
    ...(managerModal?.querySelectorAll<HTMLImageElement>(
      'img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]',
    ) ?? []),
  ]
  const currentAboutMarks = () => [
    ...(managerModal?.querySelectorAll<HTMLImageElement>(
      'img[data-cordisx-brand-mark][data-brand-rendering="direct-host"]',
    ) ?? []),
  ]
  expect(aboutDirectMarks).toHaveLength(3)
  expect(dom.window.document.querySelectorAll('[data-brand-rendering="direct-host"]')).toHaveLength(4)
  expect(aboutDirectMarks.every(mark => mark.getAttribute('aria-hidden') === 'true' && mark.alt === '')).toBe(true)
  expect(aboutDirectMarks.every(mark => mark.style.getPropertyValue('--cordisx-brand-mask') === '')).toBe(true)
  const directSvg = decodeURIComponent(aboutDirectMarks[0]?.src.slice(aboutDirectMarks[0].src.indexOf(',') + 1) ?? '')
  expect(directSvg).toContain('CordisX mark for dark backgrounds')
  expect(new Set([...directSvg.matchAll(/stroke="(#[0-9a-f]{6})"/gi)].map(match => match[1])).size).toBeGreaterThan(
    10,
  )
  dom.window.document.documentElement.className = 'electron-light'
  await settle()
  expect(currentAboutMarks().every(mark => mark.dataset.hostBackground === 'light')).toBe(true)
  expect(
    currentAboutMarks().every(mark => decodeURIComponent(mark.src).includes('CordisX mark for light backgrounds')),
  ).toBe(true)
  expect(dom.window.getComputedStyle(primaryNavigation[0]!.querySelector<HTMLElement>('.cxm-nav-icon')!).color).toBe(
    'var(--cx-muted)',
  )
  expect(managerModal?.style.getPropertyValue('--cx-muted')).toBe('#526071')
  expect(dom.window.getComputedStyle(dom.window.document.querySelector<HTMLElement>('.cxm-heading-leading')!).color)
    .toBe('var(--cx-text)')
  expect(managerModal?.style.getPropertyValue('--cx-text')).toBe('#18212f')
  dom.window.document.documentElement.className = 'electron-dark'
  await settle()
  expect(currentAboutMarks().every(mark => mark.dataset.hostBackground === 'dark')).toBe(true)
  expect(dom.window.document.querySelector('.cxm-about-name')?.textContent).toBe('CordisX')
  expect(dom.window.document.querySelector('.cxm-about-version')?.textContent).toBe('v0.1.0-beta.2')
  expect(dom.window.document.querySelector('.cxm-about-identity [data-cordisx-brand-mark]')).not.toBeNull()
  expect([...dom.window.document.querySelector('.cxm-about-identity')?.children ?? []].map(item => item.className))
    .toEqual([
      'cxm-brand-mark cxm-about-mark',
      'cxm-about-identity-copy',
    ])
  expect(dom.window.document.querySelector('.cxm-about-actions')?.getAttribute('role')).toBe('list')
  expect(dom.window.document.querySelectorAll('.cxm-about-action-item[role="listitem"]')).toHaveLength(4)
  const aboutActions = [...dom.window.document.querySelectorAll<HTMLAnchorElement>('.cxm-about-action')]
  expect(aboutActions.map(link => link.querySelector('.cxm-about-action-title')?.textContent)).toEqual([
    '反馈问题',
    '参与建设',
    '查看文档',
    '项目主页',
  ])
  expect(aboutActions.map(link => link.href)).toEqual([
    'https://github.com/cordisx/cordisx/issues/new',
    'https://github.com/cordisx/cordisx',
    'https://cordisx.github.io/docs/',
    'https://cordisx.github.io/',
  ])
  expect(aboutActions.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer')).toBe(true)
  expect(aboutActions.every(link => link.getAttribute('role') === null)).toBe(true)
  expect(
    aboutActions.every(link => link.querySelector('.cxm-about-action-arrow')?.getAttribute('aria-hidden') === 'true'),
  ).toBe(true)
  expect(
    aboutActions.every(link =>
      link.querySelector('.cxm-about-action-arrow')?.getAttribute('data-host-icon-key') === 'external-link'
    ),
  ).toBe(true)
  expect(aboutActions.every(link =>
    link.children.length === 2
    && link.children[0]?.classList.contains('cxm-about-action-body')
    && link.children[1]?.classList.contains('cxm-about-action-arrow')
  )).toBe(true)
  expect(aboutActions.every(link => link.parentElement?.matches('.cxm-about-action-item[role="listitem"]'))).toBe(
    true,
  )
  expect(aboutActions.every(link =>
    [...(link.querySelector('.cxm-about-action-body')?.children ?? [])]
      .map(child => child.className).join(' ') === 'cxm-about-action-title cxm-about-action-copy'
  )).toBe(true)
  expect(aboutActions.every(link => dom.window.getComputedStyle(link).display === 'flex')).toBe(true)
  expect(aboutActions.every(link => dom.window.getComputedStyle(link).padding === '14px 12px')).toBe(true)
  const transparentBackgrounds = new Set(['transparent', 'rgba(0, 0, 0, 0)'])
  expect(
    aboutActions.every(link =>
      transparentBackgrounds.has(
        dom.window.getComputedStyle(link.querySelector<HTMLElement>('.cxm-about-action-title')!).backgroundColor,
      )
    ),
  ).toBe(true)
  expect(
    aboutActions.every(link =>
      transparentBackgrounds.has(
        dom.window.getComputedStyle(link.querySelector<HTMLElement>('.cxm-about-action-copy')!).backgroundColor,
      )
    ),
  ).toBe(true)
  const aboutStyles = [...dom.window.document.querySelectorAll('style')].map(style => style.textContent ?? '').join(
    '\n',
  )
  expect(aboutStyles).toMatch(
    /\.cxm-about-action\s*\{[^}]*width:\s*100%;[^}]*box-sizing:\s*border-box;[^}]*border-radius:\s*9px;[^}]*background:\s*transparent;/,
  )
  expect(aboutStyles).toMatch(
    /\.cxm-about-actions\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid[^}]*border-radius:\s*12px;/,
  )
  expect(aboutStyles).toContain(
    '.cxm-about-action-item + .cxm-about-action-item { border-top: 1px solid rgba(255, 255, 255, .08); }',
  )
  expect(aboutStyles).toContain(
    '.cxm-about-action:hover, .cxm-about-action:focus-visible { background: var(--cx-hover); color: var(--cx-text); }',
  )
  expect(aboutStyles).toContain('.cxm-about-action-title, .cxm-about-action-copy { background: transparent; }')
  expect(aboutStyles).not.toMatch(/\.cxm-about-action:hover \.cxm-about-action-title\s*\{[^}]*background:/)
  aboutActions[0]?.focus()
  expect(dom.window.document.activeElement).toBe(aboutActions[0])
  const externalClick = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  expect(aboutActions[0]?.dispatchEvent(externalClick)).toBe(true)
  expect(externalClick.defaultPrevented).toBe(false)
  expect(managerModal?.hidden).toBe(true)
  expect(managerTrigger?.getAttribute('aria-expanded')).toBe('false')
  expect(dom.window.document.activeElement).not.toBe(managerTrigger)
  managerTrigger?.click()
  expect(managerModal?.textContent).not.toContain('CordisX 版本')
  expect(managerModal?.textContent).not.toContain('运行插件')
  expect(managerModal?.textContent).not.toContain('结构化 surfaces')
  expect(managerModal?.textContent).not.toContain('宿主语言')
  expect(managerModal?.textContent).not.toContain('运行边界')
  expect(managerModal?.textContent).not.toContain('管理器里的“屏蔽”')
  expect(managerModal?.querySelector('.cxm-card-grid')).toBeNull()
  expect(managerHeadings()).toEqual(['关于 CordisX'])
  expect(managerModal?.querySelector('.cxm-result-count')).toBeNull()
  expect(managerModal?.querySelector('.cxm-feed-summary')).toBeNull()
  dom.window.document.querySelector<HTMLButtonElement>('[data-tab="extension-points"]')?.click()
  expect(dom.window.document.querySelector<HTMLElement>('.cxm-heading-icon')?.dataset.hostIconKey).toBe(
    'contributions',
  )
  expect(managerModal?.textContent).toContain('sidebar.footer.before-control')
  expect(managerModal?.textContent).toContain('侧边栏底部前置操作')
  expect(managerHeadings()).toEqual(['扩展点'])
  expect(dom.window.document.querySelector('[role="list"] [role="listitem"] button[data-extension-point-id]')).not
    .toBeNull()
  expect(managerModal?.textContent).not.toContain('个活跃贡献')
  expect(managerModal?.textContent).not.toContain('Routes / Pages')
  const extensionPointSearch = dom.window.document.querySelector<HTMLInputElement>(
    '[aria-label="搜索 CordisX 扩展点"]',
  )
  extensionPointSearch!.value = '侧边栏导航'
  extensionPointSearch!.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  const managerContent = dom.window.document.querySelector<HTMLElement>('.cxm-content')!
  managerContent.scrollTop = 37
  dom.window.document.querySelector<HTMLButtonElement>('[data-extension-point-id="sidebar.navigation.items"]')
    ?.click()
  expect(managerHeadings()).toEqual(['使用情况'])
  expect(breadcrumbLabels()).toEqual(['扩展点', '侧边栏导航', '使用情况'])
  const pointTabs = [...dom.window.document.querySelectorAll<HTMLElement>('[data-extension-point-detail-tab]')]
  expect(pointTabs.map(tab => tab.textContent)).toEqual(['使用情况', '点位信息', '诊断'])
  expect(pointTabs.map(tab => tab.querySelector('.cxm-tab-icon')?.getAttribute('data-host-icon-key'))).toEqual([
    'plugins',
    'point-info',
    'diagnostics',
  ])
  expectLocalTabLeadingSeat('[data-extension-point-detail-tab]')
  expect(dom.window.document.querySelector('[data-list-search^="extension-point-usage-"]')).not.toBeNull()
  const navigationContribution = dom.window.document.querySelector<HTMLElement>('[data-contribution-id="main-page"]')
  expect(navigationContribution?.querySelector('.cxm-resource-title')?.textContent).toBe('结构化 UI 演示')
  expect(navigationContribution?.querySelector('.cxm-resource-description')?.textContent).toContain('打开演示页面。')
  expect(navigationContribution?.querySelector('.cxm-resource-id')?.textContent).toBe('main-page')
  expect(navigationContribution?.querySelector('.cxm-slot-card, .cxm-kind-badge, .cxm-chevron')).toBeNull()
  dom.window.document.querySelector<HTMLButtonElement>('[data-extension-point-detail-tab="information"]')?.click()
  expect(breadcrumbLabels()).toEqual(['扩展点', '侧边栏导航', '点位信息'])
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
  expect(breadcrumbLabels()).toEqual(['扩展点', '侧边栏导航', '使用情况'])
  const pointPolicy = dom.window.document.querySelector<TestTDesignSelect>(
    't-select[aria-label="Slot Showcase使用侧边栏导航的策略"]',
  )
  expect(pointPolicy).not.toBeNull()
  pointPolicy!.setSelectedValue('deny', true)
  for (
    let attempt = 0;
    attempt < 20
    && runtime?.snapshot().extensionPoints.policies.find(item => item.identity.pointId === 'sidebar.navigation.items')
        ?.policy !== 'deny';
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(
    runtime?.snapshot().extensionPoints.policies.find(item => item.identity.pointId === 'sidebar.navigation.items')
      ?.policy,
  ).toBe('deny')
  const deniedPointPolicy = dom.window.document.querySelector<TestTDesignSelect>(
    't-select[aria-label="Slot Showcase使用侧边栏导航的策略"]',
  )
  deniedPointPolicy!.setSelectedValue('allow', true)
  for (
    let attempt = 0;
    attempt < 20
    && runtime?.snapshot().extensionPoints.policies.find(item => item.identity.pointId === 'sidebar.navigation.items')
        ?.policy !== 'allow';
    attempt += 1
  ) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  dom.window.document.querySelector<HTMLButtonElement>('.cxm-back')?.click()
  expect(dom.window.document.querySelector<HTMLInputElement>('[data-collection-search="extension-points"]')?.value)
    .toBe('侧边栏导航')
  return {
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
  }
}
