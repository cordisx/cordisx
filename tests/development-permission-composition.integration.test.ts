import path from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { buildLocalDevelopmentPlugin } from '../packages/cli/src/launcher/development.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../packages/cli/src/usage-permissions.js'
import * as fixture from './fixtures/generation-base-plugin.js'

it(
  'carries verified local-development provenance through the launcher bundle, initial admission, and candidate replacement',
  async () => {
    const root = path.resolve(import.meta.dirname, '..')
    const entry = path.join(root, 'tests/fixtures/generation-base-plugin.ts')
    const id = 'generation-base',
      source = 'file:///cordisx-local-dev/fixture/generation-base.js',
      generation = 'development-composition'
    const build = await buildLocalDevelopmentPlugin(entry)
    const manifest = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
      schemaVersion: 11 as const,
      id,
      services: [],
      capabilities: [{
        name: 'ui.extension-points.render' as const,
        required: true,
        scope: { extensionPoints: ['sidebar.navigation.items'] },
      }],
    }
    const development = { origin: 'local-dev' as const, pluginId: id, sourcePath: entry, state: 'ready' as const }
    const active = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'development',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: generation,
      plugins: [{
        id,
        version: '1.0.0',
        digest: build.digest,
        moduleGeneration: 'first',
        enabled: true,
        dependencies: [],
      }],
    }
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [{
        id,
        entry,
        source,
        enabled: true,
        config: {},
        manifest,
        development,
        package: { version: '1.0.0', digest: build.digest, moduleGeneration: 'first', dependencies: [] },
      }],
    }
    const bundle = await buildRendererBundle(config, { generation, profileId: 'development', pluginActivation: active })
    const dom = new JSDOM(
      '<!doctype html><html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      { runScripts: 'dangerously', url: 'https://codex.local/native' },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    Object.defineProperty(dom.window, 'structuredClone', { value: structuredClone })
    dom.window.eval(bundle)
    let runtime: any
    try {
      await expect.poll(() => dom.window.document.documentElement.dataset.cordisxReady).toBe('true')
      runtime = (dom.window as any).__cordisxRuntime
      const first = runtime.snapshot()
      expect(first.plugins.find((item: any) => item.id === id)?.status).toBe('active')
      expect(
        first.permissions.some((item: any) =>
          item.identity.id === id && item.scope.extensionPoints?.includes('sidebar.navigation.items')
          && item.policy === 'allow' && item.authorizationOrigin === 'local-development'
        ),
      ).toBe(true)
      const nextManifest = normalizeUsageManifestV11({
        ...manifest,
        capabilities: [...manifest.capabilities, {
          name: 'models.read',
          required: false,
          scope: { providers: ['codex'] },
        }],
      }, id)
      const candidate = {
        ...active,
        recordKind: 'candidate',
        transactionId: 'dev-hmr',
        revision: 2,
        plugins: [{ ...active.plugins[0]!, moduleGeneration: 'second' }],
      }
      await runtime.stagePluginMutation({
        transactionId: 'dev-hmr',
        operation: 'update',
        previous: active,
        candidate,
        targetId: id,
        affectedPluginIds: [id],
        developmentPackage: {
          id,
          version: '1.0.0',
          digest: build.digest,
          identitySource: source,
          development,
          manifest: nextManifest,
        },
      }, { ...fixture, manifest: nextManifest })
      await runtime.commitPluginMutation('dev-hmr')
      const second = runtime.snapshot()
      expect(second.plugins.find((item: any) => item.id === id)?.status).toBe('active')
      expect(
        second.permissions.filter((item: any) =>
          item.identity.id === id && item.capability === 'ui.extension-points.render'
        )
          .every((item: any) => item.policy === 'allow' && item.authorizationOrigin === 'local-development'),
      ).toBe(true)
      expect(second.permissions.some((item: any) =>
        item.capability === 'models.read' && item.policy === 'allow'
        && item.authorizationOrigin === 'local-development'
      )).toBe(true)
      expect(dom.window.document.querySelector('[data-permission-dialog]')).toBeNull()
    } finally {
      await runtime?.dispose()
      dom.window.close()
    }
  },
  30_000,
)
