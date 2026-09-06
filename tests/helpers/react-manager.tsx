import { JSDOM } from 'jsdom'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, vi } from 'vitest'
import type { ManagerModel, ManagerSnapshot } from '../../packages/cli/src/renderer/manager.js'
import type { ManagerRoute, ManagerRouter } from '../../packages/cli/src/renderer/manager/model/routes.js'

export function managerSnapshot(overrides: Partial<ManagerSnapshot> = {}): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    permissions: [],
    platform: {
      hostId: 'test',
      hostName: 'test',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
    ...overrides,
  }
}

export function managerModel(state = managerSnapshot(), overrides: Partial<ManagerModel> = {}): ManagerModel {
  return {
    snapshot: () => state,
    subscribe: () => () => {},
    setPluginBlocked: vi.fn(async () => {}),
    setPermissionPolicy: vi.fn(async () => {}),
    ...overrides,
  }
}

export function managerRouter(route: ManagerRoute = { kind: 'primary', page: 'plugins' }): ManagerRouter {
  return { route, navigate: vi.fn(), replace: vi.fn(), openDetail: vi.fn(), back: vi.fn() }
}

export function reactManagerFixture() {
  const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body><div id="root"></div></body></html>', {
    url: 'https://codex.local/',
    pretendToBeVisual: true,
  })
  const replacements = {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(replacements).map(key => [key, Reflect.get(globalThis, key)]))
  Object.assign(globalThis, replacements)
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value() {} },
    detachEvent: { configurable: true, value() {} },
    scrollIntoView: { configurable: true, value() {} },
  })
  Object.defineProperty(dom.window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  })
  const root = createRoot(dom.window.document.getElementById('root')!)
  const settle = async () => {
    await new Promise(resolve => dom.window.setTimeout(resolve, 0))
  }
  const element = (selector: string) => {
    const target = dom.window.document.querySelector<HTMLElement>(selector)
    expect(target, selector).not.toBeNull()
    return target!
  }
  return {
    dom,
    document: dom.window.document,
    root,
    element,
    render: async (node: ReactNode) => {
      await act(async () => {
        root.render(node)
        await settle()
      })
    },
    click: async (selector: string) => {
      await act(async () => {
        element(selector).click()
        await settle()
      })
    },
    type: async (selector: string, value: string) => {
      await act(async () => {
        const target = element(selector) as HTMLInputElement
        target.focus()
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(target, value)
        target.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        target.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
        target.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
        await settle()
      })
    },
    choose: async (selector: string, label: string) => {
      await act(async () => {
        const target = element(selector)
        target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
        target.click()
        await settle()
      })
      const option = [...dom.window.document.querySelectorAll<HTMLElement>('.t-select-option')]
        .find(item => item.textContent === label)
      expect(option, label).toBeDefined()
      await act(async () => {
        option!.click()
        await settle()
      })
    },
    dispose: async () => {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    },
  }
}
