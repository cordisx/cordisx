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
import type { ManagerModel, ManagerSnapshot } from '../packages/cli/src/renderer/manager.js'
import type { ManagedManagerPageMount, ManagerContentPresentation } from '../packages/cli/src/renderer/navigation.js'
import { installReactCordisXManager } from '../packages/cli/src/renderer/manager/install.js'
import { HostManagerNavigationController } from '../packages/cli/src/renderer/manager/navigation-controller.js'

const previous = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  MutationObserver: globalThis.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
}

afterEach(() => Object.assign(globalThis, previous))

function snapshot(): ManagerSnapshot {
  return {
    version: '0.1.0',
    plugins: [],
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
      icon: 'host:layers',
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
  it('opens one modal at the exact detail, returns to the declared root, and closes back to the Room', async () => {
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
        : { title: 'Lead', description: 'Lead detail', parent: { id: 'team' }, tabs: [] }
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
        })
        await Promise.resolve()
      })
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

      await act(async () => {
        dom.window.document.querySelector<HTMLButtonElement>('.cxr-header [aria-label="Back"]')!.click()
        await Promise.resolve()
      })
      expect(dom.window.document.querySelector('[data-manager-route="team"]')).not.toBeNull()
      await act(async () =>
        dom.window.document.querySelector<HTMLButtonElement>('.cxr-header [aria-label="Close CordisX Manager"]')!
          .click()
      )
      expect(dom.window.document.querySelector('[data-cordisx-manager-modal="true"]')).toBeNull()
      expect(closeManagerContent).toHaveBeenCalled()
    } finally {
      await act(async () => dispose?.())
      dom.window.close()
    }
  })
})
