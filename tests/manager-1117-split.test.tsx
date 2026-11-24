import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { resolveManagerPaneSeat, resolveManagerTitlebarSeat } from '../packages/cli/src/renderer/host-probes.js'
import { resolveManagerSplitTitlebarSeat } from '../packages/cli/src/renderer/adapter/manager-split-titlebar.js'
import { captureManagerTitlebarLease } from '../packages/cli/src/renderer/adapter/manager-titlebar-continuation.js'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'
import { installNativeManagerShell } from './fixtures/native-manager-shell.js'
import { placeNativeWorkspaceTitlebar } from './helpers/native-viewport-titlebar.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => null,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

function fixture(split = true, home = false) {
  const f = reactManagerFixture()
  const { document, dom } = f
  installNativeManagerShell(dom)
  const element = (s: string) => document.querySelector<HTMLElement>(s)!
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
  const setRect = (node: Element, bounds: DOMRect) => {
    Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => bounds })
    Object.defineProperty(node, 'getClientRects', { configurable: true, value: () => ({ length: 1 }) })
  }
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value: () => ({ length: 1 }),
  })
  const nativeRect = dom.window.HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: function(this: HTMLElement) {
      return this.hasAttribute('data-cordisx-manager-sidebar-resizer')
        ? rect(321, 46, 10, 1004)
        : nativeRect.call(this)
    },
  })
  const header = element('header[data-app-shell-titlebar]')
  const main = element('[data-app-shell-main-content-layout]')
  const native = element('[data-app-shell-thread-edge-divider]')
  const aside = element('aside')
  const rail = element('nav[data-app-navigation-rail]')
  const nav = element('nav[role=navigation]')
  const { frame, surface, activePage, workspace, workspaceRow } = placeNativeWorkspaceTitlebar(header, 1920)
  surface.removeAttribute('data-app-shell-header-placement')
  surface.dataset.appShellUnifiedTabStrip = String(split)
  surface.dataset.appShellCompactPageGutter = String(split)
  frame.dataset.appShellCompactPageGutter = 'true'
  setRect(frame, rect(0, 0, 1920, 1050))
  setRect(workspaceRow, rect(0, 0, 1920, 1050))
  setRect(workspace, rect(0, 0, 1920, 1050))
  workspace.prepend(aside)
  if (home) {
    const mainSurface = document.createElement('main')
    mainSurface.dataset.appShellMainSurface = 'default'
    surface.append(mainSurface)
    mainSurface.append(main)
  } else surface.append(main)
  main.dataset.appShellMainContentLayout = home ? 'default' : 'thread-edge-scroll'
  main.dataset.appShellWorkspaceLayout = 'split'
  native.removeAttribute('data-app-shell-thread-edge-divider')
  const fade = native.querySelector<HTMLElement>('[data-app-shell-main-content-top-fade]')!
  fade.removeAttribute('data-app-shell-main-content-top-fade')
  fade.setAttribute('aria-hidden', 'true')
  const inner = document.createElement('div')
  inner.append(...native.childNodes)
  native.append(inner)
  const draft = document.createElement('input')
  draft.value = 'unsent draft'
  if (home) {
    const composer = document.createElement('div')
    composer.dataset.codexComposerRoot = ''
    composer.dataset.composerPlacement = 'home'
    composer.append(draft)
    inner.lastElementChild!.append(composer)
  } else inner.lastElementChild!.append(draft)
  const slot = element('[data-app-shell-titlebar-slot]')
  slot.removeAttribute('data-app-shell-titlebar-slot')
  const wrapper = document.createElement('div')
  slot.replaceWith(wrapper)
  wrapper.append(slot)
  header.removeAttribute('data-app-shell-header-layout')
  const start = element('[data-app-shell-header-slot=start]')
  const back = element('[data-native-back]')
  back.dataset.appShellSidebarTrigger = 'true'
  back.setAttribute('aria-controls', 'app-shell-sidebar')
  const end = element('[data-app-shell-header-slot=end]')
  end.innerHTML = split
    ? '<div data-app-shell-tab-controller="right" data-tab-id="tab"><button role="tab" aria-selected="true">Tab</button></div>'
    : '<button data-app-shell-workspace-layout-toggle="main" style="pointer-events:auto">Toggle</button>'
  const tab = document.querySelector<HTMLElement>('[role=tab]')
  if (tab !== null) tab.style.pointerEvents = 'auto'
  const panel = document.createElement('div')
  panel.setAttribute('role', 'tabpanel')
  panel.dataset.appShellTabPanelController = 'right'
  panel.dataset.tabId = 'tab'
  panel.innerHTML = '<iframe title="native panel" src="about:blank"></iframe>'
  if (split) activePage.append(panel)
  const sidebar = document.createElement('div')
  sidebar.id = 'app-shell-sidebar'
  sidebar.append(rail, nav)
  aside.prepend(sidebar)
  const resizer = element('[data-native-manager-resizer]')
  setRect(header, rect(0, 0, 1920, 46))
  setRect(start, rect(0, 0, 326, 46))
  setRect(element('[data-app-shell-main-titlebar]'), rect(326, 0, split ? 420 : home ? 1548 : 1554, 46))
  setRect(slot, rect(326, 0, split ? 414 : home ? 1542 : 1548, 46))
  setRect(end, rect(split ? 746 : home ? 1874 : 1880, 0, split ? 1174 : home ? 46 : 40, 46))
  if (tab !== null) {
    setRect(element('[data-app-shell-tab-controller]'), rect(754, 7, 240, 32))
    setRect(tab, rect(754, 7, 238, 32))
    setRect(panel, rect(747, 46, 1173, 1004))
  } else setRect(element('[data-app-shell-workspace-layout-toggle]'), rect(1882, 9, 28, 28))
  setRect(aside, rect(0, 46, 326, 1004))
  setRect(rail, rect(0, 46, 52, 1004))
  setRect(nav, rect(52, 46, 274, 1004))
  setRect(resizer, rect(318, 46, 16, 1004))
  setRect(main, rect(326, split || home ? 46 : 0, split ? 420 : 1594, split || home ? 1004 : 1050))
  setRect(native, rect(326, split || home ? 46 : 0, split ? 420 : 1594, split || home ? 1004 : 1050))
  setRect(back, rect(88, 7, 32, 32))
  setRect(element('[data-native-forward]'), rect(286, 9, 28, 28))
  const nativeStyle = dom.window.getComputedStyle.bind(dom.window)
  Object.defineProperty(dom.window, 'getComputedStyle', {
    configurable: true,
    value: (node: Element) => {
      const style = nativeStyle(node)
      const region = node === header ? 'drag' : node.matches('button') ? 'no-drag' : 'none'
      Object.defineProperty(style, 'webkitAppRegion', { value: region, configurable: true })
      return style
    },
  })
  return { ...f, element, header, main, native, slot, draft, panel, tab, surface, activePage, inner, setRect, rect }
}

