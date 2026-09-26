import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document, className?: string) => {
    const node = document.createElement('span')
    node.className = className ?? ''
    node.dataset.brandMark = 'true'
    return node
  },
}))
vi.mock('../packages/cli/src/renderer/host-ui/HostForm.js', () => ({
  HOST_FORM_REACT_STYLES: '',
  HostForm: ({ plugin }: { readonly plugin: { readonly id: string } }) => <div data-plugin-config-form={plugin.id} />,
}))
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagedManagerPageMount, ManagerContentPresentation } from '../packages/cli/src/renderer/navigation.js'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'
import type { NativeRouteSource } from '../packages/cli/src/renderer/manager/native-route-transition.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

const previous = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

function createNativeRouteSource(): NativeRouteSource & { navigate(): void } {
  let index = 0
  const listeners = new Set<() => void>()
  return {
    snapshot: () => ({
      available: true,
      key: `native-${index}`,
      index,
      nativeLocation: { pathname: index === 0 ? '/' : `/native/${index}`, search: '', hash: '' },
    }),
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    navigate: () => {
      index += 1
      for (const listener of listeners) listener()
    },
  }
}

function snapshot(): ManagerSnapshot {
  return {
    version: '0.1.0',
    plugins: [{
      id: 'gateway',
      source: 'file:///gateway',
      name: 'Gateway',
      inject: [],
      config: { endpoint: 'http://localhost' },
      status: 'active',
      configuration: {
        namespace: 'gateway',
        schemaKind: 'schemastery',
        applies: 'live',
        writable: true,
        revision: 1,
        lastGoodRevision: 1,
        value: { endpoint: 'http://localhost' },
        fields: [{
          namespace: 'gateway',
          path: ['endpoint'],
          type: 'string',
          value: 'http://localhost',
          disabled: false,
          required: true,
        }],
        secrets: [],
      },
    }],
    registrations: [],
    commands: [],
    navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [],
    localizationDiagnostics: [],
    permissions: [],
    settingsTabs: [],
    settingsNavigationItems: [{
      id: 'chatroom:team',
      owner: 'chatroom',
      group: 'before-settings',
      order: 10,
      disabled: false,
      title: 'Team Architecture',
      description: 'Entities',
      pageTitle: 'Team Architecture',
      pageDescription: 'Entities',
      icon: {
        kind: 'raster-image',
        image: {
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
          contract: 'cordisx.raster-image-snapshot/v1',
          schemaVersion: 1,
          mediaType: 'image/png',
          encoding: 'base64',
          data: PNG,
          width: 1,
          height: 1,
        },
      },
      route: { id: 'team' },
    }],
    platform: {
      hostId: 'test',
      hostName: 'test',
      mode: 'unavailable',
      supportedCapabilities: [],
      diagnostics: [],
      secondConnectionCreated: false,
      rawBridgeExposed: false,
    },
  }
}

