import Schema from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ManagerContentConfigCommandV1, ManagerContentConfigSourceV2 } from '@cordisx/protocol/manager-content-navigation/v5'
import { PluginConfigurationRegistry } from '../packages/cli/src/renderer/configuration.js'
import { ManagerContentConfigAuthority } from '../packages/cli/src/renderer/manager-content-config.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { ManagerContentNavigationRegistry } from '../packages/cli/src/renderer/navigation.js'
import {
  CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
} from '../packages/cli/src/contracts.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'

const COMMAND_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-command.v1.schema.json' as const
const PAGE_SCHEMA_V1 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-page.v1.schema.json' as const
const PAGE_SCHEMA_V2 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-subscription-page.v2.schema.json' as const

const presentation = {
  version: 2,
  fields: [{
    path: ['shortcutPolicy'],
    presenter: { version: 1, kind: 'choice.select' },
    choices: [
      { value: 'enter', label: { key: 'composer.shortcut.enter', fallback: 'Enter sends' } },
      { value: 'mod-enter', label: { key: 'composer.shortcut.mod-enter', fallback: 'Command/Ctrl+Enter sends' } },
    ],
  }],
} as const

function command(
  source: ManagerContentConfigSourceV2,
  id: string,
  revision: number,
  operation: Omit<ManagerContentConfigCommandV1, '$schema' | 'contract' | 'schemaVersion' | 'commandId' | 'binding' | 'expectedRevision'>,
): ManagerContentConfigCommandV1 {
  return {
    $schema: COMMAND_SCHEMA,
    contract: 'cordisx.manager-content-config-command/v1',
    schemaVersion: 1,
    commandId: id,
    binding: source.binding,
    expectedRevision: revision,
    ...operation,
  } as ManagerContentConfigCommandV1
}

function fixture(form: unknown = presentation, initial: unknown = { shortcutPolicy: 'enter' }) {
  const locale = { value: 'en' }
  const registry = new PluginConfigurationRegistry()
  registry.register({
    identity: { id: 'chatroom', source: 'file:///plugins/chatroom.ts' },
    moduleGeneration: 'chatroom-generation-1',
    schema: Schema.object({
      shortcutPolicy: Schema.union([Schema.const('enter'), Schema.const('mod-enter')]).default('enter'),
      title: Schema.string().default('Room'),
    }).extra('extra', { cordisxForm: form }),
    applies: 'live', raw: initial, revision: 0, writable: true,
  })
  const writes = vi.fn(async (owner: string, expectedRevision: number, operations: Parameters<PluginConfigurationRegistry['stage']>[2]) => {
    const candidate = registry.stage(owner, expectedRevision, operations)
    registry.commit(owner, expectedRevision + 1, candidate)
  })
  const translations: Record<string, Record<string, string>> = {
    en: {
      'composer.shortcut.enter': 'Enter sends',
      'composer.shortcut.mod-enter': 'Command/Ctrl+Enter sends',
    },
    'zh-CN': {
      'composer.shortcut.enter': 'Enter 发送',
      'composer.shortcut.mod-enter': 'Command/Ctrl+Enter 发送',
    },
  }
  const authority = new ManagerContentConfigAuthority({
    configuration: registry,
    profileId: 'default',
    runtimeGeneration: 'runtime-1',
    locale: () => locale.value,
    resolveText: (_owner, message) => translations[locale.value]?.[message.key] ?? message.fallback ?? message.key,
    update: writes,
  })
  const handle = authority.bind({
    owner: 'chatroom', declarationId: 'settings', moduleGeneration: 'chatroom-generation-1', contractVersion: 2,
    body: {
      kind: 'plugin-config-form', namespace: 'chatroom',
      defaultMaterialization: { mode: 'missing-only', fields: [{ path: ['shortcutPolicy'], value: 'enter' }] },
    },
  })
  return { authority, handle, locale, registry, source: handle.source as ManagerContentConfigSourceV2, writes }
}

