import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { WorkspaceRailProjection } from '../packages/cli/src/renderer/manager/workspace-rail-projection.js'
import type {
  NativeRailIconVisualRequest,
  NativeRailIconVisualResult,
} from '../packages/cli/src/renderer/adapter/native-rail-icon-visual.js'

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
  it('passes a prior committed route token when the new native marker outruns its fiber', () => {
    const f = fixture()
    f.dom.reconfigure({ url: 'app://-/index.html' })
    const root = f.document.createElement('div')
    root.id = 'root'
    f.document.body.append(root)
    const listeners = new Set<() => void>()
    const router = {
      state: {
        location: { pathname: '/', search: '', hash: '', key: 'home' },
        navigation: { state: 'idle' },
        revalidation: 'idle',
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    Object.defineProperty(root, '__reactContainer$fixture', {
      enumerable: true,
      value: { memoizedProps: { value: { router } } },
    })
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    const svg = f.document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const path = f.document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', 'selected-automation')
    svg.append(path)
    f.automations.append(svg)
    let provisionalDestination: string | undefined
    const projection = new WorkspaceRailProjection(f.document, {
      snapshot: () => ({
        available: true,
        key: router.state.location.key,
        nativeLocation: router.state.location,
      }),
      subscribe: router.subscribe,
    }, {
      appVersion: '26.924.22138',
      project: async request => {
        provisionalDestination = request.provisionalOwner?.destination
        return { status: 'unavailable', reason: 'native-react-runtime-unavailable' }
      },
    })
    f.home.removeAttribute('aria-current')
    f.home.removeAttribute('data-selected')
    f.automations.setAttribute('aria-current', 'page')
    f.automations.setAttribute('data-selected', '')
    router.state.location.pathname = '/automations'
    router.state.location.key = 'automations'
    for (const listener of listeners) listener()
    expect(projection.enter()).toBe(true)
    expect(provisionalDestination).toBe('builtin:automations')
    projection.dispose()
    expect(listeners.size).toBe(0)
    f.dom.window.close()
  })

  it('does not project without a token when the readable native fiber owns another button', () => {
    const f = fixture()
    nativeFiber(f.home, false)
    nativeFiber(f.automations, true)
    nativeFiber(f.library, false)
    let attempts = 0
    const projection = new WorkspaceRailProjection(f.document, undefined, {
      appVersion: '26.924.22138',
      project: async () => {
        attempts++
        return { status: 'unavailable', reason: 'native-icon-owner-unavailable' }
      },
    })
    expect(projection.enter()).toBe(true)
    expect(attempts).toBe(0)
    projection.dispose()
    f.dom.window.close()
  })

  it('disposes an icon lease returned after Manager has left', async () => {
    const f = fixture()
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    let finish: ((result: NativeRailIconVisualResult) => void) | undefined
    let request: NativeRailIconVisualRequest | undefined
    let disposed = 0
    let lost = 0
    const projection = new WorkspaceRailProjection(f.document, undefined, {
      appVersion: '26.924.22138',
      onLost: () => lost++,
      project: input => {
        request = input
        return new Promise(resolve => finish = resolve)
      },
    })
    expect(projection.enter()).toBe(true)
    expect(request?.appVersion).toBe('26.924.22138')
    expect(projection.leave()).toBe(true)
    finish?.({
      status: 'active',
      handle: { destination: 'builtin:home', isCurrent: () => true, dispose: () => disposed++ },
    })
    await Promise.resolve()
    expect(disposed).toBe(1)
    request?.onLost()
    expect(lost).toBe(0)
    f.dom.window.close()
  })

  it('responds only to icon loss from the current Manager entry', async () => {
    const f = fixture()
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    const requests: NativeRailIconVisualRequest[] = []
    let lost = 0
    let disposed = 0
    const projection = new WorkspaceRailProjection(f.document, undefined, {
      appVersion: '26.924.22138',
      onLost: () => lost++,
      project: async input => {
        requests.push(input)
        return {
          status: 'active',
          handle: { destination: 'builtin:home', isCurrent: () => true, dispose: () => disposed++ },
        }
      },
    })
    expect(projection.enter()).toBe(true)
    await Promise.resolve()
    expect(projection.leave()).toBe(true)
    expect(disposed).toBe(1)
    expect(projection.enter()).toBe(true)
    await Promise.resolve()
    requests[0]?.onLost()
    expect(lost).toBe(0)
    requests[1]?.onLost()
    expect(lost).toBe(1)
    projection.leave()
    f.dom.window.close()
  })

  it('retries a busy visual lease after a fast Manager reopen', async () => {
    const f = fixture()
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    let attempts = 0
    let disposed = 0
    const projection = new WorkspaceRailProjection(f.document, undefined, {
      appVersion: '26.924.22138',
      project: async () => {
        attempts++
        return attempts === 1
          ? { status: 'unavailable', reason: 'native-icon-owner-unavailable' }
          : {
            status: 'active',
            handle: { destination: 'builtin:home', isCurrent: () => true, dispose: () => disposed++ },
          }
      },
    })
    expect(projection.enter()).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 130))
    expect(attempts).toBe(2)
    expect(projection.leave()).toBe(true)
    expect(disposed).toBe(1)
    f.dom.window.close()
  })

  it('keeps icon retries through same-destination route churn and stops after another rail click', async () => {
    const f = fixture()
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    let route = {
      available: true,
      key: 'home',
      nativeLocation: { pathname: '/', search: '', hash: '' },
    }
    let attempts = 0
    const projection = new WorkspaceRailProjection(
      f.document,
      { snapshot: () => route, subscribe: () => () => {} },
      {
        appVersion: '26.924.22138',
        project: async () => {
          attempts++
          return { status: 'unavailable', reason: 'native-icon-owner-unavailable' }
        },
      },
    )
    expect(projection.enter()).toBe(true)
    route = {
      available: true,
      key: 'home-detail',
      nativeLocation: { pathname: '/home/detail', search: '', hash: '' },
    }
    await new Promise(resolve => setTimeout(resolve, 130))
    expect(attempts).toBe(2)
    f.library.click()
    await new Promise(resolve => setTimeout(resolve, 130))
    expect(attempts).toBe(2)
    projection.dispose()
    f.dom.window.close()
  })

  it('restores the same destination after entering and leaving the owned tab', async () => {
    const f = fixture()
    expect(f.projection.enter()).toBe(true)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    expect(f.home.hasAttribute('data-selected')).toBe(false)
    expect(f.home.getAttribute('data-cordisx-manager-native-selection-suppressed')).toBe('true')
    expect(f.projection.leave()).toBe(true)
    expect(f.home.getAttribute('aria-current')).toBe('page')
    expect(f.home.hasAttribute('data-selected')).toBe(true)
    expect(f.home.hasAttribute('data-cordisx-manager-native-selection-suppressed')).toBe(false)
    expect(f.projection.enter()).toBe(true)
    f.home.click()
    expect(f.projection.leave()).toBe(true)
    expect(await f.projection.settled()).toBe(true)
    expect(f.home.getAttribute('aria-current')).toBe('page')
    f.dom.window.close()
  })

  it('preserves a newly selected native destination and refuses to restore a stale one', async () => {
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
    expect(await f.projection.settled()).toBe(true)
    expect(f.automations.getAttribute('aria-current')).toBe('page')
    f.dom.window.close()
  })

  it('does not restore the old destination after a different native route commits without a marker', async () => {
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
    projection.dispose()
    expect(await projection.settled()).toBe(false)
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    f.dom.window.close()
  })

  it('restores the same native destination across a background route update with exact native readback', async () => {
    const f = fixture()
    f.home.removeAttribute('aria-current')
    f.home.removeAttribute('data-selected')
    f.automations.setAttribute('aria-current', 'page')
    f.automations.setAttribute('data-selected', '')
    let route = {
      available: true,
      key: 'automations-list',
      nativeLocation: { pathname: '/automations', search: '', hash: '' },
    }
    const projection = new WorkspaceRailProjection(f.document, { snapshot: () => route, subscribe: () => () => {} })
    nativeFiber(f.home, false)
    nativeFiber(f.automations, true)
    nativeFiber(f.library, false)
    expect(projection.enter()).toBe(true)
    route = {
      available: true,
      key: 'automations-detail',
      nativeLocation: { pathname: '/automations/detail', search: '', hash: '' },
    }
    expect(projection.leave()).toBe(false)
    expect(await projection.settled()).toBe(true)
    expect(f.automations.getAttribute('aria-current')).toBe('page')
    f.dom.window.close()
  })

  it('restores the native selected button after Codex replaces the rail element', async () => {
    const f = fixture()
    expect(f.projection.enter()).toBe(true)
    const original = f.document.querySelector<HTMLElement>('nav')!
    const replacement = original.cloneNode(true) as HTMLElement
    original.replaceWith(replacement)
    for (const element of [replacement, ...replacement.querySelectorAll('button')]) {
      element.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
    const [home, automations, library] = [...replacement.querySelectorAll<HTMLButtonElement>('button')]
    nativeFiber(home!, true)
    nativeFiber(automations!, false)
    nativeFiber(library!, false)
    expect(f.projection.leave()).toBe(false)
    expect(await f.projection.settled()).toBe(true)
    expect(home?.getAttribute('aria-current')).toBe('page')
    expect(home?.hasAttribute('data-selected')).toBe(true)
    f.dom.window.close()
  })

  it('lets Codex commit a different destination marker after a rail click', async () => {
    const f = fixture()
    nativeFiber(f.home, true)
    nativeFiber(f.automations, false)
    nativeFiber(f.library, false)
    expect(f.projection.enter()).toBe(true)
    f.automations.click()
    expect(f.projection.leave()).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    expect(f.automations.hasAttribute('aria-current')).toBe(false)
    nativeFiber(f.home, false)
    nativeFiber(f.automations, true)
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(f.automations.hasAttribute('aria-current')).toBe(false)
    f.automations.setAttribute('aria-current', 'page')
    f.automations.setAttribute('data-selected', '')
    expect(await f.projection.settled()).toBe(true)
    expect(f.automations.getAttribute('aria-current')).toBe('page')
    expect(f.home.hasAttribute('aria-current')).toBe(false)
    f.dom.window.close()
  })

  it('restores the same clicked destination on the current rail despite transient native props', () => {
    const f = fixture()
    f.home.removeAttribute('aria-current')
    f.home.removeAttribute('data-selected')
    f.automations.setAttribute('aria-current', 'page')
    f.automations.setAttribute('data-selected', '')
    nativeFiber(f.home, false)
    nativeFiber(f.automations, true)
    nativeFiber(f.library, false)
    expect(f.projection.enter()).toBe(true)
    f.automations.click()
    const original = f.document.querySelector<HTMLElement>('nav')!
    const replacement = original.cloneNode(true) as HTMLElement
    original.replaceWith(replacement)
    for (const element of [replacement, ...replacement.querySelectorAll('button')]) {
      element.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
    const [home, automations, library] = [...replacement.querySelectorAll<HTMLButtonElement>('button')]
    nativeFiber(home!, true)
    nativeFiber(automations!, false)
    nativeFiber(library!, false)
    expect(f.projection.leave()).toBe(true)
    expect(home?.hasAttribute('aria-current')).toBe(false)
    expect(automations?.getAttribute('aria-current')).toBe('page')
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
