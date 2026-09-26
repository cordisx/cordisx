import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { CodexRouteHistorySnapshot } from '../packages/cli/src/renderer/codex-router-history.js'
import { ManagerApp } from '../packages/cli/src/renderer/manager/ManagerApp.js'
import { createManagerMarketplaceStore } from '../packages/cli/src/renderer/manager/model/marketplace-store.js'
import { managerModel, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

vi.mock('../packages/cli/src/renderer/host-ui/HostForm.js', () => ({
  HOST_FORM_REACT_STYLES: '',
  HostForm: () => <input aria-label="Draft configuration" defaultValue="original" />,
}))

describe('Manager native route boundary', () => {
  it('keeps the current route and unsaved form input while a native menu opens and closes', async () => {
    const fixture = reactManagerFixture()
    const { document, dom } = fixture
    document.getElementById('root')!.dataset.cordisxReactManager = 'true'
    Object.defineProperties(dom.window.Node.prototype, {
      attachEvent: { configurable: true, value() {} },
      detachEvent: { configurable: true, value() {} },
    })
    const triggerSeat = document.createElement('div')
    const navigationSeat = document.createElement('div')
    const titlebarSeat = document.createElement('div')
    const help = document.createElement('button')
    help.textContent = 'Help'
    help.setAttribute('aria-haspopup', 'menu')
    document.body.append(triggerSeat, navigationSeat, titlebarSeat, help)
    const model = managerModel(managerSnapshot({
      plugins: [{
        id: 'gateway',
        source: 'file:///gateway',
        name: 'Gateway',
        inject: [],
        config: { endpoint: 'original' },
        status: 'active',
        configuration: {
          namespace: 'gateway',
          schemaKind: 'schemastery',
          applies: 'live',
          writable: true,
          revision: 1,
          lastGoodRevision: 1,
          value: { endpoint: 'original' },
          fields: [{
            namespace: 'gateway',
            path: ['endpoint'],
            type: 'string',
            value: 'original',
            disabled: false,
            required: true,
          }],
          secrets: [],
        },
      }],
    }))
    const marketplace = createManagerMarketplaceStore(document)
    let routeSnapshot: CodexRouteHistorySnapshot = {
      available: true,
      key: 'native-home',
      index: 0,
      nativeLocation: { pathname: '/', search: '', hash: '' },
    }
    const routeListeners = new Set<() => void>()
    const nativeRouteHistory = {
      snapshot: () => routeSnapshot,
      subscribe: (listener: () => void) => {
        routeListeners.add(listener)
        return () => routeListeners.delete(listener)
      },
    }
    try {
      await fixture.render(
        <ManagerApp
          model={model}
          marketplace={marketplace.model}
          triggerSeat={triggerSeat}
          navigationSeat={navigationSeat}
          titlebarSeat={titlebarSeat}
          activatePane={() => true}
          nativeRouteHistory={nativeRouteHistory}
        />,
      )
      await fixture.click('[data-cordisx-manager-trigger]')
      await fixture.click('[data-plugin-id="gateway"]')
      await fixture.click('[data-plugin-detail-tab="config"]')
      const draft = fixture.element('[aria-label="Draft configuration"]') as HTMLInputElement
      draft.value = 'unsaved value'
      expect(document.querySelector('[data-plugin-detail="gateway"]')).not.toBeNull()
      expect(document.querySelector('[data-plugin-detail-tab="config"]')?.getAttribute('aria-selected')).toBe('true')
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      help.addEventListener('click', () => document.body.append(menu), { once: true })
      await act(async () => {
        help.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
        help.click()
      })
      expect(menu.isConnected).toBe(true)
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      menu.remove()
      await act(async () => {
        document.body.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))
        document.body.dispatchEvent(new dom.window.Event('pointermove', { bubbles: true }))
        document.body.dispatchEvent(new dom.window.Event('pointerup', { bubbles: true }))
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      expect(document.querySelector('[data-plugin-detail="gateway"]')).not.toBeNull()
      expect(document.querySelector('[data-plugin-detail-tab="config"]')?.getAttribute('aria-selected')).toBe('true')
      expect(fixture.element('[aria-label="Draft configuration"]')).toBe(draft)
      expect(draft.value).toBe('unsaved value')
      await act(async () => dom.window.dispatchEvent(new dom.window.PopStateEvent('popstate')))
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      await act(async () => {
        routeSnapshot = {
          available: true,
          key: 'native-settings',
          index: 1,
          nativeLocation: { pathname: '/settings', search: '', hash: '' },
        }
        for (const listener of routeListeners) listener()
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
    } finally {
      marketplace.dispose()
      await fixture.dispose()
    }
  })
})
