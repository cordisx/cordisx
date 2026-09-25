import { describe, expect, it } from 'vitest'
import { applyCatalogManagementPreferences } from '../packages/cli/src/renderer/model-provider-preferences.js'

describe('model provider preference projection', () => {
  it('preserves legacy providers without management and fails closed while an attached authority has no view', () => {
    const providers = [{ pluginId: 'plugin-a', providerId: 'provider-a', models: [{ id: 'model-a' }] }]
    expect(applyCatalogManagementPreferences(providers)).toBe(providers)
    expect(applyCatalogManagementPreferences(providers, { views: [] })).toEqual([{
      pluginId: 'plugin-a',
      providerId: 'provider-a',
      models: [],
    }])
    expect(applyCatalogManagementPreferences(providers, {
      connected: false,
      views: [{
        bindingRef: 'plugin:plugin-a:provider-a',
        providerId: 'provider-a',
        sourceKind: 'plugin',
        providerFavorite: false,
        rows: [{ id: 'model-a', present: true, compatibility: 'supported', selectable: true }],
      }],
    })).toEqual([{ pluginId: 'plugin-a', providerId: 'provider-a', models: [] }])
  })

  it('isolates equal model names by provider and never restores absent source members', () => {
    const providers = [
      { pluginId: 'cordisx.codex-config', providerId: 'shared', models: [{ id: 'same' }] },
      {
        pluginId: 'plugin-a',
        providerId: 'shared',
        managementBindingRef: 'plugin:plugin-a:shared',
        models: [{ id: 'same' }],
      },
      {
        pluginId: 'plugin-b',
        providerId: 'shared',
        managementBindingRef: 'plugin:plugin-b:shared',
        models: [{ id: 'same' }],
      },
    ]
    const projected = applyCatalogManagementPreferences(providers, {
      views: [
        {
          bindingRef: 'codex-config:shared',
          providerId: 'shared',
          sourceKind: 'native',
          providerFavorite: false,
          rows: [{ id: 'same', present: true, compatibility: 'supported', selectable: true }],
        },
        {
          bindingRef: 'plugin:plugin-a:shared',
          providerId: 'shared',
          sourceKind: 'plugin',
          providerFavorite: false,
          rows: [
            { id: 'same', present: true, compatibility: 'supported', selectable: true },
            { id: 'removed', present: false, compatibility: 'supported', selectable: true },
          ],
        },
      ],
    })
    expect(projected.find(item => item.pluginId === 'cordisx.codex-config')?.models).toEqual([{ id: 'same' }])
    expect(projected.find(item => item.pluginId === 'plugin-a')?.models).toEqual([{ id: 'same' }])
    expect(projected.find(item => item.pluginId === 'plugin-b')?.models).toEqual([])
    expect(projected.flatMap(item => item.models).some(model => model.id === 'removed')).toBe(false)
  })

  it('drops an unavailable default and keeps the Host preference order for allowed models', () => {
    expect(applyCatalogManagementPreferences([{
      pluginId: 'host',
      providerId: 'aiden',
      defaultModelId: 'disabled',
      models: [{ id: 'one' }, { id: 'disabled' }, { id: 'unknown' }, { id: 'unsupported' }, { id: 'two' }],
    }], {
      views: [{
        bindingRef: 'codex-config:aiden',
        providerId: 'aiden',
        sourceKind: 'native',
        providerFavorite: false,
        rows: [
          { id: 'two', present: true, compatibility: 'supported', selectable: true },
          { id: 'disabled', present: true, compatibility: 'supported', selectable: false },
          { id: 'unknown', present: true, compatibility: 'unknown', selectable: true },
          { id: 'unsupported', present: true, compatibility: 'unsupported', selectable: true },
          { id: 'one', present: true, compatibility: 'supported', selectable: true },
        ],
      }],
    })).toEqual([{
      pluginId: 'host',
      providerId: 'aiden',
      providerFavorite: false,
      models: [{ id: 'two' }, { id: 'one' }],
    }])
  })

  it('projects exact favorite metadata without changing canonical provider order', () => {
    const providers = [
      { pluginId: 'native', providerId: 'shared', models: [] },
      { pluginId: 'plugin-a', providerId: 'shared', managementBindingRef: 'plugin:a:shared', models: [] },
      { pluginId: 'plugin-b', providerId: 'shared', managementBindingRef: 'plugin:b:shared', models: [] },
    ]
    const views = [
      {
        bindingRef: 'codex-config:shared',
        providerId: 'shared',
        sourceKind: 'native' as const,
        providerFavorite: false,
        rows: [],
      },
      {
        bindingRef: 'plugin:a:shared',
        providerId: 'shared',
        sourceKind: 'plugin' as const,
        providerFavorite: false,
        rows: [],
      },
      {
        bindingRef: 'plugin:b:shared',
        providerId: 'shared',
        sourceKind: 'plugin' as const,
        providerFavorite: true,
        rows: [],
      },
    ]
    expect(
      applyCatalogManagementPreferences(providers, { views }).map(provider => [
        provider.pluginId,
        provider.providerFavorite,
      ]),
    ).toEqual([
      ['native', false],
      ['plugin-a', false],
      ['plugin-b', true],
    ])
  })
})
