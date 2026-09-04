import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { MarketplaceModel } from '../packages/cli/src/renderer/marketplace.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

function snapshot(): ManagerSnapshot {
  return {
    version: 'test',
    plugins: [{
      id: 'demo', source: 'file:///plugins/demo.js', name: 'Demo plugin',
      inject: [], config: {}, status: 'active',
      configuration: {
        namespace: 'demo', schemaKind: 'none', applies: 'plugin-restart', writable: false,
        revision: 1, lastGoodRevision: 1, value: {}, fields: [], secrets: [],
      },
      development: {
        origin: 'local-dev', pluginId: 'demo', sourcePath: '/plugins/demo.ts', state: 'ready',
        lastSuccessfulAt: '2026-09-04T00:00:00.000Z',
      },
    }],
    registrations: [], commands: [], navigation: { routes: [], pages: [], outlets: [] },
    localization: { locale: 'en', direction: 'ltr', version: 1 },
    localeCatalogs: [], localizationDiagnostics: [], permissions: [],
    platform: {
      hostId: 'codex-desktop', hostName: 'Codex Desktop', mode: 'unavailable',
      supportedCapabilities: [], diagnostics: [], secondConnectionCreated: false, rawBridgeExposed: false,
    },
  }
}

async function settle(): Promise<void> { await new Promise(resolve => setTimeout(resolve, 0)) }

async function click(document: Document, selector: string): Promise<void> {
  await act(async () => {
    document.querySelector<HTMLButtonElement>(selector)!.click()
    await settle()
  })
}

describe('React Manager localization', () => {
  it('renders English Host chrome, plugin management, searches, and empty states from the copy catalog', async () => {
    const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', { url: 'https://codex.local/' })
    const previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
    const previous = {
      document: globalThis.document, window: globalThis.window,
      HTMLElement: globalThis.HTMLElement, Element: globalThis.Element, Node: globalThis.Node,
      MutationObserver: globalThis.MutationObserver, getComputedStyle: globalThis.getComputedStyle,
      requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame,
    }
    Object.assign(globalThis, {
      document: dom.window.document, window: dom.window,
      HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: (callback: FrameRequestCallback) => dom.window.setTimeout(() => callback(Date.now()), 0),
      cancelAnimationFrame: (handle: number) => dom.window.clearTimeout(handle),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      attachEvent: { configurable: true, value() {} },
      detachEvent: { configurable: true, value() {} },
    })
    Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
    const confirm = vi.fn(() => false)
    Object.defineProperty(dom.window, 'confirm', { configurable: true, value: confirm })
    const { ManagerApp } = await import('../packages/cli/src/renderer/manager/ManagerApp.js')
    const state = snapshot()
    const requestPluginLifecycle = vi.fn(async () => ({
      outcome: 'planned', impactToken: 'impact:demo', affectedPluginIds: ['demo'],
    }))
    const model = {
      snapshot: () => state, subscribe: () => () => {},
      setPluginBlocked: async () => {}, setPermissionPolicy: async () => {}, requestPluginLifecycle,
    } as unknown as ManagerModel
    const seat = dom.window.document.createElement('span')
    dom.window.document.body.append(seat)
    const root = createRoot(dom.window.document.body.appendChild(dom.window.document.createElement('div')))
    try {
      await act(async () => root.render(<ManagerApp model={model} marketplace={{} as MarketplaceModel} triggerSeat={seat} />))
      const trigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      expect(trigger.getAttribute('aria-label')).toBe('Manage CordisX plugins')
      expect(trigger.title).toBe('Manage CordisX plugins')
      await click(dom.window.document, '[data-cordisx-manager-trigger]')

      const dialog = dom.window.document.querySelector<HTMLElement>('[data-cordisx-manager-modal] [role="dialog"]')!
      expect(dialog.getAttribute('aria-label')).toBe('CordisX Plugin Manager')
      expect(dialog.querySelector('.cxr-header [aria-label="Close CordisX Manager"]')).not.toBeNull()
      expect(dialog.querySelector('[data-tab="plugins"]')?.textContent).toBe('Plugins')
      expect(dialog.querySelector('[data-tab="plugin-bundles"]')?.textContent).toBe('Plugin bundles')
      expect(dialog.querySelector('.cxr-heading')?.textContent).toBe('Plugins')
      expect(dialog.querySelector('[data-plugin-origin="local-dev"]')?.textContent).toContain('Local development')
      expect(dialog.querySelector('[data-plugin-id="demo"]')?.getAttribute('aria-label')).toBe('Open plugin details · Demo plugin')
      expect(dialog.querySelector('[aria-label="Disable plugin"]')).not.toBeNull()
      expect(dialog.querySelector('[aria-label="Reload plugin"]')).not.toBeNull()
      expect(dialog.querySelector('[aria-label="Demo plugin · More plugin actions"]')).not.toBeNull()

      await click(dom.window.document, '[aria-label="Disable plugin"]')
      expect(confirm).toHaveBeenCalledWith('This action affects: demo. Continue?')

      await click(dom.window.document, '[data-plugin-id="demo"]')
      expect(dialog.querySelector('.cxr-header [aria-label="Back"]')).not.toBeNull()
      expect(dialog.querySelector('.cxr-heading')?.textContent).toContain('Plugins')
      expect(dialog.querySelector('[aria-label="Plugin information and actions"]')).not.toBeNull()
      expect(dialog.querySelector('[aria-label="Plugin details"]')).not.toBeNull()
      expect(dialog.textContent).toContain('This plugin does not provide a README.')

      await click(dom.window.document, '[data-plugin-detail-tab="permissions"]')
      expect(dialog.textContent).toContain('This plugin does not declare platform permissions.')
      await click(dom.window.document, '[data-plugin-detail-tab="runtime"]')
      for (const copy of ['Local development', 'Source path', 'Build status', 'Last successful build', 'Status', 'Permissions', 'Injected capabilities', 'Dependencies', 'None']) {
        expect(dialog.textContent).toContain(copy)
      }
      await click(dom.window.document, '[data-plugin-detail-tab="extension-points"]')
      expect(dialog.querySelector('[aria-label="Search plugin extension points"]')).not.toBeNull()
      expect(dialog.textContent).toContain('This plugin does not use extension points.')
      await click(dom.window.document, '[data-plugin-detail-tab="routes"]')
      expect(dialog.querySelector('[aria-label="Search plugin routes"]')).not.toBeNull()
      expect(dialog.textContent).toContain('This plugin does not register routes.')

      await click(dom.window.document, '[data-tab="extension-points"]')
      expect(dialog.querySelector('[aria-label="Search extension points"]')).not.toBeNull()
      expect(dialog.textContent).toContain('No extension points available')
      await click(dom.window.document, '[data-tab="routes"]')
      expect(dialog.querySelector('[aria-label="Search routes and pages"]')).not.toBeNull()
      expect(dialog.textContent).toContain('No routes or pages available')
      expect(dialog.textContent).not.toMatch(/[\u3400-\u9fff]/u)
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      if (previousActEnvironment === undefined) delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
      else (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
      dom.window.close()
    }
  })
})
