import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'
import { managerModel } from './helpers/react-manager.js'
import { installNativeManagerShell } from './fixtures/native-manager-shell.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

describe('default Manager overlay', () => {
  it('opens and restores a legacy native destination without data-selected', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://codex.local/',
      pretendToBeVisual: true,
    })
    installNativeManagerShell(dom, { legacySelection: true })
    const previous = {
      window: globalThis.window,
      document: globalThis.document,
      HTMLElement: globalThis.HTMLElement,
      Element: globalThis.Element,
      Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    }
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      configurable: true,
      value: () => ({ length: 1 }) as DOMRectList,
    })
    const home = dom.window.document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
    const automations = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-sidebar-destination="builtin:automations"]',
    )!
    let routeKey = 'home'
    const nativeRouteHistory = {
      snapshot: () => ({
        available: true,
        key: routeKey,
        nativeLocation: { pathname: `/${routeKey}`, search: '', hash: '' },
      }),
      subscribe: () => () => {},
    }
    let dispose: (() => void) | undefined
    try {
      expect(home.hasAttribute('data-selected')).toBe(false)
      await act(async () =>
        dispose = installReactCordisXManager(
          dom.window.document,
          managerModel(),
          { nativeRouteHistory },
        )
      )
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      await act(async () => trigger.click())
      expect(dom.window.document.querySelectorAll('[data-cordisx-manager-pane]')).toHaveLength(1)
      expect(home.hasAttribute('aria-current')).toBe(false)
      await act(async () => trigger.click())
      expect(dom.window.document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(home.getAttribute('aria-current')).toBe('page')
      expect(home.hasAttribute('data-selected')).toBe(false)
      automations.addEventListener('click', () => {
        automations.setAttribute('aria-current', 'page')
        automations.setAttribute('data-selected', '')
        routeKey = 'automations'
      })
      await act(async () => trigger.click())
      await act(async () => {
        automations.click()
        await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      })
      expect(dom.window.document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(home.hasAttribute('aria-current')).toBe(false)
      expect(automations.getAttribute('aria-current')).toBe('page')
      expect(automations.hasAttribute('data-selected')).toBe(true)
    } finally {
      await act(async () => dispose?.())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
