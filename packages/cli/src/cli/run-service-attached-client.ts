import { randomBytes } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadValidatedConfigDocument, parseHomeConfig } from '../config/home-config.js'
import { CdpPluginLifecycleRuntime } from '../launcher/cdp.js'
import { loadConfig } from '../launcher/config.js'
import { codexHomeOfPlan, modelServiceLaunchHook } from '../launcher/model-service-projection.js'
import { type NativeSubmissionComposition } from '../launcher/native-submission-composition.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import {
  entityInstallationId,
  entityPluginGeneration,
  issueOwnerDocumentPrincipalToken,
  OwnerDocumentLeaseRegistry,
} from '../launcher/owner-document-rpc.js'
import {
  type PluginGenerationArtifactServer,
  startPluginGenerationArtifactServer,
} from '../launcher/plugin-generation-loader.js'
import { cleanupPrelaunch } from './injected-host-cleanup.js'
import { nativeSubmissionCatalogOptions } from './native-submission-catalog-options.js'
import { OwnerAdapterCdpClient } from './owner-adapter-cdp-client.js'
import { OwnerAdapterClient } from './owner-adapter-client.js'
import { OwnerAdapterLaunchIntent } from './owner-adapter-launch-intent.js'
import { createOwnerAdapterGraphBootstrap } from './owner-adapter-graph-bootstrap.js'
import { createOwnerAdapterManagement } from './owner-adapter-management.js'
import { loadOwnerAdapterMutation } from './owner-adapter-mutation.js'
import { prepareProductionHostBootstrap, type ProductionHostBootstrap } from './production-host-bootstrap.js'
import { rendererAgentContext } from './renderer-agent-context.js'
import { buildRendererComposition, loadActiveBrowserGraphs, type RendererComposition } from './renderer-composition.js'
import type { PreparedRunCommand } from './run-command-dispatch.js'
import {
  agentHistoryHost,
  codexHome,
  type CordisXCliRuntime,
  pluginIdentities,
  printPlan,
  rootFromConfigPath,
  runInjectedHost,
} from './run-support.js'
import { createStartupLifetime } from './startup-lifetime.js'
import { createSupervisorRuntime } from './supervisor-runtime.js'

async function readOwnerConfig(configPath: string) {
  return await loadValidatedConfigDocument(configPath, 'home config', value => ({
    home: parseHomeConfig(value),
    source: JSON.stringify(value),
  }))
}

