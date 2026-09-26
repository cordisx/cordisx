import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerRailOnlyTitlebarSeat } from '../packages/cli/src/renderer/adapter/manager-rail-only-titlebar.js'

function fixture(layout: 'default' | 'custom-titlebar' = 'default') {
  const dom = new JSDOM(`<!doctype html><body>
    <header data-app-shell-titlebar="true" data-app-shell-application-menu-bar="false"
      data-app-shell-header-layout="${layout}" style="position:fixed;pointer-events:none">
      <div data-app-shell-header-slot="start" data-app-shell-header-obstacle="true"></div>
      <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface"
        style="position:relative;pointer-events:none"></div>
      <div id="native-controls" style="position:absolute;pointer-events:none">
        <button id="back" style="pointer-events:auto">Back</button>
        <button id="forward" style="pointer-events:auto">Forward</button>
        <button id="hidden" style="visibility:hidden">Hidden</button>
      </div>
      <div data-app-shell-header-slot="end" data-app-shell-header-obstacle="true"></div>
      <div id="native-drag-edge"></div>
    </header>
  </body>`)
  const document = dom.window.document
  const header = document.querySelector<HTMLElement>('header')!
  const start = document.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!
  const end = document.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
  const title = document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
  const back = document.getElementById('back')!
  const forward = document.getElementById('forward')!
  const hidden = document.getElementById('hidden')!
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
  const setRect = (element: Element, bounds: DOMRect) => {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
    element.getBoundingClientRect = () => bounds
  }
  setRect(header, rect(0, 0, 1719, 44))
  setRect(start, rect(0, 0, 52, 44))
  setRect(title, rect(52, 44, 1663, 46))
  setRect(end, rect(1715, 44, 0, 46))
  setRect(back, rect(88, 8, 28, 28))
  setRect(forward, rect(122, 8, 28, 28))
  setRect(hidden, rect(94, 8, 122, 28))
  const nativeGetComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  const regions = new Map<Element, string>([
    [header, 'drag'],
    [title, layout === 'custom-titlebar' ? 'no-drag' : 'none'],
    [back, 'no-drag'],
    [forward, 'no-drag'],
  ])
  Object.defineProperty(dom.window, 'getComputedStyle', {
    value: (element: Element) => {
      const style = nativeGetComputedStyle(element)
      Object.defineProperty(style, 'webkitAppRegion', { value: regions.get(element) ?? '' })
      return style
    },
  })
  let nativeHit: Element | undefined
  Object.defineProperty(document, 'elementFromPoint', {
    value: () => nativeHit ?? document.body,
  })
  return {
    document,
    header,
    start,
    end,
    title,
    back,
    forward,
    regions,
    rect,
    setRect,
    setNativeHit: (hit?: Element) => {
      nativeHit = hit
    },
  }
}

describe('26.924 rail-only native titlebar safety probe', () => {
  it.each(['default', 'custom-titlebar'] as const)(
    'returns the measured y=0 blank span for %s without changing native DOM',
    layout => {
      const f = fixture(layout)
      const before = f.document.body.innerHTML
      expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toEqual({
        anchor: f.header,
        nativeTitle: f.title,
        bounds: { left: 166, top: 0, right: 1683, bottom: 44, width: 1517, height: 44 },
        provenance: 'codex-26.924-rail-only-titlebar',
      })
      expect(f.document.body.innerHTML).toBe(before)
      const host = f.document.createElement('div')
      host.dataset.cordisxManagerTitlebarSeat = 'true'
      host.style.pointerEvents = 'none'
      f.setRect(host, f.rect(166, 0, 1517, 44))
      f.header.append(host)
      expect(resolveManagerRailOnlyTitlebarSeat(f.document)?.bounds.left).toBe(166)
      f.setRect(host, f.rect(0, 0, 1719, 44))
      expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    },
  )

  it('fails closed if native controls, drag behavior, or the title structure change', () => {
    const f = fixture()
    const extra = f.document.createElement('button')
    extra.textContent = 'Extra native action'
    f.header.append(extra)
    f.setRect(extra, f.rect(500, 8, 28, 28))
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    extra.remove()
    f.regions.set(f.header, 'no-drag')
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    f.regions.set(f.header, 'drag')
    f.regions.set(f.title, 'no-drag')
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    f.regions.set(f.title, 'none')
    f.title.setAttribute('data-app-shell-titlebar-slot', 'main')
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    f.title.removeAttribute('data-app-shell-titlebar-slot')
    f.setRect(f.title, f.rect(52, 0, 1663, 44))
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    f.setRect(f.title, f.rect(52, 44, 1663, 46))
    f.setNativeHit(f.back)
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
  })

  it('fails closed for another sidebar, ambiguous header, or insufficient blank width', () => {
    const f = fixture()
    const nav = f.document.createElement('nav')
    nav.setAttribute('role', 'navigation')
    f.document.body.append(nav)
    nav.getClientRects = () => ({ length: 1 }) as DOMRectList
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    nav.remove()
    const duplicate = f.header.cloneNode(true)
    f.header.after(duplicate)
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
    duplicate.remove()
    f.setRect(f.header, f.rect(0, 0, 400, 44))
    expect(resolveManagerRailOnlyTitlebarSeat(f.document)).toBeUndefined()
  })
})
