import { chmod, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { describe, expect, it, vi } from 'vitest'
import {
  abortPluginConfigCandidate,
  commitPluginConfigCandidate,
  PluginConfigConflictError,
  stagePluginConfigCandidate,
} from '../packages/cli/src/config/plugin-config.js'
import {
  createDefaultHomeConfig,
  ensureHomeConfig,
  loadHomeConfig,
  updateHomeConfigAtomic,
} from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import {
  ConfigRendererRegistry,
  PluginConfigurationRegistry,
  moduleConfigApplies,
} from '../packages/cli/src/renderer/configuration.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

async function configFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-plugin-config-'))
  const home = path.join(root, '.cordisx')
  const configPath = path.join(home, 'config.json')
  await ensureHomeConfig(configPath)
  await chmod(home, 0o700)
  await updateHomeConfigAtomic(config => ({
    ...config,
    plugins: [{ id: 'example', entry: './example.ts', config: { timeout: 30 } }],
  }), configPath)
  return configPath
}

const scope = {
  profileId: 'work',
  pluginId: 'example',
  generation: 'generation-1',
  ownerToken: 'a'.repeat(64),
}

describe('plugin config persistence', () => {
  it('lazily migrates legacy config into a profile-scoped candidate and commits it as last-good', async () => {
    const configPath = await configFixture()
    const staged = await stagePluginConfigCandidate({
      ...scope,
      expectedRevision: 0,
      config: { timeout: 45 },
      now: new Date('2026-08-24T00:00:00.000Z'),
    }, configPath)
    expect(staged).toEqual({ candidateRevision: 1 })

    const stagedFile = await loadHomeConfig(configPath)
    const plugin = stagedFile.plugins[0]!
    expect(plugin.config).toEqual({ timeout: 30 })
    expect(plugin.profiles?.work).toEqual({
      revision: 0,
      config: { timeout: 30 },
      candidate: {
        revision: 1,
        config: { timeout: 45 },
        ownerToken: scope.ownerToken,
        generation: scope.generation,
        createdAt: '2026-08-24T00:00:00.000Z',
      },
    })
    expect((await loadConfig(configPath, { profileId: 'work' })).plugins[0]).toMatchObject({
      revision: 0,
      config: { timeout: 30 },
    })

    await commitPluginConfigCandidate({ ...scope, candidateRevision: 1 }, configPath)
    expect((await loadHomeConfig(configPath)).plugins[0]?.profiles?.work).toEqual({
      revision: 1,
      config: { timeout: 45 },
    })
    expect((await loadConfig(configPath, { profileId: 'work' })).plugins[0]).toMatchObject({
      revision: 1,
      config: { timeout: 45 },
    })
    expect((await loadConfig(configPath, { profileId: 'default' })).plugins[0]).toMatchObject({
      revision: 0,
      config: { timeout: 30 },
    })
  })

  it('rejects concurrent revisions and preserves last-good when a candidate is aborted', async () => {
    const configPath = await configFixture()
    const staged = await stagePluginConfigCandidate({ ...scope, expectedRevision: 0, config: { timeout: 60 } }, configPath)
    await expect(stagePluginConfigCandidate({ ...scope, expectedRevision: 0, config: { timeout: 90 } }, configPath))
      .rejects.toBeInstanceOf(PluginConfigConflictError)
    await expect(commitPluginConfigCandidate({
      ...scope,
      ownerToken: 'b'.repeat(64),
      candidateRevision: staged.candidateRevision,
    }, configPath)).rejects.toBeInstanceOf(PluginConfigConflictError)
    await abortPluginConfigCandidate({ ...scope, candidateRevision: staged.candidateRevision }, configPath)
    expect((await loadHomeConfig(configPath)).plugins[0]?.profiles?.work).toEqual({
      revision: 0,
      config: { timeout: 30 },
    })
  })

  it('keeps the version-1 default shape unchanged when no scoped write occurs', () => {
    expect(createDefaultHomeConfig().plugins).toEqual([])
  })
})

