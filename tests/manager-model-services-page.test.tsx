import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import React from 'react'
import type { ModelProviderRegistry, ModelProviderSnapshot } from '../packages/cli/src/renderer/model-providers.js'
import { ModelServicesPage } from '../packages/cli/src/renderer/manager/pages/ModelServicesPage.js'
import { reactManagerFixture } from './helpers/react-manager.js'

describe('Manager model services catalog', () => {
  it('shows aligned service details without repeating equal labels and ids', async () => {
    const state: ModelProviderSnapshot = {
      loading: false,
      entries: [],
      providers: [{
        providerId: 'provider-a',
        title: 'Provider A',
        icon: 'host:settings',
        models: [
          { id: 'same', label: 'same' },
          { id: 'model-b', label: 'Readable model', group: 'General' },
        ],
      }],
    }
    const registry = {
      snapshot: () => state,
      subscribe: () => () => {},
      refresh: async () => {},
    } as unknown as ModelProviderRegistry
    const fixture = reactManagerFixture()
    try {
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      const provider = fixture.element('.cxms-provider')
      const toggle = fixture.element('.cxms-provider-toggle') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      await act(async () => toggle.click())
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(provider.querySelector('.cxms-provider-identity')?.textContent).toContain('Provider Aprovider-a')
      expect(provider.querySelector('.cxms-model-count')?.textContent).toBe('Models: 2')
      const models = [...provider.querySelectorAll('.cxms-model-identity')]
      expect(models[0]?.querySelector('code')).toBeNull()
      expect(models[1]?.querySelector('code')?.textContent).toBe('model-b')
      expect(provider.querySelector('ul')?.getAttribute('aria-label')).toBe('Provider A · Models')
    } finally {
      await fixture.dispose()
    }
  })

  it('temporarily reveals a complete search match and restores manual disclosure state', async () => {
    const models = Array.from({ length: 140 }, (_, index) => ({
      id: `model-${index}`,
      label: index === 139 ? 'Needle model' : `Model ${index}`,
    }))
    const state: ModelProviderSnapshot = {
      loading: false,
      entries: [],
      providers: [{ providerId: 'large-provider', title: 'Large Provider', icon: 'host:settings', models }],
    }
    const registry = {
      snapshot: () => state,
      subscribe: () => () => {},
      refresh: async () => {},
    } as unknown as ModelProviderRegistry
    const fixture = reactManagerFixture()
    try {
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      const toggle = fixture.element('.cxms-provider-toggle') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      await fixture.type('[aria-label="Search services or models"]', 'Needle')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(fixture.element('.cxms-model-identity').textContent).toContain('Needle model')
      await fixture.type('[aria-label="Search services or models"]', '')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    } finally {
      await fixture.dispose()
    }
  })

  it('uses the shared pending action icon behavior in Manager', async () => {
    let finish!: () => void
    const run = vi.fn(() =>
      new Promise<void>(resolve => {
        finish = resolve
      })
    )
    let state: ModelProviderSnapshot = {
      loading: false,
      providers: [],
      entries: [{
        key: 'aiden-login',
        entry: {
          id: 'login',
          label: 'Aiden',
          icon: 'host:key',
          action: { label: 'Log in', icon: 'host:log-in', run },
        },
      }],
    }
    const listeners = new Set<() => void>()
    const registry = {
      snapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      refresh: async () => {
        state = { ...state, loading: false }
        for (const listener of listeners) listener()
      },
    } as unknown as ModelProviderRegistry
    const fixture = reactManagerFixture()
    try {
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      const button = fixture.element('[aria-label="Log in"]') as HTMLButtonElement
      expect(button.querySelector('[data-host-icon="host:log-in"]')).not.toBeNull()

      await act(async () => {
        button.click()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-busy')).toBe('true')
      expect(button.querySelector('[data-host-icon="host:loader"]')).not.toBeNull()

      await act(async () => {
        finish()
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(button.disabled).toBe(false)
      expect(button.querySelector('[data-host-icon="host:log-in"]')).not.toBeNull()
    } finally {
      await fixture.dispose()
    }
  })
})
