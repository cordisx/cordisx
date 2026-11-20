import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// The native backend is synthetic; plugin staging, package storage and Channel service are real.
vi.mock('../packages/cli/src/launcher/chat-execution-preferences.js', () => ({
  ChatExecutionPreferences: class {
    static async open() {
      return { close: async () => {} }
    }
  },
}))
vi.mock('../packages/cli/src/launcher/codex-chat-configuration.js', () => ({
  CodexChatConfiguration: class {
    static async open() {
      return { call: async () => ({}), close: async () => {} }
    }
  },
}))
vi.mock('../packages/cli/src/launcher/headless-native-authority.js', () => ({
  createHeadlessNativeAuthority: async () => ({
    authority: { request: () => ({}) },
    setReader: () => {},
    close: async () => {},
  }),
}))
vi.mock('../packages/cli/src/launcher/headless-codex-backend.js', () => ({
  startHeadlessCodexBackend: async () => ({
    nativeRequest: async () => ({}),
    models: async () => ({}),
    close: async () => {},
  }),
}))
vi.mock('../packages/cli/src/launcher/channel-native-sessions.js', () => ({ ChannelNativeSessions: class {} }))
vi.mock('../packages/cli/src/cli/channel-consumer-composition.js', () => ({
  createConfiguredChannelConsumer: async (input: { service?: { dispose(): Promise<void> } }) => ({
    tools: { callLocal: async () => ({}) },
    dispose: async () => await input.service?.dispose(),
  }),
}))

import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { startHeadlessService } from '../packages/cli/src/cli/headless-service.js'
import { createRendererChannelComposition } from '../packages/cli/src/cli/renderer-channel-composition.js'
import { bundledPluginRoot } from '../packages/cli/src/launcher/bundled-plugin.js'
import { stagePluginPackageSourceV1 } from '../packages/cli/src/launcher/packages/index.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V16 } from '../packages/cli/src/channel-exact-request-permissions.js'
import { normalizePluginManifestV16 } from '../packages/cli/src/launcher/latest-runtime-manifest.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { loadPluginComposition } from '../packages/cli/src/launcher/plugin-composition.js'
import { PackagePluginServiceConfigStore } from '../packages/cli/src/launcher/package-plugin-service-config.js'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../packages/channel-runtime/src/simulator.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { createManagerChannelCredentials } from '../packages/cli/src/cli/manager-channel-credentials-composition.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { acquireProfileRuntimeOwner } from '../packages/cli/src/launcher/profile-runtime-owner.js'

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-package-channel-'))
  const configPath = path.join(homeDir, 'config.json')
  await ensureHomeConfig(configPath)
  const releaseOwner = await acquireProfileRuntimeOwner(homeDir, 'default')
  const staged = await stagePluginPackageSourceV1({
    kind: 'local-directory',
    location: pathToFileURL(bundledPluginRoot('channel')).href,
  }, {
    homeDir,
    runtimeValidators: { [CORDISX_PLUGIN_MANIFEST_SCHEMA_V16]: value => normalizePluginManifestV16(value, 'channel') },
  })
  const activation = new PluginActivationStore(homeDir, 'default', 'runtime-1')
  await activation.writeCandidate({
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: 'candidate',
    transactionId: 'install-test',
    profileId: 'default',
    revision: 1,
    lastGoodRevision: 0,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'channel',
      version: staged.manifest.version,
      digest: staged.digest,
      moduleGeneration: 'channel-1',
      enabled: true,
      dependencies: [],
    }],
  })
  await activation.commitCandidate('install-test')
  const packageStore = new PackagePluginServiceConfigStore(homeDir, 'default', 'runtime-1')
  const seed = {
    profileId: 'default',
    pluginId: 'channel',
    serviceId: 'runtime',
    generation: 'runtime-1',
    ownerToken: 'a'.repeat(64),
    expectedRevision: 0,
    config: SIMULATOR_CHANNEL_SERVICE_CONFIG,
    applies: 'service-restart' as const,
    initialConfig: SIMULATOR_CHANNEL_SERVICE_CONFIG,
  }
  await packageStore.persistence.stage(seed as never)
  await packageStore.persistence.commit({ ...seed, candidateRevision: 1 } as never)
  const [plugin] = await loadPluginComposition(activation, await activation.loadActive())
  const input = {
    configPath,
    homeDir,
    appId: 'codex',
    profileId: 'default',
    userHome: homeDir,
    codexHome: path.join(homeDir, '.codex'),
    codexExecutable: '/bin/false',
    cwd: homeDir,
    environment: {},
    generation: 'runtime-1',
    profileOwnerVerified: true,
    report: () => {},
  }
  return {
    homeDir,
    configPath,
    plugin: plugin!,
    packageStore,
    activation,
    seed,
    input,
    close: async () => {
      await releaseOwner()
      await removeStagedPluginPackage(homeDir, staged.digest)
      await rm(homeDir, { recursive: true, force: true })
    },
  }
}