/** Experimental native transport: shared authorities remain in the verified service process. */
export async function runServiceAttachedClient(
  prepared: PreparedRunCommand,
  runtime: CordisXCliRuntime,
): Promise<void> {
  const { invocation, stdout, environment, configPath, selection, appId } = prepared
  if (
    environment.CORDISX_EXPERIMENTAL_SERVICE_NATIVE_ADAPTER !== '1' || appId !== 'codex'
    || invocation.options.attach || invocation.options.dryRun
  ) throw new Error('service-attached native client is unavailable')
  const homeDir = rootFromConfigPath(configPath)
  const lifetime = createStartupLifetime(runtime.internalSignal)
  const ownerLost = new AbortController()
  const supervisor = await createSupervisorRuntime(environment)
  let client: OwnerAdapterClient | undefined
  let participant: OwnerAdapterCdpClient | undefined
  let artifacts: PluginGenerationArtifactServer | undefined
  let renderer: RendererComposition | undefined
  let bootstrap: ProductionHostBootstrap | undefined
  let submission: NativeSubmissionComposition | undefined
  let management: ReturnType<typeof createOwnerAdapterManagement> | undefined
  let handedOff = false
  try {
    client = await OwnerAdapterClient.connect({
      homeDir,
      appId,
      profileId: selection.profileId,
      onLost: () => {
        participant?.close()
        ownerLost.abort(new Error('CordisX service disconnected'))
        void supervisor.markClientDisconnected().catch(() => undefined)
      },
    })
    const owner = client
    const generation = owner.snapshot.active.runtimeGeneration
    const remoteTerminalProvider = { homeDir, profileId: selection.profileId, appIds: [appId], selectedAppId: appId }
    const clientRuntime: CordisXCliRuntime = { ...runtime, internalRemoteTerminalProvider: remoteTerminalProvider }
    const signal = AbortSignal.any([lifetime.signal, ownerLost.signal])
    bootstrap = await prepareProductionHostBootstrap(prepared, clientRuntime, {
      prelaunch: false,
      prepareNativeSubmission: true,
      signal,
      mainInspector: supervisor.mainInspector,
      markHostLaunched: async (pid, inspectorUrl, port) => await supervisor.markHostLaunched(pid, inspectorUrl, port),
    })
    if (!bootstrap.plan || bootstrap.debugPort === undefined) throw new Error('native client launch plan unavailable')
    const plan = bootstrap.plan
    const debugPort = bootstrap.debugPort
    const [configured, config, cwd] = await Promise.all([
      loadConfig(configPath, { profileId: selection.profileId, projectRoot: homeDir }),
      readOwnerConfig(configPath),
      realpath(runtime.cwd ?? process.cwd()).catch(() => path.resolve(runtime.cwd ?? process.cwd())),
    ])
    const { home, source } = config
    const fingerprint = environment.CORDISX_SUPERVISOR_FINGERPRINT
    const launchIntent = fingerprint === undefined ? undefined : new OwnerAdapterLaunchIntent({
      initialSource: source,
      initialFingerprint: fingerprint,
      launch: {
        options: invocation.options,
        hostArgs: invocation.hostArgs,
        dataMode: selection.dataMode,
        cwd,
        ...(environment.CODEX_HOME ? { codexHome: path.resolve(cwd, environment.CODEX_HOME) } : {}),
      },
      readSource: async () => (await readOwnerConfig(configPath)).source,
      publish: async (expected, next) => await supervisor.refreshClientFingerprint(expected, next),
    })
    const store = new PluginActivationStore(homeDir, selection.profileId, generation)
    const cdp = new CdpPluginLifecycleRuntime()
    cdp.initializeOwnerRegistryEpoch(owner.snapshot.registryEpoch)
    artifacts = await startPluginGenerationArtifactServer()
    const { activatedPlugins } = await loadActiveBrowserGraphs(store, owner.snapshot.active, {
      homeDir,
      artifactServer: artifacts,
      lifecycleRuntime: cdp,
    })
    const configuredIds = new Set(configured.plugins.map(plugin => plugin.id))
    if (activatedPlugins.some(plugin => configuredIds.has(plugin.id))) {
      throw new Error('configured plugin conflicts with a service-owned package')
    }
    const composition = { ...configured, plugins: [...configured.plugins, ...activatedPlugins] }
    const documentLeases = new OwnerDocumentLeaseRegistry({
      stable: pluginIdentities(configured).map(identity => ({ source: identity.source, pluginId: identity.id })),
      active: activatedPlugins.flatMap(plugin =>
        plugin.enabled && plugin.package !== undefined
          ? [{
            source: plugin.source ?? pathToFileURL(plugin.entry).href,
            pluginId: plugin.id,
            moduleGeneration: plugin.package.moduleGeneration,
          }]
          : []
      ),
    })
    cdp.setOwnerDocumentAuthority({
      leases: documentLeases,
      issue: (identity, moduleGeneration) => ({
        ...identity,
        moduleGeneration,
        installationId: entityInstallationId(selection.profileId, identity.pluginId),
        pluginGeneration: entityPluginGeneration(moduleGeneration),
        token: issueOwnerDocumentPrincipalToken(owner.documentSecret, {
          profileId: selection.profileId,
          generation,
          moduleGeneration,
          identity,
        }),
      }),
    })
    const lifecycleToken = randomBytes(32).toString('hex')
    const managementToken = randomBytes(32).toString('hex')
    const context = rendererAgentContext()
    management = createOwnerAdapterManagement(owner)
    renderer = await buildRendererComposition(composition, stdout, {
      appId,
      profileId: selection.profileId,
      ownerPolicyVerification: { publicKey: owner.policyPublicKey, rendererId: owner.rendererId },
      ...(selection.profile.iconTheme === undefined ? {} : { iconThemePreference: selection.profile.iconTheme }),
      permission: {
        profileId: selection.profileId,
        policies: home.permissions.filter(policy => policy.key.profileId === selection.profileId),
        persistent: false,
        ownerSnapshot: true,
      },
      generation,
      ownerDocumentSecret: owner.documentSecret,
      pluginLifecycle: {
        token: lifecycleToken,
        activation: owner.snapshot.active,
        registryEpoch: owner.snapshot.registryEpoch,
      },
      pluginManagement: { token: managementToken, profileId: selection.profileId },
      agentContextBridgeToken: context.token,
      productionGraph: true,
      ...(runtime.internalBuildRendererBundle === undefined
        ? {}
        : { internalBuildRendererBundle: runtime.internalBuildRendererBundle }),
    })
    const graphBootstrap = createOwnerAdapterGraphBootstrap({
      renderer,
      configured,
      configPath,
      profileId: selection.profileId,
      store,
      cdp,
      current: () => owner.current,
    })
    participant = new OwnerAdapterCdpClient({
      cdp,
      policyScope: { profileId: selection.profileId, generation, rendererId: owner.rendererId },
      ...(launchIntent === undefined
        ? {}
        : { onPolicyAdopted: async transition => await launchIntent.adopted(transition) }),
      loadMutation: async value =>
        await loadOwnerAdapterMutation({
          value,
          homeDir,
          profileId: selection.profileId,
          generation,
          rendererId: owner.rendererId,
        }),
    })
    if (bootstrap.nativeSubmissionBootstrap) {
      const { managedCatalog: _managedCatalog, providerBindings: _providerBindings, ...catalog } =
        nativeSubmissionCatalogOptions(
          homeDir,
          selection.profileId,
          selection.profile,
          environment,
          plan.environment,
          undefined,
          home.environmentVariables,
          home.providers,
          invocation.options,
        )
      void _managedCatalog
      void _providerBindings
      submission = await bootstrap.nativeSubmissionBootstrap.complete(
        {
          nativeProviderIds: [],
          prepareNativeConnection() {
            throw new Error('native provider belongs to the CordisX service')
          },
        },
        codexHome({ ...environment, ...plan.environment }),
        {
          ...catalog,
          nativeClientScope: { homeDir, profileId: selection.profileId },
          ownerModelServicesRead: async () => await owner.modelServicesRead(),
          remoteTerminalProvider,
          contextObserver: context.observer,
        },
      )
    }
    signal.throwIfAborted()
    printPlan(plan, stdout, 'launching')
    const runHost = runtime.internalRunInjectedHost ?? runInjectedHost
    const history = (runtime.internalAgentHistoryHost ?? agentHistoryHost)(
      { ...environment, ...plan.environment },
      configPath,
      `${appId}:${selection.profileId}:${selection.dataMode}`,
    )
    const input: Parameters<typeof runInjectedHost>[0] = {
      ...(submission === undefined ? {} : { nativeSubmission: submission.installation }),
      source: renderer.source,
      ...(renderer.newDocumentSource === undefined ? {} : { newDocumentSource: renderer.newDocumentSource }),
      hasLoopbackGraph: renderer.hasLoopbackGraph,
      pluginArtifactOrigin: artifacts.origin,
      productionGraphBootstrap: graphBootstrap,
      agentHistoryHost: history,
      agentHistoryBridgeToken: renderer.agentHistoryBridgeToken,
      remoteOwnerDocuments: { request: async payload => await owner.documentBinding(payload) },
      remoteMarketplaceArtifact: { request: async (payload, signal) => await owner.artifact(payload, signal) },
      agentContext: context.binding,
      remotePluginLifecycle: {
        scope: { token: lifecycleToken, profileId: selection.profileId, generation },
        request: async envelope => await owner.lifecycle(envelope),
        runtime: cdp,
      },
      pluginManagement: {
        token: managementToken,
        profileId: selection.profileId,
        generation,
        service: management,
        ownerCoordinated: true,
      },
      executable: plan.executable,
      beforeHostLaunch: modelServiceLaunchHook(home, codexHomeOfPlan(plan), invocation.options, stdout),
      debugPort,
      hostArgs: invocation.hostArgs,
      launcher: invocation.options,
      signal: lifetime.signal,
      ownerSignal: ownerLost.signal,
      onReady: async readySignal => {
        readySignal?.throwIfAborted()
        ownerLost.signal.throwIfAborted()
        if (!await owner.admit(async command => await participant!.handle(command))) {
          throw new Error('CordisX service rejected the native client')
        }
        readySignal?.throwIfAborted()
        ownerLost.signal.throwIfAborted()
        const publicationSignal = readySignal === undefined
          ? ownerLost.signal
          : AbortSignal.any([readySignal, ownerLost.signal])
        await supervisor.markReady(debugPort, submission?.installation.accountCapability, publicationSignal)
        await launchIntent?.markReady()
        ownerLost.signal.throwIfAborted()
      },
      onHostLaunched: async (pid, inspectorUrl) => await supervisor.markHostLaunched(pid, inspectorUrl, debugPort),
      mainInspector: supervisor.mainInspector,
      ...(supervisor.startupNavigation === undefined ? {} : { startupNavigation: supervisor.startupNavigation }),
      ...(bootstrap.profile === undefined ? {} : { profile: bootstrap.profile }),
      ...(bootstrap.profileLease === undefined ? {} : { profileLease: bootstrap.profileLease }),
      environment: { ...submission?.environment },
      stdout,
    }
    handedOff = true
    await runHost(input)
  } catch (error) {
    await supervisor.markFailed(error instanceof Error ? error.message : String(error)).catch(() => undefined)
    throw error
  } finally {
    lifetime.abort()
    participant?.close()
    management?.close()
    await client?.close().catch(() => undefined)
    await bootstrap?.nativeSubmissionBootstrap?.close().catch(() => undefined)
    if (!handedOff) await cleanupPrelaunch(undefined, bootstrap?.profile, bootstrap?.profileLease?.release)
    await submission?.close().catch(() => undefined)
    await renderer?.close().catch(() => undefined)
    await artifacts?.close().catch(() => undefined)
    await supervisor.close()
    lifetime.close()
  }
}
