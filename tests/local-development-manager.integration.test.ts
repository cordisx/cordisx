import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { CordisXLocalDevelopmentSnapshot } from '../packages/cli/src/local-development-contracts.js'
import type { CordisXPluginModule } from '../packages/cli/src/contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'

interface DevelopmentRuntimeHandle {
  snapshot(): {
    readonly plugins: readonly { readonly id: string }[]
  }
  updateLocalDevelopmentStatus(status: CordisXLocalDevelopmentSnapshot): boolean
  stagePluginMutation(mutation: unknown, module?: CordisXPluginModule): Promise<unknown>
  abortPluginMutation(transactionId: string): Promise<void>
  dispose(): Promise<void>
}

describe('local development Manager projection', () => {
  it('shows first-build diagnostics without fabricating an active plugin', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const generation = 'local-development-manager-fixture'
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [],
    }
    const activation = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'development',
      revision: 0,
      lastGoodRevision: 0,
      runtimeGeneration: generation,
      plugins: [],
    }
    const bundle = await buildRendererBundle(config, {
      generation,
      profileId: 'development',
      pluginActivation: activation,
      initialRegistryEpoch: 0,
    })
    const dom = new JSDOM(
      '<!doctype html><html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      {
        runScripts: 'dangerously',
        url: 'https://codex.local/native',
      },
    )
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    Object.defineProperty(dom.window, 'fetch', {
      value: async () => ({ ok: false, status: 503, text: async () => '' }),
    })
    Object.defineProperty(dom.window, 'structuredClone', { value: structuredClone })
    dom.window.eval(bundle)
    for (
      let attempt = 0;
      attempt < 50 && dom.window.document.documentElement.dataset.cordisxReady !== 'true';
      attempt += 1
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const runtime = (dom.window as unknown as { __cordisxRuntime?: DevelopmentRuntimeHandle }).__cordisxRuntime!
    const sourcePath = path.join(root, 'plugin', 'src', 'broken.ts')
    runtime.updateLocalDevelopmentStatus({
      origin: 'local-dev',
      pluginId: 'broken',
      sourcePath,
      state: 'failed',
      error: 'fixture build failed',
    })
    expect(runtime.snapshot().plugins).toEqual([])
    const publicJson = JSON.stringify(runtime.snapshot())
    expect(publicJson).not.toContain(sourcePath)
    expect(publicJson).not.toContain('localDevelopment')
    expect(publicJson).not.toContain('extensionPointControls')
    expect(publicJson).not.toContain('principal:surface')
    expect(publicJson).not.toContain('ancestor-ownership')
    dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-manager-trigger]')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const privateProjection = dom.window.document.querySelector<HTMLElement>('.cxr-local-development-source')
    expect(privateProjection?.textContent).toContain(sourcePath)
    expect(privateProjection?.textContent).toContain('fixture build failed')
    expect(privateProjection?.textContent).toContain('Local development')
    expect(privateProjection?.textContent).not.toMatch(/[\u3400-\u9fff]/u)
    expect(privateProjection?.dataset.developmentState).toBe('failed')

    const candidate = {
      ...activation,
      recordKind: 'candidate' as const,
      transactionId: 'manifest-id-mismatch',
      revision: 1,
      plugins: [{
        id: 'demo',
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}` as const,
        moduleGeneration: 'demo-local-dev-1',
        enabled: true,
        dependencies: [],
      }],
    }
    const mismatchedModule: CordisXPluginModule = {
      manifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: 'not-demo',
        capabilities: [],
      },
      apply() {},
    }
    await expect(runtime.stagePluginMutation({
      transactionId: candidate.transactionId,
      operation: 'install',
      previous: activation,
      candidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      developmentPackage: {
        id: 'demo',
        version: '1.0.0',
        digest: candidate.plugins[0]!.digest,
        identitySource: 'file:///cordisx-local-dev/fixture/demo.js',
        development: { origin: 'local-dev', pluginId: 'demo', sourcePath, state: 'building' },
      },
    }, mismatchedModule)).rejects.toThrow('plugin manifest id not-demo does not match launcher id demo')
    await runtime.abortPluginMutation(candidate.transactionId)
    expect(runtime.snapshot().plugins).toEqual([])

    const serviceTransaction = 'renderer-only-service'
    const serviceCandidate = { ...candidate, transactionId: serviceTransaction }
    const serviceModule: CordisXPluginModule = {
      manifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
        schemaVersion: 4,
        id: 'demo',
        capabilities: [],
        services: [{ id: 'fixture', kind: 'channel-adapter', entry: './service.js', configuration: { kind: 'none' } }],
      },
      apply() {},
    }
    await expect(runtime.stagePluginMutation({
      transactionId: serviceTransaction,
      operation: 'install',
      previous: activation,
      candidate: serviceCandidate,
      targetId: 'demo',
      affectedPluginIds: ['demo'],
      developmentPackage: {
        id: 'demo',
        version: '1.0.0',
        digest: serviceCandidate.plugins[0]!.digest,
        identitySource: 'file:///cordisx-local-dev/fixture/demo.js',
        development: { origin: 'local-dev', pluginId: 'demo', sourcePath, state: 'building' },
      },
    }, serviceModule)).rejects.toThrow('local development phase 1 is renderer-only; manifest services are unavailable')
    await runtime.abortPluginMutation(serviceTransaction)
    expect(runtime.snapshot().plugins).toEqual([])
    await runtime.dispose()
    dom.window.close()
  })
})
