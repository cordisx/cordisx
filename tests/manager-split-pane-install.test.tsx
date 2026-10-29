import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { resolveManagerPaneSeat, resolveManagerRailSeat } from '../packages/cli/src/renderer/host-probes.js'
import { resolveManagerSplitTitlebarSeat } from '../packages/cli/src/renderer/adapter/manager-split-titlebar.js'
import { captureManagerTitlebarLease } from '../packages/cli/src/renderer/adapter/manager-titlebar-continuation.js'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'
import { installNativeManagerShell } from './fixtures/native-manager-shell.js'

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
      header.dataset.appShellHeaderLayout = 'full-bleed'
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
      setRect(end, rect(854, 0, 865, 44))
      setRect(element('[data-app-shell-tab-controller="right"]'), rect(858, 6, 240, 32))
      setRect(tab, rect(858, 6, 210, 32))
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
          if (node === tab) Object.defineProperty(style, 'webkitAppRegion', { value: 'no-drag', configurable: true })
          return style
        },
      })
      const route = {
        available: true as const,
        key: 'thread',
        nativeLocation: { pathname: '/thread', search: '', hash: '' },
      }
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
              subscribe: () => () => {},
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
        await act(async () => trigger.click())
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
