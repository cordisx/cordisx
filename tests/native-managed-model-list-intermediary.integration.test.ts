import { expect, it, vi } from 'vitest'
import { nativeManagedModelList } from '../packages/cli/src/launcher/native-managed-model-list.js'
import type { NativeModelProviderCatalogEntry } from '../packages/cli/src/launcher/native-model-provider-catalog.js'
import { harness } from './fixtures/native-intermediary-harness.js'
import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'

const provider: NativeModelProviderCatalogEntry = {
  providerId: 'plugin-a',
  pluginId: 'plugin',
  defaultModelId: 'model-a',
  models: [{
    id: 'model-a',
    label: 'Model A',
    aliases: [],
    reasoningCapabilities: { efforts: ['low', 'high'], defaultEffort: 'high' },
  }],
}

it('recovers the native missing-provider error only from the authenticated local Host catalog', async () => {
  const h = await harness(undefined, 'native-model-list-app-server.mjs')
  const lookup = vi.fn(nativeManagedModelList({
    owns: id => id === 'plugin-a' || id === 'native-success',
    catalog: async () => [provider],
  }))
  h.server.bindManagedModelList(lookup)
  try {
    h.send({
      id: 'managed-list',
      method: 'model/list',
      params: { modelProvider: 'plugin-a', limit: 100, includeHidden: true },
    })
    const managed = JSON.parse(await h.read())
    expect(managed).toMatchObject({
      id: 'managed-list',
      result: { data: [{ id: 'model-a', defaultReasoningEffort: 'high' }], nextCursor: null },
    })
    expect(managed.error).toBeUndefined()
    expect(lookup).toHaveBeenCalledWith({ providerId: 'plugin-a', limit: 100, includeHidden: true })

    for (
      const providerId of [
        'configured-other',
        'remote-other',
        'openai',
        'wrong-error-provider',
        'missing-error-data',
        'missing-error-provider',
        'network-error',
      ]
    ) {
      h.send({ id: providerId, method: 'model/list', params: { modelProvider: providerId, limit: 100 } })
      const response = JSON.parse(await h.read())
      expect(response.id).toBe(providerId)
      expect(response.error).toBeDefined()
    }
    expect(lookup.mock.calls.map(([input]) => input.providerId)).toEqual([
      'plugin-a',
      'configured-other',
      'remote-other',
    ])

    h.send({ id: 'native-success', method: 'model/list', params: { modelProvider: 'native-success' } })
    expect(JSON.parse(await h.read()).result.data).toEqual([{ id: 'native' }])
    h.send({ id: 'unscoped', method: 'model/list', params: {} })
    expect(JSON.parse(await h.read()).result.data).toEqual([{ id: 'native' }])
    expect(lookup).toHaveBeenCalledTimes(3)
  } finally {
    await h.close()
  }
})

it('correlates concurrent requests and rejects ambiguous duplicate IDs without replacing either failure', async () => {
  const h = await harness(undefined, 'native-model-list-app-server.mjs')
  const lookup = vi.fn(nativeManagedModelList({ owns: id => id === 'plugin-a', catalog: async () => [provider] }))
  h.server.bindManagedModelList(lookup)
  try {
    h.send({ id: 'a', method: 'model/list', params: { modelProvider: 'plugin-a', fixtureDelay: true } })
    h.send({ id: 'b', method: 'model/list', params: { modelProvider: 'other', fixtureDelay: true } })
    const [a, b] = [JSON.parse(await h.read()), JSON.parse(await h.read())]
    const result = new Map([a, b].map(value => [value.id, value]))
    expect(result.get('a').result.data[0].id).toBe('model-a')
    expect(result.get('b').error.data.modelProvider).toBe('other')

    h.send({ id: 'duplicate', method: 'model/list', params: { modelProvider: 'plugin-a', fixtureDelay: true } })
    h.send({ id: 'duplicate', method: 'model/list', params: { modelProvider: 'plugin-a', fixtureDelay: true } })
    const duplicateResponses = [JSON.parse(await h.read()), JSON.parse(await h.read())]
    expect(duplicateResponses.every(response => response.error?.data?.modelProvider === 'plugin-a')).toBe(true)
    expect(lookup.mock.calls.filter(([input]) => input.providerId === 'plugin-a')).toHaveLength(1)
  } finally {
    await h.close()
  }
})

it('preserves the native failure when the managed provider has no authoritative model metadata', async () => {
  const h = await harness(undefined, 'native-model-list-app-server.mjs')
  h.server.bindManagedModelList(nativeManagedModelList({
    owns: id => id === 'plugin-a',
    catalog: async () => [{ ...provider, models: [{ id: 'unknown', label: 'Unknown', aliases: [] }] }],
  }))
  try {
    h.send({ id: 7, method: 'model/list', params: { modelProvider: 'plugin-a' } })
    expect(JSON.parse(await h.read())).toEqual({
      id: 7,
      error: {
        code: -32600,
        message: 'provider not configured',
        data: { type: 'modelProviderNotConfigured', modelProvider: 'plugin-a' },
      },
    })
  } finally {
    await h.close()
  }
})

it('records only bounded native error categories for troubleshooting', async () => {
  const events: DiagnosticEvent[] = []
  await withDiagnostics({ emit: event => events.push(event) }, async () => {
    const h = await harness(undefined, 'native-model-list-app-server.mjs')
    try {
      h.send({ id: 'error', method: 'model/list', params: { modelProvider: 'plugin-a' } })
      expect(JSON.parse(await h.read()).error.data.type).toBe('modelProviderNotConfigured')
      await vi.waitFor(() =>
        expect(events).toContainEqual(expect.objectContaining({
          event: 'model-list-native-error',
          reason: 'provider-not-configured',
        }))
      )
      expect(JSON.stringify(events)).not.toContain('plugin-a')
      expect(JSON.stringify(events)).not.toContain('provider not configured')
    } finally {
      await h.close()
    }
  })
})
