import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import {
  projectSidebarGroupAppearance,
  resolveSidebarCollectionsSeat,
} from '../packages/cli/src/renderer/adapter/sidebar-collections.js'

function fixture() {
  const dom = new JSDOM(`<aside data-app-action-sidebar-scroll>
    <nav><div><button>Action</button></div><button>Discovery</button></nav>
    <div id="groups" style="display:grid;row-gap:12px">
      <section data-app-action-sidebar-section="one" style="display:flex;flex-direction:column;row-gap:3px">
        <button aria-expanded="true" style="font-size:12px;line-height:20px;padding:4px 8px;color:rgb(120,120,120)">First</button>
        <button data-app-action-sidebar-thread-id="local:one" data-app-action-sidebar-thread-selected="true" style="background:rgb(40,40,40);color:rgb(240,240,240)">Session</button>
      </section>
      <section data-app-action-sidebar-section="two"><button aria-expanded="false">Second</button></section>
    </div>
  </aside>`)
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
  Object.defineProperty(dom.window.HTMLElement.prototype, 'getBoundingClientRect', {
    writable: true,
    value: () => ({ x: 0, y: 100, left: 0, top: 100, right: 240, bottom: 132, width: 240, height: 32 }),
  })
  return dom
}

describe('Host sidebar collection seat', () => {
  it('inserts groups after actions as peers of native sections, using semantic markers', () => {
    const dom = fixture()
    const document = dom.window.document
    const sidebar = document.querySelector('aside')!
    const nativeNavigation = sidebar.querySelector('nav')!.outerHTML
    const nativeSections = [...document.querySelectorAll('section')].map(node => node.outerHTML)
    const seat = resolveSidebarCollectionsSeat(document, sidebar)!
    expect(seat.parent.id).toBe('groups')
    expect((seat.before as HTMLElement).dataset.appActionSidebarSection).toBe('one')
    const root = document.createElement('div')
    root.dataset.cordisxSurfaceHost = seat.key
    seat.parent.insertBefore(root, seat.before)
    projectSidebarGroupAppearance(root, seat)
    expect(root.style.getPropertyValue('--cordisx-nav-group-font-size')).toBe('12px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-item-gap')).toBe('3px')
    expect(root.style.getPropertyValue('--cordisx-nav-selected-background')).toBe('rgb(40, 40, 40)')
    expect(root.nextElementSibling).toBe(seat.before)
    expect(sidebar.querySelector('nav')!.outerHTML).toBe(nativeNavigation)
    expect([...document.querySelectorAll('section')].map(node => node.outerHTML)).toEqual(nativeSections)
    expect(resolveSidebarCollectionsSeat(document, sidebar)?.before).toBe(seat.before)
    dom.window.close()
  })

  it('restores independent heading/row insets and section outer spacing without resizing rows', () => {
    const dom = fixture()
    const document = dom.window.document
    const seat = resolveSidebarCollectionsSeat(document, document.querySelector('aside')!)!
    const root = document.createElement('div')
    seat.parent.insertBefore(root, seat.before)
    const rect = (element: HTMLElement, left: number, right: number): void => {
      element.getBoundingClientRect = () => ({
        left,
        right,
        width: right - left,
        top: 0,
        bottom: 100,
        height: 100,
        x: left,
        y: 0,
        toJSON() {},
      })
    }
    rect(root, 0, 240)
    rect(seat.section!, 8, 232)
    rect(seat.heading!, 16, 68)
    rect(seat.row!, 8, 232)
    seat.section!.style.cssText =
      'padding-left:8px;padding-right:8px;padding-block-start:10px;padding-block-end:14px;margin-block-start:12px;margin-block-end:16px'
    seat.heading!.style.paddingInlineStart = '0px'
    projectSidebarGroupAppearance(root, seat)
    expect(root.style.getPropertyValue('--cordisx-nav-group-heading-inset-start')).toBe('16px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-heading-inset-end')).toBe('16px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-row-inset-start')).toBe('8px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-row-inset-end')).toBe('8px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-margin-block')).toBe('12px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-margin-block-end')).toBe('16px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-section-padding-block-start')).toBe('10px')
    expect(root.style.getPropertyValue('--cordisx-nav-group-section-padding-block-end')).toBe('14px')
    expect(root.style.getPropertyValue('--cordisx-nav-two-line-height')).toBe('')
    const projected = root.style.cssText
    projectSidebarGroupAppearance(root, seat)
    expect(root.style.cssText).toBe(projected)
    dom.window.close()
  })

  it('fails closed without a native section and never samples hover as the selected baseline', () => {
    const dom = fixture()
    const document = dom.window.document
    const sidebar = document.querySelector('aside')!
    const row = document.querySelector<HTMLElement>('[data-app-action-sidebar-thread-id]')!
    vi.spyOn(row, 'matches').mockReturnValue(true)
    expect(resolveSidebarCollectionsSeat(document, sidebar)?.selectedRow).toBeUndefined()
    document.querySelector('#groups')!.remove()
    expect(resolveSidebarCollectionsSeat(document, sidebar)).toBeUndefined()
    dom.window.close()
  })
})
