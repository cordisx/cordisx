import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import type { CordisXConfig } from '../packages/cli/src/launcher/config.js'
import type { CordisXPluginModule } from '../packages/cli/src/contracts.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

describe('managed service UI runtime', () => {
  it('isolates the owner-bound registry for every plugin generation', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'tests/fixtures/managed-service-ui-plugin.ts')
    const plugins = ['managed-ui-one', 'managed-ui-two'].map((id, index) => ({
      id,
      entry,
      enabled: true,
      config: {},
      package: {
        version: '0.1.0',
        digest: `sha256:${String(index + 1).repeat(64)}` as `sha256:${string}`,
        moduleGeneration: `${id}-generation`,
        dependencies: [],
      },
    }))
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins,
    }
    const pluginActivation = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'work',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: 'managed-service-ui-generation',
      plugins: plugins.map(plugin => ({
        id: plugin.id,
        version: plugin.package.version,
        digest: plugin.package.digest,
        moduleGeneration: plugin.package.moduleGeneration,
        enabled: true,
        dependencies: [],
      })),
    }
    const bundle = await buildRendererBundle(config, {
      profileId: 'work',
      generation: 'managed-service-ui-generation',
      pluginActivation,
      managedServiceUICapabilities: plugins.map(plugin => ({
        pluginId: plugin.id,
        pluginGeneration: plugin.package.moduleGeneration,
        token: `${plugin.id}-token`,
      })),
    })
    const dom = new JSDOM(
      '<html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      { runScripts: 'dangerously', url: 'https://codex.local/' },
    )
    Object.assign(dom.window, { structuredClone: globalThis.structuredClone })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })

    dom.window.eval(bundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot

    const globals = dom.window as unknown as {
      __cordisxManagedServiceUIFixtures?: unknown[]
      __cordisxRuntime?: {
        snapshot(): { plugins: readonly { id: string; status: string; error?: string }[] }
        dispose(): Promise<void>
      }
    }
    expect(globals.__cordisxManagedServiceUIFixtures).toHaveLength(2)
    expect(globals.__cordisxManagedServiceUIFixtures?.[0]?.managedServices)
      .not.toBe(globals.__cordisxManagedServiceUIFixtures?.[1]?.managedServices)
    expect(globals.__cordisxManagedServiceUIFixtures?.[0]?.platform).toBeDefined()
    expect(globals.__cordisxManagedServiceUIFixtures?.[1]?.platform).toBeDefined()
    expect(globals.__cordisxRuntime?.snapshot().plugins).toMatchObject([
      { id: 'managed-ui-one', status: 'active' },
      { id: 'managed-ui-two', status: 'active' },
    ])

    await globals.__cordisxRuntime?.dispose()
    dom.window.close()
  })

  it('stages a new managed-service owner before candidate mount and retires tokens transactionally', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const entry = path.join(root, 'tests/fixtures/managed-service-ui-plugin.ts')
    const generation = 'managed-service-dynamic-generation'
    const plugin = {
      id: 'managed-ui-one',
      entry,
      enabled: true,
      config: {},
      package: {
        version: '1.0.0',
        digest: `sha256:${'1'.repeat(64)}` as `sha256:${string}`,
        moduleGeneration: 'managed-ui-old',
        dependencies: [],
      },
    }
    const active = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'work',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: generation,
      plugins: [{
        id: plugin.id,
        version: plugin.package.version,
        digest: plugin.package.digest,
        moduleGeneration: plugin.package.moduleGeneration,
        enabled: true,
        dependencies: [],
      }],
    }
    const config: CordisXConfig = {
      version: 1,
      rootDir: root,
      codex: { debugPort: 9229 },
      providers: [],
      plugins: [plugin],
    }
    const bundle = await buildRendererBundle(config, {
      profileId: 'work',
      generation,
      pluginActivation: active,
      managedServiceUICapabilities: [{
        pluginId: plugin.id,
        pluginGeneration: plugin.package.moduleGeneration,
        token: 'old-managed-token',
      }],
    })
    const dom = new JSDOM(
      '<html><body><div class="sidebar-header"><button aria-haspopup="menu">Codex</button></div></body></html>',
      { runScripts: 'dangerously', url: 'https://codex.local/' },
    )
    Object.assign(dom.window, { structuredClone: globalThis.structuredClone })
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
    dom.window.eval(bundle)
    await (dom.window as unknown as { __cordisxBoot?: Promise<unknown> }).__cordisxBoot
    const requests: Array<{ readonly token: string }> = []
    const window = dom.window as unknown as {
      __cordisxManagedServiceUIFixtures: Array<
        { managedServices: { get(input: { serviceId: string }): Promise<unknown> } }
      >
      __cordisxCandidateManagedServices?: { get(input: { serviceId: string }): Promise<unknown> }
      __cordisxRollbackManagedServices?: { get(input: { serviceId: string }): Promise<unknown> }
      __cordisxManagedServiceUIRequestV1?: (payload: string) => void
      __cordisxManagedServiceUIReceiveV1?: (payload: string) => void
      __cordisxRuntime: {
        activePluginGeneration(): typeof active
        stagePluginMutation(mutation: unknown, module?: CordisXPluginModule): Promise<unknown>
        publishPluginMutation(transactionId: string): Promise<unknown>
        completePluginMutation(transactionId: string): Promise<unknown>
        finalizePluginMutation(transactionId: string): Promise<void>
        abortPluginMutation(transactionId: string): Promise<void>
        dispose(): Promise<void>
      }
    }
    window.__cordisxManagedServiceUIRequestV1 = payload => {
      const request = JSON.parse(payload) as { requestId: string; token: string }
      requests.push(request)
      queueMicrotask(() =>
        window.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
          requestId: request.requestId,
          ok: false,
          code: 'service-not-declared',
        }))
      )
    }
    const packageManifest = (version: string) => ({
      id: plugin.id,
      version,
      runtimeManifest: {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v14.schema.json',
        schemaVersion: 14,
        id: plugin.id,
        capabilities: [],
        services: [{
          id: 'gateway',
          kind: 'managed-backend',
          owner: 'host',
          entry: './service.mjs',
          definitionSchema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json',
          runtimeResources: [],
          consumerGrants: [],
        }],
      },
    })
    const candidateModule = dom.window.eval(`({
      inject: ['managedServices'],
      apply(ctx) { globalThis.__cordisxCandidateManagedServices = ctx.managedServices }
    })`) as CordisXPluginModule
    const candidate = {
      ...active,
      recordKind: 'candidate' as const,
      transactionId: 'managed-update',
      revision: 2,
      lastGoodRevision: 1,
      plugins: [{
        ...active.plugins[0],
        version: '2.0.0',
        digest: `sha256:${'2'.repeat(64)}` as `sha256:${string}`,
        moduleGeneration: 'managed-ui-new',
      }],
    }
    await window.__cordisxRuntime.stagePluginMutation({
      transactionId: candidate.transactionId,
      operation: 'update',
      previous: active,
      candidate,
      targetId: plugin.id,
      affectedPluginIds: [plugin.id],
      managedServiceUICapabilities: [{
        pluginId: plugin.id,
        pluginGeneration: 'managed-ui-new',
        token: 'new-managed-token',
      }],
      package: {
        manifest: packageManifest('2.0.0'),
        digest: candidate.plugins[0].digest,
        identitySource: 'https://plugins.example/managed-ui-one-v2',
      },
    }, candidateModule)
    await window.__cordisxManagedServiceUIFixtures[0]!.managedServices.get({ serviceId: 'gateway' })
    await window.__cordisxCandidateManagedServices!.get({ serviceId: 'gateway' })
    expect(requests.map(request => request.token)).toEqual(['old-managed-token', 'new-managed-token'])
    await window.__cordisxRuntime.publishPluginMutation(candidate.transactionId)
    await window.__cordisxRuntime.completePluginMutation(candidate.transactionId)
    await window.__cordisxRuntime.finalizePluginMutation(candidate.transactionId)
    const beforeRetiredRequest = requests.length
    await window.__cordisxManagedServiceUIFixtures[0]!.managedServices.get({ serviceId: 'gateway' })
    expect(requests).toHaveLength(beforeRetiredRequest)
    await window.__cordisxCandidateManagedServices!.get({ serviceId: 'gateway' })
    expect(requests.at(-1)?.token).toBe('new-managed-token')

    const rollbackModule = dom.window.eval(`({
      inject: ['managedServices'],
      apply(ctx) {
        globalThis.__cordisxRollbackManagedServices = ctx.managedServices
        throw new Error('synthetic candidate readiness failure')
      }
    })`) as CordisXPluginModule
    const current = window.__cordisxRuntime.activePluginGeneration()
    const rollbackCandidate = {
      ...current,
      recordKind: 'candidate' as const,
      transactionId: 'managed-rollback',
      revision: 3,
      lastGoodRevision: 2,
      plugins: [{
        ...current.plugins[0],
        version: '3.0.0',
        digest: `sha256:${'3'.repeat(64)}` as `sha256:${string}`,
        moduleGeneration: 'managed-ui-rollback',
      }],
    }
    await expect(window.__cordisxRuntime.stagePluginMutation({
      transactionId: rollbackCandidate.transactionId,
      operation: 'update',
      previous: current,
      candidate: rollbackCandidate,
      targetId: plugin.id,
      affectedPluginIds: [plugin.id],
      managedServiceUICapabilities: [{
        pluginId: plugin.id,
        pluginGeneration: 'managed-ui-rollback',
        token: 'rollback-managed-token',
      }],
      package: {
        manifest: packageManifest('3.0.0'),
        digest: rollbackCandidate.plugins[0].digest,
        identitySource: 'https://plugins.example/managed-ui-one-v3',
      },
    }, rollbackModule)).rejects.toThrow('synthetic candidate readiness failure')
    await window.__cordisxRuntime.abortPluginMutation(rollbackCandidate.transactionId)
    const beforeRollbackRequest = requests.length
    await window.__cordisxRollbackManagedServices!.get({ serviceId: 'gateway' })
    expect(requests).toHaveLength(beforeRollbackRequest)
    await window.__cordisxCandidateManagedServices!.get({ serviceId: 'gateway' })
    expect(requests.at(-1)?.token).toBe('new-managed-token')
    await window.__cordisxRuntime.dispose()
    dom.window.close()
  })
})
