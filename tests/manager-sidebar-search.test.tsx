import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({ BrandMark: () => <span /> }))

describe('Manager sidebar search', () => {
  it('filters localized destinations without changing route identity, then clears from the control', async () => {
    const fixture = reactManagerFixture()
    const { Navigation } = await import('../packages/cli/src/renderer/manager/components/Navigation.js')
    const router = managerRouter({ kind: 'primary', page: 'plugins' })
    const snapshot = managerSnapshot({
      settingsNavigationItems: [{
        id: 'team:home',
        owner: 'team',
        group: 'before-settings',
        order: 0,
        disabled: false,
        title: 'Team canvas',
        description: '',
        pageTitle: 'Team canvas',
        pageDescription: '',
        icon: 'host:settings',
        route: { id: 'home' },
        navigationGroup: 'collaboration',
      }],
    })
    try {
      await fixture.render(<Navigation snapshot={snapshot} router={router} />)
      expect(fixture.element('.cxr-nav-title').textContent).toBe('CordisX')
      expect(fixture.element('[data-tab="plugins"]').getAttribute('aria-current')).toBe('page')
      await fixture.type('.cxr-nav-search input', 'canvas')
      expect(fixture.document.querySelector('[data-tab="plugins"]')).toBeNull()
      expect(fixture.document.querySelector('[data-navigation-group="resources"]')).toBeNull()
      expect(fixture.element('[data-settings-navigation-item="team:home"]').textContent).toContain('Team canvas')
      await fixture.click('[data-settings-navigation-item="team:home"]')
      expect(router.navigate).toHaveBeenCalledExactlyOnceWith({
        kind: 'manager-content',
        id: 'team:home',
        reference: { id: 'home' },
      })
      await fixture.click('.cxr-nav-search-clear')
      expect((fixture.element('.cxr-nav-search input') as HTMLInputElement).value).toBe('')
      expect(fixture.element('[data-tab="plugins"]').getAttribute('aria-current')).toBe('page')
      expect(fixture.document.activeElement).toBe(fixture.element('.cxr-nav-search input'))
    } finally {
      await fixture.dispose()
    }
  })

  it('shows an empty state and supports Escape and ArrowDown from the search field', async () => {
    const fixture = reactManagerFixture()
    const { Navigation } = await import('../packages/cli/src/renderer/manager/components/Navigation.js')
    try {
      await fixture.render(<Navigation snapshot={managerSnapshot()} router={managerRouter()} />)
      await fixture.type('.cxr-nav-search input', 'nothing matches here')
      expect(fixture.element('[role="status"]').textContent).toBe('No matching pages')
      expect(fixture.document.querySelectorAll('.cxr-nav-destination')).toHaveLength(0)
      await act(async () => {
        fixture.element('.cxr-nav-search input').dispatchEvent(
          new fixture.dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
          }),
        )
      })
      expect(fixture.document.querySelector('[role="status"]')).toBeNull()
      await act(async () => {
        fixture.element('.cxr-nav-search input').dispatchEvent(
          new fixture.dom.window.KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
          }),
        )
      })
      expect(fixture.document.activeElement).toBe(fixture.element('[data-tab="plugins"]'))
    } finally {
      await fixture.dispose()
    }
  })
})