describe('programmatic Manager identity detail navigation', () => {
  it('projects Manager into both 26.924 panes and restores native nodes on seat loss', async () => {
    const dom = new JSDOM(
      `<!doctype html><html><head></head><body>
      <aside data-app-shell-left-panel-appearance="default"><nav data-app-navigation-rail="true"><div>
        <div><button data-sidebar-destination="builtin:home" aria-current="page" data-selected="">Home</button></div>
        <div class="contents"><button data-sidebar-destination="builtin:automations">Automations</button></div>
      </div></nav>
      <nav role="navigation" aria-label="Home">
        <div id="native-sidebar-header"><button id="native-sidebar-action">New conversation</button></div>
        <div data-app-action-sidebar-scroll><button id="native-conversation">Conversation</button></div>
      </nav>
      <div id="native-sidebar-resizer"><div role="separator" aria-orientation="vertical"></div></div></aside>
      <header data-app-shell-titlebar="true" style="position:fixed;pointer-events:none">
        <div data-app-shell-header-slot="start"><button id="native-back" style="pointer-events:auto">Back</button><button id="native-forward" style="pointer-events:auto">Forward</button></div>
        <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface" style="pointer-events:none">
          <div data-app-shell-titlebar-slot="main" data-app-shell-focus-area="main">
            <span id="native-title">Native title</span>
          </div>
        </div>
        <div data-app-shell-header-slot="end"><button id="native-window-action" style="pointer-events:auto">Window</button></div>
      </header>
      <div data-app-shell-main-content-layout="default"><div data-app-shell-thread-edge-divider="false">
        <div data-app-shell-main-content-top-fade="visible"></div>
        <div data-app-shell-focus-area="main"><button id="native-action">Native</button></div>
      </div></div>
    </body></html>`,
      { url: 'app://-/index.html' },
    )
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    const document = dom.window.document
    Object.defineProperty(dom.window.Node.prototype, 'attachEvent', { value: () => {} })
    Object.defineProperty(dom.window.Node.prototype, 'detachEvent', { value: () => {} })
    const rail = document.querySelector<HTMLElement>('nav')!
    const sidebarNavigation = document.querySelector<HTMLElement>('nav[role="navigation"]')!
    const sidebar = sidebarNavigation
    const sidebarHeader = document.getElementById('native-sidebar-header')!
    const sidebarScroll = document.querySelector<HTMLElement>('[data-app-action-sidebar-scroll]')!
    const nativeResizer = document.getElementById('native-sidebar-resizer')!
    const anchor = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
    const frame = anchor.firstElementChild as HTMLElement
    const titlebar = document.querySelector<HTMLElement>('[data-app-shell-titlebar]')!
    const titlebarMain = document.querySelector<HTMLElement>('[data-app-shell-titlebar-slot="main"]')!
    const nativeTitle = document.getElementById('native-title')!
    for (
      const element of document.querySelectorAll(
        'nav,aside,button,header,[data-app-shell-main-titlebar],[data-app-shell-titlebar-slot],'
          + '[data-app-shell-header-slot],[data-app-action-sidebar-scroll],'
          + '[data-app-shell-main-content-layout],[data-app-shell-thread-edge-divider]',
      )
    ) {
      element.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
    sidebarHeader.getClientRects = () => ({ length: 1 }) as DOMRectList
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
    const sidebarWidth = () => Number.parseFloat(sidebar.style.width) || 238
    const contentRect = () => rect(52 + sidebarWidth(), 44, 1238 - sidebarWidth(), 800)
    rail.getBoundingClientRect = () => rect(0, 0, 52, 844)
    sidebar.getBoundingClientRect = () => rect(52, 44, sidebarWidth(), 800)
    sidebarHeader.getBoundingClientRect = () => rect(52, 44, 238, 90)
    sidebarScroll.getBoundingClientRect = () => rect(52, 134, 238, 710)
    nativeResizer.getBoundingClientRect = () => rect(44 + sidebarWidth(), 44, 16, 800)
    anchor.getBoundingClientRect = contentRect
    frame.getBoundingClientRect = contentRect
    titlebar.getBoundingClientRect = () => rect(0, 0, 1290, 44)
    titlebarMain.getBoundingClientRect = () => rect(290, 0, 1000, 44)
    const nativeHeaderTitle = document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
    nativeHeaderTitle.getBoundingClientRect = () => rect(290, 0, 1000, 44)
    document.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!.getBoundingClientRect = () =>
      rect(0, 0, 290, 44)
    document.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!.getBoundingClientRect = () =>
      rect(1254, 0, 36, 44)
    const nativeBack = document.getElementById('native-back')!
    const nativeForward = document.getElementById('native-forward')!
    const nativeWindowAction = document.getElementById('native-window-action')!
    nativeBack.getBoundingClientRect = () => rect(88, 8, 28, 28)
    nativeForward.getBoundingClientRect = () => rect(122, 8, 28, 28)
    nativeWindowAction.getBoundingClientRect = () => rect(1260, 8, 28, 28)
    const nativeGetComputedStyle = dom.window.getComputedStyle.bind(dom.window)
    const regions = new Map<Element, string>([
      [titlebar, 'drag'],
      [nativeHeaderTitle, 'none'],
      [nativeBack, 'no-drag'],
      [nativeForward, 'no-drag'],
      [nativeWindowAction, 'no-drag'],
    ])
    Object.defineProperty(dom.window, 'getComputedStyle', {
      value: (element: Element) => {
        const style = nativeGetComputedStyle(element)
        Object.defineProperty(style, 'webkitAppRegion', { value: regions.get(element) ?? '' })
        return style
      },
    })
    Object.defineProperty(document, 'elementFromPoint', { value: () => document.body })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value: () => ({ length: 1 }) as DOMRectList,
    })
    const nativeGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
      if (this.hasAttribute('data-cordisx-manager-titlebar-seat')) {
        const parentLeft = this.parentElement?.getBoundingClientRect().left ?? 0
        return rect(
          parentLeft + (Number.parseFloat(this.style.left) || 0),
          0,
          Number.parseFloat(this.style.width) || 0,
          44,
        )
      }
      if (this.hasAttribute('data-cordisx-manager-sidebar-resizer')) {
        return rect(52 + sidebarWidth() - 5, 44, 10, 800)
      }
      return nativeGetBoundingClientRect.call(this)
    }
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
    const originalInert = frame.inert
    const sidebarHeaderInert = sidebarHeader.inert
    const sidebarScrollInert = sidebarScroll.inert
    const nativeResizerInert = nativeResizer.inert
    const model = {
      snapshot,
      subscribe: () => () => {},
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
    } as unknown as ManagerModel
    let dispose: (() => void) | undefined
    const settleManager = async () => {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
    }
    const trigger = () => document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
    const nativeRouteHistory = createNativeRouteSource()
    try {
      await act(async () => {
        dispose = installReactCordisXManager(document, model, { nativeRouteHistory })
      })
      expect(trigger()).not.toBeNull()

      frame.removeAttribute('data-app-shell-thread-edge-divider')
      await act(async () => {
        trigger().click()
      })
      expect(document.querySelector('[data-cordisx-manager-pane],[data-cordisx-manager-modal]')).toBeNull()
      expect(trigger().getAttribute('aria-description')).toContain('unavailable')

      frame.setAttribute('data-app-shell-thread-edge-divider', 'false')
      const duplicate = frame.cloneNode(true)
      anchor.append(duplicate)
      await act(async () => {
        trigger().click()
      })
      expect(document.querySelector('[data-cordisx-manager-pane],[data-cordisx-manager-modal]')).toBeNull()
      duplicate.remove()

      titlebarMain.removeAttribute('data-app-shell-titlebar-slot')
      await act(async () => {
        trigger().click()
      })
      expect(document.querySelector('[data-cordisx-manager-pane],[data-cordisx-manager-modal]')).toBeNull()
      expect(frame.getAttribute('aria-hidden')).toBeNull()
      expect(nativeTitle.style.visibility).toBe('')
      titlebarMain.setAttribute('data-app-shell-titlebar-slot', 'main')

      await act(async () => {
        trigger().click()
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      expect(document.querySelector('[data-cordisx-manager-modal]')).toBeNull()
      expect(sidebar.querySelector('[data-cordisx-manager-sidebar-root] .cxr-nav')).not.toBeNull()
      expect(anchor.querySelector('[data-cordisx-manager-pane] .cxr-main')).not.toBeNull()
      expect(anchor.querySelector('[data-cordisx-manager-pane] .cxr-header')).toBeNull()
      expect(titlebarMain.querySelector('[data-cordisx-manager-titlebar-seat] .cxr-heading')?.textContent)
        .toContain('Plugins')
      const hostTitlebar = titlebarMain.querySelector<HTMLElement>('[data-cordisx-manager-titlebar-seat]')!
      expect(hostTitlebar.style.left).toBe('0px')
      expect(hostTitlebar.style.width).toBe('964px')
      expect(hostTitlebar.style.right).toBe('auto')
      expect(hostTitlebar.style.pointerEvents).toBe('none')
      const nativeEndAction = document.getElementById('native-window-action') as HTMLButtonElement
      const nativeEndClick = vi.fn()
      nativeEndAction.addEventListener('click', nativeEndClick)
      expect(nativeEndAction.closest('[aria-hidden="true"],[inert]')).toBeNull()
      expect(titlebarMain.querySelector('.cxr-header-seat [aria-label="Back"]')).toBeNull()
      expect(titlebarMain.querySelector('.cxr-header-seat .cordisx-host-icon')).not.toBeNull()
      expect(nativeTitle.getAttribute('aria-hidden')).toBe('true')
      expect(nativeTitle.style.visibility).toBe('hidden')
      expect(document.getElementById('native-back')?.inert).not.toBe(true)
      expect(document.getElementById('native-forward')?.inert).not.toBe(true)
      expect(frame.getAttribute('aria-hidden')).toBe('true')
      expect(frame.inert).toBe(true)
      expect(sidebarHeader.getAttribute('aria-hidden')).toBe('true')
      expect(sidebarScroll.getAttribute('aria-hidden')).toBe('true')
      expect(sidebarHeader.inert).toBe(true)
      expect(sidebarScroll.inert).toBe(true)
      expect(nativeResizer.inert).toBe(true)
      expect(nativeResizer.style.visibility).toBe('hidden')
      const separator = document.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-resizer]')!
      expect(separator.parentElement).toBe(document.body)
      expect(dom.window.getComputedStyle(separator).position).toBe('fixed')
      expect(separator.getAttribute('role')).toBe('separator')
      expect(separator.getAttribute('aria-valuenow')).toBe('238')
      separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      expect(sidebar.style.width).toBe('246px')
      expect(separator.getAttribute('aria-valuenow')).toBe('246')
      expect(hostTitlebar.style.left).toBe('8px')
      expect(hostTitlebar.style.width).toBe('956px')
      expect(separator.style.left).toBe('298px')
      await settleManager()
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      const titleSeat = titlebarMain.querySelector<HTMLElement>('[data-cordisx-manager-titlebar-seat]')!
      expect(titleSeat.style.position).toBe('absolute')
      expect(titleSeat.style.left).toBe('8px')
      expect(titleSeat.getBoundingClientRect().left).toBe(298)
      expect(titleSeat.getBoundingClientRect().right).toBe(1254)
      expect(nativeResizer.style.visibility).toBe('hidden')

      const titlebarClose = titlebarMain.querySelector<HTMLButtonElement>('.cxr-titlebar-action')!
      await act(async () => {
        titlebarClose.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true, cancelable: true }))
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      await act(async () => titlebarClose.click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      await act(async () => trigger().click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()

      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-plugin-id="gateway"]')?.click()
      })
      expect(titlebarMain.querySelector('.cxr-header-seat [aria-label="Back"]')).not.toBeNull()
      await act(async () => {
        titlebarMain.querySelector<HTMLButtonElement>('.cxr-header-seat [aria-label="Back"]')?.click()
      })
      expect(titlebarMain.querySelector('.cxr-header-seat [aria-label="Back"]')).toBeNull()

      await act(async () => {
        sidebar.querySelector<HTMLButtonElement>('[data-tab="model-services"]')?.click()
      })
      expect(sidebar.querySelector('[data-tab="model-services"]')?.getAttribute('aria-current')).toBe('page')
      expect(titlebarMain.querySelector('.cxr-heading')?.textContent).toContain('Model')

      await act(async () => {
        nativeEndAction.click()
      })
      expect(nativeEndClick).toHaveBeenCalledOnce()
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      await act(async () => trigger().click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(frame.getAttribute('aria-hidden')).toBeNull()
      expect(sidebarHeader.getAttribute('aria-hidden')).toBeNull()
      expect(sidebarScroll.getAttribute('aria-hidden')).toBeNull()
      expect(titlebarMain.querySelector('[data-cordisx-manager-titlebar-seat]')).toBeNull()
      expect(nativeTitle.getAttribute('aria-hidden')).toBeNull()
      expect(nativeTitle.style.visibility).toBe('')
      expect(sidebar.style.width).toBe('')
      expect(nativeResizer.inert).toBe(nativeResizerInert)
      expect(nativeResizer.style.visibility).toBe('')
      expect(document.querySelector('[data-cordisx-manager-sidebar-resizer]')).toBeNull()

      sidebarHeader.remove()
      sidebarScroll.removeAttribute('data-app-action-sidebar-scroll')
      const nativeAction = document.querySelector<HTMLButtonElement>(
        '[data-sidebar-destination="builtin:automations"]',
      )!
      const nativeClicks = vi.fn()
      nativeAction.addEventListener('click', nativeClicks)
      for (const destination of ['Automations', 'Settings', 'active thread', 'Library']) {
        sidebarNavigation.setAttribute('aria-label', destination)
        await act(async () => trigger().click())
        expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
        expect(document.querySelector('[data-cordisx-manager-modal]')).toBeNull()
        expect(sidebarScroll.getAttribute('aria-hidden')).toBe('true')
        expect(sidebarScroll.inert).toBe(true)
        await act(async () => {
          nativeAction.click()
          nativeRouteHistory.navigate()
        })
        expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
        expect(sidebarScroll.getAttribute('aria-hidden')).toBeNull()
        expect(sidebarScroll.inert).toBe(sidebarScrollInert)
      }
      expect(nativeClicks).toHaveBeenCalledTimes(4)
      sidebarNavigation.prepend(sidebarHeader)
      sidebarScroll.setAttribute('data-app-action-sidebar-scroll', '')

      await act(async () => trigger().click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()

      const nativeRow = document.getElementById('native-conversation')!
      nativeRow.setAttribute('role', 'listitem')
      nativeRow.setAttribute('data-pinned-content-tab-drop-key', 'codex:thread:fixture')
      const nativePointerEvents: string[] = []
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
        nativeRow.addEventListener(type, event => {
          expect(event.defaultPrevented).toBe(false)
          nativePointerEvents.push(type)
        })
      }
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        nativeRow.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }))
      }
      expect(nativePointerEvents).toEqual(['pointerdown', 'pointermove', 'pointerup'])
      for (const type of ['pointerdown', 'pointermove', 'pointercancel']) {
        nativeRow.dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true }))
      }
      expect(nativePointerEvents).toEqual([
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointerdown',
        'pointermove',
        'pointercancel',
      ])
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()

      await act(async () => {
        trigger().click()
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()

      await act(async () => trigger().click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()

      await act(async () => dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')))
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      await act(async () => nativeRouteHistory.navigate())
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(frame.getAttribute('aria-hidden')).toBeNull()
      await act(async () => trigger().click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()

      frame.removeAttribute('data-app-shell-thread-edge-divider')
      await settleManager()
      expect(document.querySelector('[data-cordisx-manager-pane],[data-cordisx-manager-modal]')).toBeNull()
      expect(frame.getAttribute('aria-hidden')).toBeNull()
      expect(frame.inert).toBe(originalInert)
      expect(sidebarHeader.getAttribute('aria-hidden')).toBeNull()
      expect(sidebarScroll.getAttribute('aria-hidden')).toBeNull()
      expect(sidebarHeader.inert).toBe(sidebarHeaderInert)
      expect(sidebarScroll.inert).toBe(sidebarScrollInert)
      expect(titlebarMain.querySelector('[data-cordisx-manager-titlebar-seat]')).toBeNull()
      expect(nativeTitle.getAttribute('aria-hidden')).toBeNull()
      expect(sidebar.querySelector('[data-cordisx-manager-sidebar-root]')).toBeNull()
      expect(document.querySelector('[data-cordisx-react-manager]')?.parentElement).toBe(document.body)
      expect(document.querySelector('[data-sidebar-destination="builtin:home"]')?.hasAttribute('data-selected'))
        .toBe(true)
    } finally {
      await act(async () => dispose?.())
      dom.window.close()
    }
  })

  it.each(['custom-titlebar', 'default'] as const)(
    'projects a rail-only Manager on %s and restores the native page',
    async layout => {
      const dom = new JSDOM(
        `<!doctype html><html><head></head><body>
        <header data-app-shell-titlebar="true" data-app-shell-application-menu-bar="false"
          data-app-shell-header-layout="${layout}" style="position:fixed;pointer-events:none">
          <div data-app-shell-header-slot="start" data-app-shell-header-obstacle="true"></div>
          <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface"
            style="pointer-events:none"><span>Native page title</span></div>
          <div style="pointer-events:none"><button id="native-back" style="pointer-events:auto">Back</button>
            <button id="native-forward" style="pointer-events:auto">Forward</button></div>
          <div data-app-shell-header-slot="end" data-app-shell-header-obstacle="true"></div>
          <div></div>
        </header>
        <aside data-app-shell-left-panel-appearance="default"><div>
          <nav data-app-navigation-rail="true" aria-label="应用导航"><div>
            <div><button data-sidebar-destination="builtin:home">Home</button></div>
            <div><button data-sidebar-destination="builtin:automations">Automations</button></div>
            <div><button data-sidebar-destination="builtin:library">Library</button></div>
          </div></nav>
        </div><div id="native-resizer"></div></aside>
        <div data-app-shell-main-content-layout="${layout}"><div data-app-shell-thread-edge-divider="false">
          <div data-app-shell-main-content-top-fade="hidden"></div>
          <div data-app-shell-focus-area="main"><button id="native-action">Native action</button></div>
        </div></div>
      </body></html>`,
        { url: 'app://-/index.html' },
      )
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        Element: dom.window.Element,
        Node: dom.window.Node,
        MutationObserver: dom.window.MutationObserver,
        requestAnimationFrame: (callback: FrameRequestCallback) => {
          callback(0)
          return 0
        },
        cancelAnimationFrame: () => {},
        IS_REACT_ACT_ENVIRONMENT: true,
      })
      Object.defineProperty(dom.window.Node.prototype, 'attachEvent', { value: () => {} })
      Object.defineProperty(dom.window.Node.prototype, 'detachEvent', { value: () => {} })
      const document = dom.window.document
      const rail = document.querySelector<HTMLElement>('nav')!
      const aside = document.querySelector<HTMLElement>('aside')!
      const header = document.querySelector<HTMLElement>('header')!
      const headerStart = header.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!
      const headerEnd = header.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
      const nativeTitle = header.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
      const nativeBack = document.getElementById('native-back')!
      const nativeForward = document.getElementById('native-forward')!
      const anchor = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
      const frame = anchor.firstElementChild as HTMLElement
      const resizer = document.getElementById('native-resizer')!
      const originalFrameInert = frame.inert
      const originalResizerInert = resizer.inert
      const rect = (left: number, top: number, width: number, height: number) =>
        ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
      for (const element of [header, headerStart, headerEnd, nativeTitle, nativeBack, nativeForward]) {
        element.getClientRects = () => ({ length: 1 }) as DOMRectList
      }
      header.getBoundingClientRect = () => rect(0, 0, 1056, 44)
      headerStart.getBoundingClientRect = () => rect(0, 0, 52, 44)
      headerEnd.getBoundingClientRect = () => rect(1052, 44, 0, 46)
      nativeTitle.getBoundingClientRect = () => rect(52, 44, 1000, 46)
      nativeBack.getBoundingClientRect = () => rect(88, 8, 28, 28)
      nativeForward.getBoundingClientRect = () => rect(122, 8, 28, 28)
      const nativeGetComputedStyle = dom.window.getComputedStyle.bind(dom.window)
      const regions = new Map<Element, string>([
        [header, 'drag'],
        [nativeTitle, layout === 'custom-titlebar' ? 'no-drag' : 'none'],
        [nativeBack, 'no-drag'],
        [nativeForward, 'no-drag'],
      ])
      Object.defineProperty(dom.window, 'getComputedStyle', {
        value: (element: Element) => {
          const style = nativeGetComputedStyle(element)
          Object.defineProperty(style, 'webkitAppRegion', { value: regions.get(element) ?? '' })
          return style
        },
      })
      Object.defineProperty(document, 'elementFromPoint', { value: () => document.body })
      const nativeGetClientRects = dom.window.HTMLElement.prototype.getClientRects
      const nativeGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect
      dom.window.HTMLElement.prototype.getClientRects = function() {
        return this.hasAttribute('data-cordisx-manager-titlebar-seat')
          ? ({ length: 1 } as DOMRectList)
          : nativeGetClientRects.call(this)
      }
      dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
        return this.hasAttribute('data-cordisx-manager-titlebar-seat')
          ? rect(166, 0, 854, 44)
          : nativeGetBoundingClientRect.call(this)
      }
      for (
        const element of document.querySelectorAll(
          'nav,aside,button,[data-app-shell-main-content-layout],[data-app-shell-thread-edge-divider]',
        )
      ) {
        element.getClientRects = () => ({ length: 1 }) as DOMRectList
      }
      rail.getBoundingClientRect = () => rect(0, 44, 52, 800)
      aside.getBoundingClientRect = () => rect(0, 44, 52, 800)
      anchor.getBoundingClientRect = () => rect(52, 44, 1000, 800)
      frame.getBoundingClientRect = () => rect(52, 44, 1000, 800)
      const model = {
        snapshot,
        subscribe: () => () => {},
        setPluginBlocked: async () => {},
        setPermissionPolicy: async () => {},
      } as unknown as ManagerModel
      const nativeRouteHistory = createNativeRouteSource()
      let dispose: (() => void) | undefined
      try {
        await act(async () => {
          dispose = installReactCordisXManager(document, model, { nativeRouteHistory })
        })
        const trigger = document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
        await act(async () => trigger.click())
        expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
        expect(document.querySelector('[data-cordisx-manager-modal]')).toBeNull()
        expect(anchor.querySelector('[data-cordisx-manager-sidebar-root] .cxr-nav')).not.toBeNull()
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-root]')?.style.width).toBe('238px')
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-react-manager]')?.style.left).toBe('238px')
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-react-manager]')?.style.width).toBe(
          'calc(100% - 238px)',
        )
        const separator = document.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-resizer]')!
        expect(separator.getAttribute('aria-valuenow')).toBe('238')
        separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-root]')?.style.width).toBe('246px')
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-react-manager]')?.style.left).toBe('246px')
        expect(separator.style.left).toBe('298px')
        const pointer = (type: string, x: number) => {
          const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x })
          Object.defineProperty(event, 'pointerId', { value: 1 })
          return event
        }
        let capturedPointer: number | undefined
        const setPointerCapture = vi.fn((id: number) => {
          capturedPointer = id
        })
        const releasePointerCapture = vi.fn((id: number) => {
          capturedPointer = undefined
          separator.dispatchEvent(pointer('lostpointercapture', id))
        })
        separator.setPointerCapture = setPointerCapture
        separator.hasPointerCapture = id => capturedPointer === id
        separator.releasePointerCapture = releasePointerCapture
        const down = pointer('pointerdown', 100)
        separator.dispatchEvent(down)
        expect(down.defaultPrevented).toBe(true)
        expect(setPointerCapture).toHaveBeenCalledWith(1)
        expect(document.body.style.cursor).toBe('col-resize')
        dom.window.dispatchEvent(pointer('pointermove', 130))
        expect(separator.getAttribute('aria-valuenow')).toBe('276')
        dom.window.dispatchEvent(pointer('pointerup', 130))
        expect(releasePointerCapture).toHaveBeenCalledWith(1)
        expect(document.body.style.cursor).toBe('')
        expect(document.body.style.userSelect).toBe('')
        separator.dispatchEvent(pointer('pointerdown', 100))
        dom.window.dispatchEvent(pointer('pointermove', 140))
        expect(separator.getAttribute('aria-valuenow')).toBe('316')
        capturedPointer = undefined
        separator.dispatchEvent(pointer('lostpointercapture', 140))
        expect(separator.getAttribute('aria-valuenow')).toBe('276')
        expect(document.body.style.cursor).toBe('')
        dom.window.dispatchEvent(pointer('pointermove', 160))
        expect(separator.getAttribute('aria-valuenow')).toBe('276')
        separator.dispatchEvent(pointer('pointerdown', 100))
        dom.window.dispatchEvent(pointer('pointermove', 124))
        expect(separator.getAttribute('aria-valuenow')).toBe('300')
        dom.window.dispatchEvent(new dom.window.Event('blur'))
        expect(separator.getAttribute('aria-valuenow')).toBe('276')
        expect(document.body.style.cursor).toBe('')
        expect(capturedPointer).toBeUndefined()
        separator.dispatchEvent(pointer('pointerdown', 100))
        dom.window.dispatchEvent(pointer('pointermove', 124))
        dom.window.dispatchEvent(pointer('pointercancel', 124))
        expect(separator.getAttribute('aria-valuenow')).toBe('276')
        expect(document.body.style.cursor).toBe('')
        expect(capturedPointer).toBeUndefined()
        separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
        expect(separator.getAttribute('aria-valuenow')).toBe('420')
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-react-manager]')?.style.width).toBe(
          'calc(100% - 420px)',
        )
        expect(frame.inert).toBe(true)
        expect(frame.getAttribute('aria-hidden')).toBe('true')
        expect(resizer.inert).toBe(true)
        separator.dispatchEvent(pointer('pointerdown', 100))
        expect(document.body.style.cursor).toBe('col-resize')
        await act(async () => {
          document.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:library"]')!.click()
          nativeRouteHistory.navigate()
        })
        expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
        expect(document.body.style.cursor).toBe('')
        expect(document.body.style.userSelect).toBe('')
        expect(capturedPointer).toBeUndefined()
        expect(frame.inert).toBe(originalFrameInert)
        expect(frame.getAttribute('aria-hidden')).toBeNull()
        expect(document.querySelector<HTMLElement>('[data-cordisx-react-manager]')?.style.width).toBe('')
        expect(resizer.inert).toBe(originalResizerInert)
        expect(document.querySelector('[data-cordisx-manager-sidebar-resizer]')).toBeNull()
        await act(async () => trigger.click())
        expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
        expect(anchor.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-root]')?.style.width).toBe('420px')
        await act(async () => dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')))
        expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
        await act(async () => nativeRouteHistory.navigate())
        expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
        expect(frame.inert).toBe(originalFrameInert)
        await act(async () => trigger.click())
        expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
        frame.removeAttribute('data-app-shell-thread-edge-divider')
        await act(async () => {
          await new Promise(resolve => setTimeout(resolve, 0))
        })
        expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
        expect(frame.inert).toBe(originalFrameInert)
        expect(anchor.querySelector('[data-cordisx-manager-sidebar-root]')).toBeNull()
      } finally {
        await act(async () => dispose?.())
        dom.window.close()
      }
    },
  )

  it('keeps a verified Settings titlebar when Host resize moves main but native header start stays fixed', async () => {
    const dom = new JSDOM(
      `<!doctype html><body>
      <aside data-app-shell-left-panel-appearance="default">
        <nav data-app-navigation-rail="true" aria-label="应用导航"><div>
          <div><button data-sidebar-destination="builtin:home">Home</button></div>
          <div><button data-sidebar-destination="builtin:automations">Automations</button></div>
        </div></nav>
        <nav aria-label="设置"><div>Native Settings</div></nav>
        <div id="native-resizer"><div role="separator" aria-orientation="vertical"></div></div>
      </aside>
      <header data-app-shell-titlebar="true" data-app-shell-application-menu-bar="false"
        data-app-shell-header-layout="full-bleed" style="position:fixed;pointer-events:none">
        <div data-app-shell-header-slot="start" data-app-shell-header-obstacle="true"></div>
        <div data-app-shell-main-titlebar="true" data-testid="app-shell-header-context-menu-surface"
          style="pointer-events:none">Native Settings title</div>
        <div style="pointer-events:none"><button id="native-back" style="pointer-events:auto">Back</button>
          <button id="native-forward" style="pointer-events:auto">Forward</button></div>
        <div data-app-shell-header-slot="end" data-app-shell-header-obstacle="true"></div>
        <div></div>
      </header>
      <div data-app-shell-main-content-layout="full-bleed"><div data-app-shell-thread-edge-divider="false">
        <div data-app-shell-main-content-top-fade="true"></div>
        <div data-app-shell-focus-area="main">Native content</div>
      </div></div>
    </body>`,
      { url: 'app://-/index.html' },
    )
    const document = dom.window.document
    const aside = document.querySelector<HTMLElement>('aside')!
    const rail = document.querySelector<HTMLElement>('nav[data-app-navigation-rail]')!
    const navigation = document.querySelector<HTMLElement>('nav[aria-label="设置"]')!
    const nativeResizer = document.getElementById('native-resizer')!
    const main = document.querySelector<HTMLElement>('[data-app-shell-main-content-layout]')!
    const frame = main.firstElementChild as HTMLElement
    const header = document.querySelector<HTMLElement>('header')!
    const start = document.querySelector<HTMLElement>('[data-app-shell-header-slot="start"]')!
    const nativeTitle = document.querySelector<HTMLElement>('[data-app-shell-main-titlebar]')!
    const end = document.querySelector<HTMLElement>('[data-app-shell-header-slot="end"]')!
    const back = document.getElementById('native-back')!
    const forward = document.getElementById('native-forward')!
    const rect = (left: number, top: number, width: number, height: number): DOMRect =>
      ({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect
    const navWidth = () => Number.parseFloat(navigation.style.width) || 238
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
      value: () => ({ length: 1 }) as DOMRectList,
    })
    rail.getBoundingClientRect = () => rect(0, 44, 52, 937)
    navigation.getBoundingClientRect = () => rect(52, 44, navWidth(), 937)
    aside.getBoundingClientRect = () => rect(0, 44, 52 + navWidth(), 937)
    nativeResizer.getBoundingClientRect = () => rect(44 + navWidth(), 44, 16, 937)
    main.getBoundingClientRect = () => rect(52 + navWidth() + 0.5, 44, 1715 - 52 - navWidth() - 0.5, 937)
    frame.getBoundingClientRect = main.getBoundingClientRect
    header.getBoundingClientRect = () => rect(0, 0, 1719, 44)
    start.getBoundingClientRect = () => rect(0, 0, 290, 44)
    nativeTitle.getBoundingClientRect = () => rect(290, 44, 1425, 46)
    end.getBoundingClientRect = () => rect(1715, 44, 0, 46)
    back.getBoundingClientRect = () => rect(88, 8, 28, 28)
    forward.getBoundingClientRect = () => rect(122, 8, 28, 28)
    const nativeGetComputedStyle = dom.window.getComputedStyle.bind(dom.window)
    const regions = new Map<Element, string>([
      [header, 'drag'],
      [nativeTitle, 'none'],
      [back, 'no-drag'],
      [forward, 'no-drag'],
    ])
    Object.defineProperty(dom.window, 'getComputedStyle', {
      value: (element: Element) => {
        const style = nativeGetComputedStyle(element)
        Object.defineProperty(style, 'webkitAppRegion', { value: regions.get(element) ?? '' })
        return style
      },
    })
    Object.defineProperty(document, 'elementFromPoint', { value: () => document.body })
    const nativeGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect
    dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
      if (this.hasAttribute('data-cordisx-manager-titlebar-seat')) {
        return rect(Number.parseFloat(this.style.left) || 0, 0, Number.parseFloat(this.style.width) || 0, 44)
      }
      if (this.hasAttribute('data-cordisx-manager-sidebar-resizer')) {
        return rect(52 + navWidth() - 5, 44, 10, 937)
      }
      return nativeGetBoundingClientRect.call(this)
    }
    Object.assign(globalThis, {
      window: dom.window,
      document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      IS_REACT_ACT_ENVIRONMENT: true,
      requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(0), 0),
      cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
    })
    Object.defineProperty(dom.window.Node.prototype, 'attachEvent', { value: () => {} })
    Object.defineProperty(dom.window.Node.prototype, 'detachEvent', { value: () => {} })
    const model = {
      snapshot,
      subscribe: () => () => {},
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
    } as unknown as ManagerModel
    let dispose: (() => void) | undefined
    try {
      await act(async () => {
        dispose = installReactCordisXManager(document, model)
      })
      await act(async () => document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click())
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      const separator = document.querySelector<HTMLElement>('[data-cordisx-manager-sidebar-resizer]')!
      separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      const nativeRefresh = document.createElement('span')
      main.append(nativeRefresh)
      nativeRefresh.remove()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      const titlebar = document.querySelector<HTMLElement>('[data-cordisx-manager-titlebar-seat]')
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      expect(navWidth()).toBe(420)
      expect(main.getBoundingClientRect().left).toBe(472.5)
      expect(titlebar?.getBoundingClientRect().left).toBe(472.5)
      expect(titlebar?.getBoundingClientRect().right).toBeLessThanOrEqual(1683)
      separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
      const narrowRefresh = document.createElement('span')
      main.append(narrowRefresh)
      narrowRefresh.remove()
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      expect(navWidth()).toBe(180)
      expect(main.getBoundingClientRect().left).toBe(232.5)
      expect(titlebar?.getBoundingClientRect().left).toBe(290)
      expect(titlebar?.getBoundingClientRect().right).toBeLessThanOrEqual(1683)
    } finally {
      await act(async () => dispose?.())
      dom.window.close()
    }
  })

  it.each(['team', 'shop'])(
    'opens exact detail and returns to declared parent %s rather than seeded root history',
    async parentId => {
      const dom = new JSDOM(
        '<!doctype html><html><head></head><body><button id="native-trigger">CordisX</button></body></html>',
        { url: 'app://-/index.html' },
      )
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        Element: dom.window.Element,
        Node: dom.window.Node,
        MutationObserver: dom.window.MutationObserver,
        IS_REACT_ACT_ENVIRONMENT: true,
      })
      const controller = new HostManagerNavigationController()
      const closeManagerContent = vi.fn(async () => {})
      const presentation = (reference: { readonly id: string }): ManagerContentPresentation =>
        reference.id === 'team'
          ? { title: 'Team Architecture', description: 'Entities', tabs: [] }
          : {
            title: 'Lead',
            description: 'Lead detail',
            parent: { id: parentId === reference.id ? 'team' : parentId },
            tabs: [],
          }
      const model = {
        snapshot,
        subscribe: () => () => {},
        managerContentPresentation: (_id: string, reference: { readonly id: string }) => presentation(reference),
        mountManagerContent: async (
          _id: string,
          reference: { readonly id: string },
          container: HTMLElement,
        ): Promise<ManagedManagerPageMount> => {
          const body = container.ownerDocument.createElement('div')
          body.dataset.managerRoute = reference.id
          container.append(body)
          const abort = new AbortController()
          return {
            owner: 'chatroom',
            contributionId: 'chatroom:team',
            routeId: `chatroom:${reference.id}`,
            pageId: `chatroom:${reference.id}`,
            signal: abort.signal,
            abort: () => abort.abort(),
            dispose: async () => body.remove(),
          }
        },
        closeManagerContent,
        setPluginBlocked: async () => {},
        setPermissionPolicy: async () => {},
      } as unknown as ManagerModel
      let dispose: (() => void) | undefined
      try {
        await act(async () => {
          dispose = installReactCordisXManager(dom.window.document, model, {
            triggerTarget: () => dom.window.document.getElementById('native-trigger') ?? undefined,
            navigationController: controller,
            legacyModal: true,
          })
          await Promise.resolve()
        })
        await act(async () => {
          controller.openManagerContent({
            contributionId: 'chatroom:team',
            root: { id: 'team' },
            target: { id: 'team' },
          })
          await Promise.resolve()
        })
        expect(dom.window.document.querySelector('[data-settings-navigation-item="chatroom:team"] img')).not.toBeNull()
        expect(dom.window.document.querySelector('.cxr-header-seat [data-brand-icon-kind="raster-image"] img'))
          .not.toBeNull()
        await act(async () => {
          controller.openManagerContent({
            contributionId: 'chatroom:team',
            root: { id: 'team' },
            target: { id: 'entity-overview', params: { entityId: 'lead' } },
          })
          await Promise.resolve()
        })
        expect(dom.window.document.querySelectorAll('[data-cordisx-manager-modal="true"]')).toHaveLength(1)
        expect(dom.window.document.querySelector('[data-manager-route="entity-overview"]')).not.toBeNull()

        const restoreDetail = controller.captureReturn()
        expect(restoreDetail).toBeTypeOf('function')

        await act(async () => {
          dom.window.document.querySelector<HTMLButtonElement>('.cxr-header [aria-label="Back"]')!.click()
          await Promise.resolve()
        })
        expect(dom.window.document.querySelector(`[data-manager-route="${parentId}"]`)).not.toBeNull()

        await act(async () => {
          restoreDetail?.()
          await Promise.resolve()
        })
        expect(dom.window.document.querySelector('[data-manager-route="entity-overview"]')).not.toBeNull()
        await act(async () => {
          controller.openRoute({ kind: 'plugin', pluginId: 'gateway', page: 'config' })
          await Promise.resolve()
        })
        expect(dom.window.document.querySelector('[data-plugin-config-form="gateway"]')).not.toBeNull()
        await act(async () =>
          dom.window.document.querySelector<HTMLButtonElement>('.cxr-header [aria-label="Close CordisX Manager"]')!
            .click()
        )
        expect(dom.window.document.querySelector('[data-cordisx-manager-modal="true"]')).toBeNull()
        expect(closeManagerContent).toHaveBeenCalled()
        // Opening a Session from a plugin page must not resurrect this hidden Manager on Back.
        expect(controller.captureReturn()).toBeUndefined()
      } finally {
        await act(async () => dispose?.())
        dom.window.close()
      }
    },
  )
})
