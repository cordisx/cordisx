import { expect } from 'vitest'
import { settle } from './bundle.fixtures.js'
import type { bootSurfaces } from './bundle.surfaces.js'

export async function verifyRoutes(context: Awaited<ReturnType<typeof bootSurfaces>>) {
  const {
    sessionId,
    dom,
    native,
    nativeParent,
    rect,
    getBoundingClientRect,
    runtime,
    snapshot,
    setMainRect,
    config,
    plugin,
    bundle,
  } = context
  const structuredStyles = dom.window.document.getElementById('cordisx-structured-styles')?.textContent ?? ''
  expect(structuredStyles).toContain('[data-cordisx-no-drag="true"], [data-cordisx-no-drag="true"] *')
  expect(structuredStyles).toContain('.cordisx-icon-only-control { --cordisx-icon-only-glyph-size: 16px; }')
  expect(structuredStyles).toContain(
    '.cordisx-icon-only-control.cordisx-shortcut-action { --cordisx-icon-only-glyph-size: 12px; }',
  )
  expect(dom.window.document.querySelector('details[data-cordisx-no-drag]')).toBeNull()
  expect(dom.window.document.body.textContent).not.toContain('CX')
  const toolbarAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-surface-host="toolbar.before"] button',
  )!
  expect(toolbarAction.className).not.toContain('codex-toolbar-button')
  expect(toolbarAction.className).toContain('cordisx-toolbar-action')
  expect(toolbarAction.className).toContain('cordisx-icon-only-control')
  expect(toolbarAction.dataset.cordisxIconControlVariant).toBe('toolbar')
  const toolbarSeat = toolbarAction.closest<HTMLElement>('[data-cordisx-surface-host="toolbar.before"]')!
  expect(dom.window.getComputedStyle(toolbarSeat).getPropertyValue('--cordisx-toolbar-action-target-size')).toBe(
    '28px',
  )
  expect(dom.window.getComputedStyle(toolbarSeat).getPropertyValue('--cordisx-toolbar-action-corner-radius')).toBe(
    '8px',
  )
  expect(dom.window.getComputedStyle(toolbarAction).width).toBe('var(--cordisx-toolbar-action-target-size)')
  expect(dom.window.getComputedStyle(toolbarAction).height).toBe('var(--cordisx-toolbar-action-target-size)')
  expect(dom.window.getComputedStyle(toolbarSeat).getPropertyValue('--cordisx-toolbar-action-target-size')).toBe(
    dom.window.getComputedStyle(dom.window.document.getElementById('native-toolbar-primary')!).width,
  )
  expect(dom.window.getComputedStyle(toolbarAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
  const toolbarIcon = toolbarAction.querySelector<HTMLElement>('.cordisx-host-icon')!
  const toolbarGlyph = toolbarIcon.querySelector<SVGElement>('svg')!
  const toolbarIconStyle = dom.window.getComputedStyle(toolbarIcon)
  expect(toolbarIconStyle.display).toBe('inline-flex')
  expect(toolbarIconStyle.alignItems).toBe('center')
  expect(toolbarIconStyle.justifyContent).toBe('center')
  expect(toolbarIconStyle.width).toBe('20px')
  expect(toolbarIconStyle.height).toBe('20px')
  expect(dom.window.getComputedStyle(toolbarGlyph).width).toBe('var(--cordisx-icon-only-glyph-size)')
  expect(dom.window.getComputedStyle(toolbarGlyph).height).toBe('var(--cordisx-icon-only-glyph-size)')
  expect(toolbarAction.textContent).toBe('')
  expect(toolbarAction.getAttribute('aria-label')).toBe('Open main page')
  expect(toolbarAction.dataset.cordisxTooltip).toBe('Open main page')
  expect(toolbarAction.querySelector('[data-host-icon="host:open"] svg')).not.toBeNull()
  expect(toolbarAction.closest<HTMLElement>('[data-test-id="header-shell-slot"]')?.style.width).toBe('126px')
  const sessionHeaderAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-surface-host="session.header.actions"] button',
  )!
  expect(sessionHeaderAction.className).not.toContain('codex-toolbar-button')
  expect(sessionHeaderAction.className).toContain('cordisx-toolbar-action')
  expect(dom.window.getComputedStyle(sessionHeaderAction).width).toBe('var(--cordisx-toolbar-action-target-size)')
  expect(dom.window.getComputedStyle(sessionHeaderAction).height).toBe('var(--cordisx-toolbar-action-target-size)')
  expect(dom.window.getComputedStyle(sessionHeaderAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe(
    '16px',
  )
  expect(sessionHeaderAction.getAttribute('aria-label')).toBe('Toggle session analytics')
  expect(sessionHeaderAction.dataset.cordisxTooltip).toBe('Toggle session analytics')
  expect(sessionHeaderAction.querySelector('[data-host-icon="host:analytics"] svg')).not.toBeNull()
  expect(sessionHeaderAction.getAttribute('aria-pressed')).toBe('false')
  expect(sessionHeaderAction.dataset.cordisxRouteState).toBe('inactive')
  expect(sessionHeaderAction.draggable).toBe(false)
  sessionHeaderAction.click()
  for (
    let attempt = 0;
    attempt < 20
    && runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')?.presentation
      !== 'presented';
    attempt += 1
  ) await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
    activeRoute: 'slot-showcase:session.analytics',
    contextKey: `session:${sessionId}`,
    mounted: true,
    presentation: 'presented',
  })
  const presentedSessionHeaderAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-surface-host="session.header.actions"] button',
  )!
  expect(presentedSessionHeaderAction.getAttribute('aria-pressed')).toBe('true')
  expect(presentedSessionHeaderAction.dataset.cordisxRouteState).toBe('presented')
  for (
    let attempt = 0;
    attempt < 20 && dom.window.document.querySelector('[data-cordisx-demo-marker="session.content"]') === null;
    attempt += 1
  ) await settle()
  expect(dom.window.document.querySelector('[data-cordisx-demo-marker="session.content"]')?.textContent)
    .toContain(`Session content page for native session ${sessionId}.`)
  presentedSessionHeaderAction.click()
  for (
    let attempt = 0;
    attempt < 20
    && runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')?.presentation
      !== 'inactive';
    attempt += 1
  ) await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
    mounted: false,
    presentation: 'inactive',
  })
  const restoredSessionHeaderAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-surface-host="session.header.actions"] button',
  )!
  expect(restoredSessionHeaderAction.getAttribute('aria-pressed')).toBe('false')
  expect(restoredSessionHeaderAction.dataset.cordisxRouteState).toBe('inactive')
  const composerAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-surface-host="composer.submit.before"] button',
  )!
  expect(composerAction.className).toContain('cordisx-composer-action')
  expect(composerAction.className).not.toContain('codex-composer-button')
  expect(composerAction.dataset.cordisxIconControlVariant).toBe('composer')
  expect(composerAction.classList.contains('cordisx-icon-only-control')).toBe(false)
  expect(dom.window.getComputedStyle(composerAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('')
  expect(dom.window.getComputedStyle(composerAction.querySelector('.cordisx-host-icon')!).width).toBe('16px')
  expect(dom.window.getComputedStyle(composerAction.querySelector('svg')!).width).toBe('16px')
  expect(composerAction.getAttribute('aria-label')).toBe('Refresh snapshot')
  expect(composerAction.dataset.cordisxTooltip).toBe('Refresh snapshot')
  expect(composerAction.textContent).toBe('')
  expect(composerAction.querySelector('[data-host-icon="host:refresh"] svg')).not.toBeNull()
  const composerStyle = dom.window.getComputedStyle(composerAction)
  expect(composerStyle.width).toBe('28px')
  expect(composerStyle.minWidth).toBe('28px')
  expect(composerStyle.height).toBe('28px')
  expect(composerStyle.padding).toBe('0px')
  expect(composerStyle.borderRadius).toBe('9999px')
  expect(composerStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)')
  expect(composerAction.querySelector<HTMLElement>('.cordisx-host-icon')?.getBoundingClientRect).toBeTypeOf(
    'function',
  )
  expect(structuredStyles).toContain('.cordisx-composer-action:hover:not(:disabled)')
  expect(structuredStyles).toContain('.cordisx-composer-action:focus-visible')
  expect(structuredStyles).toContain('.cordisx-composer-action:disabled')
  expect(structuredStyles).toContain('.cordisx-composer-submit-before > .cordisx-surface-overflow > summary')
  composerAction.disabled = true
  expect(dom.window.getComputedStyle(composerAction).opacity).toBe('0.4')
  composerAction.disabled = false
  const composerSeat = composerAction.closest<HTMLElement>('[data-cordisx-surface-host="composer.submit.before"]')!
  const replacementSubmit = dom.window.document.createElement('button')
  replacementSubmit.id = 'native-stop'
  replacementSubmit.className = 'codex-composer-stop bg-primary-solid'
  replacementSubmit.textContent = 'Stop'
  dom.window.document.getElementById('native-submit')?.replaceWith(replacementSubmit)
  await settle()
  await settle()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')).toBe(composerSeat)
  expect(composerSeat.nextElementSibling?.id).toBe('native-stop')
  expect(replacementSubmit.parentElement?.id).toBe('native-composer-actions')
  expect(composerSeat.querySelector('button')?.className).toContain('cordisx-composer-action')
  expect(composerSeat.querySelector('button')?.className).not.toContain('bg-primary-solid')
  const replacementCluster = dom.window.document.createElement('div')
  replacementCluster.id = 'native-composer-actions-rerendered'
  replacementCluster.style.display = 'flex'
  replacementCluster.innerHTML =
    '<button id="native-submit-rerendered" class="codex-composer-button bg-primary-solid">Send</button>'
  dom.window.document.getElementById('native-composer-actions')?.replaceWith(replacementCluster)
  await settle()
  await settle()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="composer.submit.before"]')).toBe(composerSeat)
  expect(composerSeat.parentElement).toBe(replacementCluster)
  expect(composerSeat.nextElementSibling?.id).toBe('native-submit-rerendered')
  expect(composerSeat.querySelector('button')?.className).toContain('cordisx-composer-action')
  expect(composerSeat.querySelector('button')?.className).not.toContain('bg-primary-solid')
  const sameToolbarAction = toolbarAction
  const nativeTooltip = dom.window.document.createElement('div')
  nativeTooltip.setAttribute('role', 'tooltip')
  dom.window.document.body.append(nativeTooltip)
  await settle()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="toolbar.before"] button')).toBe(
    sameToolbarAction,
  )
  nativeTooltip.remove()
  const help = dom.window.document.getElementById('native-help')!
  const footerAction = dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-surface-host="sidebar.footer.before"] button',
  )!
  expect(footerAction.className).toContain('codex-footer-button')
  expect(dom.window.getComputedStyle(footerAction).width).toBe(dom.window.getComputedStyle(help).width)
  expect(dom.window.getComputedStyle(footerAction).height).toBe(dom.window.getComputedStyle(help).height)
  expect(dom.window.getComputedStyle(footerAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('16px')
  help.setAttribute('aria-expanded', 'true')
  const helpMenu = dom.window.document.createElement('div')
  helpMenu.setAttribute('role', 'menu')
  helpMenu.setAttribute('aria-labelledby', 'native-help')
  helpMenu.innerHTML =
    '<div role="menuitem" class="codex-menu-item">Native feature</div><div role="separator"></div><div role="menuitem" class="codex-menu-item">Native help</div>'
  dom.window.document.body.append(helpMenu)
  await settle()
  await settle()
  const helpInsertion = helpMenu.querySelector<HTMLElement>('[data-cordisx-surface-host="sidebar.footer.menu"]')!
  expect(helpInsertion).not.toBeNull()
  expect(helpInsertion.previousElementSibling?.getAttribute('role')).toBe('separator')
  expect(helpInsertion.querySelector('[role="menuitem"]')?.className).toContain('codex-menu-item')
  expect(helpInsertion.querySelector('.cordisx-icon-only-control')).toBeNull()
  expect(dom.window.getComputedStyle(helpInsertion.querySelector('.cordisx-host-icon')!).width).toBe('20px')
  expect(helpInsertion.textContent).toBe('Refresh snapshot')
  help.setAttribute('aria-expanded', 'false')
  helpMenu.remove()
  const account = dom.window.document.getElementById('native-account')!
  account.setAttribute('aria-expanded', 'true')
  const accountMenu = dom.window.document.createElement('div')
  accountMenu.setAttribute('role', 'menu')
  accountMenu.setAttribute('aria-labelledby', 'native-account')
  accountMenu.innerHTML =
    '<div>Account header</div><div role="separator"></div><div role="menuitem" class="codex-menu-item">Native settings</div>'
  dom.window.document.body.append(accountMenu)
  await settle()
  await settle()
  expect(accountMenu.querySelector('[data-cordisx-surface-host="sidebar.account.menu"]')?.textContent).toBe(
    'Showcase settings',
  )
  const navigationSeat = dom.window.document.querySelector<HTMLElement>(
    '[data-cordisx-surface-host="sidebar.navigation"]',
  )!
  const replacementNavigation = dom.window.document.createElement('div')
  replacementNavigation.id = 'native-navigation'
  replacementNavigation.style.cssText = 'display:flex;flex-direction:column'
  replacementNavigation.innerHTML = '<button>New conversation</button><button>Pull requests</button>'
  dom.window.document.getElementById('native-navigation')?.replaceWith(replacementNavigation)
  await settle()
  await settle()
  expect(dom.window.document.querySelector('[data-cordisx-surface-host="sidebar.navigation"]')).toBe(navigationSeat)
  expect(navigationSeat.parentElement).toBe(replacementNavigation)
  const trailing = dom.window.document.querySelector<HTMLButtonElement>('.cordisx-nav-actions button')!
  expect(trailing.className).toContain('cordisx-icon-only-control')
  expect(trailing.className).toContain('cordisx-shortcut-action')
  expect(trailing.className).not.toContain('cordisx-navigation-direct-action')
  expect(dom.window.getComputedStyle(trailing).width).toBe('24px')
  expect(dom.window.getComputedStyle(trailing).height).toBe('24px')
  expect(dom.window.getComputedStyle(trailing).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe('12px')
  expect(dom.window.getComputedStyle(trailing.querySelector('.cordisx-host-icon')!).width).toBe('16px')
  const environmentAction = dom.window.document.querySelector<HTMLButtonElement>('.cordisx-env-header button')!
  expect(environmentAction.className).toContain('cordisx-icon-only-control')
  expect(dom.window.getComputedStyle(environmentAction).width).toBe('24px')
  expect(dom.window.getComputedStyle(environmentAction).height).toBe('24px')
  expect(dom.window.getComputedStyle(environmentAction).getPropertyValue('--cordisx-icon-only-glyph-size')).toBe(
    '18px',
  )
  trailing.click()
  await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.activeRoute).toBeUndefined()
  dom.window.document.querySelector<HTMLButtonElement>('.cordisx-nav-primary')!.click()
  await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({
    activeRoute: 'slot-showcase:main.analytics',
    mounted: true,
    presentation: 'presented',
  })
  const mainPage = dom.window.document.querySelector<HTMLElement>(
    '[data-cordisx-page="slot-showcase:main.analytics"]',
  )!
  expect(mainPage).not.toBeNull()
  expect(dom.window.document.querySelector('.cordisx-nav-primary')?.getAttribute('aria-current')).toBe('page')
  expect(dom.window.document.querySelector('[data-cordisx-page-outlet="main"]')?.parentElement).toBe(
    dom.window.document.body,
  )
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.placement).toBe('portal')
  expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.top).toBe('0px')
  expect(
    dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.getPropertyValue(
      '--cordisx-page-chrome-safe-left',
    ),
  ).toBe('0px')
  expect(
    dom.window.document.querySelector<HTMLElement>('[data-cordisx-page="slot-showcase:main.analytics"]')?.dataset
      .cordisxNoDrag,
  ).toBe('true')
  for (
    let attempt = 0;
    attempt < 20 && dom.window.document.querySelector('[data-cordisx-demo-marker="main"]') === null;
    attempt += 1
  ) await settle()
  const mainDemo = dom.window.document.querySelector<HTMLElement>('[data-cordisx-demo-marker="main"]')!
  expect(mainDemo.classList.contains('cxr-ui-card')).toBe(true)
  expect(mainDemo.getAttribute('style') ?? '').not.toMatch(/#8b5cf6|#c4b5fd|linear-gradient/)
  const mainChrome = dom.window.document.querySelector<HTMLElement>(
    '[data-cordisx-page="slot-showcase:main.analytics"] [data-cordisx-page-chrome]',
  )!
  expect(mainChrome.querySelector('[data-cordisx-page-leading] [data-host-icon="host:analytics"]')).toBeNull()
  expect(mainChrome.querySelector('button[aria-label="Back"]')).not.toBeNull()
  const mainHeaderAction = mainChrome.querySelector<HTMLButtonElement>('[data-cordisx-page-header-action="refresh"]')!
  expect(mainHeaderAction.textContent).toBe('')
  expect(mainHeaderAction.getAttribute('aria-label')).toBe('Refresh snapshot')
  expect(mainHeaderAction.querySelector('[data-host-icon="host:refresh"]')).not.toBeNull()
  expect([...dom.window.document.querySelectorAll<HTMLElement>('[data-cordisx-page-chrome] button')]
    .every(button => button.dataset.cordisxNoDrag === 'true')).toBe(true)
  setMainRect(rect(0, 0, 1200, 900))
  dom.window.document.querySelector('[data-app-shell-main-content-layout]')?.setAttribute(
    'data-sidebar-collapsed',
    'true',
  )
  await settle()
  await settle()
  expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.left).toBe('0px')
  expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.pointerEvents)
    .toBe('none')
  expect(
    dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.getPropertyValue(
      '--cordisx-page-chrome-safe-left',
    ),
  ).toBe('128px')
  expect(mainChrome.style.paddingLeft).toContain('--cordisx-page-chrome-safe-left')
  expect(mainPage.style.pointerEvents).toBe('auto')
  expect(mainPage.style.clipPath).toContain('--cordisx-page-chrome-safe-left')
  expect(mainPage.style.clipPath).toContain('46px')
  setMainRect(rect(240, 0, 960, 900))
  dom.window.document.querySelector('[data-app-shell-main-content-layout]')?.setAttribute(
    'data-sidebar-collapsed',
    'false',
  )
  await settle()
  await settle()
  expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.left)
    .toBe('240px')
  expect(
    dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.getPropertyValue(
      '--cordisx-page-chrome-safe-left',
    ),
  ).toBe('0px')
  setMainRect(rect(0, 0, 1200, 900))
  dom.window.document.querySelector('[data-app-shell-main-content-layout]')?.setAttribute(
    'data-sidebar-collapsed',
    'true',
  )
  await settle()
  await settle()
  expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.left).toBe('0px')
  expect(
    dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.style.getPropertyValue(
      '--cordisx-page-chrome-safe-left',
    ),
  ).toBe('128px')
  await runtime!.navigate('slot-showcase', { id: 'app.overview' })
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({
    activeRoute: 'slot-showcase:app.overview',
    mounted: true,
    presentation: 'presented',
  })
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({
    mounted: false,
    presentation: 'inactive',
  })
  expect(mainPage.isConnected).toBe(false)
  expect(dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="main"]')?.hidden).toBe(true)
  expect(dom.window.document.querySelector('.cordisx-nav-primary')?.hasAttribute('aria-current')).toBe(false)
  const appOutlet = dom.window.document.querySelector<HTMLElement>('[data-cordisx-page-outlet="app"]')!
  expect(appOutlet.style.top).toBe('0px')
  expect(appOutlet.style.getPropertyValue('--cordisx-page-chrome-safe-left')).toBe('128px')
  const appChrome = appOutlet.querySelector<HTMLElement>('[data-cordisx-page-chrome]')!
  expect(appChrome.dataset.cordisxDrag).toBe('true')
  expect(appChrome.style.paddingLeft).toContain('--cordisx-page-chrome-safe-left')
  expect(appChrome.querySelector('[data-cordisx-page-leading] [data-host-icon="host:layers"]')).toBeNull()
  expect(appChrome.querySelector('button[aria-label="Back"]')).not.toBeNull()
  expect(appChrome.querySelectorAll('[data-cordisx-page-header-action="refresh"]')).toHaveLength(1)
  expect(appOutlet.querySelectorAll('[role="tab"] [data-host-icon]')).toHaveLength(2)
  expect(appOutlet.querySelector('[data-cordisx-page-body]')?.closest('header')).toBeNull()
  appChrome.querySelector<HTMLButtonElement>('[data-cordisx-page-header-action="refresh"]')!.click()
  await settle()
  expect(runtime!.snapshot().extensionPoints.accessDiagnostics.at(-1)).toMatchObject({
    request: {
      generation: expect.not.stringMatching(/^generation-legacy$/),
      operation: 'outlet.page.command.invoke',
      routeId: 'slot-showcase:app.overview',
      pageId: 'slot-showcase:app.overview',
      actionId: 'refresh',
      commandId: 'slot-showcase:refresh',
    },
    authorized: true,
  })
  const ambiguousSessionSeat = dom.window.document.createElement('section')
  ambiguousSessionSeat.dataset.pipAnchorHost = 'codex-main-thread'
  ambiguousSessionSeat.dataset.appActionTimelineScroll = ''
  ambiguousSessionSeat.innerHTML =
    `<div data-response-annotation-conversation="${sessionId}"></div><div data-above-composer-conversation-id="${sessionId}"></div>`
  dom.window.document.querySelector('[data-app-shell-main-content-layout]')?.append(ambiguousSessionSeat)
  await settle()
  await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
    available: false,
    error: 'semantic anchor is unavailable',
  })
  ambiguousSessionSeat.remove()
  await settle()
  await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
    available: true,
    contextKey: `session:${sessionId}`,
  })
  await runtime!.execute('slot-showcase', { id: 'open-session' })
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'session.content')).toMatchObject({
    activeRoute: 'slot-showcase:session.analytics',
    mounted: true,
    contextKey: `session:${sessionId}`,
    presentation: 'presented',
  })
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({
    mounted: false,
    presentation: 'inactive',
  })
  expect(dom.window.document.getElementById('native-thread')?.hasAttribute('data-codex-thread-reference-drop-target'))
    .toBe(true)
  expect(dom.window.document.querySelector('[data-cordisx-page-outlet="session.content"]')?.parentElement?.id).toBe(
    'native-session-content',
  )
  await expect(runtime!.navigate('slot-showcase', { id: 'session.analytics', params: { sessionId: 'stale' } }))
    .rejects.toThrow(/does not match native session/)
  expect(dom.window.location.href).toBe('https://codex.local/native')
  dom.window.document.querySelector<HTMLButtonElement>(
    '[data-cordisx-page="slot-showcase:session.analytics"] button[aria-label="Close"]',
  )!.click()
  for (
    let attempt = 0;
    attempt < 20
    && runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')?.presentation !== 'presented';
    attempt += 1
  ) await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'app')).toMatchObject({
    presentation: 'presented',
  })
  expect(appOutlet.hidden).toBe(false)
  const restoredAppChrome = appOutlet.querySelector<HTMLElement>('[data-cordisx-page-chrome]')!
  expect(restoredAppChrome).not.toBe(appChrome)
  restoredAppChrome.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()
  for (
    let attempt = 0;
    attempt < 20
    && runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')?.presentation !== 'presented';
    attempt += 1
  ) await settle()
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({
    presentation: 'presented',
  })
  const restoredMainPage = dom.window.document.querySelector<HTMLElement>(
    '[data-cordisx-page="slot-showcase:main.analytics"]',
  )!
  expect(restoredMainPage).not.toBe(mainPage)
  expect(restoredMainPage.inert).toBe(false)
  expect(restoredMainPage.hasAttribute('aria-hidden')).toBe(false)
  expect(dom.window.document.querySelector('.cordisx-nav-primary')?.getAttribute('aria-current')).toBe('page')
  dom.window.document.documentElement.lang = 'zh-CN'
  await settle()
  await settle()
  expect(runtime!.snapshot().localization.locale).toBe('zh-CN')
  expect(
    runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'slot-showcase:main.analytics')
      ?.productMetadata,
  ).toEqual({
    title: '工作区分析',
    description: '从演示导航或工作区工具栏打开工作区分析。',
    diagnostics: [],
  })
  expect(
    runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'slot-showcase:session.analytics')
      ?.productMetadata,
  ).toEqual({
    title: '会话分析',
    description: '从会话页头切换当前会话分析，或从演示导航打开已配置会话的分析内容。',
    diagnostics: [],
  })
  expect(
    runtime!.snapshot().navigation.pages.find(item => item.qualifiedId === 'slot-showcase:session.analytics')
      ?.productMetadata,
  ).toEqual({
    title: '会话分析',
    description: '在保留当前原生会话页头的前提下，于会话正文区域展示该会话的分析内容。',
    diagnostics: [],
  })
  expect(
    runtime!.snapshot().extensionPoints.points.find(item => item.id === 'sidebar.navigation.items')?.titleProjection
      .text,
  ).toBe('侧边栏导航')
  expect(
    dom.window.document.querySelector('[data-cordisx-surface-host="session.header.actions"] button')?.getAttribute(
      'aria-label',
    ),
  ).toBe('切换会话分析')
  expect(dom.window.document.querySelector('[data-cordisx-page="slot-showcase:main.analytics"]')?.textContent)
    .toContain('工作区分析')
  expect(native.parentElement).toBe(nativeParent)
  expect(native.textContent).toBe('native data')
  expect(dom.window.getComputedStyle(native).display).not.toBe('none')
  native.textContent = 'native data updated'
  expect(native.textContent).toBe('native data updated')
  await runtime!.setPluginBlocked('slot-showcase', true)
  const blockedSnapshot = runtime!.snapshot()
  expect(blockedSnapshot.plugins[0]?.status).toBe('blocked')
  expect(blockedSnapshot.commands).toEqual([])
  expect(blockedSnapshot.navigation.routes).toEqual([])
  expect(blockedSnapshot.navigation.pages).toEqual([])
  expect(blockedSnapshot.registrations.every(item => !item.rendered)).toBe(true)
  expect(dom.window.document.querySelector('[data-cordisx-page]')).toBeNull()
  await runtime!.setPluginBlocked('slot-showcase', false)
  await settle()
  const restoredSnapshot = runtime!.snapshot()
  expect(restoredSnapshot.plugins[0]?.status).toBe('active')
  expect(restoredSnapshot.commands.length).toBe(6)
  expect(restoredSnapshot.registrations.filter(item => item.rendered).length).toBe(15)
  expect(restoredSnapshot.platform).toMatchObject({
    mode: 'unavailable',
    secondConnectionCreated: false,
    rawBridgeExposed: false,
    diagnostics: [expect.objectContaining({ code: 'current-connection-client-unavailable' })],
  })
  expect(restoredSnapshot.permissions.filter(permission => permission.capability !== 'ui.extension-points.render'))
    .toEqual([
      expect.objectContaining({ capability: 'models.read', policy: 'ask', required: false }),
    ])
  const pluginSource = restoredSnapshot.plugins[0]!.source
  await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'sidebar.navigation.items', 'deny')
  await settle()
  const deniedSurface = runtime!.snapshot()
  expect(deniedSurface.commands).toHaveLength(6)
  expect(deniedSurface.registrations.find(item => item.surface === 'sidebar.navigation.items')).toMatchObject({
    authorized: false,
    rendered: false,
  })
  expect(dom.window.document.querySelector('.cordisx-nav-row')).toBeNull()
  await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'sidebar.navigation.items', 'allow')
  await settle()
  expect(dom.window.document.querySelector('.cordisx-nav-row')).not.toBeNull()
  await runtime!.navigate('slot-showcase', { id: 'main.analytics' })
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ mounted: true })
  await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'main', 'deny')
  expect(runtime!.snapshot().navigation.outlets.find(item => item.id === 'main')).toMatchObject({ mounted: false })
  expect(runtime!.snapshot().navigation.routes.find(item => item.qualifiedId === 'slot-showcase:main.analytics'))
    .toMatchObject({ valid: true, authorized: false })
  expect(native.parentElement).toBe(nativeParent)
  expect(native.isConnected).toBe(true)
  await expect(runtime!.navigate('slot-showcase', { id: 'main.analytics' })).rejects.toThrow(/denied/)
  await runtime!.setExtensionPointPolicy(pluginSource, 'slot-showcase', 'main', 'allow')
  return { sessionId, config, plugin, bundle, dom, native, nativeParent, runtime, snapshot, help }
}
