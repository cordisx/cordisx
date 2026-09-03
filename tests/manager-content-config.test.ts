import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import type {
  ManagerContentConfigCommandV1,
  ManagerContentConfigSourceV1,
} from '@cordisx/protocol/manager-content-navigation/v4'
import { PluginConfigurationRegistry } from '../packages/cli/src/renderer/configuration.js'
import { ManagerContentConfigAuthority } from '../packages/cli/src/renderer/manager-content-config.js'

const COMMAND_SCHEMA = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/manager-content-config-command.v1.schema.json' as const

function command(
  source: ManagerContentConfigSourceV1,
  id: string,
  revision: number,
  value: Omit<ManagerContentConfigCommandV1, '$schema' | 'contract' | 'schemaVersion' | 'commandId' | 'binding' | 'expectedRevision'>,
): ManagerContentConfigCommandV1 {
  return {
    $schema: COMMAND_SCHEMA,
    contract: 'cordisx.manager-content-config-command/v1',
    schemaVersion: 1,
    commandId: id,
    binding: source.binding,
    expectedRevision: revision,
    ...value,
  } as ManagerContentConfigCommandV1
}

function fixture(raw: unknown = {}) {
  const registry = new PluginConfigurationRegistry()
  registry.register({
    identity: { id: 'chatroom', source: 'file:///plugins/chatroom.ts' },
    moduleGeneration: 'chatroom-generation-1',
    schema: Schema.object({
      shortcutPolicy: Schema.union([Schema.const('enter'), Schema.const('mod-enter')]).default('enter'),
      label: Schema.string().default('Room'),
      secret: Schema.string().role('secret'),
    }),
    applies: 'live', raw, revision: 0, writable: true,
  })
  const writes = vi.fn(async (owner: string, expectedRevision: number, operations: Parameters<PluginConfigurationRegistry['stage']>[2]) => {
    const candidate = registry.stage(owner, expectedRevision, operations)
    registry.commit(owner, expectedRevision + 1, candidate)
  })
  const authority = new ManagerContentConfigAuthority({
    configuration: registry,
    profileId: 'default',
    runtimeGeneration: 'runtime-1',
    locale: () => 'en',
    update: writes,
  })
  const handle = authority.bind({
    owner: 'chatroom', declarationId: 'settings', moduleGeneration: 'chatroom-generation-1',
    body: {
      kind: 'plugin-config-form', namespace: 'chatroom',
      defaultMaterialization: { mode: 'missing-only', fields: [{ path: ['shortcutPolicy'], value: 'enter' }] },
    },
  })
  return { registry, writes, authority, handle, source: handle.source }
}

