import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { projectNativeRailDefaultIcon } from '../packages/cli/src/renderer/adapter/native-rail-icon-visual.js'
import type { NativeRailRuntime } from '../packages/cli/src/renderer/adapter/native-rail-icon-runtime.js'
import {
  captureNativeRailIconOwner,
  nativeRailCommittedRouteIdentity,
} from '../packages/cli/src/renderer/adapter/native-rail-icon-owner.js'

const HOME = 'builtin:home'
const AUTOMATIONS = 'builtin:automations'

function fixture(peerPath = 'automation-outline') {
  const dom = new JSDOM(
    `<!doctype html><body>
    <nav data-app-navigation-rail="true">
      <button data-sidebar-destination="${HOME}" aria-current="page" data-selected="">
        <span><svg width="20" height="20"><path d="home-filled"></path></svg></span>
      </button>
      <button data-sidebar-destination="${AUTOMATIONS}">
        <span><svg width="20" height="20"><path d="${peerPath}"></path></svg></span>
      </button>
    </nav>
  </body>`,
    { url: 'app://-/index.html', pretendToBeVisual: true },
  )
  const { document } = dom.window
  for (const element of document.querySelectorAll('button,span,svg')) {
    element.getBoundingClientRect = () => ({ left: 10, top: 10, width: 20, height: 20 }) as DOMRect
  }
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
  const homeItem = {
    id: HOME,
    isCurrentDestination: true,
    railIcons: { default: () => 'home-outline', selected: () => 'home-filled' },
  }
  const automationItem = {
    id: AUTOMATIONS,
    isCurrentDestination: false,
    railIcons: { default: () => 'automation-outline' },
  }
  const attach = (button: HTMLButtonElement, item: typeof homeItem) => {
    Object.defineProperty(button, '__reactFiber$fixture', {
      configurable: true,
      enumerable: true,
      value: {
        memoizedProps: item.isCurrentDestination ? { 'data-selected': '' } : {},
        return: {
          memoizedProps: {
            'data-sidebar-destination': item.id,
            selected: item.isCurrentDestination,
            ...(item.isCurrentDestination ? { 'aria-current': 'page' } : {}),
          },
          return: { memoizedProps: { item } },
        },
      },
    })
  }
  attach(buttons[0]!, homeItem)
  attach(buttons[1]!, automationItem)
  const runtime: NativeRailRuntime = {
    assetUrl: 'app://-/assets/app-shared-fixture.js',
    react: {
      version: '19.2.7',
      isValidElement: () => false,
      createElement: type => ({ type }),
    },
    reactDOM: {
      createRoot: container => ({
        render: (element: unknown) => {
          const icon = (element as { type: () => string }).type()
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('width', '20')
          svg.setAttribute('height', '20')
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
          path.setAttribute('d', icon)
          svg.append(path)
          container.append(svg)
        },
        unmount: () => container.replaceChildren(),
      }),
    },
  }
  return { dom, document, buttons, runtime, homeItem, automationItem }
}

