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

describe('Manager native sidebar minimum after legacy persistence', () => {
  it('clamps stored 180px before mounting, then saves and reopens at native minimum', async () => {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'https://codex.local/',
      pretendToBeVisual: true,
    })
    installNativeManagerShell(dom)
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
    const aside = dom.window.document.querySelector<HTMLElement>('aside[data-app-shell-left-panel-appearance]')!
    Object.defineProperty(aside, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, right: 290, top: 44, bottom: 844, width: 290, height: 800 }) as DOMRect,
    })
    Object.defineProperty(aside, '__reactFiber$fixture', {
      enumerable: true,
      value: { memoizedProps: {}, return: { memoizedProps: { minimumWidth: 290 }, return: null } },
    })
    let stored = '180'
    Object.defineProperty(dom.window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => key === 'cordisx.manager.sidebar-width' ? stored : null,
        setItem: (key: string, value: string) => {
          if (key === 'cordisx.manager.sidebar-width') stored = value
        },
      },
    })
    let dispose: (() => void) | undefined
    try {
      await act(async () =>
        dispose = installReactCordisXManager(dom.window.document, managerModel(), {
          presentationMode: 'workspace',
          nativeAppVersion: '26.924.22138',
        })
      )
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      await act(async () => trigger.click())
      expect(dom.window.document.querySelectorAll('[data-cordisx-manager-pane]')).toHaveLength(1)
      const sidebar = dom.window.document.querySelector<HTMLElement>('nav[role="navigation"]')!
      const handle = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-resizer]')!
      expect(sidebar.style.width).toBe('238px')
      expect(handle.getAttribute('aria-valuemin')).toBe('238')
      expect(handle.getAttribute('aria-valuenow')).toBe('238')
      expect(stored).toBe('180')
      await act(async () =>
        handle.dispatchEvent(
          new dom.window.KeyboardEvent('keydown', {
            key: 'Home',
            bubbles: true,
          }),
        )
      )
      expect(stored).toBe('238')
      await act(async () => trigger.click())
      await act(async () => trigger.click())
      expect(sidebar.style.width).toBe('238px')
      expect(dom.window.document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
    } finally {
      await act(async () => dispose?.())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })
})