describe('Manager content Host config authority', () => {
  it('projects the exact owner scope and materializes only missing declared defaults through the same writer', async () => {
    const { registry, writes, authority, source } = fixture({ label: 'Existing' })
    const initial = await source.snapshot()
    expect(initial).toMatchObject({
      status: 'available',
      body: {
        sequence: 0,
        configuration: {
          identity: { source: 'file:///plugins/chatroom.ts', pluginId: 'chatroom' },
          scope: { profileId: 'default', generation: 'chatroom-generation-1' },
          namespace: 'chatroom', revision: 0, lastGoodRevision: 0,
          value: { shortcutPolicy: 'enter', label: 'Existing' },
        },
        draft: { baseRevision: 0, dirty: false, validation: { state: 'unvalidated' } },
      },
    })
    const subscribed = await source.subscribe(0)
    expect(subscribed.status).toBe('subscribed')
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    const nextPage = subscribed.subscription.pages[Symbol.asyncIterator]().next()
    const materialized = await source.execute(command(source, 'defaults-1', 0, {
      operation: 'defaults.materialize', materializationId: 'materialize-shortcut-v1',
    }))
    expect(materialized).toMatchObject({ status: 'applied', code: 'defaults-materialized', revision: 1, applies: 'live' })
    expect(writes).toHaveBeenCalledWith('chatroom', 0, [{ op: 'set', path: ['shortcutPolicy'], value: 'enter' }])
    expect(registry.descriptor('chatroom', 'en')).toMatchObject({ revision: 1, value: { label: 'Existing', shortcutPolicy: 'enter' } })
    await expect(nextPage).resolves.toMatchObject({
      done: false,
      value: { phase: 'live', subscription: { replayThrough: 0 }, updates: [{ kind: 'snapshot-replaced', sequence: 1 }] },
    })

    const preserved = await source.execute(command(source, 'defaults-2', 1, {
      operation: 'defaults.materialize', materializationId: 'materialize-shortcut-v2',
    }))
    expect(preserved).toMatchObject({ status: 'preserved', code: 'values-present', revision: 1 })
    expect(writes).toHaveBeenCalledTimes(1)
    authority.dispose()
  })

  it('validates drafts, saves with exact revision CAS, publishes reload, and rejects stale commands', async () => {
    const { registry, authority, source } = fixture({ shortcutPolicy: 'enter' })
    const publicWatch = vi.fn()
    registry.watch('chatroom', publicWatch)
    expect(registry.get('chatroom')).toMatchObject({ shortcutPolicy: 'enter' })
    const valid = await source.execute(command(source, 'validate-1', 0, {
      operation: 'draft.validate', operations: [{ op: 'set', path: ['shortcutPolicy'], value: 'mod-enter' }],
    }))
    expect(valid).toMatchObject({ status: 'validated', code: 'valid', revision: 0 })
    const invalid = await source.execute(command(source, 'validate-2', 0, {
      operation: 'draft.validate', operations: [{ op: 'set', path: ['shortcutPolicy'], value: 'future' }],
    }))
    expect(invalid).toMatchObject({ status: 'rejected', code: 'validation-failed', validation: { state: 'invalid' } })
    const saved = await source.execute(command(source, 'save-1', 0, {
      operation: 'draft.save', mutationId: 'shortcut-mutation-1',
      operations: [{ op: 'set', path: ['shortcutPolicy'], value: 'mod-enter' }],
    }))
    expect(saved).toMatchObject({ status: 'applied', code: 'saved', revision: 1 })
    expect(registry.get('chatroom')).toMatchObject({ shortcutPolicy: 'mod-enter' })
    expect(publicWatch).toHaveBeenCalledOnce()
    expect(publicWatch).toHaveBeenCalledWith(expect.objectContaining({ shortcutPolicy: 'mod-enter' }))
    const reloaded = await source.snapshot()
    expect(reloaded).toMatchObject({ status: 'available', body: { sequence: 1, configuration: { revision: 1, value: { shortcutPolicy: 'mod-enter' } } } })
    const conflict = await source.execute(command(source, 'save-stale', 0, {
      operation: 'draft.save', mutationId: 'shortcut-mutation-stale',
      operations: [{ op: 'set', path: ['shortcutPolicy'], value: 'enter' }],
    }))
    expect(conflict).toMatchObject({ status: 'conflict', code: 'revision-conflict', currentRevision: 1 })
    authority.dispose()
  })

  it('never overwrites an existing user value while materializing a missing-only default', async () => {
    const { registry, writes, authority, source } = fixture({ shortcutPolicy: 'mod-enter' })
    const result = await source.execute(command(source, 'defaults-preserve', 0, {
      operation: 'defaults.materialize', materializationId: 'materialize-shortcut-preserve',
    }))
    expect(result).toMatchObject({ status: 'preserved', code: 'values-present', revision: 0 })
    expect(writes).not.toHaveBeenCalled()
    expect(registry.get('chatroom')).toMatchObject({ shortcutPolicy: 'mod-enter' })
    authority.dispose()
  })

  it('fails closed for undeclared defaults, secret paths, command replay conflicts, and generation disposal', async () => {
    const { authority, handle, source } = fixture({ shortcutPolicy: 'enter' })
    const secret = await source.execute(command(source, 'secret-1', 0, {
      operation: 'draft.validate', operations: [{ op: 'set', path: ['secret'], value: 'nope' }],
    }))
    expect(secret).toMatchObject({ status: 'rejected', code: 'secret-path' })
    const first = await source.execute(command(source, 'same-command', 0, {
      operation: 'draft.validate', operations: [{ op: 'set', path: ['label'], value: 'One' }],
    }))
    expect(first.status).toBe('validated')
    const replayConflict = await source.execute(command(source, 'same-command', 0, {
      operation: 'draft.validate', operations: [{ op: 'set', path: ['label'], value: 'Two' }],
    }))
    expect(replayConflict).toMatchObject({ status: 'conflict', code: 'command-conflict' })
    const wrongSchema = await source.execute({
      ...command(source, 'wrong-schema', 0, {
        operation: 'draft.validate', operations: [{ op: 'set', path: ['label'], value: 'One' }],
      }),
      $schema: 'https://example.invalid/manager-config.schema.json',
    } as never)
    expect(wrongSchema).toMatchObject({ status: 'unavailable', code: 'binding-replaced' })

    const subscribed = await source.subscribe(0)
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    handle.close('generation-replaced')
    await expect(subscribed.subscription.closed).resolves.toMatchObject({ status: 'closed', code: 'generation-replaced' })
    await expect(subscribed.subscription.unsubscribe()).resolves.toMatchObject({ status: 'closed', code: 'generation-replaced' })
    await expect(source.snapshot()).resolves.toEqual({ status: 'unavailable', code: 'stale-generation' })
    authority.dispose()
  })

  it('rejects config declarations whose default differs from the Schemastery default', () => {
    const { authority } = fixture()
    expect(() => authority.bind({
      owner: 'chatroom', declarationId: 'bad', moduleGeneration: 'chatroom-generation-1',
      body: {
        kind: 'plugin-config-form', namespace: 'chatroom',
        defaultMaterialization: { mode: 'missing-only', fields: [{ path: ['shortcutPolicy'], value: 'mod-enter' }] },
      },
    })).toThrow('default-schema-mismatch')
    authority.dispose()
  })

  it('settles active subscriptions with owner-disposed when the Host authority is torn down', async () => {
    const { authority, source } = fixture({ shortcutPolicy: 'enter' })
    const subscribed = await source.subscribe(0)
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    authority.dispose()
    await expect(subscribed.subscription.closed).resolves.toMatchObject({ status: 'closed', code: 'owner-disposed' })
  })

  it('fails closed for owner, namespace, and generation mismatches', () => {
    const { authority } = fixture()
    expect(() => authority.bind({
      owner: 'other', declarationId: 'settings', moduleGeneration: 'chatroom-generation-1',
      body: { kind: 'plugin-config-form', namespace: 'other' },
    })).toThrow('not registered')
    expect(() => authority.bind({
      owner: 'chatroom', declarationId: 'settings', moduleGeneration: 'chatroom-generation-1',
      body: { kind: 'plugin-config-form', namespace: 'other' },
    })).toThrow('namespace')
    expect(() => authority.bind({
      owner: 'chatroom', declarationId: 'settings', moduleGeneration: 'chatroom-generation-2',
      body: { kind: 'plugin-config-form', namespace: 'chatroom' },
    })).toThrow('stale plugin generation')
    authority.dispose()
  })
})
