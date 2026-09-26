import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  captureManagerTitlebarLease,
  releaseManagerTitlebarLease,
  resolveManagerTitlebarContinuation,
} from '../packages/cli/src/renderer/adapter/manager-titlebar-continuation.js'

type Kind = 'native' | 'settings'

function fixture(kind: Kind) {
  const settings = kind === 'settings'
  const dom = new JSDOM(`<!doctype html><body>
    <header data-app-shell-titlebar="true" data-app-shell-application-menu-bar="false"
      data-app-shell-header-layout="${settings ? 'full-bleed' : 'default'}"
      style="position:fixed;pointer-events:none">
      <div data-app-shell-header-slot="start" data-app-shell-header-obstacle="true">
        <button id="back" style="pointer-events:auto">Back</button>
        <button id="forward" style="pointer-events:auto">Forward</button>
      </div>
      <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface"
        style="pointer-events:none">
        ${
    settings
      ? ''
      : '<div data-app-shell-titlebar-slot="main" data-app-shell-focus-area="main"><span id="native-title">Native title</span></div>'
  }
      </div>
      <div data-app-shell-header-slot="end" data-app-shell-header-obstacle="true">
        ${settings ? '' : '<button id="native-end" style="pointer-events:auto">Native end</button>'}
      </div>
    </header>
    <nav data-app-navigation-rail="true"></nav>
    <nav aria-label="${settings ? '设置' : 'Home'}" ${settings ? '' : 'role="navigation"'}></nav>
    <div data-app-shell-main-content-layout="${settings ? 'full-bleed' : 'default'}"></div>
  </body>`)
  const document = dom.window.document
  const header = document.querySelector<HTMLElement>('header')!
  const start = document.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!
  const end = document.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
  const title = document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
  const slot = document.querySelector<HTMLElement>('[data-app-shell-titlebar-slot="main"]')
  const native = settings ? title : document.getElementById('native-title')!
  const rail = document.querySelector<HTMLElement>('[data-app-navigation-rail]')!
  const navigation = document.querySelector<HTMLElement>('nav[aria-label]')!
  const main = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
  const back = document.getElementById('back')!
  const forward = document.getElementById('forward')!
  const nativeEnd = document.getElementById('native-end')
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
  const setRect = (element: Element, bounds: DOMRect) => {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
    element.getBoundingClientRect = () => bounds
  }
  setRect(header, rect(0, 0, 1719, 44))
  setRect(start, rect(0, 0, 290, 44))
  setRect(title, settings ? rect(290, 44, 1425, 46) : rect(290, 0, 1429, 44))
  setRect(end, settings ? rect(1715, 44, 0, 46) : rect(1683, 0, 36, 44))
  if (slot !== null) setRect(slot, rect(290, 0, 1429, 44))
  setRect(rail, rect(0, 44, 52, 937))
  setRect(navigation, rect(52, 44, 238, 937))
  setRect(main, rect(290.5, 44, 1424.5, 937))
  setRect(back, rect(88, 8, 28, 28))
  setRect(forward, rect(122, 8, 28, 28))
  if (nativeEnd !== null) setRect(nativeEnd, rect(1683, 8, 28, 28))
  const nativeGetComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  const regions = new Map<Element, string>([
    [header, 'drag'],
    [title, 'none'],
    [back, 'no-drag'],
    [forward, 'no-drag'],
    ...(nativeEnd === null ? [] : [[nativeEnd, 'no-drag'] as [Element, string]]),
  ])
  Object.defineProperty(dom.window, 'getComputedStyle', {
    value: (element: Element) => {
      const style = nativeGetComputedStyle(element)
      Object.defineProperty(style, 'webkitAppRegion', { value: regions.get(element) ?? '' })
      return style
    },
  })
  Object.defineProperty(document, 'elementFromPoint', { value: () => document.body })
  const pane = { rail, sidebar: { container: navigation }, main: { anchor: main } }
  const mount = (width: number) => {
    const titlebarSeat = document.createElement('div')
    titlebarSeat.dataset.cordisxManagerTitlebarSeat = 'true'
    titlebarSeat.style.pointerEvents = 'none'
    const navigationSeat = document.createElement('div')
    navigationSeat.dataset.cordisxManagerSidebarRoot = 'true'
    const contentSeat = document.createElement('div')
    contentSeat.dataset.cordisxReactManager = 'true'
    contentSeat.dataset.managerSurface = 'pane'
    const resizeHandle = document.createElement('div')
    resizeHandle.dataset.cordisxManagerSidebarResizer = 'true'
    resizeHandle.setAttribute('role', 'separator')
    ;(slot ?? header).append(titlebarSeat)
    navigation.append(navigationSeat)
    main.append(contentSeat)
    document.body.append(resizeHandle)
    for (const node of settings ? [title] : [native]) {
      node.inert = true
      node.style.visibility = 'hidden'
      node.setAttribute('aria-hidden', 'true')
    }
    const right = 52 + width
    setRect(navigation, rect(52, 44, width, 937))
    setRect(main, rect(right + .5, 44, 1715 - right - .5, 937))
    setRect(resizeHandle, rect(right - 5, 44, 10, 937))
    setRect(titlebarSeat, rect(290, 0, 1393, 44))
    return { titlebarSeat, navigationSeat, contentSeat, resizeHandle, sidebarWidth: width }
  }
  return { document, header, start, title, navigation, main, regions, pane, mount, rect, setRect }
}

