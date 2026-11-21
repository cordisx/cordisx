import { JSDOM } from 'jsdom'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { expect, it, vi } from 'vitest'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { defaultUiPlaygroundConfig } from '../packages/cli/src/playground/defaults.js'
import { createManagerRendererLifecycleClient } from '../packages/cli/src/independent-manager/lifecycle-client.js'
import { ownerSnapshotPermissionStore } from '../packages/cli/src/renderer/platform/owner-snapshot-permission-store.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
} from '../packages/cli/src/contracts.js'
import { exactDomPermissionPolicies, installPermissionPolicyBridge } from './helpers/dom-permission.js'

it('does not expose the isolated presentation as a production attachment', async () => {
  const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
  await expect(buildRendererBundle({ ...config, plugins: [] }, { managerPresentationMode: 'standalone' }))
    .rejects.toThrow('not yet available outside the isolated UI Playground')
})

it('requires a live owner-scoped attachment before and after standalone assembly', async () => {
  const loaded = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
  const { agentLoopBackend: _mock, ...codex } = loaded.codex
  const config = { ...loaded, codex, providers: [], plugins: [] }
  const activation = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: 'active' as const,
    profileId: 'work',
    revision: 0,
    lastGoodRevision: 0,
    runtimeGeneration: 'owner-test',
    plugins: [],
  }
  const owner = {
    rendererId: 'a'.repeat(64),
    profileId: 'work',
    generation: 'owner-test',
    managerOrigin: 'http://127.0.0.1:43123',
    isCurrent: vi.fn(() => true),
  }
  const options = {
    managerPresentationMode: 'standalone' as const,
    standaloneOwner: owner,
    profileId: 'work',
    generation: 'owner-test',
    pluginActivation: activation,
    initialRegistryEpoch: 0,
    permission: { profileId: 'work', policies: [] },
  }
  await expect(buildRendererBundle(config, { ...options, standaloneOwner: { ...owner, isCurrent: () => false } }))
    .rejects.toThrow('owner attachment is unavailable')
  await expect(buildRendererBundle(config, { ...options, generation: 'different' }))
    .rejects.toThrow('owner scope is invalid')
  await expect(buildRendererBundle(config, {
    ...options,
    permission: { ...options.permission, bridgeToken: 'owner-private-token' },
  })).rejects.toThrow('owner scope is invalid')
  const current = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
  await expect(buildRendererBundle(config, { ...options, standaloneOwner: { ...owner, isCurrent: current } }))
    .rejects.toThrow('owner attachment is unavailable')
  expect(current).toHaveBeenCalledTimes(3)
}, 30_000)

