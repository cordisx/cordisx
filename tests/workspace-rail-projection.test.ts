import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { WorkspaceRailProjection } from '../packages/cli/src/renderer/manager/workspace-rail-projection.js'

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
  const projection = new WorkspaceRailProjection(document)
  return {
    dom,
    document,
    home,
    automations,
    library,
    projection,
  }
}

function nativeFiber(button: HTMLButtonElement, selected: boolean): void {
  Object.defineProperty(button, '__reactFiber$fixture', {
    configurable: true,
    enumerable: true,
    value: {
      memoizedProps: selected ? { 'data-selected': '' } : {},
      return: {
        memoizedProps: {
          'data-sidebar-destination': button.getAttribute('data-sidebar-destination'),
          selected,
          ...(selected ? { 'aria-current': 'page' } : {}),
        },
      },
    },
  })
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
    expect(f.projection.leave()).toBe(true)
    expect(f.automations.getAttribute('aria-current')).toBe('page')
    f.dom.window.close()
  })

  it('does not restore the old destination after a different native route commits without a marker', () => {
    const f = fixture()
    let route = {
      available: true,
      key: 'home',
      nativeLocation: { pathname: '/', search: '', hash: '' },
    }
    const projection = new WorkspaceRailProjection(f.document, { snapshot: () => route, subscribe: () => () => {} })
    expect(projection.enter()).toBe(true)
    f.automations.click()
    route = {
      available: true,
      key: 'automations',
      nativeLocation: { pathname: '/automations', search: '', hash: '' },
    }
    expect(projection.leave()).toBe(false)
    expect(projection.enter()).toBe(false)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    f.dom.window.close()
  })

  it('restores the same native destination across a background route update with exact native readback', () => {
    const f = fixture()
    let route = {
      available: true,
      key: 'automations-list',
      nativeLocation: { pathname: '/automations', search: '', hash: '' },
    }
    const projection = new WorkspaceRailProjection(f.document, { snapshot: () => route, subscribe: () => () => {} })
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    expect(projection.enter()).toBe(true)
    route = {
      available: true,
      key: 'automations-detail',
      nativeLocation: { pathname: '/automations/detail', search: '', hash: '' },
    }
    expect(projection.leave()).toBe(true)
    expect(f.home.getAttribute('aria-current')).toBe('page')
    f.dom.window.close()
  })

  it('does not revive stale selection when native markers become inconsistent', () => {
    const f = fixture()
    expect(f.projection.enter()).toBe(true)
    f.automations.setAttribute('aria-current', 'page')
    f.library.setAttribute('data-selected', '')
    expect(f.projection.leave()).toBe(false)
    expect(f.projection.enter()).toBe(false)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    f.dom.window.close()
  })
})