describe('26.924 Manager titlebar continuation', () => {
  it.each(['settings', 'native'] as const)(
    'keeps the same %s pane after Host widens its sidebar without moving native chrome',
    kind => {
      const f = fixture(kind)
      const lease = captureManagerTitlebarLease(f.document, kind, f.pane)
      expect(lease?.seat.bounds).toMatchObject({ left: 290, top: 0, width: 1393, height: 44 })
      const owner = f.mount(420)
      const next = resolveManagerTitlebarContinuation(f.document, lease!, owner)
      expect(next?.bounds).toEqual({ left: 472.5, top: 0, width: 1210.5, height: 44 })
      expect(resolveManagerTitlebarContinuation(f.document, { ...lease! }, owner)).toBeUndefined()
      const otherSeat = f.document.createElement('div')
      expect(resolveManagerTitlebarContinuation(f.document, lease!, { ...owner, titlebarSeat: otherSeat }))
        .toBeUndefined()
      releaseManagerTitlebarLease(lease!)
      expect(resolveManagerTitlebarContinuation(f.document, lease!, owner)).toBeUndefined()
    },
  )

  it('keeps the native safe left when the Host sidebar narrows below its original width', () => {
    const f = fixture('settings')
    const lease = captureManagerTitlebarLease(f.document, 'settings', f.pane)!
    const owner = f.mount(180)
    expect(resolveManagerTitlebarContinuation(f.document, lease, owner)?.bounds).toEqual({
      left: 290,
      top: 0,
      width: 1393,
      height: 44,
    })
    f.setRect(f.start, f.rect(0, 0, 300, 44))
    expect(resolveManagerTitlebarContinuation(f.document, lease, owner)).toBeUndefined()
  })

  it('closes the lease when a native control or Host-owned held width changes independently', () => {
    const f = fixture('native')
    const lease = captureManagerTitlebarLease(f.document, 'native', f.pane)!
    const owner = f.mount(420)
    expect(resolveManagerTitlebarContinuation(f.document, lease, owner)).toBeDefined()
    f.regions.set(f.header, 'no-drag')
    expect(resolveManagerTitlebarContinuation(f.document, lease, owner)).toBeUndefined()
    f.regions.set(f.header, 'drag')
    expect(resolveManagerTitlebarContinuation(f.document, lease, { ...owner, sidebarWidth: 238 }))
      .toBeUndefined()
    f.navigation.setAttribute('aria-label', 'Other page')
    expect(resolveManagerTitlebarContinuation(f.document, lease, owner)).toBeUndefined()
  })
})
