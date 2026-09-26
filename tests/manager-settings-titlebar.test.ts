import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerSettingsTitlebarSeat } from '../packages/cli/src/renderer/adapter/manager-settings-titlebar.js'

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <header data-app-shell-titlebar="true" data-app-shell-application-menu-bar="false"
      data-app-shell-header-layout="full-bleed" style="position:fixed;pointer-events:none">
      <div data-app-shell-header-slot="start" data-app-shell-header-obstacle="true"></div>
      <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface"
        style="pointer-events:none"></div>
      <div style="position:absolute;pointer-events:none">
        <button id="back" style="pointer-events:auto">Back</button>
        <button id="forward" style="pointer-events:auto">Forward</button>
      </div>
      <div data-app-shell-header-slot="end" data-app-shell-header-obstacle="true"></div>
    </header>
    <nav data-app-navigation-rail="true"></nav>
    <nav aria-label="设置"></nav>
    <div data-app-shell-main-content-layout="full-bleed"></div>
  </body>`)
  const document = dom.window.document
  const header = document.querySelector<HTMLElement>('header')!
  const start = document.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!
  const end = document.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
  const title = document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
  const rail = document.querySelector<HTMLElement>('[data-app-navigation-rail]')!
  const navigation = document.querySelector<HTMLElement>('nav[aria-label="设置"]')!
  const main = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
  const back = document.getElementById('back')!
  const forward = document.getElementById('forward')!
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
  const setRect = (element: Element, bounds: DOMRect) => {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
    element.getBoundingClientRect = () => bounds
  }
  setRect(header, rect(0, 0, 1719, 44))
  setRect(start, rect(0, 0, 290, 44))
  setRect(title, rect(290, 44, 1425, 46))
  setRect(end, rect(1715, 44, 0, 46))
  setRect(rail, rect(0, 44, 52, 937))
  setRect(navigation, rect(52, 44, 238, 937))
  setRect(main, rect(290.5, 44, 1424.5, 937))
  setRect(back, rect(88, 8, 28, 28))
  setRect(forward, rect(122, 8, 28, 28))
  const nativeGetComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  const regions = new Map<Element, string>([
    [header, 'drag'],
    [title, 'none'],
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
  Object.defineProperty(document, 'elementFromPoint', { value: () => nativeHit ?? document.body })
  return {
    document,
    header,
    title,
    navigation,
    main,
    regions,
    rect,
    setRect,
    setNativeHit: (element?: Element) => {
      nativeHit = element
    },
  }
}

describe('26.924 Settings full-bleed titlebar safety probe', () => {
  it('returns only the measured y=0 space above Settings content without changing native nodes', () => {
    const f = fixture()
    const before = f.document.body.innerHTML
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toEqual({
      anchor: f.header,
      nativeTitle: f.title,
      bounds: { left: 290, top: 0, right: 1683, bottom: 44, width: 1393, height: 44 },
      provenance: 'codex-26.924-settings-titlebar',
    })
    expect(f.document.body.innerHTML).toBe(before)
  })

  it('rejects changed Settings identity, title placement, or an occupied blank span', () => {
    const f = fixture()
    f.navigation.setAttribute('role', 'navigation')
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toBeUndefined()
    f.navigation.removeAttribute('role')
    f.setRect(f.title, f.rect(290, 0, 1425, 44))
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toBeUndefined()
    f.setRect(f.title, f.rect(290, 44, 1425, 46))
    f.setNativeHit(f.title)
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toBeUndefined()
  })

  it('rejects another native control, changed drag authority, and a Host seat crossing its bounds', () => {
    const f = fixture()
    const action = f.document.createElement('button')
    f.header.append(action)
    f.setRect(action, f.rect(500, 8, 28, 28))
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toBeUndefined()
    action.remove()
    f.regions.set(f.header, 'no-drag')
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toBeUndefined()
    f.regions.set(f.header, 'drag')
    const host = f.document.createElement('div')
    host.dataset.cordisxManagerTitlebarSeat = 'true'
    host.style.pointerEvents = 'none'
    f.header.append(host)
    f.setRect(host, f.rect(290, 0, 1393, 44))
    expect(resolveManagerSettingsTitlebarSeat(f.document)?.bounds.width).toBe(1393)
    f.setRect(host, f.rect(0, 0, 1719, 44))
    expect(resolveManagerSettingsTitlebarSeat(f.document)).toBeUndefined()
  })
})
