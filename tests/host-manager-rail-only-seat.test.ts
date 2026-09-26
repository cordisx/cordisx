import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerPaneSeat, resolveManagerRailOnlySeat } from '../packages/cli/src/renderer/host-probes.js'

function fixture(layout: 'default' | 'custom-titlebar' | 'full-bleed', panelWidth = 52, viewportWidth = 1200) {
  const document = new JSDOM(`<!doctype html><body>
    <aside data-app-shell-left-panel-appearance="default"><div><div><div id="rail-parent">
      <nav data-app-navigation-rail="true" aria-label="应用导航"></nav><div id="native-placeholder"><button>Native</button></div>
    </div></div></div><div id="native-resizer"></div></aside>
    <div data-app-shell-main-content-layout="${layout}"><div data-app-shell-thread-edge-divider="false">
      <div data-app-shell-main-content-top-fade="hidden"></div>
      <div data-app-shell-focus-area="main"><button>Native content</button></div>
    </div></div>
  </body>`).window.document
  const rail = document.querySelector<HTMLElement>('nav')!
  const aside = document.querySelector<HTMLElement>('aside')!
  const anchor = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
  const frame = anchor.firstElementChild as HTMLElement
  const placeholder = document.getElementById('native-placeholder')!
  const resizer = document.getElementById('native-resizer')!
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect
  const setRect = (element: HTMLElement, bounds: DOMRect) => {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
    element.getBoundingClientRect = () => bounds
  }
  setRect(rail, rect(0, 44, 52, 800))
  setRect(aside, rect(0, 44, panelWidth, 800))
  setRect(anchor, rect(panelWidth, 44, viewportWidth, 800))
  setRect(frame, rect(panelWidth, 44, viewportWidth, 800))
  return { document, rail, aside, anchor, frame, placeholder, resizer, setRect, rect }
}

describe('26.924 rail-only Manager seat', () => {
  it.each(['default', 'custom-titlebar', 'full-bleed'] as const)(
    'resolves %s without altering native DOM',
    layout => {
      const f = fixture(layout)
      const before = f.document.body.innerHTML
      expect(resolveManagerRailOnlySeat(f.document)).toEqual({
        rail: f.rail,
        sidebar: {
          container: f.anchor,
          native: [f.placeholder, f.resizer],
          left: 0,
          width: 238,
          inMain: true,
        },
        main: { anchor: f.anchor, frame: f.frame },
        provenance: 'codex-26.924-rail-only',
      })
      expect(resolveManagerPaneSeat(f.document)?.provenance).toBe('codex-26.924-rail-only')
      expect(f.document.body.innerHTML).toBe(before)
    },
  )

  it('rejects an unrecognized wide panel without a semantic native navigation', () => {
    const f = fixture('full-bleed', 290)
    expect(resolveManagerRailOnlySeat(f.document)).toBeUndefined()
  })

  it('rejects ambiguity, incompatible geometry, and a window too narrow for both panes', () => {
    const f = fixture('custom-titlebar')
    const duplicate = f.anchor.cloneNode(true) as HTMLElement
    f.anchor.after(duplicate)
    f.setRect(duplicate, f.rect(290, 44, 1200, 800))
    expect(resolveManagerRailOnlySeat(f.document)).toBeUndefined()
    duplicate.remove()
    const nav = f.document.createElement('nav')
    nav.setAttribute('role', 'navigation')
    f.aside.append(nav)
    expect(resolveManagerRailOnlySeat(f.document)).toBeUndefined()
    nav.remove()
    f.setRect(f.anchor, f.rect(62, 44, 1200, 800))
    expect(resolveManagerRailOnlySeat(f.document)).toBeUndefined()
    f.setRect(f.anchor, f.rect(52, 44, 557, 800))
    f.setRect(f.frame, f.rect(52, 44, 557, 800))
    expect(resolveManagerRailOnlySeat(f.document)).toBeUndefined()
  })
})
