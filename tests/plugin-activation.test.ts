import { chmod, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizePluginActivation,
  PluginActivationStore,
  pluginDependentClosure,
  topologicalPluginOrder,
  validatePluginActivationGraph,
} from '../packages/cli/src/launcher/plugin-activation.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationItemV1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async directory => {
    await chmod(directory, 0o700).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }))
  temporary.clear()
})

function plugin(
  id: string,
  dependencies: readonly { id: string; version: string }[] = [],
): CordisXPluginActivationItemV1 {
  return {
    id,
    version: '1.0.0',
    digest: `sha256:${id.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`,
    moduleGeneration: `${id}-1`,
    enabled: true,
    dependencies,
  }
}

function candidate(
  profileId: string,
  runtimeGeneration: string,
  transactionId: string,
  revision: number,
  plugins: readonly CordisXPluginActivationItemV1[],
): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'candidate',
    transactionId,
    profileId,
    revision,
    lastGoodRevision: revision - 1,
    runtimeGeneration,
    plugins,
  }
}

describe('plugin activation graph and persistence', () => {
  it('orders dependencies and computes only the target reverse-dependency closure', () => {
    const plugins = [
      plugin('base'),
      plugin('feature', [{ id: 'base', version: '1.0.0' }]),
      plugin('consumer', [{ id: 'feature', version: '1.0.0' }]),
      plugin('unrelated'),
    ]
    expect(topologicalPluginOrder(plugins)).toEqual(['base', 'feature', 'consumer', 'unrelated'])
    expect(pluginDependentClosure(plugins, 'feature')).toEqual(['feature', 'consumer'])
    expect(pluginDependentClosure(plugins, 'unrelated')).toEqual(['unrelated'])
  })

  it('rejects missing, incompatible, disabled, and cyclic dependency graphs', () => {
    expect(() => validatePluginActivationGraph([plugin('a', [{ id: 'missing', version: '1.0.0' }])])).toThrow('missing')
    expect(() =>
      validatePluginActivationGraph([
        { ...plugin('base'), version: '2.0.0' },
        plugin('a', [{ id: 'base', version: '1.0.0' }]),
      ])
    ).toThrow('found 2.0.0')
    expect(() =>
      validatePluginActivationGraph([
        { ...plugin('base'), enabled: false },
        plugin('a', [{ id: 'base', version: '1.0.0' }]),
      ])
    ).toThrow('depends on disabled')
    expect(() =>
      validatePluginActivationGraph([
        plugin('a', [{ id: 'b', version: '1.0.0' }]),
        plugin('b', [{ id: 'a', version: '1.0.0' }]),
      ])
    ).toThrow('cycle')
  })

  it('atomically commits one candidate and recovers interrupted candidates without changing active', async () => {
    const home = await mkdtemp(path.join(process.cwd(), '.plugin-activation-test-'))
    temporary.add(home)
    const store = new PluginActivationStore(home, 'work', 'runtime-1')
    expect(await store.loadActive()).toMatchObject({ revision: 0, plugins: [] })
    const first = candidate('work', 'runtime-1', 'candidate-1', 1, [plugin('base')])
    await store.writeCandidate(first)
    expect(await store.commitCandidate('candidate-1')).toMatchObject({
      recordKind: 'active',
      revision: 1,
      lastGoodRevision: 1,
    })

    const interrupted = candidate('work', 'runtime-1', 'candidate-2', 2, [plugin('base'), plugin('unrelated')])
    await store.writeCandidate(interrupted)
    expect(await store.recoverIncompleteCandidates()).toEqual(['candidate-2'])
    expect(await store.loadActive()).toMatchObject({ revision: 1, plugins: [{ id: 'base' }] })
    await expect(store.loadCandidate('candidate-2')).rejects.toThrow()
  })

  it('rejects future last-good and stale candidate scopes on readback', async () => {
    expect(() =>
      normalizePluginActivation({
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'active',
        profileId: 'work',
        revision: 1,
        lastGoodRevision: 2,
        runtimeGeneration: 'runtime-1',
        plugins: [],
      })
    ).toThrow('exceeds')

    const home = await mkdtemp(path.join(process.cwd(), '.plugin-activation-test-'))
    temporary.add(home)
    const store = new PluginActivationStore(home, 'work', 'runtime-1')
    await expect(store.writeCandidate(candidate('other', 'runtime-1', 'candidate-1', 1, []))).rejects.toThrow(
      'scope is stale',
    )
  })
})
