import { describe, expect, it, vi } from 'vitest'
import {
  PluginPreferenceAuthority,
  pluginPreferenceBindingRef,
} from '../packages/cli/src/model-catalog/plugin-preference-authority.js'
import type { ManagementPreferenceData } from '../packages/cli/src/model-catalog/management-overlay.js'

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
