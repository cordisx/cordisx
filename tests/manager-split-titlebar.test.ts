import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerSplitTitlebarSeat } from '../packages/cli/src/renderer/adapter/manager-split-titlebar.js'
import { captureManagerTitlebarLease } from '../packages/cli/src/renderer/adapter/manager-titlebar-continuation.js'
import { resolveManagerTitlebarSeat } from '../packages/cli/src/renderer/host-probes.js'

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <div data-app-shell-unified-tab-strip="true">
      <header data-app-shell-titlebar="true" data-app-shell-header-layout="default"
        style="position:fixed;pointer-events:none">
        <div data-app-shell-header-slot="start">
          <button id="back" style="pointer-events:auto">Back</button>
          <button id="forward" style="pointer-events:auto">Forward</button>
        </div>
        <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface"
          style="pointer-events:none">
          <div data-app-shell-titlebar-slot="main" data-app-shell-focus-area="main">
            <span id="native-title">Native title</span>
          </div>
        </div>
        <div data-app-shell-header-slot="end">
          <div data-app-shell-tab-controller="right" data-tab-id="native-tab">
            <button role="tab" aria-selected="true" style="pointer-events:auto">New tab</button>
          </div>
        </div>
      </header>
    </div>
    <aside data-app-shell-left-panel-appearance="default">
      <nav data-app-navigation-rail="true"></nav>
      <nav role="navigation" aria-label="Home"></nav>
    </aside>
    <div data-app-shell-main-content-layout="default" data-app-shell-workspace-layout="split"></div>
    <div role="tabpanel" data-app-shell-tab-panel-controller="right" data-tab-id="native-tab"></div>
  </body>`)
  const document = dom.window.document
  const element = (selector: string) => document.querySelector<HTMLElement>(selector)!
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
  const setRect = (selector: string, bounds: DOMRect) => {
    const target = element(selector)
    target.getClientRects = () => ({ length: 1 }) as DOMRectList
    target.getBoundingClientRect = () => bounds
  }
  setRect('header', rect(0, 0, 1719, 44))
  setRect('[data-app-shell-header-slot="start"]', rect(0, 0, 290, 44))
  setRect('[data-app-shell-main-titlebar]', rect(290, 0, 556.5625, 44))
  setRect('[data-app-shell-titlebar-slot="main"]', rect(290, 0, 556.5625, 44))
  setRect('[data-app-shell-header-slot="end"]', rect(850.5625, 0, 868.4375, 44))
  setRect('[data-app-shell-tab-controller="right"]', rect(854.5625, 6, 240, 32))
  setRect('[role="tabpanel"]', rect(846.5625, 44, 872.4375, 937))
  setRect('[data-app-navigation-rail]', rect(0, 44, 52, 937))
  setRect('nav[role="navigation"]', rect(52, 44, 238, 937))
  setRect('[data-app-shell-main-content-layout]', rect(290.5, 44, 556.0625, 937))
  setRect('#back', rect(88, 8, 28, 28))
  setRect('#forward', rect(122, 8, 28, 28))
  setRect('[role="tab"]', rect(854.5625, 6, 210, 32))
  const nativeStyle = dom.window.getComputedStyle.bind(dom.window)
  Object.defineProperty(dom.window, 'getComputedStyle', {
    value: (target: Element) => {
      const style = nativeStyle(target)
      const region = target.matches('header')
        ? 'drag'
        : target.matches('button')
        ? 'no-drag'
        : 'none'
      Object.defineProperty(style, 'webkitAppRegion', { value: region })
      return style
    },
  })
  const pane = {
    rail: element('[data-app-navigation-rail]'),
    sidebar: { container: element('nav[role="navigation"]') },
    main: { anchor: element('[data-app-shell-main-content-layout]') },
  }
  return { document, element, pane, rect, setRect }
}

describe('26.924 split-tab Manager titlebar seat', () => {
  it('admits only the bounded left title span and leaves the right native tab as Codex-owned', () => {
    const f = fixture()
    const before = f.document.body.innerHTML
    expect(resolveManagerTitlebarSeat(f.document)).toBeUndefined()
    expect(resolveManagerSplitTitlebarSeat(f.document)).toEqual({
      slot: f.element('[data-app-shell-titlebar-slot="main"]'),
      native: [f.element('#native-title')],
      bounds: { left: 290, top: 0, width: 556.5625, height: 44 },
    })
    const lease = captureManagerTitlebarLease(f.document, 'split', f.pane)
    expect(lease?.seat.provenance).toBe('split')
    expect(f.document.body.innerHTML).toBe(before)
  })

  it('rejects ambiguous native tab identity or a title span that intersects the right strip', () => {
    const f = fixture()
    f.element('[role="tab"]').setAttribute('aria-selected', 'false')
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeUndefined()
    f.element('[role="tab"]').setAttribute('aria-selected', 'true')
    f.element('[role="tabpanel"]').setAttribute('data-tab-id', 'other')
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeUndefined()
    f.element('[role="tabpanel"]').setAttribute('data-tab-id', 'native-tab')
    f.setRect('[data-app-shell-header-slot="end"]', f.rect(838, 0, 881, 44))
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeUndefined()
  })

  it('accepts a collapsed selected tab header only while its matching right panel is visible', () => {
    const f = fixture()
    f.setRect('[data-app-shell-tab-controller="right"]', f.rect(1095, 6, 0, 32))
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeDefined()
    f.setRect('[role="tabpanel"]', f.rect(847, 44, 0, 937))
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeUndefined()
  })

  it('leases a two-tab titlebar with a noninteractive close button outside the Host seat', () => {
    const f = fixture()
    const first = f.element('[data-app-shell-tab-controller="right"]')
    f.element('[role="tab"]').setAttribute('aria-selected', 'false')
    const inactiveClose = f.document.createElement('button')
    inactiveClose.id = 'inactive-close'
    inactiveClose.style.pointerEvents = 'none'
    first.append(inactiveClose)
    const second = f.document.createElement('div')
    second.id = 'second-controller'
    second.dataset.appShellTabController = 'right'
    second.dataset.tabId = 'second-tab'
    second.innerHTML =
      '<button id="second-tab" role="tab" aria-selected="true" style="pointer-events:auto">New tab</button>'
    f.element('[data-app-shell-header-slot="end"]').append(second)
    f.element('[role="tabpanel"]').setAttribute('data-tab-id', 'second-tab')
    f.setRect('#inactive-close', f.rect(1065, 8, 20, 28))
    f.setRect('#second-controller', f.rect(1095, 6, 0, 32))
    f.setRect('#second-tab', f.rect(1095, 6, 17, 32))
    expect(resolveManagerSplitTitlebarSeat(f.document)).toBeDefined()
    expect(captureManagerTitlebarLease(f.document, 'split', f.pane)?.seat.provenance).toBe('split')
  })
})
