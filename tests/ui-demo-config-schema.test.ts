import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import {
  Config as FormSchemaGalleryConfig,
  configApplies as formSchemaGalleryConfigApplies,
} from '../examples/plugins/form-schema-gallery/index.js'
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
    applies: 'plugin-restart',
    raw,
    revision: 0,
    writable: true,
  })
  return registry.descriptor(id, locale)
}

describe('UI demo Config Schemas', () => {
  it('keeps the comprehensive ui-demos bundle free of first-level Settings navigation demos', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = JSON.parse(await readFile(path.join(projectRoot, 'cordisx.config.ui-demos.json'), 'utf8')) as {
      plugins?: readonly { id?: string }[]
    }
    expect(config.plugins?.some(plugin => plugin.id === 'settings-tab-demo')).toBe(false)
  })

  it('projects the slot showcase session option with defaults, bounds, i18n, and restart application', () => {
    expect(slotShowcaseConfigApplies).toBe('plugin-restart')
    expect(SlotShowcaseConfig({})).toEqual({ sessionId: '' })
    expect(SlotShowcaseConfig({ sessionId: 'local:01a03050-bce7-7f03-99b0-a2110cac19c5' })).toEqual({
      sessionId: 'local:01a03050-bce7-7f03-99b0-a2110cac19c5',
    })
    expect(() => SlotShowcaseConfig({ sessionId: 'not a native id' })).toThrow()
    expect(() => SlotShowcaseConfig({ sessionId: 'x'.repeat(129) })).toThrow()

    const en = descriptor('slot-showcase', SlotShowcaseConfig, {}, 'en')
    const zh = descriptor('slot-showcase', SlotShowcaseConfig, {}, 'zh-CN')
    expect(en).toMatchObject({ schemaKind: 'schemastery', applies: 'plugin-restart' })
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
    expect(settingsTabDemoConfigApplies).toBe('plugin-restart')
    expect(SettingsTabDemoConfig({})).toEqual({ demoValue: 'CordisX' })
    expect(SettingsTabDemoConfig({ demoValue: 'Configured demo' })).toEqual({ demoValue: 'Configured demo' })
    expect(() => SettingsTabDemoConfig({ demoValue: '' })).toThrow()
    expect(() => SettingsTabDemoConfig({ demoValue: '   ' })).toThrow()
    expect(() => SettingsTabDemoConfig({ demoValue: 'x'.repeat(65) })).toThrow()

    const en = descriptor('settings-tab-demo', SettingsTabDemoConfig, {}, 'en')
    const zh = descriptor('settings-tab-demo', SettingsTabDemoConfig, {}, 'zh-CN')
    expect(en).toMatchObject({ schemaKind: 'schemastery', applies: 'plugin-restart' })
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
    expect(helloToolbarConfigApplies).toBe('plugin-restart')
    expect(HelloToolbarConfig({})).toEqual({})
    const snapshot = descriptor('hello-toolbar', HelloToolbarConfig, {}, 'en')
    expect(snapshot).toMatchObject({ schemaKind: 'schemastery', applies: 'plugin-restart', fields: [] })
  })

  it('loads the form schema gallery only from ui-demos and projects the bounded Host primitives in English and Chinese', () => {
    expect(formSchemaGalleryConfigApplies).toBe('plugin-restart')
    const defaults = FormSchemaGalleryConfig({ workspaceName: 'Northstar workspace' })
    expect(defaults).toMatchObject({
      workspaceName: 'Northstar workspace',
      backgroundSync: true,
      releaseTrack: 'stable',
      approvalMode: 'manual',
      audienceTags: ['design', 'research'],
      notificationRules: [{ destination: 'Daily summary', enabled: true }],
      appearance: { density: 'comfortable', showActivity: true },
      referenceCode: 'DEMO-NORTHSTAR-01',
    })
    expect(() => FormSchemaGalleryConfig({ ...defaults, workspaceName: ' ' })).toThrow()
    expect(() => FormSchemaGalleryConfig({ ...defaults, maxParallelJobs: 17 })).toThrow()
    expect(() => FormSchemaGalleryConfig({ ...defaults, reviewThreshold: 0.45 })).toThrow()
    expect(() => FormSchemaGalleryConfig({ ...defaults, audienceTags: [] })).toThrow()

    const en = descriptor('form-schema-gallery', FormSchemaGalleryConfig, { workspaceName: 'Northstar workspace' }, 'en')
    const zh = descriptor('form-schema-gallery', FormSchemaGalleryConfig, { workspaceName: 'Northstar workspace' }, 'zh-CN')
    expect(en).toMatchObject({ schemaKind: 'schemastery', applies: 'plugin-restart', writable: true })
    const enField = (path: string) => en.fields.find(field => field.path.join('.') === path)
    expect(enField('workspaceName')).toMatchObject({ label: 'Workspace name', required: true, min: 3, max: 48 })
    expect(enField('welcomeNote')).toMatchObject({ label: 'Welcome note', role: 'multiline', type: 'string' })
    expect(enField('handoffNote')).toMatchObject({ label: 'Handoff note', role: 'multiline', value: undefined })
    expect(enField('documentationUrl')).toMatchObject({ label: 'Documentation URL', role: 'url' })
    expect(enField('exportDirectory')).toMatchObject({ label: 'Export folder', role: 'directory' })
    expect(enField('maxParallelJobs')).toMatchObject({ label: 'Parallel tasks', type: 'number', min: 1, max: 16, step: 1 })
    expect(enField('reviewThreshold')).toMatchObject({ label: 'Review threshold', min: 0.5, max: 1, step: 0.05 })
    expect(enField('showMemberAvatars')).toMatchObject({ label: 'Show member avatars', type: 'boolean' })
    expect(enField('backgroundSync')).toMatchObject({ label: 'Background sync', role: 'switch' })
    expect(enField('releaseTrack')).toMatchObject({ label: 'Release track', choices: [{ label: 'stable', value: 'stable' }, { label: 'preview', value: 'preview' }, { label: 'early-access', value: 'early-access' }] })
    expect(enField('approvalMode')).toMatchObject({ label: 'Approval mode', role: 'radio' })
    expect(enField('preferredReviewDate')).toMatchObject({ label: 'Preferred review date', role: 'date' })
    expect(enField('dailyQuietTime')).toMatchObject({ label: 'Daily quiet time', role: 'time' })
    expect(enField('accentColor')).toMatchObject({ label: 'Accent color', role: 'color' })
    expect(enField('audienceTags')).toMatchObject({ label: 'Audience tags', type: 'array', role: 'multi-select', min: 1, max: 5 })
    expect(enField('notificationRules')).toMatchObject({ label: 'Notification rules', type: 'array', min: 1, max: 4 })
    expect(enField('appearance.density')).toMatchObject({ label: 'Display density' })
    expect(enField('appearance.showActivity')).toMatchObject({ label: 'Show recent activity' })
    expect(enField('referenceCode')).toMatchObject({ label: 'Reference code', disabled: true })
    expect(zh.fields.find(field => field.path.join('.') === 'workspaceName')).toMatchObject({ label: '工作区名称' })
    expect(zh.fields.find(field => field.path.join('.') === 'notificationRules')).toMatchObject({ label: '通知规则' })
  })

  it('enables the gallery only through the opt-in ui-demos developer configuration', async () => {
    const config = JSON.parse(await readFile(new URL('../cordisx.config.ui-demos.json', import.meta.url), 'utf8')) as {
      plugins: readonly { id: string; entry: string; enabled: boolean }[]
    }
    const gallery = config.plugins.filter(plugin => plugin.id === 'form-schema-gallery')
    expect(gallery).toEqual([expect.objectContaining({
      entry: './examples/plugins/form-schema-gallery/index.ts', enabled: true,
    })])
  })
})