describe('plugin config registry', () => {
  it('normalizes the closed v1 restart spelling and preserves explicit v2 application planes', () => {
    expect(moduleConfigApplies(undefined)).toBe('plugin-restart')
    expect(moduleConfigApplies({ configApplies: 'restart' })).toBe('plugin-restart')
    expect(moduleConfigApplies({ configApplies: 'live' })).toBe('live')
    expect(moduleConfigApplies({ configApplies: 'plugin-restart' })).toBe('plugin-restart')
    expect(moduleConfigApplies({ configApplies: 'service-restart' })).toBe('service-restart')
    expect(moduleConfigApplies({ configApplies: 'app-restart' })).toBe('app-restart')
    expect(() => moduleConfigApplies({ configApplies: 'future' as never })).toThrow('must be live')
  })

  it('keeps an app-restart candidate out of the current settings snapshot until process restart', () => {
    const registry = new PluginConfigurationRegistry()
    registry.register({
      identity: { id: 'example', source: 'file:///example.ts' },
      applies: 'app-restart', raw: { label: 'active' }, revision: 3, writable: true,
    })
    const watcher = vi.fn()
    registry.watch('example', watcher)
    const first = registry.stage('example', 3, [{ op: 'set', path: ['label'], value: 'next' }])
    registry.commitForAppRestart('example', 4, first)
    expect(registry.get('example')).toEqual({ label: 'active' })
    expect(registry.descriptor('example', 'en')).toMatchObject({
      applies: 'app-restart', revision: 4, lastGoodRevision: 3, value: { label: 'next' },
    })
    expect(watcher).not.toHaveBeenCalled()

    const second = registry.stage('example', 4, [{ op: 'set', path: ['extra'], value: true }])
    registry.commitForAppRestart('example', 5, second)
    expect(registry.get('example')).toEqual({ label: 'active' })
    expect(registry.descriptor('example', 'en')).toMatchObject({
      revision: 5, lastGoodRevision: 3, value: { label: 'next', extra: true },
    })
    expect(watcher).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('keeps candidate configuration private and flips the Manager projection once', () => {
    const activation = (revision: number, moduleGeneration: string): CordisXPluginActivationRecordV1 => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      ...(revision === 1 ? {} : { transactionId: 'update-example' }),
      profileId: 'work', revision, lastGoodRevision: 1, runtimeGeneration: 'runtime-1',
      plugins: [{
        id: 'example', version: '1.0.0', digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`,
        moduleGeneration, enabled: true, dependencies: [],
      }],
    })
    const previous = activation(1, 'example-1')
    const candidate = activation(2, 'example-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const registry = new PluginConfigurationRegistry(visibility)
    registry.register({
      identity: { id: 'example', source: 'file:///old' }, moduleGeneration: 'example-1',
      applies: 'plugin-restart', raw: { value: 'old' }, revision: 1, writable: true,
    })
    let notifications = 0
    registry.subscribe(() => { notifications += 1 })
    const handle = visibility.begin('update-example', previous, candidate)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'example',
      [CORDISX_PLUGIN_GENERATION]: 'example-2',
      ...visibility.context(handle, 'example'),
    })
    const candidateView = visibility.view(candidateContext)
    registry.register({
      identity: { id: 'example', source: 'file:///new' }, moduleGeneration: 'example-2', candidateView,
      applies: 'plugin-restart', raw: { value: 'new' }, revision: 1, writable: true,
    })
    expect(registry.get('example')).toEqual({ value: 'old' })
    expect(registry.get('example', candidateView)).toEqual({ value: 'new' })
    expect(registry.descriptor('example', 'en').value).toEqual({ value: 'old' })
    expect(notifications).toBe(0)

    visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    expect(registry.get('example')).toEqual({ value: 'new' })
    expect(registry.descriptor('example', 'en').value).toEqual({ value: 'new' })
    expect(notifications).toBe(1)
    registry.unregister('example', 'example-1')
    expect(registry.get('example')).toEqual({ value: 'new' })
    registry.dispose()
  })

  it('uses Schemastery defaults and metadata, publishes live commits, and refuses secret paths', () => {
    const registry = new PluginConfigurationRegistry()
    const schema = Schema.object({
      timeout: Schema.number().default(30).min(1).max(120)
        .extra('extra', { label: { 'zh-CN': '请求超时', en: 'Request timeout' } })
        .description('Timeout'),
      apiKey: Schema.string().role('secret'),
      mode: Schema.union([Schema.const('safe'), Schema.const('fast')]).default('safe'),
    })
    registry.register({
      identity: { id: 'example', source: 'file:///example.ts' },
      schema,
      applies: 'live',
      raw: { apiKey: 'legacy-secret' },
      revision: 2,
      writable: true,
    })
    const descriptor = registry.descriptor('example', 'en')
    expect(descriptor.schemaKind).toBe('schemastery')
    expect(descriptor.fields.find(field => field.path.join('.') === 'timeout')?.label).toBe('Request timeout')
    expect(descriptor.value).toEqual({})
    expect(descriptor.fields.find(field => field.path.join('.') === 'timeout')).toMatchObject({
      value: 30, defaultValue: 30, hasDefault: true, min: 1, max: 120,
    })
    expect(descriptor.fields.find(field => field.path.join('.') === 'apiKey')).toMatchObject({ value: undefined, disabled: true })
    expect(descriptor.secrets).toEqual([{ path: ['apiKey'], set: false }])

    const listener = vi.fn()
    registry.watch('example', listener)
    const candidate = registry.stage('example', 2, [{ op: 'set', path: ['timeout'], value: 45 }])
    registry.begin('example', candidate)
    expect(registry.get('example')).toMatchObject({ timeout: 45, mode: 'safe' })
    registry.abort('example')
    expect(registry.get('example')).toMatchObject({ timeout: 30, mode: 'safe' })
    registry.commit('example', 3, candidate)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ timeout: 45 }))
    expect(() => registry.stage('example', 3, [{ op: 'set', path: ['apiKey'], value: 'nope' }]))
      .toThrow('secret-path')
    expect(() => registry.stage('example', 3, [{ op: 'set', path: ['timeout'], value: Number.NaN }]))
      .toThrow('non-finite')
  })

  it('projects only closed Host form groups, icons, bounded choices, and action hints', () => {
    const registry = new PluginConfigurationRegistry()
    const schema = Schema.object({
      reviewDate: Schema.string().default('2026-09-01').role('date').extra('extra', {
        label: { en: 'Review date' },
        cordisxForm: { icon: 'host:calendar', group: { id: 'schedule', title: { en: 'Schedule' }, icon: 'host:clock' } },
      }),
      audiences: Schema.array(Schema.union([Schema.const('design'), Schema.const('research')]))
        .default(['design']).min(1).max(2).role('multi-select'),
      tags: Schema.array(Schema.string().min(1).max(20)).default(['weekly']).max(4),
      ignored: Schema.string().extra('extra', { cordisxForm: { icon: 'host:remote-svg' } }),
      nested: Schema.object({
        leaf: Schema.string().default('value').extra('extra', { label: { en: 'Nested leaf' } }),
      }).extra('extra', { cordisxForm: { group: { id: 'not-inherited', title: { en: 'Not inherited' } } } }),
    }).extra('extra', { cordisxForm: { actions: { save: 'host:save', reset: 'host:reset' } } })
    registry.register({
      identity: { id: 'presentation', source: 'file:///presentation.ts' }, schema,
      applies: 'live', raw: {}, revision: 1, writable: true,
    })
    const descriptor = registry.descriptor('presentation', 'en')
    expect(descriptor.actionIcons).toEqual({ save: 'host:save', reset: 'host:reset' })
    expect(descriptor.fields.find(field => field.path[0] === 'reviewDate')).toMatchObject({
      icon: 'host:calendar', group: { id: 'schedule', title: 'Schedule', icon: 'host:clock' },
      hasDefault: true, defaultValue: '2026-09-01',
    })
    expect(descriptor.fields.find(field => field.path[0] === 'audiences')).toMatchObject({
      choices: [{ label: 'design', value: 'design' }, { label: 'research', value: 'research' }], min: 1, max: 2,
    })
    expect(descriptor.fields.find(field => field.path[0] === 'tags')).toMatchObject({ arrayItemType: 'string', max: 4 })
    expect(descriptor.fields.find(field => field.path[0] === 'ignored')?.icon).toBeUndefined()
    // Object recursion only determines a configuration path. It never guesses
    // a visual card from the object node: a leaf must carry explicit, closed
    // Host group metadata to join a section.
    expect(descriptor.fields.find(field => field.path.join('.') === 'nested.leaf')?.group).toBeUndefined()
    registry.dispose()
  })

  it('rejects asynchronous Standard Schema validators', () => {
    const registry = new PluginConfigurationRegistry()
    expect(() => registry.register({
      identity: { id: 'async', source: 'file:///async.ts' },
      schema: { '~standard': { version: 1, vendor: 'test', validate: async value => ({ value }) } },
      applies: 'plugin-restart',
      raw: {},
      revision: 0,
      writable: true,
    })).toThrow('must be synchronous')
  })

  it('fails closed on secret defaults and unresolved lazy Schemastery metadata', () => {
    const registry = new PluginConfigurationRegistry()
    expect(() => registry.register({
      identity: { id: 'secret-default', source: 'file:///secret.ts' },
      schema: Schema.object({ apiKey: Schema.string().default('leak').role('secret') }),
      applies: 'plugin-restart',
      raw: {},
      revision: 0,
      writable: true,
    })).toThrow('must not declare a JSON default')
    expect(() => registry.register({
      identity: { id: 'lazy', source: 'file:///lazy.ts' },
      schema: Schema.lazy(() => Schema.object({ value: Schema.string() })),
      applies: 'plugin-restart',
      raw: {},
      revision: 0,
      writable: true,
    })).toThrow('cannot prove secret positions')
  })
})

describe('custom config renderers', () => {
  it('selects exact path before role and disposes active mounts with the registration', async () => {
    const dom = new JSDOM('<!doctype html><div id="field"></div>')
    const container = dom.window.document.getElementById('field') as HTMLElement
    const registry = new ConfigRendererRegistry()
    const role = vi.fn(() => () => undefined)
    const cleanup = vi.fn()
    let aborted = false
    registry.register('example', { id: 'role', selector: { role: 'duration' } }, role)
    const unregister = registry.register('example', { id: 'path', selector: { path: ['timeout'] } }, (_container, field) => {
      field.signal.addEventListener('abort', () => { aborted = true })
      return cleanup
    })
    const mounted = await registry.mount('example', {
      namespace: 'example',
      path: ['timeout'],
      type: 'number',
      role: 'duration',
      value: 30,
      disabled: false,
      required: false,
    }, container, () => {})
    expect(mounted.mounted).toBe(true)
    expect(role).not.toHaveBeenCalled()
    unregister()
    expect(aborted).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await mounted.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('rejects sensitive roles and cross-owner namespaces', () => {
    const registry = new ConfigRendererRegistry()
    expect(() => registry.register('example', { id: 'secret', selector: { role: 'secret' } }, () => undefined))
      .toThrow('Host-reserved')
    expect(() => registry.register('example', { id: 'foreign', selector: { namespace: 'other' } }, () => undefined))
      .toThrow('outside owner')
  })

  it('falls back when a selected renderer throws', async () => {
    const dom = new JSDOM('<!doctype html><div id="field"></div>')
    const registry = new ConfigRendererRegistry()
    registry.register('example', { id: 'broken', selector: { path: ['timeout'] } }, () => {
      throw new Error('broken renderer')
    })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const mounted = await registry.mount('example', {
        namespace: 'example',
        path: ['timeout'],
        type: 'number',
        value: 30,
        disabled: false,
        required: false,
      }, dom.window.document.getElementById('field') as HTMLElement, () => {})
      expect(mounted.mounted).toBe(false)
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('example:broken failed'), expect.any(Error))
    } finally {
      diagnostic.mockRestore()
    }
  })
})
