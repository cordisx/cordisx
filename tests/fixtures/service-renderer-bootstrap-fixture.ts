import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../../packages/channel-runtime/src/simulator.js'
import { ServiceRendererBootstrap } from '../../packages/cli/src/cli/service-renderer-bootstrap.js'
import { ReadonlyChannelRendererBridge } from '../../packages/cli/src/cli/readonly-channel-renderer-bridge.js'
import { ServiceRendererParticipants } from '../../packages/cli/src/cli/service-renderer-participant.js'
import { createServiceRendererProjector } from '../../packages/cli/src/cli/service-renderer-projection.js'
import { ManagerRendererSessions } from '../../packages/cli/src/cli/manager-renderer-sessions.js'
import { createManagerRendererManagementChannel } from '../../packages/cli/src/cli/manager-renderer-management.js'
import { createProductionManagedServiceLifecycle } from '../../packages/cli/src/cli/production-managed-services.js'
import { createManagerManagedServiceUIBridge } from '../../packages/cli/src/cli/manager-managed-service-ui.js'
import { createDefaultHomeConfig } from '../../packages/cli/src/config/home-config.js'
import { createLocalChannelService } from '../../packages/cli/src/launcher/channel-service.js'
import { loadConfig } from '../../packages/cli/src/launcher/config.js'
import { PluginActivationStore } from '../../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import { persistPermissionPolicies } from '../../packages/cli/src/launcher/permission-rpc.js'
import {
  type PluginGenerationGraphLease,
  startPluginGenerationArtifactServer,
} from '../../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../../packages/cli/src/launcher/plugin-package.js'
import { attachmentHomeDigest } from '../../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { ServiceRendererLifecycle } from '../../packages/cli/src/launcher/service-renderer-lifecycle.js'
import { openPluginManagementService } from '../../packages/cli/src/management/service.js'
import { decision, localPackage, request } from '../suites/plugin-lifecycle.fixtures.js'
import { stageServiceModePlugin } from './service-mode-plugin.js'
import { exactDomPermissionPolicies } from '../helpers/dom-permission.js'

const secret = () => randomBytes(32).toString('hex')
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

