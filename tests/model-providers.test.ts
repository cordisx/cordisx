import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import {
  equivalentModel,
  ModelProviderRegistry,
  nativeModelProviderRegistry,
} from '../packages/cli/src/renderer/model-providers.js'
import { catalogFixture, catalogView } from './helpers/catalog-management-fixture.js'

const provider = { providerId: 'one', pluginId: 'plugin', models: [{ id: 'm', label: 'Model' }] }
const entry = {
  id: 'setup',
  label: 'Setup',
  icon: 'host:settings' as const,
  action: { label: 'Connect', icon: 'host:settings' as const, run: vi.fn() },
}

function activation(revision: number, generation: string): CordisXPluginActivationRecordV1 {
  const digestCharacter = revision === 1 ? 'a' : 'b'
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    ...(revision === 1 ? {} : { transactionId: 'replace-provider' }),
    profileId: 'default',
    revision,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'plugin',
      version: '1.0.0',
      digest: `sha256:${digestCharacter.repeat(64)}`,
      moduleGeneration: generation,
      enabled: true,
      dependencies: [],
    }],
  }
}

describe('model provider selector contract', () => {
  it('refreshes subscribed source snapshots and detaches on disposal', async () => {
    let listener: (() => void) | undefined
    let rows = [provider]
    const disconnect = vi.fn()
    const registry = new ModelProviderRegistry(async () => rows)
    registry.connectSource(callback => {
      listener = callback
      return disconnect
    })
    await registry.refresh()
    rows = [{ ...provider, models: [{ id: 'new', label: 'New' }] }]
    listener!()
    await vi.waitFor(() => expect(registry.snapshot().providers[0]?.models[0]?.id).toBe('new'))
    registry.dispose()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
  it('loads the launcher catalog instead of the managed bridge when the native channel is installed', async () => {
    const native = [{ ...provider, title: 'Configured provider' }]
    const managed = { nativeProviders: vi.fn(async () => [{ ...provider, title: 'Managed provider' }]) }
    const page = globalThis as typeof globalThis & {
      __cordisxNativeProviderCommandChannel?: { catalogRead(): Promise<typeof native> }
    }
    const previous = page.__cordisxNativeProviderCommandChannel
    page.__cordisxNativeProviderCommandChannel = { catalogRead: vi.fn(async () => native) }
    try {
      const registry = nativeModelProviderRegistry(managed)
      await registry.refresh()
      expect(registry.snapshot().providers[0]?.title).toBe('Configured provider')
      expect(managed.nativeProviders).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete page.__cordisxNativeProviderCommandChannel
      else page.__cordisxNativeProviderCommandChannel = previous
    }
  })

  it('projects Host-owned provider favorite metadata without changing provider order', async () => {
    const catalog = catalogFixture([catalogView({
      providerId: 'one',
      providerFavorite: true,
      sourceKind: 'native',
      rows: [{
        id: 'm',
        label: 'Model',
        provenance: ['native'],
        notListed: false,
        present: true,
        compatibility: 'supported',
        selectable: true,
        blocked: false,
        pinned: false,
      }],
    })])
    const registry = new ModelProviderRegistry(async () => [provider])
    registry.management = catalog.client
    await catalog.client.refresh()
    await registry.refresh()
    expect(registry.snapshot().providers).toEqual([expect.objectContaining({
      providerId: 'one',
      providerFavorite: true,
    })])
    registry.dispose()
  })

  it('matches actual IDs before explicit aliases, never labels or ambiguous aliases', () => {
    const current = { id: 'x', label: 'Identical label', aliases: ['portable'] }
    const exact = { id: 'x', label: 'Different' }
    expect(equivalentModel(current, [{ id: 'a', label: current.label }, exact])).toBe(exact)
    expect(equivalentModel(current, [{ id: 'a', label: current.label }])).toBeUndefined()
    expect(equivalentModel(current, [{ id: 'a', label: 'A', aliases: ['portable'] }])?.id).toBe('a')
    expect(equivalentModel(current, [
      { id: 'a', label: 'A', aliases: ['portable'] },
      { id: 'b', label: 'B', aliases: ['portable'] },
    ])).toBeUndefined()
  })

  it('matches provider-prefixed route aliases without changing the routed model ID', () => {
    const current = {
      id: 'traex/traex-gpt-5.6-sol',
      label: 'traex-gpt-5.6-sol',
      aliases: ['traex-gpt-5.6-sol'],
    }
    const target = {
      id: 'aiden/gpt-5.6-sol',
      label: 'gpt-5.6-sol',
      aliases: ['gpt-5.6-sol'],
    }
    expect(equivalentModel(current, [target])).toBe(target)
    expect(equivalentModel(target, [current])).toBe(current)
    expect(equivalentModel(current, [
      target,
      { id: 'aiden/duplicate', label: 'Duplicate', aliases: ['gpt-5.6-sol'] },
    ])).toBeUndefined()
    expect(target.id).toBe('aiden/gpt-5.6-sol')
  })

  it('keeps supplementary entries separate from host rows and binds presentation to owner', async () => {
    const registry = new ModelProviderRegistry(async () => [provider])
    const foreign = registry.bind('foreign', 'g', () => true)
    foreign.facade.present({ providerId: 'one', title: 'Spoofed', icon: 'host:settings' })
    const binding = registry.bind('plugin', 'g', () => true)
    binding.facade.present({ providerId: 'one', title: 'Actual', icon: 'host:settings' })
    const action = binding.facade.insert(entry)
    await registry.refresh()
    expect(registry.snapshot().providers[0]?.title).toBe('Actual')
    expect(registry.snapshot().entries).toHaveLength(1)
    action.dispose()
    expect(registry.snapshot().providers).toHaveLength(1)
    expect(registry.snapshot().entries).toHaveLength(0)
    binding.dispose()
    expect(registry.snapshot().providers[0]?.title).toBe('one')
    expect(() => binding.facade.insert(entry)).toThrow('unavailable')
  })

  it('applies user provider overrides before plugin presentation and plugin presentation before inference', async () => {
    const overridden = new ModelProviderRegistry(async () => [{
      ...provider,
      selectorBrand: { brand: 'generic', source: 'override' },
    }])
    overridden.bind('plugin', 'g', () => true).facade.present({
      providerId: 'one',
      title: 'Plugin',
      icon: 'host:bolt',
    })
    await overridden.refresh()
    expect(overridden.snapshot().providers[0]).toMatchObject({ selectorBrand: 'generic', icon: 'host:bolt' })

    const inferred = new ModelProviderRegistry(async () => [{
      ...provider,
      selectorBrand: { brand: 'deepseek', source: 'inferred' },
    }])
    inferred.bind('plugin', 'g', () => true).facade.present({
      providerId: 'one',
      title: 'Plugin',
      icon: 'host:bolt',
    })
    await inferred.refresh()
    expect(inferred.snapshot().providers[0]).not.toHaveProperty('selectorBrand')
    expect(inferred.snapshot().providers[0]?.icon).toBe('host:bolt')
  })

  it('aborts removed actions, detaches subscriptions and rejects late generation writes', async () => {
    const registry = new ModelProviderRegistry(async () => [])
    const binding = registry.bind('plugin', 'g', () => true)
    let signal: AbortSignal | undefined
    binding.facade.insert({
      ...entry,
      action: {
        ...entry.action,
        run: next => {
          signal = next
        },
      },
    })
    const current = registry.snapshot().entries[0]!.entry
    await current.action.run(new AbortController().signal)
    const listener = vi.fn()
    binding.facade.subscribe(listener)
    binding.dispose()
    expect(signal?.aborted).toBe(true)
    listener.mockClear()
    await registry.refresh()
    expect(listener).not.toHaveBeenCalled()
    await expect(current.action.run(new AbortController().signal)).rejects.toThrow('unavailable')
  })

  it('stages duplicate logical contributions and flips them with generation visibility', async () => {
    const previous = activation(1, 'g-1')
    const candidate = activation(2, 'g-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const registry = new ModelProviderRegistry(async () => [provider], visibility)
    const oldBinding = registry.bind('plugin', 'g-1', () => true)
    oldBinding.facade.present({ providerId: 'one', title: 'Old', icon: 'host:settings' })
    oldBinding.facade.insert({ ...entry, label: 'Old setup' })
    await registry.refresh()
    const oldAction = registry.snapshot().entries[0]!.entry.action
    const listener = vi.fn()
    registry.subscribe(listener)

    const handle = visibility.begin('replace-provider', previous, candidate)
    const newBinding = registry.bind('plugin', 'g-2', () => true)
    expect(() =>
      newBinding.facade.present({
        providerId: 'one',
        title: 'New',
        icon: 'host:settings',
      })
    ).not.toThrow()
    expect(() => newBinding.facade.insert({ ...entry, label: 'New setup' })).not.toThrow()
    expect(registry.snapshot().providers[0]?.title).toBe('Old')
    expect(registry.snapshot().entries[0]?.entry.label).toBe('Old setup')
    expect(listener).not.toHaveBeenCalled()

    const receipt = visibility.confirmReadiness(handle)
    const publication = visibility.publish(visibility.preparePublish(handle, receipt))
    expect(registry.snapshot().providers[0]?.title).toBe('New')
    expect(registry.snapshot().entries[0]?.entry.label).toBe('New setup')
    expect(listener).toHaveBeenCalledTimes(1)
    await expect(oldAction.run(new AbortController().signal)).rejects.toThrow('stale plugin generation handle')

    visibility.rollback(publication)
    expect(registry.snapshot().providers[0]?.title).toBe('Old')
    expect(registry.snapshot().entries[0]?.entry.label).toBe('Old setup')
    expect(listener).toHaveBeenCalledTimes(2)
    newBinding.dispose()
    expect(listener).toHaveBeenCalledTimes(2)
    oldBinding.dispose()
  })

  it('fences out-of-order refresh and clears stale availability on errors', async () => {
    let first!: (value: typeof provider[]) => void
    const load = vi.fn().mockImplementationOnce(() =>
      new Promise(resolve => {
        first = resolve
      })
    )
      .mockResolvedValueOnce([provider]).mockRejectedValueOnce(new Error('secret diagnostic'))
    const registry = new ModelProviderRegistry(load)
    const old = registry.refresh()
    await registry.refresh()
    first([])
    await old
    expect(registry.snapshot().providers).toHaveLength(1)
    await registry.refresh()
    expect(registry.snapshot()).toMatchObject({ providers: [], error: 'provider-catalog-unavailable' })
  })

  it('rejects duplicate entries and malformed icons', () => {
    const registry = new ModelProviderRegistry(async () => [])
    const binding = registry.bind('plugin', 'g', () => true)
    binding.facade.insert(entry)
    expect(() => binding.facade.insert(entry)).toThrow('Duplicate')
    expect(() => binding.facade.present({ providerId: 'p', title: 'P', icon: 'https://evil' as never })).toThrow()
  })

  it('decorates only owner-published model IDs and supports the native ID length', async () => {
    const longId = 'm'.repeat(400)
    const registry = new ModelProviderRegistry(async () => [{
      ...provider,
      defaultModelId: longId,
      models: [{ id: longId, label: 'Original', aliases: ['native-alias'] }],
    }])
    const binding = registry.bind('plugin', 'g', () => true)
    binding.facade.present({
      providerId: 'one',
      title: 'Owned',
      icon: 'host:settings',
      models: [
        { id: longId, label: 'Presented', group: 'Group', aliases: ['explicit-equivalent'] },
        { id: 'unpublished', label: 'Must not appear' },
      ],
    })
    await registry.refresh()
    expect(registry.snapshot().providers[0]?.models).toEqual([
      { id: longId, label: 'Presented', group: 'Group', aliases: ['explicit-equivalent'] },
    ])
  })
})
