import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'
import { reactManagerFixture } from './helpers/react-manager.js'

describe('binding catalog Manager', () => {
  it('does not reuse a manual draft as supplemental declarations when switching editors', async () => {
    const fixture = reactManagerFixture()
    const host = catalogFixture([
      catalogView({
        capabilities: ['editManual', 'editSupplement'],
        sourceCapabilities: ['editManual', 'editSupplement'],
        supplement: [{ id: 'supplement-only' }],
      } as never),
    ])
    const { CatalogBinding } = await import(
      '../packages/cli/src/renderer/manager/pages/model-catalog/CatalogBinding.js'
    )
    const select = async (text: string) => {
      await fixture.click('[aria-label="More catalog actions: Provider A"]')
      await act(async () =>
        [...fixture.document.querySelectorAll<HTMLElement>('.t-dropdown__item')].find(item =>
          item.textContent === text
        )!.click()
      )
    }
    try {
      await host.client.refresh()
      await fixture.render(
        <CatalogBinding
          view={host.client.snapshot().views[0]!}
          client={host.client}
          locale="en"
          query=""
          filter="all"
          connected
        />,
      )
      await select('Edit manual models')
      await fixture.type('[aria-label="Exact model ID 1"]', 'manual-draft')
      await select('Edit supplemental models')
      expect((fixture.element('[aria-label="Exact model ID 1"]') as HTMLInputElement).value).toBe('supplement-only')
      expect(host.commands).toEqual([])
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('shows Host status, exact scoped controls and safe diagnostics without duplicate provider rows', async () => {
    const host = catalogFixture()
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const registry = {
      management: host.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => legacy,
    } as unknown as ModelProviderRegistry
    const legacy = {
      loading: false,
      entries: [],
      providers: [{ providerId: 'provider-a', title: 'Provider A', icon: 'host:settings', models: [] }],
    }
    try {
      await host.client.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      await fixture.click('.cxmc-binding-toggle')
      expect(fixture.document.querySelectorAll('[data-binding-ref]')).toHaveLength(1)
      expect(fixture.document.querySelector('.cxms-provider')).toBeNull()
      expect(fixture.element('.cxmc-status').textContent).toContain('AutomaticUp to dateModels: 2Selectable: 2')
      await fixture.click('[aria-label="Block model: Model-A"]')
      expect(host.commands[0]).toEqual({
        operation: 'setOverlay',
        bindingRef: 'binding-a',
        scopeRevision: 'scope-1',
        expectedRevision: '1',
        modelId: 'Model-A',
        blocked: true,
      })
      expect(fixture.element('[aria-label="Unblock model: Model-A"]').getAttribute('aria-pressed')).toBe('true')
      await fixture.click('[aria-label="Pause automatic refresh"]')
      expect(host.commands[1]).toMatchObject({ operation: 'setAutoPaused', paused: true, expectedRevision: '2' })
      await fixture.click('[aria-label="Diagnostics: Provider A"]')
      expect(fixture.element('.cxmc-diagnostics').textContent).toContain('Connection confirmed')
      expect(fixture.document.querySelector('input[type="password"]')).toBeNull()
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('retains search/focused exact ID after an event and presents dormant preferences as unavailable', async () => {
    const host = catalogFixture()
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const legacy = { loading: false, entries: [], providers: [] }
    const registry = {
      management: host.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => legacy,
    } as unknown as ModelProviderRegistry
    try {
      await host.client.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      await fixture.type('[aria-label="Search services or models"]', 'Model-A')
      const button = fixture.element('[aria-label="Pin model: Model-A"]')
      button.focus()
      await act(async () => {
        host.publish({
          ...host.snapshot(),
          sequence: 2,
          views: [catalogView({
            revision: '2',
            freshness: 'stale',
            rows: [
              { ...catalogView().rows[0]!, present: false, selectable: false, blocked: true },
            ],
          })],
        })
        await host.client.refresh()
      })
      expect(fixture.document.activeElement).toBe(button)
      expect((fixture.element('[aria-label="Search services or models"]') as HTMLInputElement).value).toBe('Model-A')
      expect(fixture.element('[data-model-id="Model-A"]').textContent).toContain('Removed')
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('keeps manual provider expansion through refresh and restores it after search', async () => {
    const host = catalogFixture()
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const legacy = { loading: false, entries: [], providers: [] }
    const registry = {
      management: host.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => legacy,
    } as unknown as ModelProviderRegistry
    try {
      await host.client.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      const toggle = fixture.element('.cxmc-binding-toggle') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      await fixture.click('.cxmc-binding-toggle')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      await act(async () => {
        host.publish({ ...host.snapshot(), sequence: 2 })
        await host.client.refresh()
      })
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      await fixture.click('.cxmc-binding-toggle')
      await fixture.type('[aria-label="Search services or models"]', 'Model-A')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      await fixture.type('[aria-label="Search services or models"]', '')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('keeps ordinary catalog filters limited to explicitly supported rows', async () => {
    const base = catalogView().rows[0]!
    const rows = [
      { ...base, id: 'supported-ready', label: 'Supported ready', compatibility: 'supported' },
      {
        ...base,
        id: 'supported-blocked',
        label: 'Supported blocked',
        compatibility: 'supported',
        selectable: false,
        blocked: true,
      },
      {
        ...base,
        id: 'supported-offline',
        label: 'Supported offline',
        compatibility: 'supported',
        selectable: false,
      },
      { ...base, id: 'unknown', label: 'Unknown', compatibility: 'unknown', selectable: false },
      { ...base, id: 'unsupported', label: 'Unsupported', compatibility: 'unsupported', selectable: false },
    ] as never
    const view = catalogView({ rows, sourceCount: 3, selectableCount: 1 })
    const host = catalogFixture([view])
    const fixture = reactManagerFixture()
    const { CatalogBinding } = await import(
      '../packages/cli/src/renderer/manager/pages/model-catalog/CatalogBinding.js'
    )
    const render = (filter: 'all' | 'selectable' | 'blocked') =>
      fixture.render(
        <CatalogBinding
          view={view}
          client={host.client}
          locale="en"
          query=""
          filter={filter}
          connected
        />,
      )
    const visibleIds = () =>
      [...fixture.document.querySelectorAll('[data-model-id]')].map(row => row.getAttribute('data-model-id'))
    try {
      await render('all')
      expect(fixture.element('.cxms-model-count').textContent).toBe('Models: 3')
      expect(visibleIds()).toEqual(['supported-ready', 'supported-blocked', 'supported-offline'])

      await render('blocked')
      expect(visibleIds()).toEqual(['supported-blocked'])

      await render('selectable')
      expect(visibleIds()).toEqual(['supported-ready'])
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('separates plugin source controls from Host preference controls', async () => {
    const pluginView = catalogView({
      sourceKind: 'plugin' as never,
      capabilities: ['setOverlay', 'resetOrder', 'restoreBlocked'],
      sourceCapabilities: [],
      preferenceCapabilities: ['setOverlay', 'resetOrder', 'restoreBlocked'],
    } as never)
    const host = catalogFixture()
    const fixture = reactManagerFixture()
    const { CatalogBinding } = await import(
      '../packages/cli/src/renderer/manager/pages/model-catalog/CatalogBinding.js'
    )
    try {
      await host.client.refresh()
      await fixture.render(
        <CatalogBinding
          view={pluginView}
          client={host.client}
          locale="en"
          query=""
          filter="all"
          connected
        />,
      )
      expect(fixture.document.querySelector('[aria-label="Refresh models: Provider A"]')).toBeNull()
      expect((fixture.element('[aria-label="Pin model: Model-A"]') as HTMLButtonElement).disabled).toBe(false)
      expect(fixture.element('.cxmc-status').textContent).toContain('Plugin')
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('preserves drafts on revision conflict, requires explicit empty save and fences scope changes', async () => {
    const fixture = reactManagerFixture()
    const { ModelEditor } = await import('../packages/cli/src/renderer/manager/pages/model-catalog/ModelEditor.js')
    let saved = 0
    const props = {
      locale: 'en',
      mode: 'supplement' as const,
      save: async () => {
        saved++
        return { status: 'applied' as const }
      },
      close: () => {},
    }
    try {
      await fixture.render(<ModelEditor {...props} view={catalogView()} />)
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(true)
      await fixture.click('[aria-label="Add model"]')
      await fixture.type('[aria-label="Exact model ID 1"]', 'My-Exact-ID')
      await fixture.render(
        <ModelEditor {...props} view={catalogView({ revision: '2', supplement: [{ id: 'other' }] })} />,
      )
      expect((fixture.element('[aria-label="Exact model ID 1"]') as HTMLInputElement).value).toBe('My-Exact-ID')
      expect(fixture.element('.cxmc-conflict').textContent).toContain('other')
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(true)
      await fixture.click('.cxmc-conflict button')
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(false)
      await fixture.render(<ModelEditor {...props} view={catalogView({ revision: '3', scopeRevision: 'new-scope' })} />)
      expect((fixture.element('.cxmc-editor-actions button:last-child') as HTMLButtonElement).disabled).toBe(true)
      expect(saved).toBe(0)
    } finally {
      await fixture.dispose()
    }
  })

  it('preserves an exact capability declaration when the existing editor changes only the label', async () => {
    const fixture = reactManagerFixture()
    const { ModelEditor } = await import('../packages/cli/src/renderer/manager/pages/model-catalog/ModelEditor.js')
    const save = vi.fn(async () => ({ status: 'applied' as const }))
    try {
      await fixture.render(
        <ModelEditor
          view={catalogView({
            supplement: [{
              id: 'declared-model',
              label: 'Old label',
              protocolCapabilities: { responses: true },
            }],
          })}
          locale="en"
          mode="supplement"
          save={save}
          close={() => {}}
        />,
      )
      await fixture.type('[aria-label="Display name (optional) 1"]', 'Renamed')
      await fixture.click('.cxmc-editor-actions button:last-child')
      expect(save).toHaveBeenCalledWith([{
        id: 'declared-model',
        label: 'Renamed',
        protocolCapabilities: { responses: true },
      }], '1')
    } finally {
      await fixture.dispose()
    }
  })
})
