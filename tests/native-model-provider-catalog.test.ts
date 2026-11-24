import { describe, expect, it, vi } from 'vitest'
import {
  combinedNativeModelProviderCatalog,
  nativeModelProviderCatalog,
} from '../packages/cli/src/launcher/native-model-provider-catalog.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'

function connection(providerId: string, dispose: () => void) {
  return {
    value: {
      service: { pluginId: `${providerId}-plugin`, serviceId: 'gateway', generation: 'one' },
      endpoint: {
        origin: 'http://127.0.0.1:43127',
        apiPath: '/v1' as const,
        auth: providerId === 'alpha'
          ? { scheme: 'none' as const }
          : { scheme: 'bearer' as const, token: 'never-project-this-token' },
      },
      models: {
        generation: 'catalog-one',
        defaultAlias: 'shared',
        aliases: [
          { alias: 'shared', gatewayModelId: 'shared-model' },
          { alias: 'shared-alias', gatewayModelId: 'shared-model' },
        ],
      },
      cleanup: { authorityId: `authority-${providerId}` },
    },
    dispose,
  }
}

describe('native model provider catalog projection', () => {
  it('keeps managed providers authoritative when configured ids overlap', async () => {
    const managed = [{
      providerId: 'aiden',
      pluginId: 'aiden-plugin',
      models: [{ id: 'managed-model', label: 'Managed model', aliases: [] }],
      defaultModelId: 'managed-model',
    }]
    const configured = [{
      providerId: 'aiden',
      pluginId: 'cordisx.codex-config',
      models: [{ id: 'configured-model', label: 'Configured model', aliases: [] }],
      defaultModelId: 'configured-model',
    }, {
      providerId: 'deepseek',
      pluginId: 'cordisx.codex-config',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', aliases: [] }],
      defaultModelId: 'deepseek-chat',
    }]

    await expect(combinedNativeModelProviderCatalog(async () => managed, async () => configured)()).resolves.toEqual([
      managed[0],
      configured[1],
    ])
  })

  it('projects only safe provider and model metadata and drains every snapshot session', async () => {
    const dispose = vi.fn()
    const activation = {
      nativeProviderIds: ['alpha', 'beta'],
      prepareNativeConnection(providerId: string) {
        return connection(providerId, dispose)
      },
    } as unknown as ManagedServiceNodeActivation

    const read = nativeModelProviderCatalog(activation)
    const first = await read()
    expect(first).toEqual([
      {
        providerId: 'alpha',
        pluginId: 'alpha-plugin',
        defaultModelId: 'shared-model',
        models: [{ id: 'shared-model', label: 'shared', aliases: ['shared', 'shared-alias'] }],
      },
      {
        providerId: 'beta',
        pluginId: 'beta-plugin',
        defaultModelId: 'shared-model',
        models: [{ id: 'shared-model', label: 'shared', aliases: ['shared', 'shared-alias'] }],
      },
    ])
    expect(JSON.stringify(first)).not.toMatch(/token|endpoint|authority|43127|generation/)
    expect(dispose).toHaveBeenCalledTimes(2)

    const second = await read()
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(dispose).toHaveBeenCalledTimes(4)
  })

  it('carries only declared reasoning metadata from managed routes into the safe selector catalog', async () => {
    const capabilities = { efforts: ['low', 'high'] as const, defaultEffort: 'high' as const }
    const dispose = vi.fn()
    const activation = {
      nativeProviderIds: ['gateway'],
      prepareNativeConnection() {
        const result = connection('gateway', dispose)
        return {
          ...result,
          value: {
            ...result.value,
            models: {
              ...result.value.models,
              aliases: [{ alias: 'shared', gatewayModelId: 'shared-model', reasoningCapabilities: capabilities }],
            },
          },
        }
      },
    } as unknown as ManagedServiceNodeActivation
    const [provider] = await nativeModelProviderCatalog(activation)()
    expect(provider?.models[0]?.reasoningCapabilities).toEqual(capabilities)
    expect(JSON.stringify(provider)).not.toMatch(/token|endpoint|authority/)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('projects conservative windows and reasoning per exact provider and model on every snapshot', async () => {
    const dispose = vi.fn()
    let secondWindow: number | undefined = 32_000
    const activation = {
      nativeProviderIds: ['alpha', 'beta'],
      prepareNativeConnection(providerId: string) {
        const result = connection(providerId, dispose)
        const aliases = providerId === 'alpha'
          ? [
            {
              alias: 'shared',
              gatewayModelId: 'shared-model',
              contextWindow: 64_000,
              reasoningCapabilities: { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
            },
            {
              alias: 'shared-alias',
              gatewayModelId: 'shared-model',
              ...(secondWindow === undefined ? {} : { contextWindow: secondWindow }),
              reasoningCapabilities: { efforts: ['medium', 'high'], defaultEffort: 'medium' },
            },
          ]
          : [{ alias: 'shared', gatewayModelId: 'shared-model', contextWindow: 100_000 }]
        return { ...result, value: { ...result.value, models: { ...result.value.models, aliases } } }
      },
    } as unknown as ManagedServiceNodeActivation
    const read = nativeModelProviderCatalog(activation)
    const first = await read()
    expect(first[0]?.models[0]).toMatchObject({
      contextWindow: 32_000,
      reasoningCapabilities: { efforts: ['medium', 'high'] },
    })
    expect(first[0]?.models[0]?.reasoningCapabilities).not.toHaveProperty('defaultEffort')
    expect(first[1]?.models[0]?.contextWindow).toBe(100_000)

    secondWindow = undefined
    const unknown = await read()
    expect(unknown[0]?.models[0]).not.toHaveProperty('contextWindow')
    expect(unknown[1]?.models[0]?.contextWindow).toBe(100_000)
    secondWindow = -1
    expect((await read())[0]?.models[0]).not.toHaveProperty('contextWindow')
    secondWindow = 16_000
    expect((await read())[0]?.models[0]?.contextWindow).toBe(16_000)
    expect(dispose).toHaveBeenCalledTimes(8)
  })

  it('keeps reasoning capabilities unknown if any alias is unknown', async () => {
    const result = connection('alpha', vi.fn())
    const aliases = [
      { alias: 'shared', gatewayModelId: 'shared-model', reasoningCapabilities: { efforts: ['high'] } },
      { alias: 'other', gatewayModelId: 'shared-model' },
    ]
    const activation = {
      nativeProviderIds: ['alpha'],
      prepareNativeConnection: () => ({
        ...result,
        value: { ...result.value, models: { ...result.value.models, aliases } },
      }),
    } as unknown as ManagedServiceNodeActivation
    expect((await nativeModelProviderCatalog(activation)())[0]?.models[0]).not.toHaveProperty(
      'reasoningCapabilities',
    )
  })

  it('omits unavailable or malformed providers without retaining their sessions', async () => {
    const dispose = vi.fn()
    const activation = {
      nativeProviderIds: ['unready', 'malformed', 'ready'],
      prepareNativeConnection(providerId: string) {
        if (providerId === 'unready') throw new Error('not ready')
        const result = connection(providerId, dispose)
        if (providerId === 'malformed') {
          return {
            ...result,
            value: {
              ...result.value,
              models: { ...result.value.models, defaultAlias: 'missing' },
            },
          }
        }
        return result
      },
    } as unknown as ManagedServiceNodeActivation

    expect((await nativeModelProviderCatalog(activation)()).map(item => item.providerId)).toEqual(['ready'])
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('projects only bounded provider/model brand keys and honors provider-local overrides', async () => {
    const dispose = vi.fn()
    const activation = {
      nativeProviderIds: ['gateway'],
      prepareNativeConnection() {
        const result = connection('gateway', dispose)
        return {
          ...result,
          value: {
            ...result.value,
            endpoint: { ...result.value.endpoint, origin: 'https://openrouter.ai', apiPath: '/api/v1' as const },
            models: {
              ...result.value.models,
              defaultAlias: 'claude',
              aliases: [{ alias: 'claude', gatewayModelId: 'anthropic/claude-sonnet-4' }],
            },
          },
        }
      },
    } as unknown as ManagedServiceNodeActivation

    const [provider] = await nativeModelProviderCatalog(activation, {
      providers: { gateway: 'generic' },
      models: { gateway: { 'anthropic/claude-sonnet-4': 'claude' } },
    })()
    expect(provider).toMatchObject({
      providerId: 'gateway',
      selectorBrand: { brand: 'generic', source: 'override' },
      models: [{ id: 'anthropic/claude-sonnet-4', selectorBrand: 'claude' }],
    })
    expect(JSON.stringify(provider)).not.toMatch(/openrouter|token|endpoint|authority/)
  })
})