it('mounts the original Manager and registered plugin in an owner-scoped standalone composition', async () => {
  const loaded = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
  const { agentLoopBackend: _mock, ...codex } = loaded.codex
  const plugin = loaded.plugins.find(item => item.id === 'settings-tab-demo')!
  const permissionPolicies = exactDomPermissionPolicies('work', [{
    id: plugin.id,
    entry: plugin.entry,
    pointIds: ['manager.settings.navigation-items', 'manager.content'],
  }])
  const config = { ...loaded, codex, providers: [], plugins: [plugin] }
  const generation = 'owner-test'
  const activation = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: 'active' as const,
    profileId: 'work',
    revision: 0,
    lastGoodRevision: 0,
    runtimeGeneration: generation,
    plugins: [],
  }
  const owner = {
    rendererId: 'a'.repeat(64),
    profileId: 'work',
    generation,
    managerOrigin: 'http://127.0.0.1:43123',
    isCurrent: () => true,
  }
  const bundle = await buildRendererBundle(config, {
    managerPresentationMode: 'standalone',
    standaloneOwner: owner,
    profileId: 'work',
    generation,
    pluginActivation: activation,
    initialRegistryEpoch: 0,
    permission: { profileId: 'work', policies: permissionPolicies },
  })
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1/',
  })
  try {
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(dom.window, { TextEncoder, TextDecoder })
    const fixtureBundle = await transform(bundle, { format: 'iife', globalName: '__testStandaloneModule' })
    dom.window.eval(fixtureBundle.code)
    const module = (dom.window as unknown as {
      __testStandaloneModule: {
        startStandaloneManagerComposition(signal: AbortSignal): Promise<unknown>
      }
    }).__testStandaloneModule
    expect((dom.window as unknown as { __cordisxRuntime?: unknown }).__cordisxRuntime).toBeUndefined()
    await module.startStandaloneManagerComposition(new AbortController().signal)
    expect(() => module.startStandaloneManagerComposition(new AbortController().signal))
      .toThrow('Standalone Manager session is unavailable')
    const doc = dom.window.document
    await vi.waitFor(() => expect(doc.documentElement.dataset.cordisxReady).toBe('true'), { timeout: 10_000 })
    const root = doc.querySelector<HTMLElement>('[data-manager-surface="standalone"]')!
    expect(root.querySelector('[data-unified-plugins-page="true"]')).not.toBeNull()
    expect(doc.querySelector('link[href="/manager-host.css"]')).not.toBeNull()
    const navigation = root.querySelector<HTMLButtonElement>(
      '[data-settings-navigation-item="settings-tab-demo:navigation"]',
    )!
    expect(navigation.disabled).toBe(false)
    navigation.click()
    await vi.waitFor(() =>
      expect(root.querySelector('[data-settings-navigation-demo-content="mounted"]')).not.toBeNull()
    )
    expect(
      (dom.window as unknown as { __cordisxPluginGenerationResourcesV1?: unknown })
        .__cordisxPluginGenerationResourcesV1,
    )
      .toBeDefined()
    const runtime = (dom.window as unknown as {
      __cordisxRuntime: {
        setExtensionPointPolicy(source: string, plugin: string, point: string, value: string): Promise<void>
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    await expect(runtime.setExtensionPointPolicy(
      pathToFileURL(plugin.entry).href,
      plugin.id,
      'manager.settings.navigation-items',
      'deny',
    )).rejects.toThrow('Owner permission writes are unavailable')
    expect(root.querySelector('[data-settings-navigation-item="settings-tab-demo:navigation"]')).not.toBeNull()
    await runtime.dispose()
  } finally {
    dom.window.close()
  }
  const policies = ownerSnapshotPermissionStore(permissionPolicies)
  expect(policies.readV4?.()).toEqual(permissionPolicies.filter(item => item.schemaVersion === 4))
  expect(() => policies.write([])).toThrow('Owner permission writes are unavailable')
  expect(() => policies.writeAll?.([])).toThrow('Owner permission writes are unavailable')
}, 30_000)

it('mounts the existing Manager and an actual registered plugin page without a native application seat', async () => {
  const config = await loadConfig(defaultUiPlaygroundConfig, { profileId: 'playground' })
  const plugin = config.plugins.find(item => item.id === 'settings-tab-demo')!
  const permissionPolicies = exactDomPermissionPolicies('playground', [{
    id: plugin.id,
    entry: plugin.entry,
    pointIds: ['manager.settings.navigation-items', 'manager.content'],
  }])
  const bundle = await buildRendererBundle({ ...config, plugins: [plugin] }, {
    playground: true,
    managerPresentationMode: 'standalone',
    generation: 'standalone-manager-test',
    profileId: 'playground',
    permission: { profileId: 'playground', bridgeToken: '5'.repeat(64), policies: permissionPolicies },
  })
  const dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1/',
  })
  try {
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(dom.window, { TextEncoder, TextDecoder })
    installPermissionPolicyBridge(dom.window)
    dom.window.eval(bundle)
    const doc = dom.window.document
    await vi.waitFor(() => expect(doc.documentElement.dataset.cordisxReady).toBe('true'), { timeout: 10_000 })
    const root = doc.querySelector<HTMLElement>('[data-manager-surface="standalone"]')!
    expect(root.querySelector('[data-unified-plugins-page="true"]')).not.toBeNull()
    expect(root.querySelector('[data-cordisx-manager-trigger]')).toBeNull()
    const runtime = (dom.window as unknown as {
      __cordisxRuntime: {
        activePluginGeneration(): unknown
        pluginRegistryEpoch(): number
        snapshot(): { navigation: { outlets: readonly { id: string; available: boolean }[] } }
        dispose(): Promise<void>
      }
    }).__cordisxRuntime
    const outlets = runtime.snapshot().navigation.outlets
    expect(runtime.pluginRegistryEpoch()).toBe(0)
    for (const id of ['app', 'main', 'session.content']) {
      expect(outlets.find(outlet => outlet.id === id)).toMatchObject({ id, available: false })
    }
    const navigation = root.querySelector<HTMLButtonElement>(
      '[data-settings-navigation-item="settings-tab-demo:navigation"]',
    )!
    expect(navigation).not.toBeNull()
    expect(navigation.disabled).toBe(false)
    navigation.click()
    await vi.waitFor(() =>
      expect(root.querySelector('[data-settings-navigation-demo-content="mounted"]')).not.toBeNull()
    )
    expect(root.querySelector('[data-settings-navigation-demo-route]')?.textContent).toContain(
      'settings-tab-demo:navigation',
    )
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(root.querySelector('[data-settings-navigation-demo-content="mounted"]')).not.toBeNull()
    const lifecycle = createManagerRendererLifecycleClient({
      runtime: runtime as never,
      scope: { profileId: 'playground', generation: 'standalone-manager-test', rendererId: 'a'.repeat(64) },
    })
    const active = runtime.activePluginGeneration()
    expect(
      await lifecycle.handle({
        id: 'b'.repeat(64),
        sequence: 1,
        method: 'synchronize',
        payload: { active, registryEpoch: 0 },
      }),
    ).toMatchObject({ ok: true, value: { active, registryEpoch: 0 } })
    await lifecycle.close()
    expect(doc.querySelector('[data-manager-surface="standalone"]')).toBeNull()
    expect(doc.getElementById('cordisx-react-manager-style')).toBeNull()
  } finally {
    dom.window.close()
  }
}, 30_000)

