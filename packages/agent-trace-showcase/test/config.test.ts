import { describe, expect, it } from 'vitest'
import { PluginConfigurationRegistry } from '../../cli/src/renderer/configuration.js'
import { Config, configApplies } from '../src/index.js'

const identity = Object.freeze({
  source: 'file:///agent-trace-showcase/dist/index.js',
  id: 'agent-trace-showcase',
  version: '0.1.0',
  generation: 'generation-config-1',
})

describe('Agent Trace plugin configuration', () => {
  it('exports one synchronous Schemastery schema with bounded product defaults', () => {
    expect(configApplies).toBe('restart')
    expect(Config['~standard'].validate({})).toEqual({
      value: { mode: 'live', historyPageSize: 100, timelineWindowSize: 500 },
    })
    expect(Config['~standard'].validate({
      mode: 'historical',
      historyPageSize: 250,
      timelineWindowSize: 350,
    })).toEqual({
      value: { mode: 'historical', historyPageSize: 250, timelineWindowSize: 350 },
    })
    expect(Config['~standard'].validate({ mode: 'unavailable' })).toMatchObject({ issues: expect.any(Array) })
    expect(Config['~standard'].validate({ historyPageSize: 501 })).toMatchObject({ issues: expect.any(Array) })
    expect(Config['~standard'].validate({ timelineWindowSize: 49 })).toMatchObject({ issues: expect.any(Array) })
  })

  it('projects localized Manager fields without identities, policy, paths, diagnostics, or secrets', () => {
    const registry = new PluginConfigurationRegistry()
    registry.register({ identity, schema: Config, applies: configApplies, raw: {}, revision: 0, writable: true })
    const descriptor = registry.descriptor(identity.id, 'zh-CN')

    expect(descriptor).toMatchObject({
      schemaKind: 'schemastery',
      applies: 'restart',
      revision: 0,
      value: {},
    })
    expect(descriptor.fields.map(field => ({
      path: field.path.join('.'),
      type: field.type,
      value: field.value,
      min: field.min,
      max: field.max,
      step: field.step,
      description: field.description,
      choices: field.choices,
      label: field.label,
    }))).toEqual([
      {
        path: 'mode',
        type: 'union',
        value: 'live',
        min: undefined,
        max: undefined,
        step: undefined,
        label: '数据模式',
        description: '选择实时公开账本、与实时观察合并的 Host 历史导入，或确定性的 fixture 数据。',
        choices: [
          { label: 'live', value: 'live' },
          { label: 'historical', value: 'historical' },
          { label: 'fixture', value: 'fixture' },
        ],
      },
      {
        path: 'historyPageSize',
        type: 'number',
        value: 100,
        min: 25,
        max: 500,
        step: 25,
        label: '历史分页大小',
        description: '每次通过 Host 受控接口读取的历史记录数；仅用于 historical 模式，最大 500。',
        choices: undefined,
      },
      {
        path: 'timelineWindowSize',
        type: 'number',
        value: 500,
        min: 50,
        max: 500,
        step: 50,
        label: '时间线窗口大小',
        description: '当前时间线保留的合并记录上限；Host 硬上限仍为 500。',
        choices: undefined,
      },
    ])
    const serialized = JSON.stringify(descriptor)
    expect(descriptor.secrets).toEqual([])
    for (
      const forbidden of [
        'sessionId',
        'providerId',
        'profileId',
        'permissionPolicy',
        'contractHead',
        'diagnostic',
        'CODEX_HOME',
        '.jsonl',
      ]
    ) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(registry.descriptor(identity.id, 'en').fields.map(field => field.description)).toEqual([
      'Choose live public ledger data, Host-imported history merged with live observations, or deterministic fixture data.',
      'Historical records requested per Host-brokered page. Applies only in historical mode; maximum 500.',
      'Maximum merged records retained in the current Timeline window. The Host ceiling remains 500.',
    ])
    expect(registry.descriptor(identity.id, 'en').fields.map(field => field.label)).toEqual([
      'Data mode',
      'History page size',
      'Timeline window size',
    ])
    registry.dispose()
  })
})
