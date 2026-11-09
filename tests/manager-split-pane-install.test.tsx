import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { resolveManagerPaneSeat, resolveManagerRailSeat } from '../packages/cli/src/renderer/host-probes.js'
import { resolveManagerSplitTitlebarSeat } from '../packages/cli/src/renderer/adapter/manager-split-titlebar.js'
import { captureManagerTitlebarLease } from '../packages/cli/src/renderer/adapter/manager-titlebar-continuation.js'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'
import { installNativeManagerShell } from './fixtures/native-manager-shell.js'
import { insetNativeWorkspaceTitle, placeNativeWorkspaceTitlebar } from './helpers/native-viewport-titlebar.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

/** Exercise the installed Host entry, seat assembly and cleanup together, without a browser process. */
describe('Manager installation beside native right tabs', () => {
  it.each(['overlay', 'workspace'] as const)(
    'opens %s on the main Host seat and preserves the selected right panel, native draft and route',
    async presentationMode => {
      const f = reactManagerFixture()
      const { document, dom } = f
      installNativeManagerShell(dom)
      Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
        configurable: true,
        writable: true,
        value: () => ({ length: 1 }) as DOMRectList,
      })
      const element = (selector: string) => document.querySelector<HTMLElement>(selector)!
      const rect = (left: number, top: number, width: number, height: number): DOMRect =>
        ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
      const geometry = new Map<Element, DOMRect>()
      const setRect = (node: Element, bounds: DOMRect) => {
        geometry.set(node, bounds)
        node.getClientRects = () => ({ length: 1 }) as DOMRectList
        Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => geometry.get(node)! })
      }
      const header = element('header[data-app-shell-titlebar]')
      const workspace = document.createElement('div')
      workspace.dataset.appShellUnifiedTabStrip = 'true'
      workspace.dataset.appShellCompactPageGutter = 'true'
      workspace.dataset.appShellHeaderPlacement = 'titlebar'
      header.replaceWith(workspace)
      workspace.append(header)
      const touchingSeam = presentationMode === 'workspace'
      header.dataset.appShellHeaderLayout = touchingSeam ? 'default' : 'full-bleed'
      const titleSlot = element('[data-app-shell-titlebar-slot="main"]')
      const obstacle = document.createElement('div')
      obstacle.dataset.appShellHeaderObstacle = 'true'
      titleSlot.replaceWith(obstacle)
      obstacle.append(titleSlot)
      const main = element('[data-app-shell-main-content-layout]')
      main.dataset.appShellMainContentLayout = 'thread-edge-scroll'
      main.dataset.appShellWorkspaceLayout = 'split'
      const frame = element('[data-app-shell-thread-edge-divider]')
      frame.insertAdjacentHTML('beforeend', '<input id="native-draft" value="unsent draft" />')
      const draft = element('#native-draft') as HTMLInputElement
      const end = element('[data-app-shell-header-slot="end"]')
      end.innerHTML = `<div data-app-shell-tab-controller="right" data-tab-id="browser">
      <button role="tab" aria-selected="true" style="pointer-events:auto">Browser</button>
    </div>`
      const panel = document.createElement('div')
      panel.setAttribute('role', 'tabpanel')
      panel.dataset.appShellTabPanelController = 'right'
      panel.dataset.tabId = 'browser'
      panel.innerHTML = '<iframe title="Owned browser fixture" src="about:blank"></iframe>'
      document.body.append(panel)
      const browser = panel.querySelector('iframe')!
      const tab = element('[role="tab"]')
      setRect(header, rect(0, 0, 1719, 44))
      setRect(element('[data-app-shell-header-slot="start"]'), rect(0, 0, 290, 44))
      setRect(element('aside[data-app-shell-left-panel-appearance]'), rect(0, 44, 290, 800))
      setRect(element('[data-app-shell-main-titlebar]'), rect(290, 0, 560, 44))
      setRect(element('[data-app-shell-titlebar-slot="main"]'), rect(290, 0, 554, 44))
      const endLeft = touchingSeam ? 850 : 854
      const tabLeft = endLeft + 4
      setRect(end, rect(endLeft, 0, 1719 - endLeft, 44))
      setRect(element('[data-app-shell-tab-controller="right"]'), rect(tabLeft, 6, 240, 32))
      setRect(tab, rect(tabLeft, 6, 210, 32))
      setRect(element('[data-native-manager-resizer]'), rect(282, 44, 16, 800))
      setRect(main, rect(290, 44, 560, 800))
      setRect(frame, rect(290, 44, 560, 800))
      setRect(panel, rect(850, 44, 869, 800))
      for (const node of document.querySelectorAll('nav, button')) {
        node.getClientRects = () => ({ length: 1 }) as DOMRectList
      }
      const nativeStyle = dom.window.getComputedStyle.bind(dom.window)
      Object.defineProperty(dom.window, 'getComputedStyle', {
        configurable: true,
        value: (node: Element) => {
          const style = nativeStyle(node)
          if (node.matches('[data-app-shell-tab-controller="right"] [role="tab"]')) {
            Object.defineProperty(style, 'webkitAppRegion', { value: 'no-drag', configurable: true })
          }
          return style
        },
      })
      let route = {
        available: true as const,
        key: 'thread',
        nativeLocation: { pathname: '/thread', search: '', hash: '' },
      }
      const routeListeners = new Set<() => void>()
      const panelBefore = panel.outerHTML
      const sourceBefore = browser.getAttribute('src')
      expect(resolveManagerRailSeat(document)).toBeDefined()
      const pane = resolveManagerPaneSeat(document)
      expect(pane).toBeDefined()
      expect(resolveManagerSplitTitlebarSeat(document)).toBeDefined()
      expect(captureManagerTitlebarLease(document, 'split', pane!)).toBeDefined()
      let dispose: (() => void) | undefined
      try {
        await act(async () => {
          dispose = installReactCordisXManager(document, managerModel(), {
            presentationMode,
            nativeRouteHistory: {
              snapshot: () => route,
              subscribe: listener => {
                routeListeners.add(listener)
                return () => routeListeners.delete(listener)
              },
            },
          })
        })
        const trigger = element('[data-cordisx-manager-trigger]')
        await act(async () => trigger.click())
        const manager = element('[data-cordisx-react-manager]')
        expect(document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull()
        expect(manager.parentElement).toBe(main)
        expect(frame.inert).toBe(true)
        expect(panel.outerHTML).toBe(panelBefore)
        expect(browser.getAttribute('src')).toBe(sourceBefore)
        expect(browser.contentDocument?.querySelector('[data-cordisx-react-manager]')).toBeNull()
        expect(tab.getAttribute('aria-selected')).toBe('true')
        expect(draft.value).toBe('unsent draft')
        expect(route.key).toBe('thread')
        // The native right controller is replaced when a browser tab opens.
        // Keep the same Manager React tree and draft across that geometry lease.
        const controller = element('[data-app-shell-tab-controller="right"]')
        const replacement = controller.cloneNode(true) as HTMLElement
        controller.replaceWith(replacement)
        setRect(replacement, rect(tabLeft, 6, 0, 32))
        const replacementTab = replacement.querySelector<HTMLElement>('[role="tab"]')!
        setRect(replacementTab, rect(tabLeft, 6, 210, 32))
        replacementTab.style.setProperty('-webkit-app-region', 'no-drag')
        if (touchingSeam) setRect(frame, rect(290, 44, 0, 800))
        await act(async () => {
          // Default workspaces can lose the measurable pane for longer than the
          // first 150ms retry window. Retain its actual root through recapture.
          await new Promise(resolve => setTimeout(resolve, touchingSeam ? 220 : 80))
          setRect(frame, rect(290, 44, 560, 800))
          setRect(replacement, rect(tabLeft, 6, 240, 32))
          await new Promise(resolve => setTimeout(resolve, 40))
        })
        await vi.waitFor(() => expect(document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull())
        expect(document.querySelector('[data-cordisx-react-manager]')).toBe(manager)
        expect(frame.inert).toBe(true)
        expect(browser.getAttribute('src')).toBe(sourceBefore)
        expect(draft.value).toBe('unsent draft')
        await act(async () => {
          if (touchingSeam) {
            route = { ...route, key: 'different-thread', nativeLocation: { pathname: '/other', search: '', hash: '' } }
            for (const listener of routeListeners) listener()
          } else trigger.click()
        })
        await vi.waitFor(() => expect(document.querySelector('[data-cordisx-manager-pane="true"]')).toBeNull())
        expect(document.querySelector('[data-cordisx-manager-pane="true"]')).toBeNull()
        expect(frame.inert).toBeFalsy()
        expect(frame.style.visibility).toBe('')
        expect(panel.outerHTML).toBe(panelBefore)
        expect(draft.isConnected).toBe(true)
        expect(draft.value).toBe('unsent draft')
      } finally {
        await act(async () => dispose?.())
        await f.dispose()
      }
    },
  )
})

