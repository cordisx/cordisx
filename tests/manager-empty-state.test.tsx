import React, { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ModelServicesPage } from '../packages/cli/src/renderer/manager/pages/ModelServicesPage.js'
import { PluginsPage } from '../packages/cli/src/renderer/manager/pages/PluginsPage.js'
import { RoutesPage } from '../packages/cli/src/renderer/manager/pages/RoutesPage.js'
import { ExtensionPointsPage } from '../packages/cli/src/renderer/manager/pages/ExtensionPointsPage.js'
import { MarketplacePage } from '../packages/cli/src/renderer/manager/pages/MarketplacePage.js'
import { ModelProviderRegistry, type ModelProviderSnapshot } from '../packages/cli/src/renderer/model-providers.js'
import type { CatalogClientState } from '../packages/cli/src/renderer/model-catalog-client.js'
import type { MarketplaceModel, MarketplaceSnapshot } from '../packages/cli/src/renderer/marketplace.js'
import { managerModel, managerRouter, managerSnapshot, reactManagerFixture } from './helpers/react-manager.js'

const ready: CatalogClientState = {
  epoch: 'test',
  sequence: 1,
  views: [],
  connected: true,
  loading: false,
  canCreateConnection: true,
}
function registry(state: Partial<ModelProviderSnapshot> = {}, catalog: Partial<CatalogClientState> | false = {}) {
  const snapshot = { providers: [], entries: [], loading: false, ...state }
  const refresh = vi.fn(async () => {})
  const management = catalog === false ? undefined : {
    snapshot: () => ({ ...ready, ...catalog }),
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
  }
  const stable = management?.snapshot()
  if (management) management.snapshot = () => stable!
  return {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    refresh,
    management,
  } as unknown as ModelProviderRegistry
}

