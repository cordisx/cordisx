import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { resolveManagerTwoPaneSeat } from '../packages/cli/src/renderer/host-probes.js'

function nativeTwoPane() {
  const document = new JSDOM(`<!doctype html><body>
    <aside data-app-shell-left-panel-appearance="default">
    <nav data-app-navigation-rail="true"></nav>
    <nav role="navigation" aria-label="首页">
      <div data-native-header><button>新建对话</button></div>
      <div data-app-action-sidebar-scroll><button>对话</button></div>
    </nav>
    <div id="native-resizer"><div role="separator" aria-orientation="vertical"></div></div>
    </aside>
    <div data-app-shell-main-content-layout="default">
      <div data-app-shell-thread-edge-divider="false">
        <div data-app-shell-main-content-top-fade="visible"></div>
        <div data-app-shell-focus-area="main"><button>native action</button></div>
      </div>
    </div>
  </body>`).window.document
  const rail = document.querySelector<HTMLElement>('[data-app-navigation-rail]')!
  const aside = document.querySelector<HTMLElement>('aside')!
  const resizer = document.getElementById('native-resizer')!
  const navigation = document.querySelector<HTMLElement>('nav[role="navigation"]')!
  const container = navigation
  const header = container.firstElementChild as HTMLElement
  const scroll = container.lastElementChild as HTMLElement
  const anchor = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
  const frame = anchor.firstElementChild as HTMLElement
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect
  const setRect = (element: HTMLElement, bounds: DOMRect) => {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
    element.getBoundingClientRect = () => bounds
  }
  setRect(rail, rect(0, 0, 52, 981))
  setRect(aside, rect(0, 44, 290, 937))
  setRect(resizer, rect(282, 44, 16, 937))
  setRect(navigation, rect(52, 44, 238, 937))
  setRect(container, rect(52, 44, 238, 937))
  setRect(header, rect(52, 44, 238, 90))
  setRect(scroll, rect(52, 134, 238, 847))
  setRect(anchor, rect(290, 44, 1200, 937))
  setRect(frame, rect(290, 44, 1200, 937))
  return { document, rail, aside, resizer, navigation, container, header, scroll, anchor, frame, rect, setRect }
}

describe('26.924 Manager paired sidebar and card seat', () => {
  it('keeps the overlapping native resize wrapper identified while Host hides it', () => {
    const fixture = nativeTwoPane()
    const { aside, resizer: wrapper } = fixture
    expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.resizer).toBe(wrapper)
    wrapper.style.visibility = 'hidden'
    wrapper.inert = true
    expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.resizer).toBe(wrapper)
    const duplicate = wrapper.cloneNode(true) as HTMLElement
    aside.append(duplicate)
    fixture.setRect(duplicate, fixture.rect(282, 44, 16, 937))
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
    duplicate.remove()
    wrapper.remove()
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
  })

  it('fails closed without the native aside that owns the separate resize strip', () => {
    const fixture = nativeTwoPane()
    fixture.aside.replaceWith(fixture.rail, fixture.navigation)
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
  })

  it('returns exact native nodes, geometry, and provenance without changing the DOM', () => {
    const fixture = nativeTwoPane()
    const before = fixture.document.body.innerHTML
    expect(resolveManagerTwoPaneSeat(fixture.document)).toEqual({
      rail: fixture.rail,
      sidebar: {
        navigation: fixture.navigation,
        container: fixture.container,
        native: [fixture.header, fixture.scroll],
        resizer: fixture.resizer,
      },
      main: { anchor: fixture.anchor, frame: fixture.frame },
      geometry: {
        railRight: 52,
        sidebarLeft: 52,
        sidebarRight: 290,
        mainLeft: 290,
        top: 44,
        bottom: 981,
      },
      provenance: 'codex-26.924-native-two-pane',
    })
    expect(fixture.document.body.innerHTML).toBe(before)

    const hostRoot = fixture.document.createElement('div')
    hostRoot.setAttribute('data-cordisx-manager-sidebar-root', 'true')
    fixture.container.append(hostRoot)
    expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.native).toEqual([fixture.header, fixture.scroll])
  })

  it('resolves the same adjacent sidebar on destinations with one native child', () => {
    for (const destination of ['automations', 'settings', 'thread', 'library']) {
      const fixture = nativeTwoPane()
      fixture.navigation.setAttribute('aria-label', destination)
      fixture.header.remove()
      fixture.scroll.removeAttribute('data-app-action-sidebar-scroll')
      expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.native).toEqual([fixture.scroll])
    }
  })

  it('accepts the implicit Settings navigation beside a full-bleed main viewport', () => {
    const fixture = nativeTwoPane()
    fixture.navigation.removeAttribute('role')
    fixture.navigation.setAttribute('aria-label', '设置')
    fixture.anchor.setAttribute('data-app-shell-main-content-layout', 'full-bleed')
    expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.navigation).toBe(fixture.navigation)
  })

  it('rejects a missing native sidebar or ambiguous adjacent navigation', () => {
    const fixture = nativeTwoPane()
    const duplicate = fixture.navigation.cloneNode(true) as HTMLElement
    fixture.navigation.after(duplicate)
    fixture.setRect(duplicate, fixture.rect(52, 44, 238, 937))
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
    duplicate.remove()
    fixture.header.remove()
    fixture.scroll.remove()
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
  })

  it('preserves native children and rejects a misplaced or duplicate Host root', () => {
    const fixture = nativeTwoPane()
    fixture.container.prepend(fixture.scroll)
    expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.native).toEqual([fixture.scroll, fixture.header])
    fixture.container.append(fixture.scroll)
    const root = fixture.document.createElement('div')
    root.setAttribute('data-cordisx-manager-sidebar-root', 'true')
    fixture.container.append(root)
    expect(resolveManagerTwoPaneSeat(fixture.document)?.sidebar.native).toEqual([fixture.header, fixture.scroll])
    fixture.container.append(fixture.document.createElement('div'))
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
    fixture.container.lastElementChild?.remove()
    fixture.container.prepend(root)
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
    root.remove()
    fixture.navigation.removeAttribute('role')
    fixture.navigation.removeAttribute('aria-label')
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
  })

  it('rejects nonadjacent rail, sidebar, and card geometry', () => {
    const fixture = nativeTwoPane()
    fixture.setRect(fixture.navigation, fixture.rect(60, 44, 230, 937))
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
    fixture.setRect(fixture.navigation, fixture.rect(52, 44, 238, 937))
    fixture.setRect(fixture.anchor, fixture.rect(310, 44, 1200, 937))
    fixture.setRect(fixture.frame, fixture.rect(310, 44, 1200, 937))
    expect(resolveManagerTwoPaneSeat(fixture.document)).toBeUndefined()
  })
})