export async function fixture(
  options: {
    delayLease?: boolean
    managedBackend?: boolean
    protectProfileInputs?: boolean
    writeDispatch?: () => Promise<unknown>
    channelArchive?: string
    channelUiGrant?: boolean
    channelGrantOtherSource?: boolean
    channelOwnerMismatch?: boolean
    includePluginManagement?: boolean
  } = {},
) {
  const root = await mkdtemp('/tmp/cx-service-bootstrap-')
  const homeDir = path.join(root, 'home')
  const configPath = path.join(homeDir, 'config.json')
  await mkdir(homeDir, { recursive: true, mode: 0o700 })
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()))
  const profileId = 'default'
  const generation = 'fixture-owner'
  let configuredChannel: {
    plugin: Awaited<ReturnType<typeof loadConfig>>['plugins'][number]
    service: ReturnType<typeof createLocalChannelService>
    configuration: unknown
  } | undefined
  if (options.channelArchive) {
    const configuration = {
      contract: 'cordisx.channel-service-config/v3',
      schemaVersion: 3,
      connections: SIMULATOR_CHANNEL_SERVICE_CONFIG.connections,
      pendingConnections: [{
        account: { adapterId: 'feishu', accountId: 'cli_pending' },
        adapterKind: 'feishu',
        secretRef: 'host-secret:channel/fixture-private-reference',
        displayName: 'Pending',
      }],
    }
    await writeFile(
      configPath,
      JSON.stringify({
        ...createDefaultHomeConfig(),
        plugins: [{
          id: 'channel',
          entry: options.channelArchive,
          services: {
            runtime: { profiles: { [profileId]: { revision: 1, lastGoodRevision: 1, config: configuration } } },
          },
        }],
      }),
    )
    const plugin = (await loadConfig(configPath, { profileId, projectRoot: homeDir })).plugins[0]!
    if (!plugin.source) throw new Error('configured Channel source is missing')
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(plugin.entry),
      ...(plugin.configuredServiceEntry === undefined ? {} : { runtimeEntry: plugin.configuredServiceEntry }),
      dataDir: path.join(root, 'channel-runtime'),
      source: plugin.source,
      environment: {},
    })
    await service.start(configuration)
    configuredChannel = { plugin, service, configuration }
    if (options.channelUiGrant) {
      const policies = exactDomPermissionPolicies(profileId, [{
        id: 'channel',
        entry: plugin.entry,
        pointIds: ['manager.settings.navigation-items', 'manager.content'],
      }]).map(policy => ({
        ...policy,
        key: {
          ...policy.key,
          identity: {
            ...policy.key.identity,
            source: options.channelGrantOtherSource ? 'https://example.test/unrelated-source' : plugin.source!,
          },
        },
      }))
      await persistPermissionPolicies({ configPath }, policies)
    }
  }
  if (options.managedBackend) {
    await stageServiceModePlugin(
      root,
      homeDir,
      profileId,
      true,
      'https://example.test/fixtures',
      `export const inject = ['managedServices'];
       export async function apply(ctx) {
         const result = await ctx.managedServices.get({ serviceId: 'gateway' });
         globalThis.__fixtureManagedStatus = result.status;
         if (result.status === 'available') globalThis.__fixtureManagedSnapshot = (await result.service.snapshot()).status;
       }`,
    )
  }
  const scope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: 'codex', profileId, generation }
  const participants = new ServiceRendererParticipants(scope)
  const leaseReady = defer<PluginGenerationGraphLease>()
  const releaseLease = defer<void>()
  const lifecycle = new ServiceRendererLifecycle({
    scope,
    projectMutation: createServiceRendererProjector({
      homeDir,
      profileId,
      generation,
      isLive: identity => participants.isLive(identity),
    }),
    async createArtifactServer() {
      const server = await startPluginGenerationArtifactServer()
      return {
        origin: server.origin,
        close: async () => await server.close(),
        requestTrace: () => server.requestTrace(),
        async lease(...args) {
          const lease = await server.lease(...args)
          if (options.delayLease) {
            leaseReady.resolve(lease)
            await releaseLease.promise
          }
          return lease
        },
      }
    },
  })
  participants.bind(lifecycle)
  const channelBridge = configuredChannel === undefined ? undefined : new ReadonlyChannelRendererBridge({
    profileId,
    generation,
    isCurrent: context => {
      const peer = participants.peer(context.rendererId)
      return peer !== undefined && !peer.closed
    },
  })
  const store = new PluginActivationStore(homeDir, profileId, generation)
  const managed = createProductionManagedServiceLifecycle({
    runtime: lifecycle,
    homeDir,
    profileId,
    generation,
    environment: { PATH: process.env.PATH, HOME: root },
    store,
    dryRun: false,
    requireOwnedProcess: true,
  })
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId,
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: managed,
    headless: true,
  })
  await coordinator.recover()
  lifecycle.initialize(await store.bindRuntimeGeneration())
  const management = options.includePluginManagement
    ? await openPluginManagementService({
      homeDir,
      configPath,
      appId: 'codex',
      profileId,
      lifecycle: { coordinator, runtimeGeneration: generation, mode: 'service' },
      watch: false,
    })
    : undefined
  const startup = await managed.initialize(await store.loadActive())
  await Promise.all([startup.coreReady, startup.adopted])
  await vi.waitFor(() => expect(managed.readManagedServiceUIFence()).toEqual(expect.any(Number)))
  const managedUI = createManagerManagedServiceUIBridge({
    profileId,
    runtimeGeneration: generation,
    ownerGeneration: generation,
    ownerCurrent: () => true,
    readLifecycleFence: () => managed.readManagedServiceUIFence(),
    runtime: managed,
  })
  const bootstrap = new ServiceRendererBootstrap({
    homeDir,
    configPath,
    appId: 'codex',
    profileId,
    generation,
    lifecycle,
    participants,
    store,
    managedServiceUI: managedUI,
    protectProfileInputs: options.protectProfileInputs === true,
    ...(configuredChannel === undefined ? {} : {
      experimentalConfiguredChannel: {
        plugin: options.channelOwnerMismatch
          ? { ...configuredChannel.plugin, source: 'https://example.test/unrelated-owner' }
          : configuredChannel.plugin,
        service: configuredChannel.service,
        bridge: channelBridge!,
      },
    }),
  })
  const gateway = { pid: process.pid, processStartedAt: 'fixture', instanceToken: secret() }
  const sessions = new ManagerRendererSessions({
    profileId,
    ownerGeneration: generation,
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    writeLifetimes: bootstrap.writeLifetimes,
    ...(options.protectProfileInputs
      ? { waitForRetirement: async (rendererId: string) => await bootstrap.waitForRetirement(rendererId) }
      : {}),
    participant: participants.participant,
    channels: new Map([
      ...(management === undefined
        ? []
        : [['plugin-management', createManagerRendererManagementChannel(management)] as const]),
      ['manager-bootstrap', bootstrap.channel()],
      ['managed-service-ui', managedUI.channel],
      ...(channelBridge === undefined ? [] : [['channel-actions', channelBridge.channel] as const]),
      ...(options.writeDispatch === undefined ? [] : [
        [
          'fixture-write',
          { prepare: () => ({ mode: 'write' as const, dispatch: options.writeDispatch! }) },
        ] as const,
      ]),
    ]),
  })
  const browserSessionId = secret()
  const handle = (await sessions.open(gateway, browserSessionId))!
  const invocation = { gateway, browserSessionId, handle }
  async function call(payload: unknown) {
    return await sessions.call(invocation, 'manager-bootstrap', payload)
  }
  async function install(id: string, revision = 0, requiredCapability = false, code?: string) {
    const sourceDirectory = await localPackage({ root, id, requiredCapability, code })
    const plan = await coordinator.handle({
      ...request({ kind: 'inspect-local', sourceDirectory }, revision, generation),
      profileId,
    })
    expect(plan, JSON.stringify(plan)).toMatchObject({ outcome: 'planned', candidateId: expect.any(String) })
    return await coordinator.handle(
      {
        ...request(
          {
            kind: plan.operation === 'update' ? 'update' : 'install',
            candidateId: plan.candidateId!,
            authorizationDecision: decision(plan.authorizationPlan!),
          },
          revision,
          generation,
        ),
        profileId,
      },
    )
  }
  return {
    root,
    homeDir,
    configPath,
    profileId,
    generation,
    lifecycle,
    managed,
    managedUI,
    gateway,
    participants,
    sessions,
    invocation,
    handle,
    call,
    install,
    leaseReady,
    releaseLease,
    configuredChannel,
    async close() {
      releaseLease.resolve()
      sessions.dispose()
      bootstrap.close()
      channelBridge?.close()
      management?.close()
      managedUI.dispose()
      participants.close()
      await lifecycle.close()
      await managed.dispose()
      await configuredChannel?.service.dispose()
      const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => await removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
      await rm(root, { recursive: true, force: true })
    },
  }
}
