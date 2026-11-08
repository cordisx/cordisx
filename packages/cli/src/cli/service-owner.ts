import { randomUUID } from 'node:crypto'
import path from 'node:path'
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
import { createServicePluginRuntime } from '../launcher/service-plugin-runtime.js'
import { startServiceModelApi } from '../launcher/service-model-api.js'
import { LauncherMarketplaceCertifiedAuthority } from '../launcher/marketplace-certified-authority.js'
import type { CordisXCertifiedPermissionProjectionV1 } from '../permission-contracts.js'
import { createProductionManagedServiceLifecycle } from './production-managed-services.js'
import { openProductionPluginManagementComposition } from './production-plugin-management.js'
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
      let releaseRuntimeOwner: (() => Promise<void>) | undefined
      let certified: LauncherMarketplaceCertifiedAuthority | undefined
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
        services = createProductionManagedServiceLifecycle({
          runtime: createServicePluginRuntime(generation),
          homeDir,
          profileId,
          generation,
          environment,
          store,
          startupConfig: config.apps[appId]?.profiles[profileId]?.managedServiceStartupConfig,
          dryRun: false,
          requireOwnedProcess: true,
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
        const startup = await services.initialize(await store.bindRuntimeGeneration())
        await startup.coreReady
        lifetime.signal.removeEventListener('abort', stopServices)
        lifetime.signal.throwIfAborted()
        management = await openProductionPluginManagementComposition({
          homeDir,
          profileId,
          configPath,
          appId,
          runtimeGeneration: generation,
          token: randomUUID(),
          coordinator,
          mode: 'service',
        })
        await supervisor.markServiceReady(api.baseUrl, lifetime.signal)
        diagnostic({ event: 'service-ready' })
        await waitForAbort(lifetime.signal)
      } catch (error) {
        if (!lifetime.signal.aborted) failure = error
      } finally {
        lifetime.signal.removeEventListener('abort', stopServices)
        for (
          const close of [
            () => api?.close(),
            () => management?.close(),
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
