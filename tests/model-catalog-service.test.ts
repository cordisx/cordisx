import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CatalogBinding,
  CatalogError,
  catalogModels,
} from '../packages/cli/src/launcher/model-catalog/contracts.js'
import { DiscoveryAdapterRegistry } from '../packages/cli/src/launcher/model-catalog/registry.js'
import { ModelCatalogService } from '../packages/cli/src/launcher/model-catalog/service.js'

const binding: CatalogBinding = {
  bindingRef: 'profile/provider',
  scopeRevision: 'account-1',
  authorityRevision: 'source-1',
  strategy: { kind: 'native' },
}

describe('model catalog owner', () => {
  const services: ModelCatalogService[] = []
  afterEach(() => {
    services.splice(0).forEach(service => service.dispose())
    vi.useRealTimers()
  })
  const create = (read: () => Promise<ReturnType<typeof catalogModels>>) => {
    const connection = vi.fn(() => undefined)
    const service = new ModelCatalogService({ registry: new DiscoveryAdapterRegistry([]), connection, read })
    services.push(service)
    return { service, connection }
  }

  it('returns immediately, single-flights and atomically publishes complete empty', async () => {
    let resolve!: (models: ReturnType<typeof catalogModels>) => void
    const read = vi.fn(() =>
      new Promise<ReturnType<typeof catalogModels>>(done => {
        resolve = done
      })
    )
    const { service } = create(read)
    service.configure(binding)
    expect(service.snapshot(binding.bindingRef)?.loading).toBe(false)
    const first = service.refresh(binding.bindingRef)
    expect(service.refresh(binding.bindingRef)).toBe(first)
    await Promise.resolve()
    resolve(catalogModels([]))
    await first
    expect(read).toHaveBeenCalledTimes(1)
    expect(service.snapshot(binding.bindingRef)).toMatchObject({ complete: true, models: [], freshness: 'fresh' })
  })

  it('retains LKG on invalid input but not across scope changes', async () => {
    let invalid = false
    const { service } = create(async () => {
      if (invalid) throw new CatalogError('source-invalid')
      return catalogModels(['a', 'b'])
    })
    service.configure(binding)
    await service.refresh(binding.bindingRef)
    invalid = true
    await service.refresh(binding.bindingRef)
    expect(service.snapshot(binding.bindingRef)).toMatchObject({ freshness: 'stale', error: 'source-invalid' })
    expect(service.snapshot(binding.bindingRef)?.models).toHaveLength(2)
    service.configure({ ...binding, scopeRevision: 'account-2' })
    expect(service.snapshot(binding.bindingRef)?.models).toEqual([])
  })

  it('waits for durable complete-empty commit and discards publication after pause', async () => {
    let release!: () => void
    let current!: () => boolean
    const persistSource = vi.fn(async (_snapshot, valid) => {
      current = valid
      await new Promise<void>(resolve => {
        release = resolve
      })
    })
    const service = new ModelCatalogService({
      registry: new DiscoveryAdapterRegistry([]),
      connection: () => undefined,
      read: async () => [],
      persistSource,
    })
    services.push(service)
    service.configure(binding, {
      cached: {
        ...binding,
        revision: 1,
        complete: true,
        freshness: 'stale',
        loading: false,
        models: catalogModels(['old']),
      },
    })
    const job = service.refresh(binding.bindingRef)
    await vi.waitFor(() => expect(persistSource).toHaveBeenCalledOnce())
    expect(service.snapshot(binding.bindingRef)?.models.map(model => model.id)).toEqual(['old'])
    expect(persistSource.mock.calls[0]?.[0]).toMatchObject({ complete: true, models: [] })
    service.setPaused(binding.bindingRef, true)
    expect(current()).toBe(false)
    release()
    await job
    expect(service.snapshot(binding.bindingRef)?.models.map(model => model.id)).toEqual(['old'])
  })

  it('rejects late results after a manual replacement, without union or credential access', async () => {
    let resolve!: (models: ReturnType<typeof catalogModels>) => void
    const { service, connection } = create(() =>
      new Promise(done => {
        resolve = done
      })
    )
    service.configure(binding)
    const old = service.refresh(binding.bindingRef)
    await Promise.resolve()
    service.configure({ ...binding, strategy: { kind: 'manual', ids: ['manual'] } })
    await service.refresh(binding.bindingRef)
    resolve(catalogModels(['late']))
    await old
    expect(service.snapshot(binding.bindingRef)?.models.map(model => model.id)).toEqual(['manual'])
    expect(connection).not.toHaveBeenCalled()
  })

  it('removal cannot be resurrected by an in-flight result', async () => {
    let resolve!: (models: ReturnType<typeof catalogModels>) => void
    const { service } = create(() =>
      new Promise(done => {
        resolve = done
      })
    )
    service.configure(binding)
    const job = service.refresh(binding.bindingRef)
    await Promise.resolve()
    service.remove(binding.bindingRef)
    resolve(catalogModels(['late']))
    await job
    expect(service.snapshot(binding.bindingRef)).toBeUndefined()
  })

  it('schedules opted-in auto and reports unsupported without a private owner capability', async () => {
    vi.useFakeTimers()
    const { service, connection } = create(async () => [])
    service.configure({ ...binding, strategy: { kind: 'auto', adapter: 'detect', ttlMs: 60_000 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(connection).toHaveBeenCalledTimes(1)
    expect(service.snapshot(binding.bindingRef)?.error).toBe('unsupported')
  })

  it('does not start a second read from a reentrant subscriber', async () => {
    const read = vi.fn(async () => catalogModels(['one']))
    const { service } = create(read)
    service.configure(binding)
    const unsubscribe = service.subscribe(() => {
      if (service.snapshot(binding.bindingRef)?.loading) void service.refresh(binding.bindingRef)
    })
    await service.refresh(binding.bindingRef)
    unsubscribe()
    expect(read).toHaveBeenCalledOnce()
  })

  it('refreshes on TTL without deleting LKG and backs off temporary failures', async () => {
    vi.useFakeTimers()
    let failed = false
    const discover = vi.fn(async () => {
      if (failed) throw new CatalogError('temporary')
      return catalogModels(['one', 'two'])
    })
    const service = new ModelCatalogService({
      registry: new DiscoveryAdapterRegistry([{
        id: 'fixture',
        version: '1',
        pagination: 'none',
        matches: () => true,
        discover,
      }]),
      connection: () => ({
        endpoint: 'https://fixture.invalid',
        providerName: 'Fixture',
        scopeRevision: 'account-1',
        current: () => true,
        request: async () => Response.json({}),
      }),
      read: async () => [],
    })
    services.push(service)
    service.configure({ ...binding, strategy: { kind: 'auto', adapter: 'fixture', ttlMs: 60_000 } })
    await vi.advanceTimersByTimeAsync(0)
    failed = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(service.snapshot(binding.bindingRef)).toMatchObject({ freshness: 'stale', complete: true })
    expect(service.snapshot(binding.bindingRef)?.models).toHaveLength(2)
    await service.refresh(binding.bindingRef)
    expect(discover).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(discover).toHaveBeenCalledTimes(3)
  })
})
