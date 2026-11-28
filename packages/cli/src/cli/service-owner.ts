import { randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { startHeadlessService } from './headless-service.js'
import { loadHomeConfig } from '../config/home-config.js'
import { loadConfig } from '../launcher/config.js'
import { mergeHomeEnvironment } from '../config/home-config-environment.js'
import { diagnostic, diagnosticError, diagnosticId, withDiagnostics } from '../diagnostics/context.js'
import { journalDirectory, LocalJournal } from '../diagnostics/journal.js'
import { safeDiagnosticMessage } from '../launcher/diagnostic-redaction.js'
import { acquireProfileRuntimeOwner } from '../launcher/profile-runtime-owner.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { ModelApiLifecycleUnavailable, TerminalLifecycleUnavailable } from '../launcher/plugin-lifecycle-model.js'
import { ManagedCatalogComposition } from '../launcher/model-catalog/managed-catalog-composition.js'
import { resolveOwningPackageVersion } from '../launcher/package-version.js'
import { ServiceRendererLifecycle } from '../launcher/service-renderer-lifecycle.js'
import { attachmentHomeDigest, attachmentRecord } from '../launcher/renderer-lifecycle-peer.js'
import {
  handlePluginLifecycleBindingRequest,
  parsePluginLifecycleBindingRequest,
} from '../launcher/plugin-lifecycle-rpc.js'
import { handlePluginManagementRpcRequest, parsePluginManagementRpcRequest } from '../launcher/management-rpc.js'
import { ServiceRendererParticipants } from './service-renderer-participant.js'
import { createServiceRendererProjector } from './service-renderer-projection.js'
import { ServiceRendererBootstrap } from './service-renderer-bootstrap.js'
import { ReadonlyChannelRendererBridge } from './readonly-channel-renderer-bridge.js'
import { createManagerRendererModelServicesChannel } from './manager-renderer-model-services.js'
import { createManagerRendererNativeCatalogChannel } from './manager-renderer-native-catalog.js'
import { createManagerManagedServiceUIBridge } from './manager-managed-service-ui.js'
import { startServiceModelApi } from '../launcher/service-model-api.js'
import { createServiceTerminalProvider } from '../launcher/service-terminal-provider.js'
import { reserveManagedServiceClients } from '../launcher/managed-service-client-reservation.js'
import { createHeadlessCodexOperations } from '../launcher/headless-codex-operations.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { createProductionManagedServiceLifecycle } from './production-managed-services.js'
import { openProductionPluginManagementComposition } from './production-plugin-management.js'
import { createManagerChannelCredentials } from './manager-channel-credentials-composition.js'
import { startServiceManager } from './manager-supervisor.js'
import { createConfiguredChannelOwner } from './configured-channel-owner.js'
import {
  includeClientLifecycleFence,
  lifecycleAffectedPlugins,
  reserveServiceOwnerLifecycle,
} from './service-owner-lifecycle-fence.js'
import { ServiceOwnerLifecycleRuntime } from './service-owner-lifecycle-runtime.js'
import { OwnerAdapterSessions } from './owner-adapter-sessions.js'
import {
  inspectMarketplaceArtifactPackage,
  parseMarketplaceArtifactBindingRequest,
  previewMarketplaceArtifactPackage,
} from '../launcher/marketplace-artifact.js'
import { createOwnerAdapterDocuments } from './owner-adapter-documents.js'
import { readModelServices } from '../launcher/model-service-store.js'
import { ManagerPermissionProofAuthority } from './manager-permission-proof-authority.js'
import { ServiceOwnerPermissionConsumers } from './service-owner-permission-consumers.js'
import { PermissionDecisionJournal } from './permission-decision-journal.js'
import { createOwnerAdapterPermissionHistory } from './owner-adapter-permission-history.js'
import { OwnerAdapterPermissionProof } from './owner-adapter-permission-proof.js'
import { createOwnerAdapterPermissionPolicy } from './owner-adapter-permission-policy.js'
import { ownerAdapterInstalledPermissionTarget } from './owner-adapter-permission-target.js'
import type { OwnerAdapterManagementContext } from './owner-adapter-sessions.js'
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
      let serviceManager: Awaited<ReturnType<typeof startServiceManager>> | undefined
      let releaseRuntimeOwner: (() => Promise<void>) | undefined
      let certified: LauncherMarketplaceCertifiedAuthority | undefined
      let rendererLifecycle: ServiceRendererLifecycle | undefined
      let rendererParticipants: ServiceRendererParticipants | undefined
      let nativeAdapters: OwnerAdapterSessions | undefined
      let rendererBootstrap: ServiceRendererBootstrap | undefined
      let rendererReadonlyChannel: ReadonlyChannelRendererBridge | undefined
      let rendererManagedServiceUI: ReturnType<typeof createManagerManagedServiceUIBridge> | undefined
      let rendererPermissionProof: ManagerPermissionProofAuthority | undefined
      let rendererPermissionConsumers: ServiceOwnerPermissionConsumers | undefined
      let nativePermissionProof: OwnerAdapterPermissionProof | undefined
      let ownerOpen = true
      let serviceReady = false
      let webUnavailable = false
      let webRetirement: Promise<void> | undefined
      let webRetirementFailure: unknown
      let failure: unknown
      const retireUnavailableWeb = () => {
        webRetirement ??= (async () => {
          try {
            await supervisor.markServiceWebUnavailable()
          } catch (error) {
            diagnostic({ event: 'service-web-status-failed', ...diagnosticError(error) })
          }
          try {
            await serviceManager?.close()
            serviceManager = undefined
          } catch (error) {
            webRetirementFailure ??= error ?? new Error('service web cleanup failed')
            diagnostic({ event: 'service-web-cleanup-failed', ...diagnosticError(error) })
          }
        })()
      }
      const stopServices = () => {
        void services?.dispose().catch(() => undefined)
      }
      lifetime.signal.addEventListener('abort', stopServices, { once: true })
      try {
        lifetime.signal.throwIfAborted()
        const webEnabled = environment.CORDISX_WEB_ENABLED
        if (webEnabled !== undefined && webEnabled !== '0' && webEnabled !== '1') {
          throw new Error('invalid CordisX Web setting')
        }
        releaseRuntimeOwner = await acquireProfileRuntimeOwner(homeDir, profileId)
        const loadPolicies = async () =>
          (await loadHomeConfig(configPath)).permissions.filter(
            policy => policy.key.profileId === profileId,
          )
        const decisionJournal = new PermissionDecisionJournal({ homeDir, profileId })
        const permissionHistory = createOwnerAdapterPermissionHistory({
          profileId,
          journal: decisionJournal,
          loadPolicies,
          reviewIdentity: async (pluginId, context) => {
            if (!rendererLifecycle) return undefined
            const target = await ownerAdapterInstalledPermissionTarget({
              homeDir,
              profileId,
              generation,
              pluginId,
              context: context as OwnerAdapterManagementContext,
              lifecycle: rendererLifecycle,
            }).catch(() => undefined)
            return target && { identity: target.ownerIdentity, isCurrent: target.isCurrent }
          },
        })
        const config = await loadHomeConfig(configPath)
        const rendererScope = { homeDigest: attachmentHomeDigest(homeDir), ownerAppId: appId, profileId, generation }
        rendererParticipants = new ServiceRendererParticipants(rendererScope)
        rendererLifecycle = new ServiceRendererLifecycle({
          scope: rendererScope,
          projectMutation: createServiceRendererProjector({
            homeDir,
            profileId,
            generation,
            isLive: identity => rendererParticipants!.isLive(identity) || nativeAdapters?.isLive(identity) === true,
            canMutate: identity =>
              rendererParticipants!.canMutate(identity) || nativeAdapters?.isLive(identity) === true,
            canProjectIdentity: identity => rendererBootstrap?.canProjectLifecycle(identity) === true,
            projectIdentity: async (mutation, identity, stage) => {
              if (!rendererBootstrap) throw new Error('renderer-projection-session-unavailable')
              return await rendererBootstrap.projectLifecycleMutation(mutation, identity, stage)
            },
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
        const managerConsoleOrigins = await services.browserConsoleLaunch.prepareStandalone(lifetime.signal)
          .catch(() => undefined)
        rendererManagedServiceUI = createManagerManagedServiceUIBridge({
          profileId,
          runtimeGeneration: generation,
          ownerGeneration: generation,
          ownerCurrent: () => ownerOpen && !lifetime.signal.aborted,
          readLifecycleFence: () => services!.readManagedServiceUIFence(),
          allowAuthentication: true,
          allowLogout: true,
          allowAccountReads: true,
          allowAccountToggle: true,
          ...(managerConsoleOrigins === undefined ? {} : { browserConsoleOrigins: managerConsoleOrigins }),
          runtime: services,
        })
        certified = await LauncherMarketplaceCertifiedAuthority.open({ homeDir, configPath, profileId })
          .catch(() => undefined)
        const coordinatorRuntime = new ServiceOwnerLifecycleRuntime({
          runtime: services,
          reserve: mutation => {
            const affected = lifecycleAffectedPlugins(mutation)
            const terminal = terminalProvider?.reserveForLifecycle(affected)
            if (terminalProvider && !terminal) throw new TerminalLifecycleUnavailable()
            const release = (reservation: typeof terminal) => {
              if (!reservation) return
              try {
                if (!reservation.release()) reservation.fence()
              } catch {
                try {
                  reservation.fence()
                } catch { /* Preserve the original admission failure. */ }
              }
            }
            let modelApi: ReturnType<NonNullable<typeof api>['reserveForLifecycle']>
            try {
              modelApi = api?.reserveForLifecycle(affected)
              if (api && !modelApi) throw new ModelApiLifecycleUnavailable()
            } catch (error) {
              release(modelApi)
              release(terminal)
              throw error
            }
            const withAdapters = (adapters?: ReturnType<OwnerAdapterSessions['reserve']>) => {
              const releaseClients = () => {
                release(adapters)
                release(modelApi)
                release(terminal)
              }
              const withClients = (
                manager?: import('./service-owner-lifecycle-fence.js').ServiceOwnerLifecycleFence,
              ) => {
                let fence = manager
                if (terminal) fence = includeClientLifecycleFence(terminal, fence)
                if (modelApi) fence = includeClientLifecycleFence(modelApi, fence)
                if (adapters) fence = includeClientLifecycleFence(adapters, fence)
                return fence
              }
              const managers = management?.lifecycleParticipants
              if (!managers || !managers.hasLive()) return withClients()
              if (!rendererBootstrap || !rendererManagedServiceUI || !rendererLifecycle || !rendererParticipants) {
                releaseClients()
                throw new Error('manager-lifecycle-fence-unavailable')
              }
              return reserveServiceOwnerLifecycle({
                mutation,
                management: managers,
                bootstrap: rendererBootstrap,
                managedUI: rendererManagedServiceUI,
                lifecycle: rendererLifecycle,
                participants: rendererParticipants,
              }).then(
                manager => withClients(manager),
                error => {
                  releaseClients()
                  throw error
                },
              )
            }
            if (management !== undefined && nativeAdapters) {
              return nativeAdapters.reserveForLifecycle().then(withAdapters, error => {
                release(modelApi)
                release(terminal)
                throw error
              })
            }
            return withAdapters()
          },
        })
        const coordinator = new PluginLifecycleCoordinator({
          homeDir,
          profileId,
          runtimeGeneration: generation,
          runtime: coordinatorRuntime,
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
        if (appId === 'codex') {
          const adapterLifecycleHandler = { token: randomUUID(), profileId, generation, coordinator }
          nativePermissionProof = new OwnerAdapterPermissionProof({ profileId, generation })
          const nativePermissionPolicy = createOwnerAdapterPermissionPolicy({
            homeDir,
            configPath,
            profileId,
            generation,
            lifecycle: rendererLifecycle,
            loadPolicies,
            journal: decisionJournal,
            proof: nativePermissionProof,
            runtime: () => {
              const fence = management?.fenceAdapterPermissionOrigin
              if (!rendererBootstrap || !rendererPermissionConsumers || !fence) return undefined
              return { bootstrap: rendererBootstrap, consumers: rendererPermissionConsumers, fence }
            },
          })
          const configured = await loadConfig(configPath, { profileId, projectRoot: homeDir })
          const documents = createOwnerAdapterDocuments({
            homeDir,
            profileId,
            generation,
            configured: configured.plugins,
            snapshot: () => rendererLifecycle!.snapshot(),
          })
          nativeAdapters = new OwnerAdapterSessions({
            scope: rendererScope,
            adapter: { appId: 'codex', adapterId: 'codex-desktop' },
            snapshot: () => rendererLifecycle!.snapshot(),
            attach: async peer => await rendererLifecycle!.attach(peer),
            ...(process.platform !== 'darwin' && process.platform !== 'linux' ? {} : {
              acquirePermissionFence: async () => {
                if (!rendererBootstrap) throw new Error('adapter-permission-fence-unavailable')
                return await rendererBootstrap.permissionAccess.acquireAdapterPermissionFence()
              },
            }),
            document: documents,
            modelServicesRead: async () => await readModelServices(configPath, environment),
            artifact: async (value, signal) => {
              const request = parseMarketplaceArtifactBindingRequest(value)
              if (request.kind === 'cancel') throw new Error('adapter-artifact-request-invalid')
              return request.kind === 'preview'
                ? await previewMarketplaceArtifactPackage(adapterLifecycleHandler, request.request, signal)
                : await inspectMarketplaceArtifactPackage(adapterLifecycleHandler, request.request, signal)
            },
            lifecycle: async value => {
              const envelope = attachmentRecord(value)
              if (Object.hasOwn(envelope, 'token')) throw new Error('adapter-lifecycle-request-invalid')
              const request = parsePluginLifecycleBindingRequest(
                { ...envelope, token: adapterLifecycleHandler.token },
                adapterLifecycleHandler,
              )
              return await handlePluginLifecycleBindingRequest(adapterLifecycleHandler, request)
            },
            management: async (value, context) => {
              const operation = attachmentRecord(value)
              if (operation.kind === 'permission-history') {
                return await permissionHistory(operation, context)
              }
              if (
                operation.kind === 'permission-key-register' || operation.kind === 'permission-policy-write'
                || operation.kind === 'permission-once'
              ) {
                return await nativePermissionPolicy(operation, context)
              }
              if (
                ![
                  'query',
                  'refresh-catalog',
                  'query-catalog',
                  'plugin-info',
                  'plan',
                  'execute',
                  'migrate-legacy-sources',
                ].includes(String(operation.kind)) || !management
              ) throw new Error('adapter-management-unavailable')
              const scope = { token: adapterLifecycleHandler.token, profileId }
              const request = parsePluginManagementRpcRequest({
                version: 1,
                requestId: `adapter-${randomUUID()}`,
                ...scope,
                operation,
              }, scope)
              return await handlePluginManagementRpcRequest(management.handler.service, request)
            },
            ownerCurrent: () => ownerOpen && management !== undefined && !lifetime.signal.aborted,
          })
        }
        const startup = await services.initialize(active)
        await startup.coreReady
        terminalProvider = createServiceTerminalProvider({
          activation: services.nativeActivation(),
          ...(managed === undefined ? {} : { managed }),
        })
        lifetime.signal.removeEventListener('abort', stopServices)
        lifetime.signal.throwIfAborted()
        const protectProfileInputs = process.platform === 'darwin' || process.platform === 'linux'
        const serviceOwnerBundledChannel = protectProfileInputs && releaseRuntimeOwner !== undefined
        if (appId === 'codex') {
          const userHome = environment.HOME || os.homedir()
          channel = await startHeadlessService({
            configPath,
            homeDir,
            appId,
            profileId,
            generation,
            profileOwnerVerified: releaseRuntimeOwner !== undefined,
            serviceOwnerBundledChannel,
            userHome,
            codexHome: environment.CODEX_HOME || path.join(userHome, '.codex'),
            codexExecutable: 'codex',
            cwd: userHome,
            environment,
            report: code => diagnostic({ event: 'service-channel-error', errorCode: code }),
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
        if (protectProfileInputs && releaseRuntimeOwner !== undefined) {
          rendererPermissionProof = new ManagerPermissionProofAuthority({
            profileId,
            generation,
            isCurrent: context =>
              ownerOpen && !lifetime.signal.aborted
              && rendererParticipants?.peer(context.rendererId) !== undefined,
          })
          rendererPermissionConsumers = new ServiceOwnerPermissionConsumers({
            profileId,
            generation,
            ...(channelOwner?.plugin.source === undefined ? {} : { channelSource: channelOwner.plugin.source }),
            participants: rendererParticipants,
            lifecycle: rendererLifecycle,
            ownerCurrent: () => ownerOpen && !lifetime.signal.aborted,
            loadPolicies,
            ...(nativeAdapters === undefined ? {} : { nativeAdapters }),
          })
        }
        rendererBootstrap = new ServiceRendererBootstrap({
          homeDir,
          configPath,
          appId,
          profileId,
          generation,
          ownerStartupConfig: config.apps[appId]?.profiles[profileId]?.managedServiceStartupConfig,
          lifecycle: rendererLifecycle,
          participants: rendererParticipants,
          store,
          managedServiceUI: rendererManagedServiceUI,
          protectProfileInputs,
          serviceOwnerBundledChannel,
          experimentalInstalledPermissionPolicy: rendererPermissionProof !== undefined
            && rendererPermissionConsumers !== undefined,
          experimentalConfiguredPluginPermissionPolicy: rendererPermissionProof !== undefined
            && rendererPermissionConsumers !== undefined,
          experimentalConfiguredPermissionPolicy: configuredServiceOwner !== undefined
            && rendererPermissionProof !== undefined && rendererPermissionConsumers !== undefined,
          ...(rendererPermissionProof === undefined ? {} : { permissionProof: rendererPermissionProof }),
          restrictedManagement: {
            available: () =>
              ownerOpen && !lifetime.signal.aborted
              && management?.lifecycleParticipants !== undefined
              && management.handler.service.discardExecutionPlan !== undefined,
            discardPlan: token => {
              const discard = management?.handler.service.discardExecutionPlan
              if (!discard) throw new Error('renderer-management-plan-cleanup-unavailable')
              discard(token)
            },
          },
          experimentalChannelServiceConfig: configuredServiceOwner !== undefined,
          experimentalChannelControl: configuredServiceOwner !== undefined,
          experimentalChannelReconnect: configuredServiceOwner !== undefined,
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
        const rendererNativeCatalog = appId === 'codex'
          ? createManagerRendererNativeCatalogChannel({
            configPath,
            codexHome: environment.CODEX_HOME || path.join(environment.HOME || os.homedir(), '.codex'),
            profileId,
            generation,
            isCurrent: context =>
              ownerOpen && !lifetime.signal.aborted
              && rendererParticipants?.peer(context.rendererId)?.closed === false,
          })
          : undefined
        management = await openProductionPluginManagementComposition({
          homeDir,
          profileId,
          configPath,
          appId,
          runtimeGeneration: generation,
          ...(managerConsoleOrigins === undefined ? {} : { managerConsoleOrigins }),
          token: randomUUID(),
          coordinator,
          ...(nativeAdapters === undefined ? {} : { ownerAdapterSessions: nativeAdapters }),
          rendererParticipant: rendererParticipants.participant,
          rendererParticipants,
          rendererLifecycle,
          rendererBootstrap: rendererBootstrap.channel(),
          ...(rendererBootstrap.documentChannel() === undefined
            ? {}
            : { rendererDocuments: rendererBootstrap.documentChannel()! }),
          rendererManagementAuthority: rendererBootstrap,
          rendererRetirement: rendererId => rendererBootstrap!.waitForRetirement(rendererId),
          rendererWriteLifetimes: rendererBootstrap.writeLifetimes,
          rendererReadLifetimes: rendererBootstrap.readLifetimes,
          rendererManagedServiceUI: rendererManagedServiceUI.channel,
          rendererModelServices,
          ...(rendererNativeCatalog === undefined ? {} : { rendererNativeCatalog }),
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
          ...(rendererPermissionProof === undefined || rendererPermissionConsumers === undefined ? {} : {
            rendererPermissionPolicy: {
              bootstrap: rendererBootstrap,
              proof: rendererPermissionProof,
              onFailure: (phase, error) =>
                diagnostic({
                  event: 'service-permission-handoff-failed',
                  phase,
                  ...diagnosticError(error),
                }),
              ...(nativeAdapters === undefined ? {} : {
                reserveAdditionalPeers: async () => await nativeAdapters!.reserveForLifecycle(),
              }),
              reserveOtherConsumers: async (origin, evidence) =>
                rendererPermissionConsumers!.reserve(origin, {
                  identity: evidence.ownerIdentity,
                  moduleGeneration: evidence.moduleGeneration,
                  isCurrent: () => rendererBootstrap!.permissionAccess.isCurrentEvidence(evidence),
                }),
            },
          }),
          mode: 'service',
          managerServiceAuth: operation => services!.managerAuth(operation),
          ...(managerChannel === undefined
            ? {}
            : { managerChannelCredentials: operation => managerChannel!.handle(operation) }),
          terminalProvider: request => terminalProvider!.request(request),
          reserveServiceClients: identity =>
            reserveManagedServiceClients(identity, [
              value => terminalProvider!.reserveForService(value),
              value => services!.reserveServiceClients(value),
            ]),
          reserveManagedAccountUI: async current => await rendererManagedServiceUI!.reserveAccountAction(current),
          ...(channel?.channel === undefined
            ? {}
            : {
              channel: (operation: string, value: unknown, metadata?: unknown) =>
                channel!.channel!.tools.callLocal(operation, value, metadata),
            }),
          codex,
        })
        if (webEnabled !== '0' && process.platform !== 'win32') {
          serviceManager = await startServiceManager({
            homeDir,
            profileId,
            appId,
            generation,
            environment,
            onUnavailable: () => {
              webUnavailable = true
              if (serviceReady) retireUnavailableWeb()
            },
          })
        }
        const webStatus = webEnabled === '0'
          ? 'disabled'
          : webUnavailable || serviceManager === undefined
          ? 'unavailable'
          : 'ready'
        await supervisor.markServiceReady(api.baseUrl, lifetime.signal, {
          status: webStatus,
          ...(webStatus === 'ready' ? { origin: serviceManager!.origin } : {}),
        })
        serviceReady = true
        if (webUnavailable) retireUnavailableWeb()
        diagnostic({ event: 'service-ready' })
        await waitForAbort(lifetime.signal)
      } catch (error) {
        if (!lifetime.signal.aborted) failure = error ?? new Error('service owner failed')
      } finally {
        ownerOpen = false
        lifetime.signal.removeEventListener('abort', stopServices)
        for (
          const close of [
            () => webRetirement,
            () => serviceManager?.close(),
            () => api?.close(),
            () => nativeAdapters?.close(),
            async () => {
              if (rendererBootstrap && !await rendererBootstrap.close()) {
                throw new Error('renderer-bootstrap-retirement-unconfirmed')
              }
            },
            () => rendererReadonlyChannel?.close(),
            () => rendererManagedServiceUI?.dispose(),
            () => services?.browserConsoleLaunch.close(),
            () => rendererParticipants?.close(),
            () => rendererLifecycle?.close(),
            () => management?.close(),
            () => rendererPermissionConsumers?.close(),
            () => rendererPermissionProof?.close(),
            () => nativePermissionProof?.close(),
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
            failure ??= error ?? new Error('service cleanup failed')
          }
        }
        if (webRetirementFailure !== undefined) failure ??= webRetirementFailure
        let cleanupRecorded = false
        if (serviceReady) {
          try {
            cleanupRecorded = await supervisor.markServiceCleanup(
              failure === undefined
                ? { ok: true }
                : { ok: false, failure: safeDiagnosticMessage(failure) },
            )
          } catch (error) {
            failure ??= error ?? new Error('service cleanup receipt unavailable')
          }
          if (!cleanupRecorded) failure ??= new Error('service cleanup receipt unavailable')
        }
        if (failure !== undefined) {
          diagnostic({ event: 'service-failed', ...diagnosticError(failure) })
          if (!cleanupRecorded) await supervisor.markFailed(safeDiagnosticMessage(failure)).catch(() => undefined)
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
