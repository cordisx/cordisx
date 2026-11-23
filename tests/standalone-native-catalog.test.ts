import { afterEach, expect, it, vi } from 'vitest'
import { StandaloneNativeCatalog } from '../packages/cli/src/renderer/standalone-native-catalog.js'
import { createRuntimeModelProviders } from '../packages/cli/src/renderer/runtime-model-providers.js'
import { nativeModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import type { CordisXRuntimeMetadata } from '../packages/cli/src/renderer/runtime-shared.js'

afterEach(() => {
  globalThis.__cordisxNativeCatalogRequestV1 = undefined
  globalThis.__cordisxNativeCatalogReceiveV1 = undefined
  vi.useRealTimers()
})

it('reads the owner catalog and rejects an outstanding read when retired', async () => {
  const requests: Array<{ requestId: string; operation: string }> = []
  globalThis.__cordisxNativeCatalogRequestV1 = payload => {
    const request = JSON.parse(payload) as { requestId: string; operation: string }
    requests.push(request)
    if (requests.length === 1) {
      queueMicrotask(() =>
        globalThis.__cordisxNativeCatalogReceiveV1?.(JSON.stringify({
          requestId: request.requestId,
          ok: true,
          value: { status: 'ok', providers: [{ providerId: 'p', pluginId: 'config', models: [] }] },
        }))
      )
    }
  }
  const client = StandaloneNativeCatalog.connect()!
  expect(await client.nativeProviders()).toEqual([{ providerId: 'p', pluginId: 'config', models: [] }])
  const pending = client.nativeProviders()
  client.dispose()
  await expect(pending).rejects.toThrow('NATIVE_CATALOG_UNAVAILABLE')
  await expect(client.nativeProviders()).rejects.toThrow('NATIVE_CATALOG_UNAVAILABLE')
  expect(requests.map(request => request.operation)).toEqual(['read', 'read'])
  expect(globalThis.__cordisxNativeCatalogReceiveV1).toBeUndefined()
})

it('keeps managed providers and marks the configured catalog read-only', async () => {
  let model = 'first'
  const dispose = vi.fn()
  const managed = { nativeProviders: async () => [{ providerId: 'shared', pluginId: 'managed', models: [] }] }
  const standalone = {
    nativeProviders: async () => [
      { providerId: 'shared', pluginId: 'config', readOnly: true, models: [] },
      { providerId: 'local', pluginId: 'config', readOnly: true, models: [{ id: model, label: model }] },
    ],
    dispose,
  }
  const registry = nativeModelProviderRegistry(managed, standalone)
  try {
    await registry.refresh()
    expect(registry.snapshot().providers.map(item => item.providerId)).toEqual(['shared', 'local'])
    expect(registry.snapshot().providers[0]?.readOnly).toBeUndefined()
    expect(registry.snapshot().providers[1]).toMatchObject({ readOnly: true, models: [{ id: 'first' }] })
    model = 'second'
    await registry.refresh()
    expect(registry.snapshot().providers[1]?.models[0]?.id).toBe('second')
  } finally {
    registry.dispose()
  }
  expect(dispose).toHaveBeenCalledOnce()
})

it('connects the owner catalog to the standalone runtime without a native adapter', async () => {
  globalThis.__cordisxNativeCatalogRequestV1 = payload => {
    const request = JSON.parse(payload) as { requestId: string }
    queueMicrotask(() =>
      globalThis.__cordisxNativeCatalogReceiveV1?.(JSON.stringify({
        requestId: request.requestId,
        ok: true,
        value: {
          status: 'ok',
          providers: [{ providerId: 'local', pluginId: 'config', readOnly: true, models: [{ id: 'm', label: 'M' }] }],
        },
      }))
    )
  }
  const runtime = createRuntimeModelProviders({ hostKind: 'standalone' } as CordisXRuntimeMetadata, 'generation')
  try {
    await vi.waitFor(() =>
      expect(runtime.modelProviders.snapshot().providers[0]).toMatchObject({
        providerId: 'local',
        readOnly: true,
        models: [{ id: 'm' }],
      })
    )
  } finally {
    runtime.modelProviders.dispose()
    runtime.managedServiceBridge?.dispose()
  }
})

it('retains a healthy catalog when the other source fails and clears the error on recovery', async () => {
  let failed = true
  const managed = { nativeProviders: async () => [{ providerId: 'managed', pluginId: 'plugin', models: [] }] }
  const standalone = {
    nativeProviders: async () => {
      if (failed) throw new Error('temporarily unavailable')
      return [{ providerId: 'configured', pluginId: 'config', readOnly: true, models: [] }]
    },
    dispose: () => {},
  }
  const registry = nativeModelProviderRegistry(managed, standalone)
  try {
    await registry.refresh()
    expect(registry.snapshot().providers.map(provider => provider.providerId)).toEqual(['managed'])
    expect(registry.snapshot().error).toBe('provider-catalog-unavailable')
    failed = false
    await registry.refresh()
    expect(registry.snapshot().providers.map(provider => provider.providerId)).toEqual(['managed', 'configured'])
    expect(registry.snapshot().error).toBeUndefined()
  } finally {
    registry.dispose()
  }
})

it('keeps the configured catalog visible when the managed source is unavailable', async () => {
  const registry = nativeModelProviderRegistry(
    {
      nativeProviders: async () => {
        throw new Error('managed unavailable')
      },
    },
    {
      nativeProviders: async () => [{ providerId: 'configured', pluginId: 'config', readOnly: true, models: [] }],
      dispose: () => {},
    },
  )
  try {
    await registry.refresh()
    expect(registry.snapshot().providers.map(provider => provider.providerId)).toEqual(['configured'])
    expect(registry.snapshot().error).toBe('provider-catalog-unavailable')
  } finally {
    registry.dispose()
  }
})