describe('26.1117 marker-light native thread', () => {
  it('opens with the empty 26.1120 window slot and rejects nonempty slots', async () => {
    const f = fixture(false)
    const slot = f.document.createElement('div')
    slot.className = 'shrink-0'
    f.native.prepend(slot)
    f.setRect(slot, f.rect(326, 0, 1594, 0))
    const resizeLayer = f.element('[data-native-manager-resizer]')
    const separator = resizeLayer.querySelector<HTMLElement>('[role="separator"]')!
    separator.innerHTML = '<div aria-hidden="true"></div>'
    resizeLayer.style.pointerEvents = 'none'
    f.setRect(resizeLayer, f.rect(0, 0, 326, 1050))
    f.setRect(separator, f.rect(318, 0, 16, 1050))
    expect(resolveManagerPaneSeat(f.document)).toBeDefined()
    slot.textContent = 'unexpected content'
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    slot.textContent = ''
    resizeLayer.style.pointerEvents = 'auto'
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    resizeLayer.style.pointerEvents = 'none'
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = installReactCordisXManager(f.document, managerModel(), { presentationMode: 'overlay' })
      })
      await act(async () => f.element('[data-cordisx-manager-trigger]').click())
      expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull()
      expect(f.draft.value).toBe('unsent draft')
      await act(async () => f.element('[data-cordisx-manager-trigger]').click())
      expect(f.native.inert).toBeFalsy()
      expect(f.draft.value).toBe('unsent draft')
    } finally {
      await act(async () => dispose?.())
      await f.dispose()
    }
  })

  it('opens, closes and reopens on the native home without losing its unsent draft', async () => {
    const f = fixture(false, true)
    const pane = resolveManagerPaneSeat(f.document)
    expect(pane).toBeDefined()
    expect(resolveManagerTitlebarSeat(f.document)?.slot).toBe(f.slot)
    expect(captureManagerTitlebarLease(f.document, 'native', pane!)).toBeDefined()
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = installReactCordisXManager(f.document, managerModel(), { presentationMode: 'workspace' })
      })
      for (let i = 0; i < 2; i++) {
        await act(async () => f.element('[data-cordisx-manager-trigger]').click())
        expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull()
        expect(f.native.inert).toBe(true)
        await act(async () => f.element('[data-cordisx-manager-trigger]').click())
        expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).toBeNull()
        expect(f.native.inert).toBeFalsy()
        expect(f.draft.value).toBe('unsent draft')
      }
    } finally {
      await act(async () => dispose?.())
      await f.dispose()
    }
  })

  it('rejects default layouts without a unique home composer or with an unmeasured titlebar', async () => {
    const f = fixture(false, true)
    const composer = f.element('[data-codex-composer-root]')
    composer.dataset.composerPlacement = 'thread'
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    composer.dataset.composerPlacement = 'home'
    const duplicate = composer.cloneNode(true)
    composer.after(duplicate)
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    duplicate.remove()
    f.surface.dataset.appShellUnifiedTabStrip = 'true'
    f.surface.dataset.appShellCompactPageGutter = 'true'
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    await f.dispose()
  })

  it('requires the exact measured shell and preserves the native tab and draft on open and close', async () => {
    const f = fixture()
    const pane = resolveManagerPaneSeat(f.document)
    expect(pane).toBeDefined()
    expect(resolveManagerSplitTitlebarSeat(f.document)?.slot).toBe(f.slot)
    expect(captureManagerTitlebarLease(f.document, 'split', pane!)).toBeDefined()
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = installReactCordisXManager(f.document, managerModel(), { presentationMode: 'workspace' })
      })
      await act(async () => f.element('[data-cordisx-manager-trigger]').click())
      expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull()
      expect(f.native.inert).toBe(true)
      expect(f.draft.value).toBe('unsent draft')
      expect(f.tab?.getAttribute('aria-selected')).toBe('true')
      expect(f.panel.querySelector('iframe')?.getAttribute('src')).toBe('about:blank')
      await act(async () => f.element('[data-cordisx-manager-trigger]').click())
      expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).toBeNull()
      expect(f.native.inert).toBeFalsy()
      expect(f.draft.value).toBe('unsent draft')
    } finally {
      await act(async () => dispose?.())
      await f.dispose()
    }
  })

  it.each(['active page', 'shared local frame'])(
    'seats the normal thread below the header in a %s and restores its native frame on close',
    async mode => {
      const f = fixture(false)
      if (mode === 'shared local frame') {
        f.activePage.removeAttribute('data-app-shell-active-page')
        f.activePage.dataset.appShellSharedLocalFrame = 'true'
      }
      const pane = resolveManagerPaneSeat(f.document)
      expect(pane).toBeDefined()
      expect(resolveManagerTitlebarSeat(f.document)?.slot).toBe(f.slot)
      expect(captureManagerTitlebarLease(f.document, 'native', pane!)).toBeDefined()
      let dispose: (() => void) | undefined
      try {
        await act(async () => {
          dispose = installReactCordisXManager(f.document, managerModel(), { presentationMode: 'workspace' })
        })
        await act(async () => f.element('[data-cordisx-manager-trigger]').click())
        expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull()
        expect(f.element('[data-cordisx-react-manager]').style.top).toBe('46px')
        expect(f.native.inert).toBe(true)
        await act(async () => f.element('[data-cordisx-manager-trigger]').click())
        expect(f.native.inert).toBeFalsy()
        expect(f.draft.value).toBe('unsent draft')
      } finally {
        await act(async () => dispose?.())
        await f.dispose()
      }
    },
  )

  it('retains the mounted Manager when the same thread leaves its split layout', async () => {
    const f = fixture()
    const route = {
      available: true as const,
      key: 'thread',
      nativeLocation: { pathname: '/thread', search: '', hash: '' },
    }
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = installReactCordisXManager(f.document, managerModel(), {
          presentationMode: 'workspace',
          nativeRouteHistory: { snapshot: () => route, subscribe: () => () => {} },
        })
      })
      await act(async () => f.element('[data-cordisx-manager-trigger]').click())
      const manager = f.element('[data-cordisx-react-manager]')
      const embedded = f.document.createElement('iframe')
      manager.append(embedded)
      const embeddedDocument = embedded.contentDocument
      await act(async () => {
        f.surface.dataset.appShellUnifiedTabStrip = 'false'
        f.surface.dataset.appShellCompactPageGutter = 'false'
        const end = f.element('[data-app-shell-header-slot=end]')
        end.innerHTML =
          '<button data-app-shell-workspace-layout-toggle="main" style="pointer-events:auto">Toggle</button>'
        f.panel.remove()
        f.setRect(end, f.rect(1880, 0, 40, 46))
        f.setRect(f.element('[data-app-shell-workspace-layout-toggle]'), f.rect(1882, 9, 28, 28))
        f.setRect(f.element('[data-app-shell-main-titlebar]'), f.rect(326, 0, 1554, 46))
        f.setRect(f.slot, f.rect(326, 0, 1548, 46))
        f.setRect(f.main, f.rect(326, 0, 1594, 1050))
        f.setRect(f.native, f.rect(326, 0, 1594, 1050))
        await new Promise(resolve => setTimeout(resolve, 120))
      })
      await vi.waitFor(() => expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull())
      expect(f.element('[data-cordisx-react-manager]')).toBe(manager)
      expect(embedded.contentDocument).toBe(embeddedDocument)
      expect(manager.style.top).toBe('46px')
      expect(f.draft.value).toBe('unsent draft')
    } finally {
      await act(async () => dispose?.())
      await f.dispose()
    }
  })

  it('rejects changed frame, tab identity and header geometry', async () => {
    const f = fixture()
    f.inner.firstElementChild!.removeAttribute('aria-hidden')
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    f.inner.firstElementChild!.setAttribute('aria-hidden', 'true')
    const falseHost = f.document.createElement('div')
    falseHost.setAttribute('data-cordisx-react-manager', 'false')
    f.main.append(falseHost)
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    falseHost.remove()
    f.panel.dataset.tabId = 'other'
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeUndefined()
    f.panel.dataset.tabId = 'tab'
    f.surface.removeAttribute('data-app-shell-compact-page-gutter')
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeUndefined()
    await f.dispose()
  })

  it('does not admit an explicitly inactive shared local frame', async () => {
    const f = fixture(false)
    f.activePage.dataset.appShellSharedLocalFrame = 'true'
    f.activePage.dataset.appShellActivePage = 'false'
    expect(resolveManagerPaneSeat(f.document)).toBeUndefined()
    expect(resolveManagerTitlebarSeat(f.document)).toBeUndefined()
    await f.dispose()
  })
})
