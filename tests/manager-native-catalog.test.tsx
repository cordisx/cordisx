import React, { act } from 'react'
import { describe, expect, it } from 'vitest'
import { nativeModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'
import { reactManagerFixture } from './helpers/react-manager.js'

const providers = [{
  providerId: 'deepseek',
  pluginId: 'native',
  title: 'DeepSeek',
  selectorBrand: { brand: 'deepseek' as const, source: 'inferred' as const },
  models: [{ id: 'model-one', label: 'Model one' }, { id: 'model-two', label: 'Model two' }],
}]

describe('Manager native catalog coverage', () => {
  it('keeps native branding, search and disabled filter when management is absent', async () => {
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const registry = nativeModelProviderRegistry({ nativeProviders: async () => providers })
    try {
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      expect(fixture.element('.cxmp-management').dataset.catalogManagement).toBe('no-channel')
      expect(fixture.element('[aria-label="Model visibility"]').hasAttribute('disabled')).toBe(true)
      expect(fixture.element('[role="status"]').textContent).toBe('Model management unavailable')
      expect(fixture.element('[data-selector-brand="deepseek"]')).toBeDefined()
      await fixture.type('[aria-label="Search services or models"]', 'ＭＯＤＥＬ－ＯＮＥ')
      expect(fixture.document.querySelectorAll('.cxms-model-identity')).toHaveLength(1)
      expect(fixture.element('.cxms-model-identity').textContent).toContain('model-one')
      expect(fixture.document.querySelector('[aria-label="Pin model: model-one"]')).toBeNull()
      await fixture.render(<ModelServicesPage registry={registry} locale="zh-CN" />)
      expect(fixture.element('[role="status"]').textContent).toBe('模型管理暂不可用')
    } finally {
      registry.dispose()
      await fixture.dispose()
    }
  })

  it('distinguishes unbound and disconnected catalogs and consumes native-id bindings without duplicate rows', async () => {
    const fixture = reactManagerFixture()
    const { ModelServicesPage } = await import('../packages/cli/src/renderer/manager/pages/ModelServicesPage.js')
    const host = catalogFixture([])
    const previous = Reflect.get(globalThis, '__cordisxNativeProviderCommandChannel')
    let fail = false
    Reflect.set(globalThis, '__cordisxNativeProviderCommandChannel', {
      catalogRead: async () => providers,
      ...host.channel,
      catalogManagementRead: async () => {
        if (fail) throw new Error('fixture unavailable')
        return host.snapshot()
      },
    })
    const registry = nativeModelProviderRegistry()
    try {
      await registry.management!.refresh()
      await fixture.render(<ModelServicesPage registry={registry} locale="en" />)
      expect(fixture.element('.cxmp-management').dataset.catalogManagement).toBe('ready')
      expect(fixture.element('.cxms-provider').dataset.catalogBinding).toBe('unbound')
      expect(fixture.element('.cxmc-muted').textContent).toBe('Read only')
      await fixture.choose('input[aria-label="Model visibility"]', 'Blocked')
      expect(fixture.document.querySelector('.cxms-provider')).toBeNull()
      await fixture.choose('input[aria-label="Model visibility"]', 'All models')
      await act(async () => {
        host.publish({
          epoch: 'epoch-a',
          sequence: 2,
          views: [catalogView({
            providerId: 'deepseek',
            bindingRef: 'native-deepseek',
            title: 'DeepSeek',
            sourceKind: 'native',
            capabilities: ['refresh', 'setOverlay', 'resetOrder', 'restoreBlocked'],
            rows: providers[0]!.models.map(model => ({
              ...model,
              provenance: ['native'],
              notListed: false,
              present: true,
              selectable: true,
              blocked: false,
              pinned: false,
            })),
          })],
        })
        await registry.management!.refresh()
      })
      expect(fixture.document.querySelector('.cxms-provider')).toBeNull()
      expect(fixture.document.querySelectorAll('[data-binding-ref]')).toHaveLength(1)
      await fixture.click('[aria-label="Refresh models: DeepSeek"]')
      expect(host.commands[0]).toMatchObject({ operation: 'refresh', bindingRef: 'native-deepseek' })
      await fixture.click('[aria-label="Pin model: model-one"]')
      expect(host.commands[1]).toMatchObject({ operation: 'setOverlay', modelId: 'model-one', pinned: true })
      await act(async () => {
        fail = true
        await registry.management!.refresh()
      })
      expect(fixture.element('.cxmp-management').dataset.catalogManagement).toBe('disconnected')
      expect((fixture.element('[aria-label="Unpin model: model-one"]') as HTMLButtonElement).disabled).toBe(true)
    } finally {
      registry.dispose()
      host.client.dispose()
      if (previous === undefined) Reflect.deleteProperty(globalThis, '__cordisxNativeProviderCommandChannel')
      else Reflect.set(globalThis, '__cordisxNativeProviderCommandChannel', previous)
      await fixture.dispose()
    }
  })
})