it('applies a fixture-projected install through the real standalone renderer lifecycle', async () => {
  const generation = 'owner-test'
  const active = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: 'active' as const,
    profileId: 'work',
    revision: 0,
    lastGoodRevision: 0,
    runtimeGeneration: generation,
    plugins: [],
  }
  const config = {
    version: 1 as const,
    rootDir: path.resolve('.'),
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [],
  }
  const bundle = await buildRendererBundle(config, {
    playground: true,
    managerPresentationMode: 'standalone',
    generation,
    profileId: 'work',
    pluginActivation: active,
  })
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    runScripts: 'dangerously',
    url: 'http://127.0.0.1/',
  })
  let dispose!: () => Promise<void>
  try {
    Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
    Object.assign(dom.window, { TextEncoder, TextDecoder })
    dom.window.eval(bundle)
    await vi.waitFor(() => expect(dom.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
      timeout: 10_000,
    })
    const runtime = (dom.window as unknown as {
      __cordisxRuntime: { snapshot(): { plugins: readonly { id: string; status: string }[] } }
    }).__cordisxRuntime
    const digest = `sha256:${'a'.repeat(64)}` as const
    const manifest = {
      $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V1,
      schemaVersion: 1 as const,
      id: 'renderer-demo',
      version: '1.0.0',
      entry: './index.ts',
      compatibility: { runtimeAbi: 1 as const, protocol: 1 as const },
      dependencies: [],
      runtimeManifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1 as const,
        id: 'renderer-demo',
        name: 'Renderer demo',
        capabilities: [],
      },
    }
    const candidate = {
      ...active,
      recordKind: 'candidate' as const,
      transactionId: 'install-demo',
      revision: 1,
      plugins: [{
        id: 'renderer-demo',
        version: '1.0.0',
        digest,
        moduleGeneration: 'demo-1',
        enabled: true,
        dependencies: [],
      }],
    }
    const mutation = {
      transactionId: 'install-demo',
      transactionEpoch: 'install-demo:epoch',
      expectedRegistryEpoch: 0,
      afterRegistryEpoch: 1,
      operation: 'install' as const,
      previous: active,
      candidate,
      targetId: 'renderer-demo',
      affectedPluginIds: ['renderer-demo'],
      package: { manifest, digest, identitySource: 'file:///verified/renderer-demo.js' },
    }
    const effects = { mounted: 0, disposed: 0 }
    const module = {
      apply(ctx: { effect(callback: () => () => void, label: string): void }) {
        effects.mounted++
        ctx.effect(() => () => {
          effects.disposed++
        }, 'fixture cleanup')
      },
    }
    const loader = {
      load: async () => ({ mutation, module, publish() {}, commit() {}, retire() {} }),
      dispose() {},
    }
    const client = createManagerRendererLifecycleClient({
      runtime: runtime as never,
      scope: { profileId: 'work', generation, rendererId: 'a'.repeat(64) },
      loader: loader as never,
    })
    dispose = client.close
    const send = (sequence: number, method: string, payload: unknown) =>
      client.handle({
        id: sequence.toString(16).padStart(64, '0'),
        sequence,
        method,
        payload,
      })
    expect(await send(1, 'synchronize', { active, registryEpoch: 0 })).toMatchObject({ ok: true })
    expect(
      await send(2, 'prepare', {
        transactionId: 'install-demo',
        transactionEpoch: 'install-demo:epoch',
        expectedRegistryEpoch: 0,
      }),
    ).toMatchObject({ ok: true })
    expect(await send(3, 'stage', { rendererId: 'a'.repeat(64), ...mutation })).toMatchObject({ ok: true })
    expect(await send(4, 'publish', { transactionId: 'install-demo' })).toMatchObject({ ok: true })
    expect(await send(5, 'complete', { transactionId: 'install-demo' })).toMatchObject({ ok: true })
    expect(await send(6, 'finalize', { transactionId: 'install-demo' })).toMatchObject({ ok: true })
    expect(runtime.snapshot().plugins.find(plugin => plugin.id === 'renderer-demo')).toMatchObject({ status: 'active' })
    expect(effects).toEqual({ mounted: 1, disposed: 0 })
    await dispose()
    expect(effects).toEqual({ mounted: 1, disposed: 1 })
  } finally {
    await dispose?.()
    dom.window.close()
  }
}, 30_000)
