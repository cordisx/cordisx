import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

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

describe('Manager legacy Host compatibility', () => {
  const installFixture = async (body: string) => {
    const dom = new JSDOM(
      `<!doctype html><html><head></head><body>
      ${body}
    </body></html>`,
      { url: 'app://-/index.html', pretendToBeVisual: true },
    )
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      Node: dom.window.Node,
      MutationObserver: dom.window.MutationObserver,
      getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      IS_REACT_ACT_ENVIRONMENT: true,
    })
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      attachEvent: { configurable: true, value() {} },
      detachEvent: { configurable: true, value() {} },
      scrollIntoView: { configurable: true, value() {} },
    })
    for (const element of dom.window.document.querySelectorAll<HTMLElement>('button, nav, header')) {
      element.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
    const state: ManagerSnapshot = {
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
        hostId: 'codex-desktop',
        hostName: 'Codex Desktop',
        mode: 'unavailable',
        supportedCapabilities: [],
        diagnostics: [],
        secondConnectionCreated: false,
        rawBridgeExposed: false,
      },
    }
    const model = {
      snapshot: () => state,
      subscribe: () => () => {},
      setPluginBlocked: async () => {},
      setPermissionPolicy: async () => {},
    } as unknown as ManagerModel
    let dispose: (() => void) | undefined
    await act(async () => {
      dispose = installReactCordisXManager(dom.window.document, model)
    })
    return { dom, dispose: () => dispose?.() }
  }

  it('opens the modal shell from the unique Codex mode trigger when no pane seat exists', async () => {
    const { dom, dispose } = await installFixture(
      '<button aria-haspopup="menu" aria-label="Switch mode, current mode: Codex">Codex</button>',
    )
    try {
      const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      expect(managerTrigger).not.toBeNull()
      await act(async () => managerTrigger.click())
      expect(dom.window.document.querySelector('[data-cordisx-manager-modal="true"]')).not.toBeNull()
      expect(dom.window.document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(managerTrigger.getAttribute('aria-description')).toBeNull()
    } finally {
      await act(async () => dispose())
      dom.window.close()
    }
  })

  it('rejects modal fallback when a malformed modern rail marker is present', async () => {
    const { dom, dispose } = await installFixture(`
      <nav data-app-navigation-rail="true"></nav>
      <button aria-haspopup="menu" aria-label="Switch mode, current mode: Codex">Codex</button>
    `)
    try {
      const managerTrigger = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!
      expect(managerTrigger).not.toBeNull()
      await act(async () => managerTrigger.click())
      expect(dom.window.document.querySelector('[data-cordisx-manager-modal="true"]')).toBeNull()
      expect(managerTrigger.getAttribute('aria-description')).toBe('CordisX is unavailable on this page')
    } finally {
      await act(async () => dispose())
      dom.window.close()
    }
  })
})
