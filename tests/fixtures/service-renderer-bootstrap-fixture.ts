import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, vi } from 'vitest'
import { SIMULATOR_CHANNEL_SERVICE_CONFIG } from '../../packages/channel-runtime/src/simulator.js'
import { ServiceRendererBootstrap } from '../../packages/cli/src/cli/service-renderer-bootstrap.js'
import type { DesktopManagerConfigProjection } from '../../packages/cli/src/cli/desktop-manager-config-projection.js'
import { createConfiguredChannelOwner } from '../../packages/cli/src/cli/configured-channel-owner.js'
import { createManagerRendererServiceConfigChannel } from '../../packages/cli/src/cli/manager-renderer-service-config.js'
import { createManagerRendererChannelCredentials } from '../../packages/cli/src/cli/manager-renderer-channel-credentials.js'
import { createManagerRendererManagementChannel } from '../../packages/cli/src/cli/manager-renderer-management.js'
import { openPluginManagementService } from '../../packages/cli/src/management/service.js'
import { channelConfigurationApi } from '../../packages/cli/src/cli/renderer-channel-composition.js'
import { ReadonlyChannelRendererBridge } from '../../packages/cli/src/cli/readonly-channel-renderer-bridge.js'
import { ServiceRendererParticipants } from '../../packages/cli/src/cli/service-renderer-participant.js'
import { createServiceRendererProjector } from '../../packages/cli/src/cli/service-renderer-projection.js'
import {
  type ManagerRendererChannelContext,
  ManagerRendererSessions,
} from '../../packages/cli/src/cli/manager-renderer-sessions.js'
import { createProductionManagedServiceLifecycle } from '../../packages/cli/src/cli/production-managed-services.js'
import { createManagerManagedServiceUIBridge } from '../../packages/cli/src/cli/manager-managed-service-ui.js'
import { reserveServiceOwnerLifecycle } from '../../packages/cli/src/cli/service-owner-lifecycle-fence.js'
import { ServiceOwnerLifecycleRuntime } from '../../packages/cli/src/cli/service-owner-lifecycle-runtime.js'
import {
  createDefaultHomeConfig,
  type HomeConfigProfile,
  updateHomeConfigAtomic,
} from '../../packages/cli/src/config/home-config.js'
import { createLocalChannelService } from '../../packages/cli/src/launcher/channel-service.js'
import { loadConfig } from '../../packages/cli/src/launcher/config.js'
import { PluginActivationStore } from '../../packages/cli/src/launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../../packages/cli/src/launcher/plugin-lifecycle.js'
import { ManagerChannelCredentials } from '../../packages/cli/src/launcher/manager-channel-credentials.js'
import { LauncherSecretStore } from '../../packages/cli/src/launcher/secret-store.js'
import { persistPermissionPolicies } from '../../packages/cli/src/launcher/permission-rpc.js'
import {
  type PluginGenerationGraphLease,
  startPluginGenerationArtifactServer,
} from '../../packages/cli/src/launcher/plugin-generation-artifact-server.js'
import { removeStagedPluginPackage } from '../../packages/cli/src/launcher/plugin-package.js'
import { attachmentHomeDigest } from '../../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { ServiceRendererLifecycle } from '../../packages/cli/src/launcher/service-renderer-lifecycle.js'
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
    managedUiVersion?: 14 | 15
    managedUiSource?: string
    managedUiGrant?: boolean
    managedStartupConfig?: HomeConfigProfile['managedServiceStartupConfig']
    protectProfileInputs?: boolean
    writeDispatch?: (context: ManagerRendererChannelContext, payload: unknown) => Promise<unknown>
    readDispatch?: () => Promise<unknown>
    channelArchive?: string
    channelUiGrant?: boolean
    channelGrantOtherSource?: boolean
    channelOwnerMismatch?: boolean
    channelServiceConfig?: boolean
    channelCredentials?: boolean
    channelCredentialValidate?: () => Promise<void>
    channelCredentialCleanupFails?: boolean
    channelCredentialCommitUnknown?: boolean
    permissionProof?: ConstructorParameters<typeof ServiceRendererBootstrap>[0]['permissionProof']
    browserManagement?: boolean
    coordinateLifecycle?: boolean
    projectPluginConfig?: Pick<DesktopManagerConfigProjection, 'project' | 'clear'>
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
      connections: [
        ...SIMULATOR_CHANNEL_SERVICE_CONFIG.connections,
        ...(options.channelCredentials
          ? [{
            ref: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture-tenant' },
            adapterKind: 'feishu',
            enabled: false,
            transport: { mode: 'websocket' },
            secretRef: 'host-secret:channel/fixture-private-reference',
          }]
          : []),
      ],
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
  if (options.managedBackend || options.managedUiVersion) {
    const managedSource = options.managedUiSource ?? 'https://example.test/fixtures'
    await stageServiceModePlugin(
      root,
      homeDir,
      profileId,
      true,
      managedSource,
      `export const inject = ['managedServices'];
       export async function apply(ctx) {
         const result = await ctx.managedServices.get({ serviceId: 'gateway' });
         globalThis.__fixtureManagedStatus = result.status;
         if (result.status === 'available') globalThis.__fixtureManagedSnapshot = (await result.service.snapshot()).status;
       }`,
      options.managedUiVersion === undefined ? {} : {
        version: options.managedUiVersion,
        nodeConfig: options.managedStartupConfig !== undefined,
        uiPoints: ['manager.settings.navigation-items', 'manager.content', 'workspace.toolbar.items'],
      },
    )
    if (options.managedUiGrant) {
      const policies = exactDomPermissionPolicies(profileId, [{
        id: 'fixture-service',
        entry: '/fixture/entry.js',
        pointIds: ['manager.settings.navigation-items', 'manager.content', 'workspace.toolbar.items'],
      }]).map(policy => ({
        ...policy,
        key: { ...policy.key, identity: { ...policy.key.identity, source: managedSource } },
      }))
      await persistPermissionPolicies({ configPath }, policies)
    }
  }
  if (options.managedStartupConfig) {
    await updateHomeConfigAtomic(current => ({
      ...current,
      apps: {
        ...current.apps,
        codex: {
          ...current.apps.codex!,
          profiles: {
            ...current.apps.codex!.profiles,
            [profileId]: {
              ...current.apps.codex!.profiles[profileId]!,
              managedServiceStartupConfig: options.managedStartupConfig,
            },
          },
        },
      },
    }), configPath)
  }
  const scope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: 'codex', profileId, generation }
  const participants = new ServiceRendererParticipants(scope)
  let bootstrap!: ServiceRendererBootstrap
  let sessions!: ManagerRendererSessions
  let managedUI!: ReturnType<typeof createManagerManagedServiceUIBridge>
  const leaseReady = defer<PluginGenerationGraphLease>()
  const releaseLease = defer<void>()
  const lifecycle = new ServiceRendererLifecycle({
    scope,
    projectMutation: createServiceRendererProjector({
      homeDir,
      profileId,
      generation,
      isLive: identity => participants.isLive(identity),
      canMutate: identity => participants.canMutate(identity),
      canProjectIdentity: identity => bootstrap?.canProjectLifecycle(identity) === true,
      projectIdentity: async (mutation, identity, stage) => {
        if (!bootstrap) throw new Error('renderer-projection-session-unavailable')
        return await bootstrap.projectLifecycleMutation(mutation, identity, stage)
      },
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
    startupConfig: options.managedStartupConfig,
    dryRun: false,
    requireOwnedProcess: true,
  })
  const coordinatedRuntime = options.coordinateLifecycle
    ? new ServiceOwnerLifecycleRuntime({
      runtime: managed,
      reserve: mutation => {
        if (!sessions?.hasLiveRenderers()) return undefined
        return reserveServiceOwnerLifecycle({
          mutation,
          management: {
            hasLive: () => sessions.hasLiveRenderers(),
            admitted: peer => sessions.hasAdmittedPeer(peer),
            reserveWrites: async () => await sessions.suspendMutationsForLifecycle(),
          },
          bootstrap,
          managedUI,
          lifecycle,
          participants,
        })
      },
    })
    : managed
  const coordinator = new PluginLifecycleCoordinator({
    homeDir,
    profileId,
    runtimeGeneration: generation,
    permissionPolicies: [],
    runtime: coordinatedRuntime,
    headless: true,
    reservedPluginIds: configuredChannel === undefined ? [] : [configuredChannel.plugin.id],
  })
  await coordinator.recover()
  lifecycle.initialize(await store.bindRuntimeGeneration())
  const startup = await managed.initialize(await store.loadActive())
  await Promise.all([startup.coreReady, startup.adopted])
  await vi.waitFor(() => expect(managed.readManagedServiceUIFence()).toEqual(expect.any(Number)))
  managedUI = createManagerManagedServiceUIBridge({
    profileId,
    runtimeGeneration: generation,
    ownerGeneration: generation,
    ownerCurrent: () => true,
    readLifecycleFence: () => managed.readManagedServiceUIFence(),
    runtime: managed,
  })
  bootstrap = new ServiceRendererBootstrap({
    homeDir,
    configPath,
    appId: 'codex',
    profileId,
    generation,
    ownerStartupConfig: options.managedStartupConfig,
    lifecycle,
    participants,
    store,
    managedServiceUI: managedUI,
    protectProfileInputs: options.protectProfileInputs === true,
    ...(options.projectPluginConfig === undefined ? {} : { projectPluginConfig: options.projectPluginConfig }),
    ...(options.browserManagement && options.coordinateLifecycle
      ? {
        restrictedManagement: {
          available: () => management?.discardExecutionPlan !== undefined,
          discardPlan: (token: string) => {
            if (!management?.discardExecutionPlan) throw new Error('fixture plan cleanup unavailable')
            management.discardExecutionPlan(token)
          },
        },
      }
      : {}),
    experimentalChannelServiceConfig: options.channelServiceConfig === true,
    experimentalChannelCredentials: options.channelCredentials === true,
    ...(options.permissionProof === undefined ? {} : { permissionProof: options.permissionProof }),
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
  const configuredOwner = configuredChannel === undefined ? undefined : createConfiguredChannelOwner({
    homeDir,
    configPath,
    profileId,
    plugin: configuredChannel.plugin,
    service: configuredChannel.service,
    ownerCurrent: () => true,
  })
  const serviceConfigChannel = options.channelServiceConfig && configuredChannel && configuredOwner
    ? createManagerRendererServiceConfigChannel({
      profileId,
      generation,
      configPath,
      plugin: configuredChannel.plugin,
      service: configuredChannel.service,
      authority: configuredOwner,
      bootstrap,
      participants,
      lifecycle,
      sessions: () => sessions,
    })
    : undefined
  const credentialValues = new Map<string, string>()
  let credentialCleanupFails = options.channelCredentialCleanupFails === true
  let credentialCommitUnknown = options.channelCredentialCommitUnknown === true
  const credentialStore = new LauncherSecretStore({
    platform: 'darwin',
    backend: {
      read: async (service, account) => credentialValues.get(`${service}/${account}`)!,
      upsert: async (service, account, value) => {
        credentialValues.set(`${service}/${account}`, value)
      },
      remove: async (service, account) => {
        if (credentialCleanupFails) throw new Error('synthetic cleanup failure')
        credentialValues.delete(`${service}/${account}`)
      },
      status: async () => 'set',
    },
  })
  const credentialManager = options.channelCredentials && configuredChannel && configuredOwner
    ? new ManagerChannelCredentials({
      profileId,
      runtimeGeneration: generation,
      generation: () => configuredChannel!.service.generation(),
      withOwner: async action => await configuredOwner.withOwner(action),
      openService: expectedServiceGeneration =>
        channelConfigurationApi({
          token: secret(),
          profileId,
          generation,
          configPath,
          plugin: configuredChannel!.plugin,
          service: configuredChannel!.service,
          persistence: configuredOwner.persistence,
          expectedServiceGeneration,
        }),
      store: credentialStore,
      validateCredentials: options.channelCredentialValidate ?? (async () => {}),
    })
    : undefined
  const credentialsChannel = credentialManager && configuredChannel && configuredOwner
    ? createManagerRendererChannelCredentials({
      profileId,
      generation,
      configPath,
      plugin: configuredChannel.plugin,
      service: configuredChannel.service,
      authority: configuredOwner,
      bootstrap,
      participants,
      lifecycle,
      sessions: () => sessions,
      handle: async operation => {
        const result = await credentialManager.handle(operation)
        if (
          credentialCommitUnknown && operation.action === 'commit'
          && result !== null && typeof result === 'object' && 'status' in result && result.status === 'applied'
        ) return { status: 'unknown', code: 'RESULT_UNKNOWN' }
        return result
      },
    })
    : undefined
  const management = options.browserManagement
    ? await openPluginManagementService({
      configPath,
      homeDir,
      appId: 'codex',
      profileId,
      watch: false,
      lifecycle: { coordinator, runtimeGeneration: generation, mode: 'service' },
    })
    : undefined
  sessions = new ManagerRendererSessions({
    profileId,
    ownerGeneration: generation,
    ownerCurrent: () => true,
    authenticateGateway: async value => value.instanceToken === gateway.instanceToken,
    writeLifetimes: bootstrap.writeLifetimes,
    readLifetimes: bootstrap.readLifetimes,
    ...(options.protectProfileInputs
      ? {
        waitForRetirement: async (rendererId: string) => {
          const results = await Promise.all([
            bootstrap.waitForRetirement(rendererId),
            credentialsChannel?.waitForRetirement(rendererId) ?? Promise.resolve(true),
          ])
          return results.every(Boolean)
        },
      }
      : {}),
    participant: participants.participant,
    channels: new Map([
      ...(management === undefined
        ? []
        : [['plugin-management', createManagerRendererManagementChannel(management, bootstrap)] as const]),
      ['manager-bootstrap', bootstrap.channel()],
      ['managed-service-ui', managedUI.channel],
      ...(channelBridge === undefined ? [] : [['channel-actions', channelBridge.channel] as const]),
      ...(serviceConfigChannel === undefined ? [] : [['service-config', serviceConfigChannel] as const]),
      ...(credentialsChannel === undefined ? [] : [['channel-credentials', credentialsChannel.channel] as const]),
      ...(options.writeDispatch === undefined ? [] : [
        [
          'fixture-write',
          {
            prepare: (payload: unknown, context: ManagerRendererChannelContext) => ({
              mode: 'write' as const,
              dispatch: async () => await options.writeDispatch!(context, payload),
            }),
          },
        ] as const,
      ]),
      ...(options.readDispatch === undefined ? [] : [
        ['fixture-read', { prepare: () => ({ mode: 'read' as const, dispatch: options.readDispatch! }) }] as const,
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
  async function installThroughManagement(id: string) {
    if (!management) throw new Error('fixture management is unavailable')
    const sourceDirectory = await localPackage({ root, id })
    const planned = await management.plan({ kind: 'plugin-plan-local', sourceDirectory })
    if (planned.status !== 'planned' || !planned.executionRequest) {
      throw new Error('fixture management planning failed')
    }
    return await management.execute(planned.executionRequest, planned.snapshot.revision)
  }
  return {
    root,
    homeDir,
    configPath,
    profileId,
    generation,
    lifecycle,
    coordinator,
    bootstrap,
    channelBridge,
    managed,
    managedUI,
    gateway,
    participants,
    sessions,
    invocation,
    handle,
    call,
    install,
    installThroughManagement,
    leaseReady,
    releaseLease,
    configuredChannel,
    credentialValues,
    channelCredentialsEnabled: options.channelCredentials === true,
    setCredentialCleanupFailure(value: boolean) {
      credentialCleanupFails = value
    },
    setCredentialCommitUnknown(value: boolean) {
      credentialCommitUnknown = value
    },
    async close() {
      releaseLease.resolve()
      sessions.dispose()
      await bootstrap.close()
      await credentialManager?.close()
      management?.close()
      channelBridge?.close()
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
