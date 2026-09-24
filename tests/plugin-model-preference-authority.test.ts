import { describe, expect, it, vi } from 'vitest'
import {
  type CatalogManagementAuthority,
  PluginPreferenceAuthority,
  pluginPreferenceBindingRef,
  PluginPreferenceManagementAdapter,
} from '../packages/cli/src/model-catalog/plugin-preference-authority.js'
import { pluginPreferenceSource } from '../packages/cli/src/launcher/model-catalog/plugin-preference-source.js'
import {
  ManagementOverlayStore,
  type ManagementPreferenceData,
  serializeManagementOverlayData,
} from '../packages/cli/src/model-catalog/management-overlay.js'

const provider = (pluginId: string, providerId: string, selectable = true) => ({
  pluginId,
  providerId,
  title: `${pluginId} ${providerId}`,
  models: [{ id: 'same-name', label: 'Same name', selectable }],
})

describe('plugin model preference authority', () => {
  it('encodes plugin and provider identity without delimiter collisions and preserves exact model IDs', async () => {
    const first = provider('a:b', 'c')
    const second = provider('a', 'b:c')
    expect(pluginPreferenceBindingRef(first)).not.toBe(pluginPreferenceBindingRef(second))
    expect(pluginPreferenceBindingRef(first)).toBe('plugin:a%3Ab:c')
    expect(pluginPreferenceBindingRef(second)).toBe('plugin:a:b%3Ac')

    const authority = await PluginPreferenceAuthority.open({
      load: async () => [first, second],
      persist: async () => {},
    })
    const view = authority.snapshot().views[0]!
    await authority.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
      pinned: true,
    }, () => true)
    expect(authority.snapshot().views.map(item => item.rows[0]?.blocked)).toEqual([true, false])
    expect(authority.preferences().bindings[0]?.entries[0]?.id).toBe('same-name')
  })

  it('survives reload and plugin re-registration while disabled models remain recoverable', async () => {
    let source = [provider('aiden', 'primary')]
    let durable: ManagementPreferenceData | undefined
    const open = () =>
      PluginPreferenceAuthority.open({
        load: async () => source,
        initial: durable,
        persist: async (next, expectedRevision) => {
          expect(durable?.revision ?? 0).toBe(expectedRevision)
          durable = next
        },
      })
    const first = await open()
    const original = first.snapshot().views[0]!
    await first.command({
      operation: 'setOverlay',
      bindingRef: original.bindingRef,
      scopeRevision: original.scopeRevision,
      expectedRevision: original.revision,
      modelId: 'same-name',
      blocked: true,
      pinned: true,
    }, () => true)
    expect(first.catalog()[0]?.models).toEqual([])
    first.close()

    source = [{
      ...provider('aiden', 'primary'),
      models: [{ id: 'new-model', label: 'New' }, { id: 'same-name', label: 'Renamed' }],
    }]
    const reloaded = await open()
    const current = reloaded.snapshot().views[0]!
    expect(current.scopeRevision).not.toBe(original.scopeRevision)
    expect(current.rows.find(row => row.id === 'same-name')).toMatchObject({
      id: 'same-name',
      compatibility: 'supported',
      blocked: true,
      pinned: true,
      selectable: false,
    })
    expect(current.preferenceCapabilities).toEqual(['setOverlay', 'resetOrder', 'restoreBlocked'])
    expect(current.sourceCapabilities).toEqual([])
    expect(
      (await reloaded.command({
        operation: 'setOverlay',
        bindingRef: current.bindingRef,
        scopeRevision: current.scopeRevision,
        expectedRevision: current.revision,
        modelId: 'same-name',
        blocked: false,
      }, () => true)).status,
    ).toBe('applied')
    expect(reloaded.catalog()[0]?.models[0]?.id).toBe('same-name')
  })

  it('cannot elevate source permission and never recreates removed members', async () => {
    let source = [provider('traex', 'work', false)]
    const persist = vi.fn(async () => {})
    const authority = await PluginPreferenceAuthority.open({ load: async () => source, persist })
    const view = authority.snapshot().views[0]!
    await authority.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => true)
    expect(authority.catalog()[0]?.models).toEqual([])

    source = []
    await authority.refresh()
    expect(authority.snapshot().views).toEqual([])
    expect(authority.catalog()).toEqual([])
    expect(authority.preferences().bindings[0]?.entries).toEqual([{ id: 'same-name', blocked: true }])
  })

  it('rejects the command result when authorization is revoked during persistence', async () => {
    let release!: () => void
    let authorized = true
    const authority = await PluginPreferenceAuthority.open({
      load: async () => [provider('aiden', 'primary')],
      persist: async (_next, _expectedRevision, stillAuthorized) =>
        new Promise<void>((resolve, reject) => {
          release = () => stillAuthorized() ? resolve() : reject(new Error('permission-revoked'))
        }),
    })
    const view = authority.snapshot().views[0]!
    const command = authority.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => authorized)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    authorized = false
    release()
    await expect(command).resolves.toEqual({ status: 'rejected', code: 'permission' })
    expect(authority.preferences().bindings).toEqual([])
  })

  it('rechecks live plugin source membership before persistence commits', async () => {
    let release!: () => void
    let current = true
    const authority = await PluginPreferenceAuthority.open({
      load: async () => [provider('aiden', 'primary')],
      sourceCurrent: () => current,
      persist: async (_next, _expectedRevision, authorized) =>
        new Promise<void>((resolve, reject) => {
          release = () => authorized() ? resolve() : reject(new Error('source-retired'))
        }),
    })
    const view = authority.snapshot().views[0]!
    const command = authority.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    current = false
    release()
    await expect(command).resolves.toEqual({ status: 'rejected', code: 'permission' })
    expect(authority.preferences().bindings).toEqual([])
  })

  it('retains last-known source and preferences across a transient source failure', async () => {
    let failing = false
    const authority = await PluginPreferenceAuthority.open({
      load: async () => {
        if (failing) throw new Error('temporary-source-failure')
        return [provider('aiden', 'primary')]
      },
      persist: async () => {},
    })
    const view = authority.snapshot().views[0]!
    await authority.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => true)

    failing = true
    await authority.refresh()
    expect(authority.snapshot().views[0]).toMatchObject({
      bindingRef: view.bindingRef,
      freshness: 'stale',
      outcome: 'error',
    })
    expect(authority.preferences().bindings[0]?.entries).toEqual([{ id: 'same-name', blocked: true }])

    failing = false
    await authority.refresh()
    expect(authority.snapshot().views[0]).toMatchObject({ freshness: 'fresh', outcome: 'ok' })
    expect(authority.catalog()[0]?.models).toEqual([])
  })

  it('keeps invalid subscription updates stale and recovers on the next valid source', async () => {
    let source = [provider('aiden', 'primary')]
    let notify!: () => void
    const authority = await PluginPreferenceAuthority.open({
      load: async () => source,
      persist: async () => {},
      subscribeSource: listener => {
        notify = listener
        return () => {}
      },
    })

    source = [provider('aiden', 'primary'), provider('aiden', 'primary')]
    notify()
    await vi.waitFor(() => expect(authority.snapshot().views[0]?.freshness).toBe('stale'))
    expect(authority.snapshot().views[0]).toMatchObject({ outcome: 'error', selectableCount: 0 })
    expect(authority.snapshot().views[0]?.rows[0]).toMatchObject({ id: 'same-name', selectable: false })

    source = [{
      ...provider('aiden', 'primary'),
      models: [{ id: 'new-model', label: 'New model' }],
    }]
    notify()
    await vi.waitFor(() => expect(authority.snapshot().views[0]?.freshness).toBe('fresh'))
    expect(authority.snapshot().views[0]?.rows.map(row => row.id)).toEqual(['new-model'])
  })

  it('replays a source invalidation received while a load is pending', async () => {
    let notify!: () => void
    let source = [provider('aiden', 'primary')]
    let release!: (value: typeof source) => void
    let calls = 0
    const authority = await PluginPreferenceAuthority.open({
      load: async () => {
        calls++
        if (calls === 2) {
          return new Promise<typeof source>(resolve => {
            release = resolve
          })
        }
        return source
      },
      persist: async () => {},
      subscribeSource: listener => {
        notify = listener
        return () => {}
      },
    })

    const pending = authority.refresh()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    source = [{ ...provider('aiden', 'primary'), models: [{ id: 'latest', label: 'Latest' }] }]
    notify()
    release([provider('aiden', 'primary')])
    await pending
    expect(calls).toBe(3)
    expect(authority.snapshot().views[0]?.rows.map(row => row.id)).toEqual(['latest'])
  })

  it('shares one section authority across native and plugin binding writes', async () => {
    let durable: ManagementPreferenceData | undefined
    const store = new ManagementOverlayStore(async (next, expectedRevision, authorized) => {
      expect(authorized()).toBe(true)
      expect(durable?.revision ?? 0).toBe(expectedRevision)
      durable = next
    })
    const authority = await PluginPreferenceAuthority.open({
      load: async () => [provider('aiden', 'primary')],
      overlayStore: store,
    })
    const nativeScope = { bindingRef: 'codex-config:native', scopeRevision: 'native-scope' }
    const nativePinned = await store.mutate({
      ...nativeScope,
      expectedRevision: '0',
      operation: 'setOverlay',
      modelId: 'native-model',
      pinned: true,
    }, ['native-model'])
    const plugin = authority.snapshot().views[0]!
    await authority.command({
      operation: 'setOverlay',
      bindingRef: plugin.bindingRef,
      scopeRevision: plugin.scopeRevision,
      expectedRevision: plugin.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => true)
    await store.mutate({
      ...nativeScope,
      expectedRevision: nativePinned.revision,
      operation: 'setOverlay',
      modelId: 'native-model',
      pinned: false,
    }, ['native-model'])
    const currentPlugin = authority.snapshot().views[0]!
    await authority.command({
      operation: 'restoreBlocked',
      bindingRef: currentPlugin.bindingRef,
      scopeRevision: currentPlugin.scopeRevision,
      expectedRevision: currentPlugin.revision,
    }, () => true)

    const reopened = new ManagementOverlayStore(async () => {}, JSON.parse(serializeManagementOverlayData(durable!)))
    expect(reopened.snapshot().bindings.map(binding => binding.bindingRef).sort()).toEqual([
      'codex-config:native',
      plugin.bindingRef,
    ].sort())
    expect(reopened.read(nativeScope.bindingRef, nativeScope.scopeRevision).entries).toEqual([])
    expect(reopened.read(plugin.bindingRef, plugin.scopeRevision).entries).toEqual([])
  })

  it('adapts the live managed-service catalog and composes its management channel', async () => {
    let notify!: () => void
    let active = true
    const activation = {
      nativeProviderIds: ['primary'],
      prepareNativeConnection: vi.fn(() => {
        if (!active) throw new Error('retired')
        return {
          value: {
            service: { pluginId: 'aiden', serviceId: 'gateway', generation: 'one' },
            endpoint: { origin: 'https://example.test', apiPath: '/v1', auth: { scheme: 'none' as const } },
            models: {
              generation: 'models-one',
              defaultAlias: 'same-name',
              aliases: [{ alias: 'same-name', gatewayModelId: 'same-name' }],
            },
            cleanup: { authorityId: 'one' },
          },
          dispose: vi.fn(),
        }
      }),
      subscribeNativeProviders: (listener: () => void) => {
        notify = listener
        return () => {}
      },
    }
    const source = pluginPreferenceSource(activation)
    const plugins = await PluginPreferenceAuthority.open({
      ...source,
      persist: async (_next, _expectedRevision, authorized) => {
        if (!authorized()) throw new Error('retired')
      },
    })
    const baseCommand = vi.fn(async () => ({ status: 'rejected' as const, code: 'unsupported' as const }))
    const base: CatalogManagementAuthority = {
      snapshot: () => ({
        epoch: 'base',
        sequence: 1,
        views: [],
        canCreateConnection: true,
      }),
      command: baseCommand,
      subscribe: () => () => {},
    }
    const management = new PluginPreferenceManagementAdapter(base, plugins)
    const view = plugins.snapshot().views[0]!
    expect(plugins.catalog()[0]).toMatchObject({
      pluginId: 'aiden',
      providerId: 'primary',
      managementBindingRef: view.bindingRef,
    })
    expect(plugins.catalog()[0]).not.toHaveProperty('sourceRevision')
    await expect(management.catalog()).resolves.toEqual(plugins.catalog())
    expect(management.snapshot()).toMatchObject({ canCreateConnection: true, views: [{ bindingRef: view.bindingRef }] })

    active = false
    notify()
    expect(plugins.snapshot().views[0]).toMatchObject({ freshness: 'stale', selectableCount: 0 })
    await expect(plugins.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => true)).resolves.toEqual({ status: 'rejected', code: 'permission' })

    await management.command({
      operation: 'createConnection',
      settings: {
        title: 'Base',
        endpoint: 'https://example.test/v1',
        protocol: 'responses',
        discoveryEnabled: false,
        strategy: { kind: 'manual', ids: ['same-name'] },
      },
    }, () => true)
    expect(baseCommand).toHaveBeenCalledOnce()
    management.close()
  })

  it('preserves explicit provider and model icon overrides through the production source adapter', async () => {
    const activation = {
      nativeProviderIds: ['primary'],
      prepareNativeConnection: () => ({
        value: {
          service: { pluginId: 'aiden', serviceId: 'gateway', generation: 'one' },
          endpoint: { origin: 'https://api.deepseek.com', apiPath: '/v1', auth: { scheme: 'none' as const } },
          models: {
            generation: 'models-one',
            defaultAlias: 'same-name',
            aliases: [{ alias: 'same-name', gatewayModelId: 'same-name' }],
          },
          cleanup: { authorityId: 'one' },
        },
        dispose() {},
      }),
      subscribeNativeProviders: () => () => {},
    }
    const plugins = await PluginPreferenceAuthority.open({
      ...pluginPreferenceSource(activation, {
        providers: { primary: 'generic' },
        models: { primary: { 'same-name': 'generic' } },
      }),
      persist: async () => {},
    })

    expect(plugins.catalog()[0]).toMatchObject({
      selectorBrand: { brand: 'generic', source: 'override' },
      models: [{ id: 'same-name', selectorBrand: 'generic' }],
    })
    plugins.close()
  })

  it('pulls same-generation model changes through each catalog read without a lifecycle event', async () => {
    let modelId = 'first'
    const activation = {
      nativeProviderIds: ['primary'],
      prepareNativeConnection: () => ({
        value: {
          service: { pluginId: 'aiden', serviceId: 'gateway', generation: 'same-generation' },
          endpoint: { origin: 'https://example.test', apiPath: '/v1', auth: { scheme: 'none' as const } },
          models: {
            generation: `models-${modelId}`,
            defaultAlias: modelId,
            aliases: [{ alias: modelId, gatewayModelId: modelId }],
          },
          cleanup: { authorityId: 'same-generation' },
        },
        dispose() {},
      }),
      subscribeNativeProviders: () => () => {},
    }
    const plugins = await PluginPreferenceAuthority.open({
      ...pluginPreferenceSource(activation),
      persist: async () => {},
    })
    const base: CatalogManagementAuthority = {
      snapshot: () => ({ epoch: 'base', sequence: 0, views: [] }),
      command: async () => ({ status: 'rejected', code: 'unsupported' }),
      subscribe: () => () => {},
    }
    const management = new PluginPreferenceManagementAdapter(base, plugins)
    const catalogChanged = vi.fn()
    const unsubscribeCatalog = management.catalogSubscribe(catalogChanged)
    await expect(management.catalog()).resolves.toMatchObject([{ models: [{ id: 'first' }] }])
    await expect(management.catalog()).resolves.toMatchObject([{ models: [{ id: 'first' }] }])
    expect(catalogChanged).not.toHaveBeenCalled()

    modelId = 'second'
    await expect(management.catalog()).resolves.toMatchObject([{ models: [{ id: 'second' }] }])
    expect(catalogChanged).toHaveBeenCalledOnce()
    await expect(management.catalog()).resolves.toMatchObject([{ models: [{ id: 'second' }] }])
    expect(catalogChanged).toHaveBeenCalledOnce()
    expect(plugins.snapshot().views[0]?.rows.map(row => row.id)).toEqual(['second'])
    unsubscribeCatalog()
    management.close()
  })

  it('retires an admitted command when the plugin generation changes without changing model IDs', async () => {
    let notify!: () => void
    let release!: () => void
    let generation = 'one'
    const activation = {
      nativeProviderIds: ['primary'],
      prepareNativeConnection: () => ({
        value: {
          service: { pluginId: 'aiden', serviceId: 'gateway', generation },
          endpoint: { origin: 'https://example.test', apiPath: '/v1', auth: { scheme: 'none' as const } },
          models: {
            generation,
            defaultAlias: 'same-name',
            aliases: [{ alias: 'same-name', gatewayModelId: 'same-name' }],
          },
          cleanup: { authorityId: generation },
        },
        dispose() {},
      }),
      subscribeNativeProviders: (listener: () => void) => {
        notify = listener
        return () => {}
      },
    }
    const plugins = await PluginPreferenceAuthority.open({
      ...pluginPreferenceSource(activation),
      persist: async (_next, _expectedRevision, authorized) =>
        new Promise<void>((resolve, reject) => {
          release = () => authorized() ? resolve() : reject(new Error('retired'))
        }),
    })
    const view = plugins.snapshot().views[0]!
    const command = plugins.command({
      operation: 'setOverlay',
      bindingRef: view.bindingRef,
      scopeRevision: view.scopeRevision,
      expectedRevision: view.revision,
      modelId: 'same-name',
      blocked: true,
    }, () => true)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    generation = 'two'
    notify()
    release()
    await expect(command).resolves.toEqual({ status: 'rejected', code: 'permission' })
    expect(plugins.preferences().bindings).toEqual([])
    await vi.waitFor(() => expect(plugins.snapshot().views[0]?.scopeRevision).not.toBe(view.scopeRevision))
    plugins.close()
  })

  it('rejects duplicate bindings and duplicate exact model IDs', async () => {
    await expect(PluginPreferenceAuthority.open({
      load: async () => [provider('aiden', 'main'), provider('aiden', 'main')],
      persist: async () => {},
    })).rejects.toMatchObject({ code: 'source-invalid' })
    await expect(PluginPreferenceAuthority.open({
      load: async () => [{
        ...provider('aiden', 'main'),
        models: [{ id: 'same-name', label: 'One' }, { id: 'same-name', label: 'Two' }],
      }],
      persist: async () => {},
    })).rejects.toMatchObject({ code: 'source-invalid' })
  })
})