describe('Manager shared list states', () => {
  it.each(
    [
      ['empty', {}, {}, 'No model connections yet', true],
      ['loading', { loading: true }, {}, 'Loading model services…', false],
      ['loading', {}, { loading: true, connected: false, epoch: '' }, 'Loading model services…', false],
      ['error', { error: 'read failed' }, {}, 'Could not load model services', false],
      ['error', {}, { connected: false }, 'Could not load model services', false],
      ['unavailable', {}, false, 'Model connections are currently unavailable', false],
      ['empty', {}, { canCreateConnection: false }, 'No model connections yet', false],
    ] as const,
  )('distinguishes %s without exposing an unusable create action', async (kind, state, catalog, text, create) => {
    const fixture = reactManagerFixture()
    const onCreate = vi.fn()
    const source = registry(state, catalog)
    try {
      await fixture.render(<ModelServicesPage registry={source} locale="en" onCreate={onCreate} />)
      const status = fixture.element('[data-empty-state]')
      expect(status.dataset.emptyState).toBe(kind)
      expect(status.textContent).toContain(text)
      expect(status.querySelector('button')?.textContent === 'Add model connection').toBe(create)
      expect(fixture.document.querySelector('.cxr-empty')).toBeNull()
      expect(fixture.document.querySelector('input[type="search"]')).not.toBeNull()
      if (create) {
        await fixture.click('[data-empty-state] button')
        expect(onCreate).toHaveBeenCalledOnce()
      } else {
        expect(onCreate).not.toHaveBeenCalled()
      }
      if (kind === 'error') {
        expect(status.getAttribute('role')).toBe('alert')
        const before = vi.mocked(source.refresh).mock.calls.length
        await fixture.click('[data-empty-state] button')
        expect(source.refresh).toHaveBeenCalledTimes(before + 1)
      }
    } finally {
      await fixture.dispose()
    }
  })

  it('keeps the same hero from initial load through known-empty slow automatic/manual reads and exposes failures', async () => {
    const fixture = reactManagerFixture()
    let complete!: (value: []) => void
    let fail!: (error: Error) => void
    const source = new ModelProviderRegistry(() =>
      new Promise<[]>((resolve, reject) => {
        complete = resolve
        fail = reject
      })
    )
    const catalog = { snapshot: () => ready, subscribe: () => () => {}, refresh: async () => {}, dispose: () => {} }
    source.management = catalog as never
    try {
      await fixture.render(<ModelServicesPage registry={source} locale="en" onCreate={vi.fn()} />)
      const scene = fixture.element('.cxms-illustration svg')
      expect(fixture.element('[data-empty-state="loading"]').textContent).toContain('Loading model services…')
      expect(fixture.element('[data-empty-state="loading"]').querySelector('button')).toBeNull()
      await act(async () => complete([]))
      expect(fixture.element('.cxms-illustration svg')).toBe(scene)
      let pending!: Promise<void>
      await act(async () => {
        pending = source.refresh()
      })
      expect(fixture.element('[data-empty-state="empty"]').textContent).toContain('No model connections yet')
      expect(fixture.element('.cxms-illustration svg')).toBe(scene)
      expect(fixture.element('.cxmp-results').getAttribute('aria-busy')).toBe('true')
      expect((fixture.element('[data-empty-state="empty"] button') as HTMLButtonElement).disabled).toBe(true)
      await act(async () => {
        complete([])
        await pending
      })
      await fixture.click('[aria-label="Refresh"]')
      expect(fixture.element('.cxms-illustration svg')).toBe(scene)
      await act(async () => complete([]))
      await act(async () => {
        pending = source.refresh()
        fail(new Error('read'))
        await pending
      })
      expect(fixture.document.querySelector('.cxms-illustration')).toBeNull()
      expect(fixture.element('[data-empty-state="error"]').textContent).toContain('Could not load model services')
    } finally {
      source.dispose()
      await fixture.dispose()
    }
  })

  it('preserves known provider rows, query and focus during a slow background read', async () => {
    const fixture = reactManagerFixture()
    let complete!: (
      rows: { providerId: string; pluginId: string; title: string; models: { id: string; label: string }[] }[],
    ) => void
    const source = new ModelProviderRegistry(() =>
      new Promise(resolve => {
        complete = resolve
      })
    )
    source.management = {
      snapshot: () => ready,
      subscribe: () => () => {},
      refresh: async () => {},
      dispose: () => {},
    } as never
    const rows = [{
      providerId: 'a',
      pluginId: 'native',
      title: 'Provider A',
      models: [{ id: 'needle', label: 'Needle' }],
    }]
    try {
      await fixture.render(<ModelServicesPage registry={source} locale="en" />)
      await act(async () => complete(rows))
      await fixture.type('input[type="search"]', 'needle')
      const input = fixture.element('input[type="search"]') as HTMLInputElement
      input.focus()
      const provider = fixture.element('.cxms-provider')
      let pending!: Promise<void>
      await act(async () => {
        pending = source.refresh()
      })
      expect(fixture.element('.cxms-provider')).toBe(provider)
      expect(input.value).toBe('needle')
      expect(fixture.document.activeElement).toBe(input)
      expect(fixture.document.querySelector('[data-empty-state="loading"]')).toBeNull()
      expect(fixture.element('.cxmp-results').getAttribute('aria-busy')).toBe('true')
      await act(async () => {
        complete(rows)
        await pending
      })
      expect(fixture.element('.cxms-provider')).toBe(provider)
    } finally {
      source.dispose()
      await fixture.dispose()
    }
  })

  it('omits create without a navigation callback and clears an empty search back to the real empty state', async () => {
    const fixture = reactManagerFixture()
    try {
      await fixture.render(<ModelServicesPage registry={registry()} locale="zh-CN" />)
      expect(fixture.document.querySelector('[aria-label="添加模型连接"]')).toBeNull()
      expect(fixture.element('[data-empty-state]').textContent).toContain('还没有模型连接')
      await fixture.type('input[type="search"]', 'not-present')
      expect(fixture.element('[data-empty-state="search"]').textContent).toContain('没有匹配的模型')
      await fixture.click('[data-empty-state="search"] button')
      expect((fixture.element('input[type="search"]') as HTMLInputElement).value).toBe('')
      expect(fixture.element('[data-empty-state="empty"]').textContent).toContain('还没有模型连接')
    } finally {
      await fixture.dispose()
    }
  })

  it('clears model filters when a chosen state has no rows, retaining provider controls', async () => {
    const fixture = reactManagerFixture()
    const source = registry({
      providers: [{
        providerId: 'a',
        title: 'Provider A',
        icon: 'host:settings',
        models: [{ id: 'model', label: 'Model' }],
      }],
    })
    try {
      await fixture.render(<ModelServicesPage registry={source} locale="en" />)
      await fixture.click('[aria-label="Model visibility"]')
      await act(async () => {
        const items = [...fixture.document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
        items.find(e => e.textContent?.includes('Blocked'))!.click()
      })
      await act(async () => {
        const items = [...fixture.document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]
        items.find(e => e.textContent?.includes('Selectable'))!.click()
      })
      expect(fixture.element('[data-empty-state="search"]').textContent).toContain('No matching models')
      expect(fixture.document.querySelector('.cxms-provider')).not.toBeNull()
      await fixture.click('[data-empty-state="search"] button')
      expect(fixture.document.querySelector('[data-empty-state="search"]')).toBeNull()
      expect(fixture.element('.cxms-model-count').textContent).toBe('Models: 1')
    } finally {
      await fixture.dispose()
    }
  })

  it('shows unavailable Host without a fake retry or create action', async () => {
    const fixture = reactManagerFixture()
    try {
      await fixture.render(<ModelServicesPage registry={undefined} locale="en" onCreate={vi.fn()} />)
      expect(fixture.element('[data-empty-state="unavailable"]').querySelector('button')).toBeNull()
      expect(fixture.document.querySelector('[aria-label="Add model connection"]')).toBeNull()
    } finally {
      await fixture.dispose()
    }
  })

  it.each([RoutesPage, ExtensionPointsPage])('clears a no-match search for a read-only collection', async Page => {
    const fixture = reactManagerFixture()
    try {
      await fixture.render(<Page snapshot={managerSnapshot()} router={managerRouter()} />)
      expect(fixture.element('[data-empty-state="empty"]').querySelector('button')).toBeNull()
      await fixture.type('input[type="search"]', 'missing')
      await fixture.click('[data-empty-state="search"] button')
      expect((fixture.element('input[type="search"]') as HTMLInputElement).value).toBe('')
    } finally {
      await fixture.dispose()
    }
  })

  it('gives an installed-plugin empty list an existing Marketplace navigation action', async () => {
    const fixture = reactManagerFixture(), router = managerRouter(), snapshot = managerSnapshot()
    try {
      await fixture.render(<PluginsPage snapshot={snapshot} model={managerModel(snapshot)} router={router} />)
      await fixture.click('[data-empty-state] button')
      expect(router.navigate).toHaveBeenCalledWith({ kind: 'primary', page: 'marketplace' })
      await fixture.type('input[type="search"]', 'missing')
      await fixture.click('[data-empty-state="search"] button')
      expect((fixture.element('input[type="search"]') as HTMLInputElement).value).toBe('')
    } finally {
      await fixture.dispose()
    }
  })

  it.each(['loading', 'error', 'empty'] as const)(
    'distinguishes Marketplace %s and exposes only available recovery',
    async kind => {
      const fixture = reactManagerFixture(), router = managerRouter(), snapshot = managerSnapshot()
      const catalog: MarketplaceSnapshot = {
        sources: [],
        sourceRecords: [],
        sourceStates: kind === 'error'
          ? [{ url: 'https://example.test', status: 'failed', enabled: true, official: false, local: false }]
          : [],
        plugins: [],
        duplicates: [],
        loading: kind === 'loading',
        revalidating: false,
      }
      const marketplace = { snapshot: () => catalog, subscribe: () => () => {} } as unknown as MarketplaceModel
      try {
        await fixture.render(
          <MarketplacePage
            marketplace={marketplace}
            manager={managerModel(snapshot)}
            snapshot={snapshot}
            router={router}
          />,
        )
        const status = fixture.element('[data-empty-state]')
        expect(status.dataset.emptyState).toBe(kind)
        if (kind === 'loading') expect(status.querySelector('button')).toBeNull()
        else {
          await fixture.click('[data-empty-state] button')
          expect(router.navigate).toHaveBeenCalledWith({ kind: 'marketplace-sources' })
        }
        if (kind === 'empty') {
          await fixture.click('[aria-label="Official only"]')
          expect(fixture.element('[data-empty-state="search"]').textContent).toContain('No matching plugins')
          await fixture.click('[data-empty-state="search"] button')
          expect(fixture.element('[aria-label="Official only"]').getAttribute('aria-pressed')).toBe('false')
        }
      } finally {
        await fixture.dispose()
      }
    },
  )
})
