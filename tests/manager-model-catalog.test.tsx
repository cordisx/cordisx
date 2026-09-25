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
          filters={new Set()}
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
      expect(fixture.document.querySelector('.cxmc-status')).toBeNull()
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

  it('disables empty disclosures without hiding managed actions and recovers when models arrive', async () => {
    const emptyView = catalogView({
      rows: [],
      sourceCount: 0,
      selectableCount: 0,
      outcome: 'empty',
    })
    const host = catalogFixture([emptyView])
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const registry = {
      management: host.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => ({ loading: false, entries: [], providers: [] }),
    } as unknown as ModelProviderRegistry
    try {
      await host.client.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      const toggle = fixture.element('.cxmc-binding-toggle') as HTMLButtonElement
      expect(toggle.disabled).toBe(true)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(fixture.element('.cxms-provider-identity').textContent).toContain('Provider A')
      expect(fixture.element('.cxms-model-count').textContent).toBe('No models')
      expect((fixture.element('.cxmc-models') as HTMLUListElement).hidden).toBe(true)

      await fixture.click('[aria-label="Diagnostics: Provider A"]')
      expect(fixture.element('.cxmc-diagnostics').textContent).toContain('Connection confirmed')
      await fixture.click('[aria-label="Refresh models: Provider A"]')
      expect(host.commands[0]).toMatchObject({ operation: 'refresh', bindingRef: 'binding-a' })

      const base = catalogView().rows[0]!
      await act(async () => {
        host.publish({
          ...host.snapshot(),
          sequence: 2,
          views: [catalogView({
            revision: '2',
            rows: [{ ...base, selectable: false }],
            sourceCount: 1,
            selectableCount: 0,
          })],
        })
        await host.client.refresh()
      })
      expect(toggle.disabled).toBe(true)
      expect(fixture.element('.cxms-model-count').textContent).toBe('No selectable models')

      await fixture.click('[aria-label="Model visibility"]')
      await act(async () => {
        ;[...fixture.document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
          .find(item => item.textContent?.includes('All models'))!.click()
      })
      expect(toggle.disabled).toBe(false)
      await fixture.click('.cxmc-binding-toggle')
      expect(fixture.document.querySelector('[data-model-id="Model-A"]')).not.toBeNull()

      await fixture.type('[aria-label="Search services or models"]', 'not-present')
      expect(toggle.disabled).toBe(true)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(fixture.element('.cxms-model-count').textContent).toBe('No matching models')
      expect(fixture.element('.cxms-provider-identity').textContent).toContain('Provider A')
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('favorites an empty provider only through the advertised Host preference capability', async () => {
    const view = catalogView({
      rows: [],
      sourceCount: 0,
      selectableCount: 0,
      outcome: 'empty',
      providerFavorite: false,
      preferenceCapabilities: ['setProviderFavorite'],
    } as never)
    const host = catalogFixture([view])
    const fixture = reactManagerFixture()
    const { CatalogBinding } = await import(
      '../packages/cli/src/renderer/manager/pages/model-catalog/CatalogBinding.js'
    )
    try {
      await fixture.render(
        <CatalogBinding
          view={view}
          client={host.client}
          locale="en"
          query=""
          filters={new Set(['selectable'])}
          connected
          expanded={false}
        />,
      )
      expect((fixture.element('.cxmc-binding-toggle') as HTMLButtonElement).disabled).toBe(true)
      const favorite = fixture.element('[aria-label="Favorite provider: Provider A"]') as HTMLButtonElement
      expect(favorite.getAttribute('aria-pressed')).toBe('false')
      await fixture.click('[aria-label="Favorite provider: Provider A"]')
      expect(host.commands[0]).toMatchObject({
        operation: 'setProviderFavorite',
        bindingRef: 'binding-a',
        scopeRevision: 'scope-1',
        expectedRevision: '1',
        favorite: true,
      })
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
    const render = (filters: ReadonlySet<'selectable' | 'blocked'>) =>
      fixture.render(
        <CatalogBinding
          view={view}
          client={host.client}
          locale="en"
          query=""
          filters={filters}
          connected
        />,
      )
    const visibleIds = () =>
      [...fixture.document.querySelectorAll('[data-model-id]')].map(row => row.getAttribute('data-model-id'))
    try {
      await render(new Set())
      expect(fixture.element('.cxms-model-count').textContent).toBe('Models: 3')
      expect(visibleIds()).toEqual(['supported-ready', 'supported-blocked', 'supported-offline'])

      await render(new Set(['blocked']))
      expect(visibleIds()).toEqual(['supported-blocked'])

      await render(new Set(['selectable']))
      expect(visibleIds()).toEqual(['supported-ready'])
    } finally {
      host.client.dispose()
      await fixture.dispose()
    }
  })

  it('keeps the icon filter menu open for OR selections and resets empty selection to all', async () => {
    const base = catalogView().rows[0]!
    const host = catalogFixture([catalogView({
      sourceCount: 3,
      selectableCount: 1,
      rows: [
        { ...base, id: 'ready', label: 'Ready' },
        { ...base, id: 'blocked', label: 'Blocked model', selectable: false, blocked: true },
        { ...base, id: 'removed', label: 'Removed model', present: false, selectable: false },
      ],
    })])
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const registry = {
      management: host.client,
      subscribe: () => () => {},
      refresh: async () => {},
      snapshot: () => ({ loading: false, entries: [], providers: [] }),
    } as unknown as ModelProviderRegistry
    const menuItem = (label: string) =>
      [...fixture.document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
        .find(item => item.textContent?.includes(label))!
    const visibleIds = () =>
      [...fixture.document.querySelectorAll('[data-model-id]')].map(row => row.getAttribute('data-model-id'))
    try {
      await host.client.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      const trigger = fixture.element('[aria-label="Model visibility"]') as HTMLButtonElement
      expect(visibleIds()).toEqual(['ready'])
      expect(fixture.document.querySelector('.cxmp-filter-indicator')).not.toBeNull()
      await fixture.click('[aria-label="Model visibility"]')
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(menuItem('Selectable').getAttribute('aria-checked')).toBe('true')

      await act(async () => menuItem('All models').click())
      expect(fixture.document.querySelector('.cxmp-filter-indicator')).toBeNull()
      await act(async () => menuItem('Blocked').click())
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(visibleIds()).toEqual(['blocked'])

      await act(async () => menuItem('Removed').click())
      expect(visibleIds()).toEqual(['blocked', 'removed'])

      await act(async () => menuItem('Blocked').click())
      await act(async () => menuItem('Removed').click())
      expect(visibleIds()).toEqual(['ready', 'blocked', 'removed'])

      await act(async () => {
        menuItem('All models').dispatchEvent(
          new fixture.dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
          }),
        )
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(trigger.getAttribute('aria-expanded')).toBe('false')
      expect(fixture.document.activeElement).toBe(trigger)

      await act(async () => {
        trigger.dispatchEvent(new fixture.dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
        await new Promise(resolve => setTimeout(resolve, 0))
      })
      expect(trigger.getAttribute('aria-expanded')).toBe('true')
      expect(fixture.document.activeElement?.textContent).toContain('Removed')
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
          filters={new Set()}
          connected
        />,
      )
      expect(fixture.document.querySelector('[aria-label="Refresh models: Provider A"]')).toBeNull()
      expect((fixture.element('[aria-label="Pin model: Model-A"]') as HTMLButtonElement).disabled).toBe(false)
      expect(fixture.document.querySelector('.cxmc-status')).toBeNull()
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
