import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ManagerApp } from '../packages/cli/src/renderer/manager/ManagerApp.js'
import { createManagerMarketplaceStore } from '../packages/cli/src/renderer/manager/model/marketplace-store.js'
import type { NativeRouteSnapshot } from '../packages/cli/src/renderer/manager/native-route-transition.js'
import { managerModel, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span data-brand-mark="true" />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

vi.mock('../packages/cli/src/renderer/host-ui/HostForm.js', () => ({
  HOST_FORM_REACT_STYLES: '',
  HostForm: () => <input aria-label="Draft configuration" defaultValue="original" />,
}))

describe('Host Manager workspace presentation', () => {
  it('returns the native seat on route leave and restores the same detail, history, and unsaved draft', async () => {
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
    const nativeFrame = document.createElement('main')
    const nativeNewTab = document.createElement('button')
    nativeNewTab.textContent = '+'
    const nativeNewTabAction = vi.fn()
    nativeNewTab.addEventListener('click', nativeNewTabAction)
    const nativeRail = document.createElement('nav')
    nativeRail.dataset.appNavigationRail = 'true'
    nativeRail.innerHTML = `<div>
      <div><button data-sidebar-destination="builtin:home">Home</button></div>
      <div><button data-sidebar-destination="builtin:automations" aria-current="page">Automations</button></div>
    </div>`
    const nativeHome = nativeRail.querySelector<HTMLButtonElement>('[data-sidebar-destination="builtin:home"]')!
    const nativeAutomation = nativeRail.querySelector<HTMLButtonElement>(
      '[data-sidebar-destination="builtin:automations"]',
    )!
    for (const element of [nativeRail, nativeHome, nativeAutomation]) {
      element.getClientRects = () => ({ length: 1 }) as DOMRectList
    }
    const nativeAutomationAction = vi.fn()
    nativeAutomation.addEventListener('click', nativeAutomationAction)
    document.body.append(triggerSeat, navigationSeat, titlebarSeat, nativeFrame, nativeNewTab, nativeRail)
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
    const routeListeners = new Set<() => void>()
    let route: NativeRouteSnapshot = {
      available: true,
      key: 'native-automations',
      index: 0,
      nativeLocation: { pathname: '/native/automations', search: '', hash: '' },
    }
    const activatePane = vi.fn(() => {
      nativeFrame.inert = true
      return true
    })
    const deactivatePane = vi.fn(() => {
      nativeFrame.inert = false
    })
    let paneLoss = () => {}
    try {
      await fixture.render(
        <ManagerApp
          model={model}
          marketplace={marketplace.model}
          triggerSeat={triggerSeat}
          navigationSeat={navigationSeat}
          titlebarSeat={titlebarSeat}
          activatePane={activatePane}
          deactivatePane={deactivatePane}
          registerPaneLoss={handler => {
            paneLoss = handler
          }}
          presentationMode="workspace"
          setWorkspaceVisible={visible => {
            document.getElementById('root')!.hidden = !visible
          }}
          nativeRouteHistory={{
            snapshot: () => route,
            subscribe: listener => {
              routeListeners.add(listener)
              return () => routeListeners.delete(listener)
            },
          }}
        />,
      )
      await fixture.click('[data-cordisx-manager-trigger]')
      expect(document.querySelector('[data-cordisx-manager-workspace="true"]')).not.toBeNull()
      expect(titlebarSeat.querySelector('[aria-label="Close"]')).toBeNull()
      expect(document.getElementById('root')!.hidden).toBe(false)
      await fixture.click('[data-plugin-id="gateway"]')
      await fixture.click('[data-plugin-detail-tab="config"]')
      const draft = fixture.element('[aria-label="Draft configuration"]') as HTMLInputElement
      draft.value = 'unsaved value'
      expect(titlebarSeat.querySelector('.cxr-header-seat [aria-label="Back"]')).not.toBeNull()
      expect(titlebarSeat.querySelector('.cxr-breadcrumbs')?.textContent).toContain('Gateway')
      await act(async () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })))
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      expect(nativeFrame.inert).toBe(true)

      await act(async () => nativeAutomation.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })))
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      await act(async () => {
        nativeAutomation.click()
        await new Promise(resolve => dom.window.setTimeout(resolve, 0))
      })
      expect(nativeAutomationAction).toHaveBeenCalledOnce()
      expect(route.key).toBe('native-automations')
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(nativeFrame.inert).toBe(false)
      expect(fixture.element('[aria-label="Draft configuration"]')).toBe(draft)
      await fixture.click('[data-cordisx-manager-trigger]')
      expect(fixture.element('[aria-label="Draft configuration"]')).toBe(draft)
      expect(draft.value).toBe('unsaved value')

      await act(async () => {
        route = {
          available: true,
          key: 'native-other',
          index: 1,
          nativeLocation: { pathname: '/native/other', search: '', hash: '' },
        }
        for (const listener of routeListeners) listener()
      })
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(titlebarSeat.querySelector('.cxr-header')).toBeNull()
      expect(navigationSeat.querySelector('.cxr-native-navigation')).toBeNull()
      expect(nativeFrame.inert).toBe(false)
      expect(document.getElementById('root')!.hidden).toBe(true)
      expect(fixture.element('[aria-label="Draft configuration"]')).toBe(draft)
      expect(draft.value).toBe('unsaved value')
      await act(async () => nativeNewTab.click())
      expect(nativeNewTabAction).toHaveBeenCalledOnce()

      await fixture.click('[data-cordisx-manager-trigger]')
      expect(activatePane).toHaveBeenCalledTimes(3)
      expect(document.querySelector('[data-cordisx-manager-pane]')).not.toBeNull()
      expect(fixture.element('[aria-label="Draft configuration"]')).toBe(draft)
      expect(draft.value).toBe('unsaved value')
      expect(document.querySelector('[data-plugin-detail-tab="config"]')?.getAttribute('aria-selected')).toBe('true')
      await act(async () => paneLoss())
      expect(document.querySelector('[data-cordisx-manager-pane]')).toBeNull()
      expect(nativeFrame.inert).toBe(false)
      await fixture.click('[data-cordisx-manager-trigger]')
      expect(fixture.element('[aria-label="Draft configuration"]')).toBe(draft)
      expect(draft.value).toBe('unsaved value')
      await fixture.click('.cxr-header-seat [aria-label="Back"]')
      expect(document.querySelector('[data-plugin-detail="gateway"]')).toBeNull()
      expect(document.querySelector('[data-tab="plugins"]')).not.toBeNull()
      await fixture.click('[data-cordisx-manager-trigger]')
      expect(nativeFrame.inert).toBe(false)
      expect(document.getElementById('root')!.hidden).toBe(true)
    } finally {
      marketplace.dispose()
      await fixture.dispose()
      expect(routeListeners.size).toBe(0)
    }
  })
})
