import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { managerModel, managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'
vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({ BrandMark: () => <span /> }))

describe('React Manager contributed navigation and content', () => {
  it('keeps retired global settings absent and routes enabled Host navigation while disabled entries remain inert', async () => {
    const fixture = reactManagerFixture()
    const { Navigation } = await import('../packages/cli/src/renderer/manager/components/Navigation.js')
    const item = {
      id: 'demo:settings',
      owner: 'demo',
      group: 'before-settings' as const,
      order: 0,
      disabled: false,
      title: 'Demo settings',
      description: '',
      pageTitle: 'Demo settings',
      pageDescription: '',
      icon: 'host:settings' as const,
      route: { id: 'settings' },
    }
    const state = managerSnapshot({
      settingsNavigationItems: [item, { ...item, id: 'demo:disabled', disabled: true, disabledReason: 'Unavailable' }],
      settingsTabs: [{
        id: 'retired',
        owner: 'demo',
        title: 'Retired tab',
        icon: 'host:settings',
        order: 0,
        disabled: false,
        builtin: false,
      }],
    })
    const router = managerRouter()
    try {
      await fixture.render(<Navigation snapshot={state} router={router} />)
      expect(fixture.document.querySelector('[data-tab="settings"]')).toBeNull()
      expect(fixture.document.body.textContent).not.toContain('Retired tab')
      expect(fixture.element('[data-settings-navigation-item="demo:disabled"]')).toHaveProperty('disabled', true)
      await fixture.click('[data-settings-navigation-item="demo:disabled"]')
      expect(router.navigate).not.toHaveBeenCalled()
      await fixture.click('[data-settings-navigation-item="demo:settings"]')
      expect(router.navigate).toHaveBeenCalledExactlyOnceWith({
        kind: 'manager-content',
        id: item.id,
        reference: item.route,
      })
    } finally {
      await fixture.dispose()
    }
  })

  it('mounts only contributed body content, uses keyboard tab replacement, and aborts/cleans it on unmount', async () => {
    const fixture = reactManagerFixture()
    const { ManagerContentPage } = await import('../packages/cli/src/renderer/manager/pages/ManagerContentPage.js')
    const abort = vi.fn()
    const close = vi.fn(async () => {})
    const router = managerRouter({ kind: 'manager-content', id: 'demo:settings', reference: { id: 'general' } })
    const model = managerModel(undefined, {
      managerContentPresentation: () => ({
        title: 'Demo settings',
        description: '',
        tabs: [
          { id: 'general', label: 'General', icon: 'host:settings', active: true, route: { id: 'general' } },
          { id: 'advanced', label: 'Advanced', icon: 'host:settings', active: false, route: { id: 'advanced' } },
        ],
      }),
      mountManagerContent: async (_id, _reference, container) => {
        container.textContent = 'Plugin body'
        return {
          owner: 'demo',
          contributionId: 'demo:settings',
          routeId: 'demo:general',
          pageId: 'demo:general',
          signal: new AbortController().signal,
          abort,
          dispose: async () => {},
        }
      },
      closeManagerContent: close,
    })
    try {
      await fixture.render(<ManagerContentPage model={model} router={router} locale="en" />)
      expect(fixture.document.body.textContent).toContain('Plugin body')
      const selected = fixture.element('[data-manager-content-tab="general"]')
      expect(selected.getAttribute('aria-selected')).toBe('true')
      expect(fixture.element('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe(selected.id)
      await act(async () =>
        selected.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      )
      expect(router.replace).toHaveBeenCalledExactlyOnceWith({
        kind: 'manager-content',
        id: 'demo:settings',
        reference: { id: 'advanced' },
      })
      expect(fixture.document.activeElement).toBe(fixture.element('[data-manager-content-tab="advanced"]'))
      await fixture.render(null)
      expect(abort).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
      expect(fixture.document.body.textContent).not.toContain('Plugin body')
    } finally {
      await fixture.dispose()
    }
  })
})
