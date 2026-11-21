import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { resolveManagerPaneSeat } from '../packages/cli/src/renderer/host-probes.js'
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

function fixture() {
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
  surface.dataset.appShellUnifiedTabStrip = 'true'
  surface.dataset.appShellCompactPageGutter = 'true'
  frame.dataset.appShellCompactPageGutter = 'true'
  setRect(frame, rect(0, 0, 1920, 1050))
  setRect(workspaceRow, rect(0, 0, 1920, 1050))
  setRect(workspace, rect(0, 0, 1920, 1050))
  workspace.prepend(aside)
  surface.append(main)
  main.dataset.appShellMainContentLayout = 'thread-edge-scroll'
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
  inner.lastElementChild!.append(draft)
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
  end.innerHTML =
    '<div data-app-shell-tab-controller="right" data-tab-id="tab"><button role="tab" aria-selected="true">Tab</button></div>'
  const tab = element('[role=tab]')
  tab.style.pointerEvents = 'auto'
  const panel = document.createElement('div')
  panel.setAttribute('role', 'tabpanel')
  panel.dataset.appShellTabPanelController = 'right'
  panel.dataset.tabId = 'tab'
  panel.innerHTML = '<iframe title="native panel" src="about:blank"></iframe>'
  activePage.append(panel)
  const sidebar = document.createElement('div')
  sidebar.id = 'app-shell-sidebar'
  sidebar.append(rail, nav)
  aside.prepend(sidebar)
  const resizer = element('[data-native-manager-resizer]')
  setRect(header, rect(0, 0, 1920, 46))
  setRect(start, rect(0, 0, 326, 46))
  setRect(element('[data-app-shell-main-titlebar]'), rect(326, 0, 420, 46))
  setRect(slot, rect(326, 0, 414, 46))
  setRect(end, rect(746, 0, 1174, 46))
  setRect(element('[data-app-shell-tab-controller]'), rect(754, 7, 240, 32))
  setRect(tab, rect(754, 7, 238, 32))
  setRect(panel, rect(747, 46, 1173, 1004))
  setRect(aside, rect(0, 46, 326, 1004))
  setRect(rail, rect(0, 46, 52, 1004))
  setRect(nav, rect(52, 46, 274, 1004))
  setRect(resizer, rect(318, 46, 16, 1004))
  setRect(main, rect(326, 46, 420, 1004))
  setRect(native, rect(326, 46, 420, 1004))
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
  return { ...f, element, header, main, native, slot, draft, panel, tab, surface, inner }
}

describe('26.1117 marker-light native split thread', () => {
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
      expect(f.tab.getAttribute('aria-selected')).toBe('true')
      expect(f.panel.querySelector('iframe')?.getAttribute('src')).toBe('about:blank')
      await act(async () => f.element('[data-cordisx-manager-trigger]').click())
      expect(f.document.querySelector('[data-cordisx-manager-pane="true"]')).toBeNull()
      expect(f.native.inert).toBeFalsy()
      expect(f.draft.value).toBe('unsent draft')
    } finally {
      await act(async () => dispose?.())
    }
  })

  it('rejects changed frame, tab identity and header geometry', () => {
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
  })
})