describe('Manager installation in the 26.1103 compact workspace', () => {
  it('opens and normally closes through the production entry while preserving the native title, draft, and route', async () => {
    const f = reactManagerFixture()
    const { document, dom } = f
    installNativeManagerShell(dom)
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: () => ({ length: 1 }) as DOMRectList,
    })
    const element = (selector: string) => document.querySelector<HTMLElement>(selector)!
    const header = element('header[data-app-shell-titlebar]')
    const { workspace } = placeNativeWorkspaceTitlebar(header, 1290)
    insetNativeWorkspaceTitle(header)
    const main = element('[data-app-shell-main-content-layout]')
    const frame = element('[data-app-shell-thread-edge-divider]')
    workspace.append(element('aside[data-app-shell-left-panel-appearance]'), main)
    frame.insertAdjacentHTML('beforeend', '<input id="native-draft" value="unsent draft" />')
    const draft = element('#native-draft') as HTMLInputElement
    const nativeTitle = element('[data-app-shell-titlebar-slot="main"]')
    const end = element('[data-app-shell-header-slot="end"]')
    const nativeTitleChildren = [...nativeTitle.childNodes]
    const nativeTitleStyle = nativeTitle.style.cssText
    const endChildren = [...end.childNodes]
    const endStyle = end.style.cssText
    const endAriaHidden = end.getAttribute('aria-hidden')
    const route = {
      available: true as const,
      key: 'native-home',
      nativeLocation: { pathname: '/', search: '', hash: '' },
    }
    let dispose: (() => void) | undefined
    try {
      const pane = resolveManagerPaneSeat(document)
      expect(pane).toBeDefined()
      expect(captureManagerTitlebarLease(document, 'native', pane!)).toBeDefined()
      await act(async () => {
        dispose = installReactCordisXManager(document, managerModel(), {
          presentationMode: 'workspace',
          nativeRouteHistory: { snapshot: () => route, subscribe: () => () => {} },
        })
      })
      await f.click('[data-cordisx-manager-trigger]')
      expect(document.querySelector('[data-cordisx-manager-pane="true"]')).not.toBeNull()
      expect(element('[data-cordisx-react-manager]').parentElement).toBe(main)
      expect(frame.inert).toBe(true)
      expect(end.inert).toBe(true)
      expect(document.querySelector('[data-cordisx-manager-pane="true"] button:not(:disabled)')).not.toBeNull()
      await f.click('[data-cordisx-manager-trigger]')
      expect(document.querySelector('[data-cordisx-manager-pane="true"]')).toBeNull()
      expect(frame.inert).toBeFalsy()
      expect(frame.style.visibility).toBe('')
      expect([...nativeTitle.childNodes]).toEqual(nativeTitleChildren)
      expect(nativeTitle.style.cssText).toBe(nativeTitleStyle)
      expect([...end.childNodes]).toEqual(endChildren)
      expect(end.style.cssText).toBe(endStyle)
      expect(end.inert).toBeFalsy()
      expect(end.getAttribute('aria-hidden')).toBe(endAriaHidden)
      expect(draft.isConnected).toBe(true)
      expect(draft.value).toBe('unsent draft')
      expect(route.key).toBe('native-home')
    } finally {
      await act(async () => dispose?.())
      await f.dispose()
    }
  })
})
