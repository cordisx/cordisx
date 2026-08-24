import { describe, expect, it } from 'vitest'
import {
  Config as HelloToolbarConfig,
  configApplies as helloToolbarConfigApplies,
} from '../examples/plugins/hello-toolbar/index.js'
import {
  Config as SettingsTabDemoConfig,
  configApplies as settingsTabDemoConfigApplies,
} from '../examples/plugins/settings-tab-demo/index.js'
import {
  Config as SlotShowcaseConfig,
  configApplies as slotShowcaseConfigApplies,
} from '../examples/plugins/slot-showcase/index.js'
import type { CordisXStandardSchema } from '../packages/cli/src/contracts.js'
import { PluginConfigurationRegistry } from '../packages/cli/src/renderer/configuration.js'

function descriptor(
  id: string,
  schema: Schemastery,
  raw: unknown,
  locale: string,
) {
  const registry = new PluginConfigurationRegistry()
  registry.register({
    identity: { id, source: `file:///examples/plugins/${id}/index.ts` },
    schema: schema as unknown as CordisXStandardSchema,
    applies: 'restart',
    raw,
    revision: 0,
    writable: true,
  })
  return registry.descriptor(id, locale)
}

describe('UI demo Config Schemas', () => {
  it('projects the slot showcase session option with defaults, bounds, i18n, and restart application', () => {
    expect(slotShowcaseConfigApplies).toBe('restart')
    expect(SlotShowcaseConfig({})).toEqual({ sessionId: '' })
    expect(SlotShowcaseConfig({ sessionId: 'local:01a03050-bce7-7f03-99b0-a2110cac19c5' })).toEqual({
      sessionId: 'local:01a03050-bce7-7f03-99b0-a2110cac19c5',
    })
    expect(() => SlotShowcaseConfig({ sessionId: 'not a native id' })).toThrow()
    expect(() => SlotShowcaseConfig({ sessionId: 'x'.repeat(129) })).toThrow()

    const en = descriptor('slot-showcase', SlotShowcaseConfig, {}, 'en')
    const zh = descriptor('slot-showcase', SlotShowcaseConfig, {}, 'zh-CN')
    expect(en).toMatchObject({ schemaKind: 'schemastery', applies: 'restart' })
    expect(en.fields).toEqual([
      expect.objectContaining({
        path: ['sessionId'],
        label: 'Native session ID',
        description: 'Selected native session ID used by the optional session analytics action. Leave empty to hide it.',
        value: '',
        max: 128,
      }),
    ])
    expect(zh.fields[0]).toMatchObject({
      label: '原生会话 ID',
      description: '可选会话分析操作使用的当前原生会话 ID；留空时隐藏该操作。',
    })
  })

  it('projects the settings tab demo value with a real default, range, i18n, and restart application', () => {
    expect(settingsTabDemoConfigApplies).toBe('restart')
    expect(SettingsTabDemoConfig({})).toEqual({ demoValue: 'CordisX' })
    expect(SettingsTabDemoConfig({ demoValue: 'Configured demo' })).toEqual({ demoValue: 'Configured demo' })
    expect(() => SettingsTabDemoConfig({ demoValue: '' })).toThrow()
    expect(() => SettingsTabDemoConfig({ demoValue: '   ' })).toThrow()
    expect(() => SettingsTabDemoConfig({ demoValue: 'x'.repeat(65) })).toThrow()

    const en = descriptor('settings-tab-demo', SettingsTabDemoConfig, {}, 'en')
    const zh = descriptor('settings-tab-demo', SettingsTabDemoConfig, {}, 'zh-CN')
    expect(en).toMatchObject({ schemaKind: 'schemastery', applies: 'restart' })
    expect(en.fields).toEqual([
      expect.objectContaining({
        path: ['demoValue'],
        label: 'Demo value',
        description: 'Initial value shown inside the controlled settings page.',
        value: 'CordisX',
        min: 1,
        max: 64,
      }),
    ])
    expect(zh.fields[0]).toMatchObject({ label: '演示值', description: '受控设置页面内显示的初始值。' })
  })

  it('declares hello-toolbar as an explicit zero-field Schemastery configuration', () => {
    expect(helloToolbarConfigApplies).toBe('restart')
    expect(HelloToolbarConfig({})).toEqual({})
    const snapshot = descriptor('hello-toolbar', HelloToolbarConfig, {}, 'en')
    expect(snapshot).toMatchObject({ schemaKind: 'schemastery', applies: 'restart', fields: [] })
  })
})
