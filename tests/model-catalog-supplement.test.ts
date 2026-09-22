import { afterEach, describe, expect, it } from 'vitest'
import {
  type CatalogBinding,
  CatalogError,
  catalogModels,
} from '../packages/cli/src/launcher/model-catalog/contracts.js'
import { ModelCatalogService } from '../packages/cli/src/launcher/model-catalog/service.js'
import { DiscoveryAdapterRegistry } from '../packages/cli/src/launcher/model-catalog/registry.js'

describe('explicit same-scope supplements', () => {
  let service: ModelCatalogService
  let ids: string[] = []
  let failed = false
  const binding: CatalogBinding = {
    bindingRef: 'profile/provider',
    scopeRevision: 'account-1',
    authorityRevision: 'source-1',
    strategy: { kind: 'auto', mode: 'augment', adapter: 'fixture', ttlMs: 60_000 },
  }
  const setup = () => {
    failed = false
    service = new ModelCatalogService({
      registry: new DiscoveryAdapterRegistry([{
        id: 'fixture',
        version: '1',
        pagination: 'none',
        matches: () => true,
        discover: async () => {
          if (failed) throw new CatalogError('temporary')
          return catalogModels(ids)
        },
      }]),
      connection: () => ({
        endpoint: 'https://fixture.invalid',
        scopeRevision: 'account-1',
        current: () => true,
        request: async () => Response.json({}),
      }),
      read: async () => catalogModels(ids),
    })
    service.configure(binding)
  }
  const supplement = (models: unknown) =>
    service.setSupplement(binding.bindingRef, 'account-1', 'manual-1', {
      scopeRevision: 'account-1',
      authorityRevision: 'manual-1',
      models,
    })
  const models = () => service.snapshot(binding.bindingRef)!.models
  afterEach(() => service?.dispose())

  it('retains supplement through auto removal and complete-empty', async () => {
    ids = ['listed', 'both']
    setup()
    supplement([{ id: 'both', label: 'My label' }, { id: 'hidden' }])
    await service.refresh(binding.bindingRef)
    expect(models().find(model => model.id === 'both')).toMatchObject({
      provenance: ['auto', 'manual-supplement'],
      label: 'My label',
    })
    ids = []
    await service.refresh(binding.bindingRef)
    expect(models().map(model => model.id)).toEqual(['both', 'hidden'])
    expect(models().every(model => model.notListed && model.provenance?.join() === 'manual-supplement')).toBe(true)
    expect(service.snapshot(binding.bindingRef)?.complete).toBe(true)
  })

  it('deletes only the supplement declaration and deduplicates exact IDs', async () => {
    ids = ['same']
    setup()
    supplement([{ id: 'same' }, { id: 'same' }])
    await service.refresh(binding.bindingRef)
    expect(models()).toHaveLength(1)
    supplement([])
    expect(models()).toHaveLength(1)
    expect(models()[0]?.provenance).toEqual(['auto'])
  })

  it('retains independent LKG on invalid supplement and temporary auto failure', async () => {
    ids = ['listed']
    setup()
    supplement([{ id: 'hidden' }])
    await service.refresh(binding.bindingRef)
    supplement([{ id: 'bad', capabilities: { tools: true } }])
    failed = true
    await service.refresh(binding.bindingRef)
    expect(models().map(model => model.id)).toEqual(['hidden', 'listed'])
    expect(service.snapshot(binding.bindingRef)).toMatchObject({
      freshness: 'stale',
      supplementError: 'source-invalid',
    })
  })

  it('isolates supplements on account changes and rejects old-scope writes', () => {
    ids = []
    setup()
    supplement([{ id: 'hidden' }])
    service.configure({ ...binding, scopeRevision: 'account-2' })
    supplement([{ id: 'old' }])
    expect(models()).toEqual([])
  })

  it('supports native augmentation but never augments manual-replace or auto-only', async () => {
    ids = ['listed']
    setup()
    service.configure({ ...binding, strategy: { kind: 'native', mode: 'augment' } })
    supplement([{ id: 'hidden' }])
    await service.refresh(binding.bindingRef)
    expect(models().map(model => model.id)).toEqual(['hidden', 'listed'])
    service.configure({ ...binding, strategy: { kind: 'manual', ids: ['fixed'] } })
    supplement([{ id: 'hidden' }])
    await service.refresh(binding.bindingRef)
    expect(models().map(model => model.id)).toEqual(['fixed'])
    service.configure({ ...binding, strategy: { kind: 'auto', mode: 'only', adapter: 'fixture', ttlMs: 60_000 } })
    supplement([{ id: 'hidden' }])
    await service.refresh(binding.bindingRef)
    expect(models().map(model => model.id)).toEqual(['listed'])
  })
})