function committedRoute(document: Document) {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  const listeners = new Set<() => void>()
  const router = {
    state: {
      location: { pathname: '/home', search: '', hash: '', key: 'new-route' },
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
  const previous = JSON.stringify(['/previous', '', '', 'old-route'])
  return { router, listeners, previous }
}

describe('native rail icon visual lease', () => {
  it('overlays one native default glyph and restores the exact original visual state on disposal', async () => {
    const f = fixture()
    const lost = vi.fn()
    const original = f.buttons[0]!.querySelector('svg')!
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.925.1',
      runtime: f.runtime,
      onLost: lost,
    })
    expect(result.status).toBe('active')
    if (result.status !== 'active') return
    expect(result.handle.isCurrent()).toBe(true)
    expect(original.style.visibility).toBe('hidden')
    expect(f.buttons[0]!.querySelector('[data-cordisx-native-rail-icon-visual] path')?.getAttribute('d'))
      .toBe('home-outline')
    expect(f.buttons[0]!.getAttribute('aria-current')).toBe('page')
    expect(f.buttons[0]!.hasAttribute('data-selected')).toBe(true)
    const second = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.925.1',
      runtime: f.runtime,
      onLost: lost,
    })
    expect(second).toEqual({ status: 'unavailable', reason: 'visual-lease-exists' })
    result.handle.dispose()
    result.handle.dispose()
    expect(original.style.visibility).toBe('')
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    expect(f.document.querySelector('[data-cordisx-native-icon-render-probe]')).toBeNull()
    expect(lost).not.toHaveBeenCalled()
    f.dom.window.close()
  })

  it('fails closed on a mismatched peer glyph and releases its offscreen root', async () => {
    const f = fixture('foreign-path')
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.924.22138',
      runtime: f.runtime,
      onLost: vi.fn(),
    })
    expect(result).toEqual({ status: 'unavailable', reason: 'native-default-render-mismatch' })
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    expect(f.document.querySelector('[data-cordisx-native-icon-render-probe]')).toBeNull()
    f.dom.window.close()
  })

  it('reserves the document during asynchronous preparation', async () => {
    const f = fixture()
    const request = { document: f.document, appVersion: '26.925.1', runtime: f.runtime, onLost: vi.fn() }
    const first = projectNativeRailDefaultIcon(request)
    expect(await projectNativeRailDefaultIcon(request))
      .toEqual({ status: 'unavailable', reason: 'visual-lease-exists' })
    const result = await first
    expect(result.status).toBe('active')
    if (result.status === 'active') result.handle.dispose()
    f.dom.window.close()
  })

  it('keeps the native fiber owner after the Host clears only DOM selection markers', async () => {
    const f = fixture()
    f.buttons[0]!.removeAttribute('aria-current')
    f.buttons[0]!.removeAttribute('data-selected')
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.925.1',
      runtime: f.runtime,
      onLost: vi.fn(),
    })
    expect(result.status).toBe('active')
    if (result.status === 'active') {
      expect(result.handle.isCurrent()).toBe(true)
      result.handle.dispose()
    }
    expect(f.buttons[0]!.getAttribute('aria-current')).toBeNull()
    expect(f.buttons[0]!.hasAttribute('data-selected')).toBe(false)
    f.dom.window.close()
  })

  it('accepts a minted committed-route token while the selected item fiber lags, then revokes on route jump', async () => {
    const f = fixture()
    const route = committedRoute(f.document)
    const token = captureNativeRailIconOwner(f.document, route.previous)
    expect(token?.destination).toBe(HOME)
    f.homeItem.isCurrentDestination = false
    f.buttons[0]!.removeAttribute('aria-current')
    f.buttons[0]!.removeAttribute('data-selected')
    const lost = vi.fn()
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.924.22138',
      provisionalOwner: token,
      runtime: f.runtime,
      onLost: lost,
    })
    expect(result.status).toBe('active')
    if (result.status !== 'active') return
    expect(result.handle.isCurrent()).toBe(true)
    expect(f.buttons[0]!.querySelector('[data-cordisx-native-rail-icon-visual] path')?.getAttribute('d'))
      .toBe('home-outline')
    f.homeItem.isCurrentDestination = true // Fiber catches up before a programmatic native route jump.
    route.router.state.location.key = 'next-route'
    for (const listener of route.listeners) listener()
    expect(lost).toHaveBeenCalledOnce()
    expect(result.handle.isCurrent()).toBe(false)
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    expect(route.listeners.size).toBe(0)
    f.dom.window.close()
  })

  it('rejects a provisional token before route commit, on wrong destination, or mismatched selected SVG', async () => {
    const f = fixture()
    const route = committedRoute(f.document)
    route.router.state.navigation.state = 'loading'
    expect(captureNativeRailIconOwner(f.document, route.previous)).toBeUndefined()
    route.router.state.navigation.state = 'idle'
    expect(captureNativeRailIconOwner(f.document, nativeRailCommittedRouteIdentity(f.document)!))
      .toBeUndefined()
    const wrong = captureNativeRailIconOwner(f.document, route.previous)!
    f.buttons[1]!.setAttribute('aria-current', 'page')
    expect(
      await projectNativeRailDefaultIcon({
        document: f.document,
        appVersion: '26.924.22138',
        provisionalOwner: wrong,
        runtime: f.runtime,
        onLost: vi.fn(),
      }),
    ).toEqual({ status: 'unavailable', reason: 'native-provisional-owner-invalid' })
    f.buttons[1]!.removeAttribute('aria-current')
    const mismatch = captureNativeRailIconOwner(f.document, route.previous)!
    f.homeItem.isCurrentDestination = false
    f.buttons[0]!.querySelector('path')!.setAttribute('d', 'foreign-selected')
    expect(
      await projectNativeRailDefaultIcon({
        document: f.document,
        appVersion: '26.924.22138',
        provisionalOwner: mismatch,
        runtime: f.runtime,
        onLost: vi.fn(),
      }),
    ).toEqual({ status: 'unavailable', reason: 'native-selected-render-mismatch' })
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    f.dom.window.close()
  })

  it('refuses a transitional stale item until its native selected model settles', async () => {
    const f = fixture()
    f.homeItem.isCurrentDestination = false
    const request = { document: f.document, appVersion: '26.924.22138', runtime: f.runtime, onLost: vi.fn() }
    expect(await projectNativeRailDefaultIcon(request))
      .toEqual({ status: 'unavailable', reason: 'native-icon-owner-unavailable' })
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    f.homeItem.isCurrentDestination = true
    const result = await projectNativeRailDefaultIcon(request)
    expect(result.status).toBe('active')
    if (result.status === 'active') result.handle.dispose()
    f.dom.window.close()
  })

  it('removes only its visual layer when the native rail owner changes', async () => {
    const f = fixture()
    const lost = vi.fn()
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.924.22138',
      runtime: f.runtime,
      onLost: lost,
    })
    expect(result.status).toBe('active')
    if (result.status !== 'active') return
    f.homeItem.isCurrentDestination = false
    f.automationItem.isCurrentDestination = true
    f.buttons[1]!.setAttribute('aria-current', 'page')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lost).toHaveBeenCalledOnce()
    expect(result.handle.isCurrent()).toBe(false)
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    expect(f.buttons[0]!.querySelector('svg')?.style.visibility).toBe('')
    f.dom.window.close()
  })

  it('releases the visual lease when a theme update changes the native muted icon color', async () => {
    const f = fixture()
    const lost = vi.fn()
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.924.22138',
      runtime: f.runtime,
      onLost: lost,
    })
    expect(result.status).toBe('active')
    if (result.status !== 'active') return
    f.buttons[1]!.style.color = 'red'
    f.document.documentElement.setAttribute('data-theme', 'dark')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(lost).toHaveBeenCalledOnce()
    expect(result.handle.isCurrent()).toBe(false)
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    f.dom.window.close()
  })

  it('rechecks theme color after a CSS transition begins', async () => {
    const f = fixture()
    const lost = vi.fn()
    const result = await projectNativeRailDefaultIcon({
      document: f.document,
      appVersion: '26.924.22138',
      runtime: f.runtime,
      onLost: lost,
    })
    expect(result.status).toBe('active')
    if (result.status !== 'active') return
    f.document.documentElement.setAttribute('data-theme', 'dark')
    await new Promise(resolve => setTimeout(resolve, 20))
    f.buttons[1]!.style.color = 'red'
    await new Promise(resolve => setTimeout(resolve, 70))
    expect(lost).toHaveBeenCalledOnce()
    expect(f.document.querySelector('[data-cordisx-native-rail-icon-visual]')).toBeNull()
    expect(f.buttons[0]!.querySelector('svg')?.style.visibility).toBe('')
    f.dom.window.close()
  })
})
