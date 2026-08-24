import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
  type CordisXPluginModule,
  type CordisXPluginPackageManifestV1,
} from '../packages/cli/src/contracts.js'

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`
const source = (id: string, character: string): string => `file:///cordisx-store/sha256/${character.repeat(64)}/${id}.js`

function packageManifest(id: string): CordisXPluginPackageManifestV1 {
  return {
    $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
    schemaVersion: 1,
    id,
    version: '1.0.0',
    entry: './index.ts',
    compatibility: { runtimeAbi: 1, protocol: 1 },
    dependencies: id === 'generation-consumer' ? [{ id: 'generation-base', version: '1.0.0' }] : [],
    runtimeManifest: {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
      schemaVersion: 1,
      id,
      name: id,
      capabilities: [],
    },
  }
}

function activation(generation: string): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'active',
    profileId: 'work',
    revision: 1,
    lastGoodRevision: 1,
    runtimeGeneration: generation,
    plugins: [
      { id: 'generation-base', version: '1.0.0', digest: digest('a'), moduleGeneration: 'generation-base-a', enabled: true, dependencies: [] },
      { id: 'generation-consumer', version: '1.0.0', digest: digest('b'), moduleGeneration: 'generation-consumer-a', enabled: true, dependencies: [{ id: 'generation-base', version: '1.0.0' }] },
      { id: 'generation-unrelated', version: '1.0.0', digest: digest('c'), moduleGeneration: 'generation-unrelated-a', enabled: true, dependencies: [] },
    ],
  }
}

interface RuntimeHandle {
  snapshot(): { plugins: readonly { id: string; status: string }[]; registrations: readonly { owner: string }[]; navigation: { routes: readonly { owner: string }[]; pages: readonly { owner: string }[] } }
  stagePluginMutation(mutation: unknown, module?: CordisXPluginModule): Promise<void>
  commitPluginMutation(transactionId: string): Promise<void>
  abortPluginMutation(transactionId: string): Promise<void>
  reloadPluginGeneration(pluginId: string, moduleGeneration: string, runtimeGeneration: string): Promise<void>
  dispose(): Promise<void>
}