describe('Manager content localized config choices', () => {
  it('negotiates navigation v5 into the Host v2 config source', async () => {
    const activation = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, schemaVersion: 1 as const, recordKind: 'active' as const,
      profileId: 'default', revision: 1, lastGoodRevision: 1, runtimeGeneration: 'runtime-1',
      plugins: [{ id: 'chatroom', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` as const, moduleGeneration: 'chatroom-generation-1', enabled: true, dependencies: [] }],
    }
    const visibility = new GenerationVisibilityCoordinator(activation)
    const { authority, registry } = fixture()
    const navigation = new ManagerContentNavigationRegistry(visibility)
    navigation.setConfigFactory(input => authority.bind(input))
    const context = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'chatroom',
      [CORDISX_PLUGIN_GENERATION]: 'chatroom-generation-1',
    })
    const unregister = navigation.register(context, {
      $schema: CORDISX_MANAGER_CONTENT_NAVIGATION_SCHEMA_V5,
      schemaVersion: 5,
      id: 'settings', route: { id: 'settings' }, header: { title: { kind: 'route' } },
      body: { kind: 'plugin-config-form', namespace: 'chatroom' },
    })
    const handle = navigation.resolve('chatroom', { id: 'settings' })?.config
    expect(handle?.contractVersion).toBe(2)
    await expect(handle?.source.snapshot()).resolves.toMatchObject({
      status: 'available', body: { configuration: { version: 3 } },
    })
    unregister()
    navigation.dispose(); authority.dispose(); registry.dispose()
  })

  it('negotiates descriptor v3/source v2 and resolves zh, en, and fallback labels without changing values', async () => {
    const { authority, handle, locale, source } = fixture()
    const snapshot = await source.snapshot()
    expect(snapshot).toMatchObject({
      status: 'available',
      body: {
        configuration: {
          version: 3,
          value: { shortcutPolicy: 'enter' },
          schema: { kind: 'schemastery', form: presentation },
        },
      },
    })
    expect(handle.snapshotForHost().fields.find(field => field.path[0] === 'shortcutPolicy')?.choices).toEqual([
      { value: 'enter', label: 'Enter sends' },
      { value: 'mod-enter', label: 'Command/Ctrl+Enter sends' },
    ])
    locale.value = 'zh-CN'
    expect(handle.snapshotForHost().fields.find(field => field.path[0] === 'shortcutPolicy')?.choices).toEqual([
      { value: 'enter', label: 'Enter 发送' },
      { value: 'mod-enter', label: 'Command/Ctrl+Enter 发送' },
    ])
    locale.value = 'fr'
    expect(handle.snapshotForHost().fields.find(field => field.path[0] === 'shortcutPolicy')?.choices?.[0]?.label).toBe('Enter sends')
    authority.dispose()
  })

  it('keeps exact choice values through save, reload, CAS, and subscription page v2', async () => {
    const { authority, registry, source, writes } = fixture()
    const subscribed = await source.subscribe(0)
    if (subscribed.status !== 'subscribed') throw new Error('localized config subscription unavailable')
    const page = subscribed.subscription.pages[Symbol.asyncIterator]().next()
    const saved = await source.execute(command(source, 'save-choice', 0, {
      operation: 'draft.save', mutationId: 'choice-mutation',
      operations: [{ op: 'set', path: ['shortcutPolicy'], value: 'mod-enter' }],
    }))
    expect(saved).toMatchObject({ status: 'applied', code: 'saved', revision: 1 })
    expect(writes).toHaveBeenCalledWith('chatroom', 0, [{ op: 'set', path: ['shortcutPolicy'], value: 'mod-enter' }])
    expect(registry.get('chatroom')).toEqual({ shortcutPolicy: 'mod-enter', title: 'Room' })
    expect(await source.snapshot()).toMatchObject({
      status: 'available', body: { configuration: { version: 3, revision: 1, value: { shortcutPolicy: 'mod-enter' } } },
    })
    await expect(page).resolves.toMatchObject({
      done: false,
      value: {
        $schema: PAGE_SCHEMA_V2,
        contract: 'cordisx.manager-content-config-subscription-page/v2', schemaVersion: 2,
        updates: [{ kind: 'snapshot-replaced', body: { configuration: { version: 3 } } }],
      },
    })
    const conflict = await source.execute(command(source, 'stale-choice', 0, {
      operation: 'draft.save', mutationId: 'stale-choice-mutation',
      operations: [{ op: 'set', path: ['shortcutPolicy'], value: 'enter' }],
    }))
    expect(conflict).toMatchObject({ status: 'conflict', code: 'revision-conflict', currentRevision: 1 })
    authority.dispose()
  })

  it.each([
    ['unknown version', { ...presentation, version: 3 }],
    ['unknown root field', { ...presentation, extra: true }],
    ['duplicate path', { ...presentation, fields: [presentation.fields[0], presentation.fields[0]] }],
    ['duplicate choice', { ...presentation, fields: [{ ...presentation.fields[0], choices: [presentation.fields[0].choices[0], presentation.fields[0].choices[0]] }] }],
    ['missing enum choice', { ...presentation, fields: [{ ...presentation.fields[0], choices: [presentation.fields[0].choices[0]] }] }],
    ['additional enum choice', { ...presentation, fields: [{ ...presentation.fields[0], choices: [...presentation.fields[0].choices, { value: 'future', label: { key: 'future', fallback: 'Future' } }] }] }],
    ['malformed localized label', { ...presentation, fields: [{ ...presentation.fields[0], choices: [{ value: 'enter', label: { key: 'bad key', fallback: 'Enter' } }, presentation.fields[0].choices[1]] }] }],
    ['unknown presenter option', { ...presentation, fields: [{ ...presentation.fields[0], presenter: { ...presentation.fields[0].presenter, future: true } }] }],
    ['non-scalar enum target', { ...presentation, fields: [{ path: ['title'], choices: presentation.fields[0].choices }] }],
  ])('fails closed for %s', (_name, malformed) => {
    expect(() => fixture(malformed)).toThrow(/manager config form/u)
  })

  it('preserves the predecessor v4 descriptor and subscription page versions', async () => {
    const registry = new PluginConfigurationRegistry()
    registry.register({
      identity: { id: 'chatroom', source: 'file:///plugins/chatroom.ts' }, moduleGeneration: 'chatroom-generation-1',
      schema: Schema.object({ shortcutPolicy: Schema.union([Schema.const('enter'), Schema.const('mod-enter')]) }),
      applies: 'live', raw: { shortcutPolicy: 'enter' }, revision: 0, writable: true,
    })
    const authority = new ManagerContentConfigAuthority({
      configuration: registry, profileId: 'default', runtimeGeneration: 'runtime-1', locale: () => 'en',
      update: async () => {},
    })
    const handle = authority.bind({
      owner: 'chatroom', declarationId: 'settings', moduleGeneration: 'chatroom-generation-1',
      body: { kind: 'plugin-config-form', namespace: 'chatroom' },
    })
    const snapshot = await handle.source.snapshot()
    expect(snapshot).toMatchObject({ status: 'available', body: { configuration: { version: 2 } } })
    const subscribed = await handle.source.subscribe(0)
    if (subscribed.status !== 'subscribed') throw new Error('predecessor config subscription unavailable')
    const page = subscribed.subscription.pages[Symbol.asyncIterator]().next()
    authority.dispose()
    await expect(page).resolves.toMatchObject({
      done: false,
      value: {
        $schema: PAGE_SCHEMA_V1,
        contract: 'cordisx.manager-content-config-subscription-page/v1', schemaVersion: 1,
        updates: [{ kind: 'disposed' }],
      },
    })
  })
})
