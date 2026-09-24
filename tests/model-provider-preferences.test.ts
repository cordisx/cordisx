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
        rows: [{ id: 'model-a', present: true, compatibility: 'supported', selectable: true }],
      }],
    })).toEqual([{ pluginId: 'plugin-a', providerId: 'provider-a', models: [] }])
  })

  it('isolates equal model names by provider and never restores absent source members', () => {
    const providers = [
      { pluginId: 'plugin-a', providerId: 'shared', models: [{ id: 'same' }] },
      { pluginId: 'plugin-b', providerId: 'shared', models: [{ id: 'same' }] },
    ]
    const projected = applyCatalogManagementPreferences(providers, {
      views: [
        {
          bindingRef: 'codex-config:shared',
          providerId: 'shared',
          sourceKind: 'native',
          rows: [{ id: 'same', present: true, compatibility: 'supported', selectable: true }],
        },
        {
          bindingRef: 'plugin:plugin-a:shared',
          providerId: 'shared',
          sourceKind: 'plugin',
          rows: [
            { id: 'same', present: true, compatibility: 'supported', selectable: false },
            { id: 'removed', present: false, compatibility: 'supported', selectable: true },
          ],
        },
      ],
    })
    expect(projected.find(item => item.pluginId === 'plugin-a')?.models).toEqual([])
    expect(projected.find(item => item.pluginId === 'plugin-b')?.models).toEqual([{ id: 'same' }])
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
      models: [{ id: 'two' }, { id: 'one' }],
    }])
  })
})