describe('renderer plugin generation transactions', () => {
  it('switches only the dependent closure, rolls back readiness failures, fences stale reloads, and cleans uninstall ownership', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const generation = 'runtime-generation-a'
    const active = activation(generation)
    const entries = new Map([
      ['generation-base', path.join(root, 'tests/fixtures/generation-base-plugin.ts')],
      ['generation-consumer', path.join(root, 'tests/fixtures/generation-consumer-plugin.ts')],
      ['generation-unrelated', path.join(root, 'tests/fixtures/generation-unrelated-plugin.ts')],
    ])
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: active.plugins.map(item => ({
        id: item.id,
        entry: entries.get(item.id)!,
        source: source(item.id, item.id === 'generation-base' ? 'a' : item.id === 'generation-consumer' ? 'b' : 'c'),
        enabled: true,
        config: {},
        revision: 0,
        manifest: packageManifest(item.id).runtimeManifest,
        package: {
          version: item.version,
          digest: item.digest,
          moduleGeneration: item.moduleGeneration,
          dependencies: item.dependencies,
        },
      })),
    }
    const bundle = await buildRendererBundle(config, { generation, profileId: 'work', pluginActivation: active })
    const dom = new JSDOM('<!doctype html><html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>', {
      runScripts: 'dangerously',
      url: 'https://codex.local/native',
    })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: false, status: 503, text: async () => '' }) })
    dom.window.eval(bundle)
    for (let attempt = 0; attempt < 50 && dom.window.document.documentElement.dataset.cordisxReady !== 'true'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: RuntimeHandle }).__cordisxRuntime!
    const globals = dom.window as unknown as Record<string, { apply: number; dispose: number }>
    expect(globals.__cordisxGenerationBase).toEqual({ apply: 1, dispose: 0 })
    expect(globals.__cordisxGenerationConsumer).toEqual({ apply: 1, dispose: 0 })
    expect(globals.__cordisxGenerationUnrelated).toEqual({ apply: 1, dispose: 0 })

    const nextBase = dom.window.eval(`({ apply(ctx) {
      const state = globalThis.__cordisxGenerationBase
      state.apply += 1
      ctx.effect(() => () => { state.dispose += 1 }, 'updated base cleanup')
    } })`) as CordisXPluginModule
    const candidate: CordisXPluginActivationRecordV1 = {
      ...active,
      recordKind: 'candidate',
      transactionId: 'update-base',
      revision: 2,
      lastGoodRevision: 1,
      plugins: active.plugins.map(item => item.id === 'generation-base'
        ? { ...item, digest: digest('d'), moduleGeneration: 'generation-base-b' }
        : item.id === 'generation-consumer' ? { ...item, moduleGeneration: 'generation-consumer-b' } : item),
    }
    const decision = {
      $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V1,
      schemaVersion: 1 as const,
      planId: `${generation}:generation-base`,
      operation: 'update' as const,
      profileId: 'work',
      identity: { source: source('generation-base', 'd'), pluginId: 'generation-base' },
      decisions: [],
    }
    await runtime.stagePluginMutation({
      transactionId: 'update-base', operation: 'update', previous: active, candidate, targetId: 'generation-base',
      affectedPluginIds: ['generation-base', 'generation-consumer'],
      package: { manifest: packageManifest('generation-base'), digest: digest('d'), identitySource: source('generation-base', 'd') },
      authorizationDecision: decision,
    }, nextBase)
    expect(globals.__cordisxGenerationBase).toEqual({ apply: 2, dispose: 1 })
    expect(globals.__cordisxGenerationConsumer).toEqual({ apply: 2, dispose: 1 })
    expect(globals.__cordisxGenerationUnrelated).toEqual({ apply: 1, dispose: 0 })
    await runtime.abortPluginMutation('update-base')
    expect(globals.__cordisxGenerationBase).toEqual({ apply: 3, dispose: 2 })
    expect(globals.__cordisxGenerationConsumer).toEqual({ apply: 3, dispose: 2 })
    expect(globals.__cordisxGenerationUnrelated).toEqual({ apply: 1, dispose: 0 })

    const failing = dom.window.eval(`({ apply() { throw new Error('readiness rejected') } })`) as CordisXPluginModule
    await expect(runtime.stagePluginMutation({
      transactionId: 'update-fail', operation: 'update', previous: active,
      candidate: { ...candidate, transactionId: 'update-fail' }, targetId: 'generation-base',
      affectedPluginIds: ['generation-base', 'generation-consumer'],
      package: { manifest: packageManifest('generation-base'), digest: digest('d'), identitySource: source('generation-base', 'd') },
      authorizationDecision: decision,
    }, failing)).rejects.toThrow('readiness rejected')
    expect(globals.__cordisxGenerationBase.apply).toBe(4)
    expect(globals.__cordisxGenerationConsumer.apply).toBe(4)
    expect(globals.__cordisxGenerationUnrelated).toEqual({ apply: 1, dispose: 0 })

    await expect(runtime.reloadPluginGeneration('generation-base', 'stale', generation)).rejects.toThrow('stale plugin module generation')
    await runtime.reloadPluginGeneration('generation-base', 'generation-base-a', generation)
    expect(globals.__cordisxGenerationBase.apply).toBe(5)
    expect(globals.__cordisxGenerationConsumer.apply).toBe(4)
    expect(globals.__cordisxGenerationUnrelated).toEqual({ apply: 1, dispose: 0 })

    const uninstallCandidate: CordisXPluginActivationRecordV1 = {
      ...active,
      recordKind: 'candidate',
      transactionId: 'uninstall-base',
      revision: 2,
      lastGoodRevision: 1,
      plugins: active.plugins.filter(item => item.id === 'generation-unrelated'),
    }
    await runtime.stagePluginMutation({
      transactionId: 'uninstall-base', operation: 'uninstall', previous: active, candidate: uninstallCandidate,
      targetId: 'generation-base', affectedPluginIds: ['generation-base', 'generation-consumer'],
    })
    await runtime.commitPluginMutation('uninstall-base')
    expect(runtime.snapshot().plugins.map(item => item.id)).toEqual(['generation-unrelated'])
    expect(runtime.snapshot().registrations.some(item => item.owner === 'generation-base')).toBe(false)
    expect(runtime.snapshot().navigation.routes.some(item => item.owner === 'generation-base')).toBe(false)
    expect(runtime.snapshot().navigation.pages.some(item => item.owner === 'generation-base')).toBe(false)
    expect(globals.__cordisxGenerationUnrelated).toEqual({ apply: 1, dispose: 0 })
    await runtime.dispose()
  })
})
