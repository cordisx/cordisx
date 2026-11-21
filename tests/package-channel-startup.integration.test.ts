import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { c as createTar } from 'tar'

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

import { ensureHomeConfig, loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { commitServiceConfigCandidate, stageServiceConfigCandidate } from '../packages/cli/src/config/service-config.js'
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
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { acquireProfileRuntimeOwner } from '../packages/cli/src/launcher/profile-runtime-owner.js'
import { ServiceRendererLifecycle } from '../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'
import { attachmentHomeDigest } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'

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
        const web = await startManagerWeb(
          {
            appId: 'codex',
            profileId: 'default',
            generation: 'runtime-1',
            isCurrent: async () => true,
            request: async (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
              await requestPluginManagementRpc(paths, endpoint, operation),
          } as unknown as Parameters<typeof startManagerWeb>[0],
        )
        try {
          const url = new URL(web.url)
          const exchange = await fetch(`${url.origin}/api/session`, {
            method: 'POST',
            headers: { origin: url.origin, 'content-type': 'application/json' },
            body: JSON.stringify({ token: url.hash.slice(1) }),
          })
          const { token } = await exchange.json() as { token: string }
          const response = await fetch(`${url.origin}/api/channel-credentials`, {
            method: 'POST',
            headers: { origin: url.origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: 'view' }),
          })
          expect(await response.json()).toMatchObject({
            status: 'available',
            revision: 1,
            writable: true,
            connections: [],
          })
        } finally {
          await web.close()
        }
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
          generation: 'runtime-1',
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

it(
  'serves a verified configured Channel archive through the production owner and rejects a changed archive',
  async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-configured-channel-manager-'))
    const configPath = path.join(homeDir, 'config.json')
    const archive = path.join(homeDir, 'channel.tgz')
    const source = bundledPluginRoot('channel')
    await createTar({ cwd: source, file: archive, gzip: true }, await readdir(source))
    await ensureHomeConfig(configPath)
    await updateHomeConfigAtomic(config => ({
      ...config,
      plugins: [{ id: 'channel', entry: archive, config: {} }],
    }), configPath)
    const account = { adapterId: 'feishu' as const, accountId: 'cli_fixture', tenantId: 'tenant-fixture' }
    const seed = {
      profileId: 'default',
      pluginId: 'channel',
      serviceId: 'runtime',
      generation: 'runtime-1',
      ownerToken: 'a'.repeat(64),
      expectedRevision: 0,
      config: {
        contract: 'cordisx.channel-service-config/v2',
        schemaVersion: 2,
        connections: [
          ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections,
          {
            ref: account,
            adapterKind: 'feishu',
            enabled: false,
            transport: { mode: 'websocket' },
            secretRef: 'host-secret:env/FIXTURE_UNUSED',
          },
        ],
      },
      applies: 'service-restart' as const,
      initialConfig: SIMULATOR_CHANNEL_SERVICE_CONFIG,
    }
    const staged = await stageServiceConfigCandidate(seed as never, configPath)
    await commitServiceConfigCandidate({ ...seed, candidateRevision: staged.candidateRevision } as never, configPath)
    const releaseOwner = await acquireProfileRuntimeOwner(homeDir, 'default')
    let current = true
    let headless: Awaited<ReturnType<typeof startHeadlessService>> | undefined
    let manager: ReturnType<typeof createManagerChannelCredentials>
    let renderers: ServiceRendererLifecycle | undefined
    let participants: ServiceRendererParticipants | undefined
    let management: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
    let web: Awaited<ReturnType<typeof startManagerWeb>> | undefined
    let digest: `sha256:${string}` | undefined
    try {
      headless = await startHeadlessService({
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
      })
      const selected = headless.managerChannelOwner!
      digest = selected.plugin.configuredArchiveDigest
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
      manager = createManagerChannelCredentials({
        ...selected,
        lifecycle: {} as ManagedServicePluginLifecycleRuntime,
        configPath,
        profileId: 'default',
        generation: 'runtime-1',
        ownerCurrent: () => current,
      }, true)
      expect(manager).toBeDefined()
      const scope = {
        homeDigest: attachmentHomeDigest(homeDir),
        ownerAppId: 'codex',
        profileId: 'default',
        generation: 'runtime-1',
      }
      renderers = new ServiceRendererLifecycle({ scope })
      renderers.initialize({
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'active',
        profileId: 'default',
        revision: 0,
        lastGoodRevision: 0,
        runtimeGeneration: 'runtime-1',
        plugins: [],
      })
      participants = new ServiceRendererParticipants(scope)
      participants.bind(renderers)
      management = await openProductionPluginManagementComposition({
        mode: 'service',
        homeDir,
        appId: 'codex',
        profileId: 'default',
        configPath,
        runtimeGeneration: 'runtime-1',
        token: 'd'.repeat(64),
        coordinator: new PluginLifecycleCoordinator({
          homeDir,
          profileId: 'default',
          runtimeGeneration: 'runtime-1',
          permissionPolicies: [],
          runtime: renderers,
        }),
        rendererParticipant: participants.participant,
        rendererParticipants: participants,
        rendererLifecycle: renderers,
        managerChannelCredentials: operation => manager!.handle(operation),
      })
      const rpcPaths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      const endpoint = (await readPluginManagementRpcEndpoint(rpcPaths))!
      web = await startManagerWeb(
        {
          appId: 'codex',
          profileId: 'default',
          generation: 'runtime-1',
          isCurrent: async () => true,
          request: async (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
            await requestPluginManagementRpc(rpcPaths, endpoint, operation),
        } as unknown as Parameters<typeof startManagerWeb>[0],
      )
      const url = new URL(web.url)
      const exchange = await fetch(url.origin + '/api/session', {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: url.hash.slice(1) }),
      })
      const { token } = await exchange.json() as { token: string }
      const post = async (body: unknown) => {
        const response = await fetch(url.origin + '/api/channel-credentials', {
          method: 'POST',
          headers: { origin: url.origin, 'content-type': 'application/json', authorization: 'Bearer ' + token },
          body: JSON.stringify(body),
        })
        return await response.json() as Record<string, unknown>
      }
      const before = await post({ action: 'view' })
      expect(before).toMatchObject({
        status: 'available',
        revision: 1,
        writable: true,
        connections: [{ ref: account }],
      })
      expect(
        await post({
          action: 'set-enabled',
          serviceGeneration: before.serviceGeneration,
          expectedRevision: 1,
          account,
          enabled: false,
        }),
      ).toMatchObject({ status: 'applied' })
      const state = (await loadHomeConfig(configPath)).plugins[0]!.services!.runtime!.profiles.default!
      expect(state).toMatchObject({ revision: 2, lastGoodRevision: 2 })
      expect(headless.snapshot()?.accounts.some(item => item.ref.adapterId === 'simulator')).toBe(true)
      await appendFile(archive, 'changed')
      expect(await post({ action: 'view' })).toMatchObject({ status: 'unavailable', code: 'CHANNEL_OWNER_UNAVAILABLE' })
    } finally {
      current = false
      await web?.close()
      await management?.close()
      participants?.close()
      await renderers?.close()
      await manager?.close()
      await headless?.close()
      await releaseOwner()
      if (digest) await removeStagedPluginPackage(homeDir, digest)
      await rm(homeDir, { recursive: true, force: true })
    }
  },
  60_000,
)
