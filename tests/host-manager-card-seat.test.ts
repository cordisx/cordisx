import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerCardSeat } from '../packages/cli/src/renderer/host-probes.js'

function nativeCard() {
  const document = new JSDOM(`<!doctype html><body>
    <nav data-app-navigation-rail="true"></nav>
    <div data-app-shell-main-content-layout="default">
      <div data-app-shell-thread-edge-divider="false">
        <div data-app-shell-main-content-top-fade="visible"></div>
        <div data-app-shell-focus-area="main"><button>native action</button></div>
      </div>
    </div>
  </body>`).window.document
  const rail = document.querySelector<HTMLElement>('nav')!
  const anchor = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
  const frame = anchor.firstElementChild as HTMLElement
  for (const element of [rail, anchor, frame]) {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
  }
  rail.getBoundingClientRect = () => ({ left: 0, right: 52 }) as DOMRect
  anchor.getBoundingClientRect = () => ({ left: 290, top: 44, width: 1200, height: 700 }) as DOMRect
  frame.getBoundingClientRect = () => ({ left: 290, top: 44, width: 1200, height: 700 }) as DOMRect
  return { document, anchor, frame }
}

describe('26.924 Manager card seat', () => {
  it('resolves the exact native frame while permitting a separate Host-owned sibling', () => {
    const { document, anchor, frame } = nativeCard()
    expect(resolveManagerCardSeat(document)).toEqual({ anchor, frame })
    const manager = document.createElement('div')
    manager.dataset.cordisxReactManager = 'true'
    anchor.append(manager)
    expect(resolveManagerCardSeat(document)).toEqual({ anchor, frame })
  })

  it('fails closed when native identity, frame, or geometry changes', () => {
    const { document, anchor, frame } = nativeCard()
    const duplicate = anchor.cloneNode(true)
    anchor.after(duplicate)
    expect(resolveManagerCardSeat(document)).toBeUndefined()
    duplicate.remove()

    frame.removeAttribute('data-app-shell-thread-edge-divider')
    expect(resolveManagerCardSeat(document)).toBeUndefined()
    frame.setAttribute('data-app-shell-thread-edge-divider', 'false')
    frame.getBoundingClientRect = () => ({ left: 275, top: 44, width: 1200, height: 700 }) as DOMRect
    expect(resolveManagerCardSeat(document)).toBeUndefined()
  })
})