describe('package Channel startup routing', () => {
  it('loads existing package state in both production startup compositions without a home plugin entry', async () => {
    const f = await fixture()
    let headless: Awaited<ReturnType<typeof startHeadlessService>> | undefined
    let renderer: Awaited<ReturnType<typeof createRendererChannelComposition>> | undefined
    try {
      const original = await readFile(f.configPath, 'utf8')
      headless = await startHeadlessService(f.input)
      expect(headless.managerChannelOwner?.plugin.package?.moduleGeneration).toBe('channel-1')
      expect(headless.snapshot()?.accounts).toMatchObject([{ ref: { adapterId: 'simulator', accountId: 'local' } }])
      const lifecycle = new ManagedServicePluginLifecycleRuntime({
        runtime: {} as PluginLifecycleRuntime,
        profileId: 'default',
        runtimeGeneration: 'runtime-1',
        activate: async () => undefined,
      })
      await lifecycle.initialize(await f.activation.loadActive())
      const managerInput = {
        ...headless.managerChannelOwner!,
        lifecycle,
        configPath: f.configPath,
        profileId: 'default',
        generation: 'runtime-1',
      }
      expect(createManagerChannelCredentials(managerInput)).toBeUndefined()
      const manager = createManagerChannelCredentials(managerInput, true)!
      const rpc = await startPluginManagementRpcServer({
        homeDir: f.homeDir,
        appId: 'codex',
        profileId: 'default',
        configPath: f.configPath,
        generation: 'runtime-1',
        processStartedAt: new Date().toISOString(),
        service: {} as PluginManagementService,
        managerChannelCredentials: operation => manager.handle(operation),
      })
      try {
        const paths = pluginManagementRpcPaths(f.homeDir, 'codex', 'default')
        const endpoint = (await readPluginManagementRpcEndpoint(paths))!
        const view = await requestPluginManagementRpc(paths, endpoint, {
          kind: 'manager-channel-credentials',
          action: 'view',
          sessionId: 'a'.repeat(64),
        })
        expect(view).toMatchObject({ status: 'available', revision: 1, writable: true, connections: [] })
      } finally {
        await rpc.close()
        await manager.close()
        await lifecycle.dispose()
      }
      await headless.close()
      headless = undefined
      renderer = await createRendererChannelComposition(
        {
          composition: {
            version: 1,
            rootDir: f.homeDir,
            codex: { debugPort: 9229 },
            providers: [],
            plugins: [f.plugin],
          },
          profileId: 'default',
          appId: 'codex',
          configPath: f.configPath,
          homeDir: f.homeDir,
          environment: {},
        },
        { runtimeGeneration: 'runtime-1', profileOwnerVerified: true },
      )
      expect(renderer.service?.snapshot()?.accounts).toMatchObject([{
        ref: { adapterId: 'simulator', accountId: 'local' },
      }])
      expect(await renderer.loadManagerProjection()).toMatchObject({ service: { revision: 1 } })
      expect(await readFile(f.configPath, 'utf8')).toEqual(original)
      expect(await f.packageStore.persistence.read(f.seed)).toMatchObject({
        revision: 1,
        config: SIMULATOR_CHANNEL_SERVICE_CONFIG,
      })
    } finally {
      await renderer?.service?.dispose()
      await headless?.close()
      await f.close()
    }
  }, 30_000)

  it('leaves package state and a conflicting legacy home entry unchanged', async () => {
    const f = await fixture()
    try {
      await updateHomeConfigAtomic(
        config => ({ ...config, plugins: [{ id: 'channel', entry: 'cordisx:channel', config: { legacy: true } }] }),
        f.configPath,
      )
      const before = await readFile(f.configPath, 'utf8')
      const packageBefore = await f.packageStore.persistence.read(f.seed)
      await expect(startHeadlessService(f.input)).rejects.toThrow('PLUGIN_ID_COLLISION')
      expect(await readFile(f.configPath, 'utf8')).toEqual(before)
      expect(await f.packageStore.persistence.read(f.seed)).toEqual(packageBefore)
    } finally {
      await f.close()
    }
  }, 30_000)
})
