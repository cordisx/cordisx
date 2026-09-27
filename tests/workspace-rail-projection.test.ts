import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { WorkspaceRailProjection } from '../packages/cli/src/renderer/manager/workspace-rail-projection.js'
import type { NativeRouteSnapshot } from '../packages/cli/src/renderer/manager/native-route-transition.js'

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <nav data-app-navigation-rail="true"><div>
      <div><button data-sidebar-destination="builtin:home" aria-current="page" data-selected="">Home</button></div>
      <div><button data-sidebar-destination="builtin:automations">Automations</button></div>
      <div><button data-sidebar-destination="builtin:library">Library</button></div>
    </div></nav>
  </body>`)
  const { document } = dom.window
  for (const element of document.querySelectorAll('nav, nav button')) {
    element.getClientRects = () => ({ length: 1 }) as DOMRectList
  }
  const home = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
  const automations = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:automations"]')!
  const library = document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:library"]')!
  let route: NativeRouteSnapshot = {
    available: true,
    key: 'home',
    index: 0,
    nativeLocation: { pathname: '/', search: '', hash: '' },
  }
  const projection = new WorkspaceRailProjection(document, { snapshot: () => route, subscribe: () => () => {} })
  return {
    dom,
    document,
    home,
    automations,
    library,
    projection,
    setRoute: (next: NativeRouteSnapshot) => route = next,
  }
}

describe('Host-owned workspace rail selection projection', () => {
  it('restores the same destination after entering and leaving the owned tab', () => {
    const f = fixture()
    expect(f.projection.enter()).toBe(true)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    expect(f.home.hasAttribute('data-selected')).toBe(false)
    expect(f.projection.leave()).toBe(true)
    expect(f.home.getAttribute('aria-current')).toBe('page')
    expect(f.home.hasAttribute('data-selected')).toBe(true)
    expect(f.projection.enter()).toBe(true)
    f.home.click()
    expect(f.projection.leave()).toBe(true)
    expect(f.home.getAttribute('aria-current')).toBe('page')
    f.dom.window.close()
  })

  it('preserves a newly selected native destination and refuses to restore a stale one', () => {
    const f = fixture()
    expect(f.projection.enter()).toBe(true)
    f.automations.addEventListener('click', () => {
      f.automations.setAttribute('aria-current', 'page')
      f.automations.setAttribute('data-selected', '')
    })
    f.automations.click()
    expect(f.projection.leave()).toBe(true)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    expect(f.automations.getAttribute('aria-current')).toBe('page')
    expect(f.projection.enter()).toBe(true)
    f.library.click()
    expect(f.projection.leave()).toBe(false)
    expect(f.automations.hasAttribute('aria-current')).toBe(false)
    f.dom.window.close()
  })

  it('does not restore a captured selection after a programmatic native route change', () => {
    const f = fixture()
    expect(f.projection.enter()).toBe(true)
    f.setRoute({
      available: true,
      key: 'automations',
      index: 1,
      nativeLocation: { pathname: '/automations', search: '', hash: '' },
    })
    expect(f.projection.leave()).toBe(false)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    f.dom.window.close()
  })
})
