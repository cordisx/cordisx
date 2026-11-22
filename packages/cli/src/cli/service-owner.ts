import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { startHeadlessService } from './headless-service.js'
import { loadHomeConfig } from '../config/home-config.js'
import { mergeHomeEnvironment } from '../config/home-config-environment.js'
import { diagnostic, diagnosticError, diagnosticId, withDiagnostics } from '../diagnostics/context.js'
import { journalDirectory, LocalJournal } from '../diagnostics/journal.js'
import { safeDiagnosticMessage } from '../launcher/diagnostic-redaction.js'
import { acquireProfileRuntimeOwner } from '../launcher/profile-runtime-owner.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { ManagedCatalogComposition } from '../launcher/model-catalog/managed-catalog-composition.js'
import { resolveOwningPackageVersion } from '../launcher/package-version.js'
import { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { attachmentHomeDigest } from '../launcher/renderer-lifecycle-peer.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { createServiceRendererProjector } from './service-renderer-projection.js'
import { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import { createManagerRendererModelServicesChannel } from './manager-renderer-model-services.js'
import { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import { startServiceModelApi } from '../launcher/service-model-api.js'
import { createServiceTerminalProvider } from '../launcher/service-terminal-provider.js'
import { createHeadlessCodexOperations } from '../launcher/headless-codex-operations.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { createProductionManagedServiceLifecycle } from './production-managed-services.js'
import { openProductionPluginManagementComposition } from './production-plugin-management.js'
import { createManagerChannelCredentials } from './manager-channel-credentials-composition.js'
import { createConfiguredChannelOwner } from './configured-channel-owner.js'
import { type CordisXCliRuntime, waitForAbort } from './run-support.js'
import { createStartupLifetime } from './startup-lifetime.js'
import { createSupervisorRuntime } from './supervisor-runtime.js'

/** Internal child entry. A published supervisor generation is required before opening any services. */
export async function runServiceOwner(runtime: CordisXCliRuntime): Promise<void> {
  const environment = runtime.env ?? process.env
  const homeDir = environment.CORDISX_SUPERVISOR_HOME
  const appId = environment.CORDISX_SUPERVISOR_APP
  const profileId = environment.CORDISX_SUPERVISOR_PROFILE
  if (
    !homeDir || !appId || !profileId || !environment.CORDISX_SUPERVISOR_TOKEN_FILE
    || environment.CORDISX_SUPERVISOR_FINGERPRINT !== 'service'
  ) {
    throw new Error('Use cordisx start --mode service')
  }
  const lifetime = createStartupLifetime(runtime.internalSignal)
  const journal = new LocalJournal({
    directory: journalDirectory(homeDir, 'service:' + appId, profileId),
    version: await resolveOwningPackageVersion(import.meta.url, 'cordisx'),
    launchId: environment.CORDISX_DIAGNOSTIC_LAUNCH_ID ?? diagnosticId(),
  })
  try {
    await withDiagnostics(journal, async () => {
      const configPath = path.join(homeDir, 'config.json')
      const supervisor = await createSupervisorRuntime(environment)
      const generation = randomUUID()
      const store = new PluginActivationStore(homeDir, profileId, generation)
      let services: ReturnType<typeof createProductionManagedServiceLifecycle> | undefined
      let managed: ManagedCatalogComposition | undefined
      let api: Awaited<ReturnType<typeof startServiceModelApi>> | undefined
      let management: Awaited<ReturnType<typeof openProductionPluginManagementComposition>> | undefined
      let terminalProvider: ReturnType<typeof createServiceTerminalProvider> | undefined
      let channel: Awaited<ReturnType<typeof startHeadlessService>> | undefined
      let managerChannel: ReturnType<typeof createManagerChannelCredentials> = undefined
      let releaseRuntimeOwner: (() => Promise<void>) | undefined
      let certified: LauncherMarketplaceCertifiedAuthority | undefined
      let rendererLifecycle: ServiceRendererLifecycle | undefined
      let rendererParticipants: ServiceRendererParticipants | undefined
      let rendererBootstrap: ServiceRendererBootstrap | undefined
      let rendererReadonlyChannel: ReadonlyChannelRendererBridge | undefined
      let rendererManagedServiceUI: ReturnType<typeof createManagerManagedServiceUIBridge> | undefined
      let ownerOpen = true
      let failure: unknown
      const stopServices = () => {
        void services?.dispose().catch(() => undefined)
      }
      lifetime.signal.addEventListener('abort', stopServices, { once: true })
      try {
        lifetime.signal.throwIfAborted()
        releaseRuntimeOwner = await acquireProfileRuntimeOwner(homeDir, profileId)
        const loadPolicies = async () =>
          (await loadHomeConfig(configPath)).permissions.filter(
            policy => policy.key.profileId === profileId,
          )
        const config = await loadHomeConfig(configPath)
        const rendererScope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: appId, profileId, generation }
        rendererParticipants = new ServiceRendererParticipants(rendererScope)
        rendererLifecycle = new ServiceRendererLifecycle({
          scope: rendererScope,
          projectMutation: createServiceRendererProjector({
            homeDir,
            profileId,
            generation,
            isLive: identity => rendererParticipants!.isLive(identity),
            canMutate: identity => rendererParticipants!.canMutate(identity),
          }),
        })
        rendererParticipants.bind(rendererLifecycle)
        services = createProductionManagedServiceLifecycle({
          runtime: rendererLifecycle,
          homeDir,
          profileId,
          generation,
          environment,
          store,
          startupConfig: config.apps[appId]?.profiles[profileId]?.managedServiceStartupConfig,
          dryRun: false,
          requireOwnedProcess: true,
        })
        rendererManagedServiceUI = createManagerManagedServiceUIBridge({
          profileId,
          runtimeGeneration: generation,
          ownerGeneration: generation,
          ownerCurrent: () => ownerOpen && !lifetime.signal.aborted,
          readLifecycleFence: () => services!.readManagedServiceUIFence(),
          runtime: services,
        })
        certified = await LauncherMarketplaceCertifiedAuthority.open({ homeDir, configPath, profileId })
          .catch(() => undefined)
        const coordinator = new PluginLifecycleCoordinator({
          homeDir,
          profileId,
          runtimeGeneration: generation,
          runtime: services,
          headless: true,
          permissionPolicies: await loadPolicies(),
          loadPermissionPolicies: loadPolicies,
          // A configured plugin and an installed package cannot share an id
          // in the same profile, including when the configured entry is disabled.
          reservedPluginIds: config.plugins.map(plugin => plugin.id),
          ...(certified === undefined ? {} : {
            certifiedPermissionForArtifact: async artifact =>
              (await certified?.lookup(artifact).catch(() => undefined))?.projection as
                | CordisXCertifiedPermissionProjectionV1
                | undefined,
          }),
        })
        await coordinator.recover()
        managed = await ManagedCatalogComposition.open({
          homeDir,
          profileId,
          responsesAvailable: true,
          environment: () => mergeHomeEnvironment(environment, config.environmentVariables),
        }).catch(error => {
          diagnostic({ event: 'service-managed-catalog-unavailable', ...diagnosticError(error) })
          return undefined
        })
        api = await startServiceModelApi({
          homeDir,
          profileId,
          configPath,
          environment,
          activation: services.nativeActivation(),
          ...(managed === undefined ? {} : { managed }),
        })
        const active = await store.bindRuntimeGeneration()
        rendererLifecycle.initialize(active)
        const startup = await services.initialize(active)
        await startup.coreReady
        terminalProvider = createServiceTerminalProvider({
          activation: services.nativeActivation(),
          ...(managed === undefined ? {} : { managed }),
        })
        lifetime.signal.removeEventListener('abort', stopServices)
        lifetime.signal.throwIfAborted()
        if (appId === 'codex') {
          const userHome = environment.HOME || os.homedir()
          channel = await startHeadlessService({
            configPath,
            homeDir,
            appId,
            profileId,
            generation,
            profileOwnerVerified: releaseRuntimeOwner !== undefined,
            userHome,
            codexHome: environment.CODEX_HOME || path.join(userHome, '.codex'),
            codexExecutable: 'codex',
            cwd: userHome,
            environment,
            report: code => diagnostic({ event: 'service-channel-error', code }),
          })
        }
        lifetime.signal.throwIfAborted()
        managerChannel = createManagerChannelCredentials({
          plugin: channel?.managerChannelOwner?.plugin,
          service: channel?.managerChannelOwner?.service,
          lifecycle: services,
          configPath,
          profileId,
          generation,
          ownerCurrent: () => ownerOpen && !lifetime.signal.aborted,
        }, releaseRuntimeOwner !== undefined)
        const protectProfileInputs = process.platform === 'darwin' || process.platform === 'linux'
        const channelOwner = channel?.managerChannelOwner
        if (
          protectProfileInputs && releaseRuntimeOwner !== undefined && channelOwner
          && channelOwner.plugin.configuredArchiveDigest !== undefined
          && channelOwner.plugin.package === undefined && channelOwner.plugin.development === undefined
        ) {
          rendererReadonlyChannel = new ReadonlyChannelRendererBridge({
            profileId,
            generation,
            isCurrent: context =>
              ownerOpen && !lifetime.signal.aborted
              && rendererParticipants?.peer(context.rendererId) !== undefined,
          })
        }
        const configuredServiceOwner = rendererReadonlyChannel && channelOwner
          ? createConfiguredChannelOwner({
            homeDir,
            configPath,
            profileId,
            plugin: channelOwner.plugin,
            service: channelOwner.service,
            ownerCurrent: () => ownerOpen && !lifetime.signal.aborted,
          })
          : undefined
        rendererBootstrap = new ServiceRendererBootstrap({
          homeDir,
          configPath,
          appId,
          profileId,
          generation,
          lifecycle: rendererLifecycle,
          participants: rendererParticipants,
          store,
          managedServiceUI: rendererManagedServiceUI,
          protectProfileInputs,
          experimentalChannelServiceConfig: configuredServiceOwner !== undefined,
          experimentalChannelCredentials: configuredServiceOwner !== undefined && managerChannel !== undefined,
          ...(rendererReadonlyChannel === undefined || channelOwner === undefined ? {} : {
            experimentalConfiguredChannel: { ...channelOwner, bridge: rendererReadonlyChannel },
          }),
        })
        const codex = channel?.codex ?? createHeadlessCodexOperations({
          configPath,
          environment,
          closed: () => lifetime.signal.aborted,
        })
        const rendererModelServices = createManagerRendererModelServicesChannel({
          profileId,
          generation,
          isCurrent: context =>
            ownerOpen && !lifetime.signal.aborted
            && rendererParticipants?.peer(context.rendererId) !== undefined,
          call: codex,
        })
        management = await openProductionPluginManagementComposition({
          homeDir,
          profileId,
          configPath,
          appId,
          runtimeGeneration: generation,
          token: randomUUID(),
          coordinator,
          rendererParticipant: rendererParticipants.participant,
          rendererParticipants,
          rendererLifecycle,
          rendererBootstrap: rendererBootstrap.channel(),
          rendererManagementAuthority: rendererBootstrap,
          rendererRetirement: rendererId => rendererBootstrap!.waitForRetirement(rendererId),
          rendererWriteLifetimes: rendererBootstrap.writeLifetimes,
          rendererReadLifetimes: rendererBootstrap.readLifetimes,
          rendererManagedServiceUI: rendererManagedServiceUI.channel,
          rendererModelServices,
          ...(rendererReadonlyChannel === undefined
            ? {}
            : { rendererReadonlyChannel: rendererReadonlyChannel.channel }),
          ...(configuredServiceOwner === undefined || channelOwner === undefined ? {} : {
            rendererConfiguredChannelService: {
              bootstrap: rendererBootstrap,
              plugin: channelOwner.plugin,
              service: channelOwner.service,
              authority: configuredServiceOwner,
            },
          }),
          mode: 'service',
          managerServiceAuth: operation => services!.managerAuth(operation),
          ...(managerChannel === undefined
            ? {}
            : { managerChannelCredentials: operation => managerChannel!.handle(operation) }),
          terminalProvider: request => terminalProvider!.request(request),
          ...(channel?.channel === undefined
            ? {}
            : {
              channel: (operation: string, value: unknown, metadata?: unknown) =>
                channel!.channel!.tools.callLocal(operation, value, metadata),
            }),
          codex,
        })
        await supervisor.markServiceReady(api.baseUrl, lifetime.signal)
        diagnostic({ event: 'service-ready' })
        await waitForAbort(lifetime.signal)
      } catch (error) {
        if (!lifetime.signal.aborted) failure = error
      } finally {
        ownerOpen = false
        lifetime.signal.removeEventListener('abort', stopServices)
        for (
          const close of [
            () => api?.close(),
            async () => {
              if (rendererBootstrap && !await rendererBootstrap.close()) {
                throw new Error('renderer-bootstrap-retirement-unconfirmed')
              }
            },
            () => rendererReadonlyChannel?.close(),
            () => rendererManagedServiceUI?.dispose(),
            () => rendererParticipants?.close(),
            () => rendererLifecycle?.close(),
            () => management?.close(),
            () => managerChannel?.close(),
            () => terminalProvider?.close(),
            () => channel?.close(),
            () => services?.dispose(),
            () => managed?.close(),
            () => certified?.dispose(),
            () => releaseRuntimeOwner?.(),
          ]
        ) {
          try {
            await close()
          } catch (error) {
            failure ??= error
          }
        }
        if (failure !== undefined) {
          diagnostic({ event: 'service-failed', ...diagnosticError(failure) })
          await supervisor.markFailed(safeDiagnosticMessage(failure)).catch(() => undefined)
        }
        await supervisor.close()
      }
      if (failure !== undefined) throw failure
    })
  } finally {
    lifetime.close()
    await journal.close()
  }
}
