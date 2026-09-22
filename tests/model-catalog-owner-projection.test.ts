import { describe, expect, it, vi } from 'vitest'
import { createOwnerCatalogProjection } from '../packages/cli/src/launcher/model-catalog/owner-projection.js'
import { deepSeekDiscoveryAdapter } from '../packages/cli/src/launcher/model-catalog/deepseek.js'
import { DiscoveryAdapterRegistry } from '../packages/cli/src/launcher/model-catalog/registry.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { createDiscoveryRequestCapability } from '../packages/cli/src/launcher/model-catalog/request-capability.js'

describe('private owner discovery to safe renderer projection', () => {
  it('publishes exact-ID provenance without leaking owner endpoint or credential capability', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ object: 'list', data: [{ id: 'listed', object: 'model', owned_by: 'deepseek' }] })
    )
    const projection = createOwnerCatalogProjection(new DiscoveryAdapterRegistry([deepSeekDiscoveryAdapter()]))
    const renderer = new ModelProviderRegistry(async () => projection.catalog())
    renderer.connectSource(projection.subscribe)
    try {
      projection.update({
        binding: {
          bindingRef: 'target/provider',
          scopeRevision: 'account-1',
          authorityRevision: 'auto-1',
          strategy: { kind: 'auto', mode: 'augment', adapter: 'detect', ttlMs: 60_000 },
        },
        provider: {
          providerId: 'arbitrary-name',
          pluginId: 'host',
          selectorBrand: { brand: 'deepseek', source: 'inferred' },
        },
        connection: {
          endpoint: 'https://api.deepseek.com',
          scopeRevision: 'account-1',
          current: () => true,
          request: createDiscoveryRequestCapability({
            operation: { origin: 'https://api.deepseek.com', method: 'GET', path: '/models' },
            current: () => true,
            bearer: async () => 'private-fixture-key',
            fetcher,
          }),
        },
        read: async () => [],
      })
      projection.service.setSupplement('target/provider', 'account-1', 'manual-1', {
        scopeRevision: 'account-1',
        authorityRevision: 'manual-1',
        models: [{ id: 'not-listed' }],
      })
      await projection.service.refresh('target/provider')
      await renderer.refresh()
      expect(fetcher).toHaveBeenCalledOnce()
      const value = renderer.snapshot()
      expect(value.providers[0]?.models.map(model => model.id)).toEqual(['listed', 'not-listed'])
      expect(value.providers[0]?.models[1]).toMatchObject({ provenance: ['manual-supplement'], notListed: true })
      expect(value.providers[0]?.selectorBrand).toBe('deepseek')
      expect(JSON.stringify(value)).not.toMatch(/private-fixture-key|api\.deepseek\.com|bearer|account-1/)
    } finally {
      renderer.dispose()
      projection.dispose()
    }
  })
})
