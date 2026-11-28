import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { openReadonlyHeadlessChannel } from '../packages/cli/src/cli/readonly-headless-channel.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/contracts.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

// The coordinated plugin candidate is a separate repository and is deliberately
// not a dependency of ordinary CI until its Protocol and package are merged.
const candidateEntry = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE
const candidateTest = candidateEntry === undefined ? it.skip : it

candidateTest.each(['no-ui-grant', 'fixture-ui-grant'] as const)(
  'mounts the real Channel plugin with %s against a real isolated backend',
  async grant => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-readonly-external-channel-'))
    const configPath = path.join(root, 'config.json')
    const generation = 'independent-owner-fixture'
    const controller = new AbortController()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let service: ReturnType<typeof createLocalChannelService> | undefined
    let dom: JSDOM | undefined
    let digest: `sha256:${string}` | undefined
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          ...createDefaultHomeConfig(),
          apps: { codex: { defaultProfile: 'test', profiles: { test: { displayName: 'Test', dataMode: 'shared' } } } },
          plugins: [{
            id: 'channel',
            entry: candidateEntry!,
            services: {
              runtime: {
                profiles: {
                  test: {
                    revision: 1,
                    lastGoodRevision: 1,
                    config: SIMULATOR_CHANNEL_SERVICE_CONFIG,
                  },
                },
              },
            },
          }],
        }),
      )
      const config = await loadConfig(configPath, { profileId: 'test', projectRoot: root })
      const plugin = config.plugins.find(item => item.id === 'channel')!
      digest = plugin.configuredArchiveDigest
      service = createLocalChannelService({
        artifactDirectory: path.dirname(plugin.entry),
        ...(plugin.configuredServiceEntry === undefined ? {} : { runtimeEntry: plugin.configuredServiceEntry }),
        dataDir: path.join(root, 'runtime'),
        source: plugin.source ?? pathToFileURL(plugin.entry).href,
        environment: {},
      })
      await service.start(SIMULATOR_CHANNEL_SERVICE_CONFIG)
      const view = (await openReadonlyHeadlessChannel({
        profileId: 'test',
        configPath,
        plugin,
        service,
        fence: {
          signal: controller.signal,
          current: () => !controller.signal.aborted,
          retire: () => controller.abort(),
        },
      }))!
      expect(view.initial.projection.accounts).toContainEqual(expect.objectContaining({ connectionState: 'ready' }))
      const activation = {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1 as const,
        recordKind: 'active' as const,
        profileId: 'test',
        revision: 0,
        lastGoodRevision: 0,
        runtimeGeneration: generation,
        plugins: [],
      }
      const bundle = await buildRendererBundle({ ...config, plugins: [{ ...plugin, documents: [] }] }, {
        managerPresentationMode: 'standalone',
        standaloneOwner: {
          rendererId: 'a'.repeat(64),
          profileId: 'test',
          generation,
          managerOrigin: 'http://127.0.0.1:43123',
          isCurrent: () => !controller.signal.aborted,
        },
        profileId: 'test',
        generation,
        pluginActivation: activation,
        initialRegistryEpoch: 0,
        permission: {
          profileId: 'test',
          policies: grant === 'fixture-ui-grant'
            ? exactDomPermissionPolicies('test', [{
              id: plugin.id,
              entry: plugin.entry,
              pointIds: ['manager.settings.navigation-items', 'manager.content'],
            }]).map(policy => ({
              ...policy,
              key: {
                ...policy.key,
                identity: { ...policy.key.identity, source: plugin.source ?? policy.key.identity.source },
              },
            }))
            : [],
        },
        channelManager: view.initial.projection,
        serviceCapabilityOwners: [view.initial.owner],
        channelActionsBridgeToken: 'renderer-binding-placeholder',
      })
      dom = new JSDOM('<!doctype html><html lang="en"><head></head><body></body></html>', {
        runScripts: 'dangerously',
        url: 'http://127.0.0.1/',
      })
      Object.defineProperty(dom.window, 'structuredClone', { configurable: true, value: structuredClone })
      Object.assign(dom.window, { TextEncoder, TextDecoder })
      const calls: string[] = []
      const global = dom.window as unknown as Record<string, unknown>
      global.__cordisxChannelActionsRequestV1 = (payload: string) => {
        const request = JSON.parse(payload) as { requestId: string; action: string }
        calls.push(request.action)
        void view.snapshot().then(value => {
          const receive = global.__cordisxChannelActionsReceiveV1 as (payload: string) => void
          receive(JSON.stringify({ requestId: request.requestId, ok: true, value }))
        })
      }
      const fixtureBundle = await transform(bundle, { format: 'iife', globalName: '__testStandaloneModule' })
      dom.window.eval(fixtureBundle.code)
      const module = global.__testStandaloneModule as {
        startStandaloneManagerComposition(signal: AbortSignal): Promise<unknown>
      }
      await module.startStandaloneManagerComposition(controller.signal)
      await vi.waitFor(() => expect(dom!.window.document.documentElement.dataset.cordisxReady).toBe('true'), {
        timeout: 10_000,
      })
      const runtime = global.__cordisxRuntime as {
        snapshot(): { plugins: Array<{ id: string; status: string }>; navigation: unknown }
        dispose(): Promise<void>
      }
      const snapshot = runtime.snapshot()
      expect(snapshot.plugins).toContainEqual(expect.objectContaining({ id: 'channel', status: 'active' }))
      const screen = dom.window.document.querySelector<HTMLElement>('[data-manager-surface="standalone"]')!
      expect(screen).not.toBeNull()
      const destination = screen.querySelector<HTMLButtonElement>('[data-settings-navigation-item="channel:channels"]')!
      expect(destination).not.toBeNull()
      expect(destination.disabled).toBe(false)
      destination.click()
      if (grant === 'no-ui-grant') {
        await vi.waitFor(() => expect(screen.textContent).toContain('Review permissions'))
        expect(screen.querySelector('[data-manager-collection-item]')).toBeNull()
        await runtime.dispose()
        view.close()
        return
      }
      await vi.waitFor(() => {
        expect(screen.querySelector('[data-manager-collection-item]')).not.toBeNull()
      }, { timeout: 10_000 })
      expect(screen.textContent).toContain('Simulator')
      expect(screen.querySelector('[data-manager-page-header-actions]')?.querySelectorAll('button')).toHaveLength(0)
      await vi.waitFor(() => expect(calls).toContain('snapshot'))
      const row = screen.querySelector<HTMLButtonElement>(
        '[data-manager-collection-item] .cxr-manager-collection-open',
      )!
      row.click()
      await vi.waitFor(() => expect(screen.querySelector('[data-channel-page="detail"]')).not.toBeNull(), {
        timeout: 10_000,
      })
      expect(screen.textContent).toContain('Connected')
      expect(screen.querySelectorAll('[data-manager-content-tab]')).toHaveLength(1)
      expect(screen.querySelector('[data-manager-content-tab="runtime"]')).not.toBeNull()
      expect(screen.querySelector('[data-manager-page-header-actions]')?.querySelectorAll('button')).toHaveLength(0)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(screen.querySelector('[data-channel-page="detail"]')).not.toBeNull()
      expect(errorSpy).not.toHaveBeenCalled()
      // The real plugin must not publish mutation commands or configuration routes.
      expect(JSON.stringify(snapshot.navigation)).not.toContain('channel:create')
      expect(JSON.stringify(snapshot.navigation)).not.toContain('channel:policy')
      expect(JSON.stringify(snapshot.navigation)).not.toContain('channel:conversation-bindings')
      expect(calls.every(action => action === 'snapshot')).toBe(true)
      await runtime.dispose()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(errorSpy).not.toHaveBeenCalled()
      view.close()
    } finally {
      controller.abort()
      dom?.window.close()
      errorSpy.mockRestore()
      await service?.dispose()
      if (digest) await removeStagedPluginPackage(root, digest)
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
