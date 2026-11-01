import { bundle as builtinAdapter } from '@cordisx/codex-adapter'
import { selectAdapterModules } from './codex-adapter/selection.js'
import { adapterStoreRoot } from './codex-adapter/store.js'
import { resolveHomeConfigPath } from '../config/home-config.js'
import { defaultNativeSubmissionCacheDirectory, nativeSubmissionTransforms } from './native-adapter-analysis.js'
import { startResponsesEncryptedReplay } from './responses-encrypted-replay.js'
import { configuredEncryptedReplay } from './configured-encrypted-replay.js'
import { diagnostic } from '../diagnostics/context.js'
import { loadHomeConfig } from '../config/home-config.js'
import { type CliModelExportResult, exportCliModelCatalog } from './model-catalog/cli-export.js'
import type { ModelExportRequest } from '../cli/model-export-parse.js'
import {
  createTerminalProviderAuthority,
  type TerminalProviderRequest,
  type TerminalProviderResult,
} from './terminal-provider.js'
import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ManagedServiceNodeActivation } from './managed-service-node-host.js'
import { nativeModelProviderCatalog, type NativeModelProviderCatalogEntry } from './native-model-provider-catalog.js'
import { createNativeProviderCredentialBroker } from './native-provider-credential-broker.js'
import { nativeSubmissionCredentialBroker } from './native-submission-credentials.js'
import { createNativeSubmissionController, type NativeSubmissionController } from './native-submission-controller.js'
import {
  createNativeSubmissionCdpAuthority,
  type NativeSubmissionCdpAuthority,
} from './native-submission-cdp-channel.js'
import { startNativeSubmissionControlServer } from './native-submission-control-server.js'
import { startNativeAgentModelsServer } from './native-agent-models.js'
import { NativeAgentTaskRouting } from './native-agent-task-routing.js'
import { NativeAgentTasks } from './native-agent-tasks.js'
import type { NativeResourceTransform } from './native-predispatch-interception.js'
import type { NativeScriptResource } from './native-submission-structure.js'
import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import { combinedNativeModelProviderCatalog } from './native-model-provider-catalog.js'
import { dynamicConfiguredCatalog } from './model-catalog/configured-source.js'
import { mergeDeclaredIntoCodexProjection } from './model-service-projection.js'
import { type AgentBridge, startAgentBridge } from './agent-bridge.js'
import { createIntegrationStatus } from './integration-status.js'
import { parseModelServicesSaveRequest, readModelServices, saveModelServices } from './model-service-store.js'
import type { ModelSelectorIconOverrides } from '../model-selector-branding.js'
import { ManagedCatalogComposition } from './model-catalog/managed-catalog-composition.js'
import { CompositeCatalogManagement, NativeCatalogManagement } from './model-catalog/native-catalog-management.js'
import { NativeConfigCatalogDiscovery } from './model-catalog/native-config-catalog-discovery.js'
import type { HomeConfigProviderBinding } from '../config/home-config-model-catalogs.js'
import type { HomeConfigProvider } from '../config/home-config.js'
import { providerSyncCredentialEnvironmentKey, syncCodexProviderProfile } from './provider-profile-sync-codex.js'
import type { ProviderSyncBindingDefinition } from './provider-profile-sync-contracts.js'
import type { ManagedServiceNativeActivation } from './managed-service-plugin-lifecycle.js'
import { pluginPreferenceSource } from './model-catalog/plugin-preference-source.js'
import {
  type CatalogManagementAuthority,
  PluginPreferenceAuthority,
  PluginPreferenceManagementAdapter,
} from '../model-catalog/plugin-preference-authority.js'

type NativeSubmissionActivation =
  & Pick<ManagedServiceNodeActivation, 'nativeProviderIds' | 'prepareNativeConnection'>
  & {
    subscribeNativeProviders?(listener: () => void): () => void
  }

export interface NativeSubmissionInstallation {
  readonly authority: NativeSubmissionCdpAuthority
  readonly adapterLifecycle?: {
    lifecycle(target: string, status: 'active' | 'unavailable'): Promise<void>
    close(): Promise<void>
  }
  readonly transforms: readonly NativeResourceTransform[]
  readonly accountCapability?: NativeAccountCapabilityDescriptor
}
export interface NativeSubmissionComposition {
  readonly terminalProvider?: (request: TerminalProviderRequest) => Promise<TerminalProviderResult>
  readonly modelExport?: (request: ModelExportRequest) => Promise<CliModelExportResult>
  readonly installation: NativeSubmissionInstallation
  readonly environment: Readonly<Record<string, string>>
  close(): Promise<void>
}
export interface NativeSubmissionBootstrap {
  readonly environment: Readonly<Record<string, string>>
  complete(
    activation: NativeSubmissionActivation,
    codexHome: string,
    options?: NativeSubmissionCatalogOptions,
  ): Promise<NativeSubmissionComposition>
  close(): Promise<void>
}
export class NativeSubmissionCompatibilityError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'NativeSubmissionCompatibilityError'
  }
}
interface NativeSubmissionCatalogOptions {
  readonly onStage?: (stage: NativeSubmissionCompletionStage) => void
  readonly defaultProviderId?: string
  readonly defaultModelId?: string
  readonly configModelCatalogs?: Readonly<Record<string, string>>
  readonly dynamicModelCatalog?: boolean
  readonly nativeModelDiscovery?: boolean
  readonly selectorIcons?: ModelSelectorIconOverrides
  readonly managedCatalog?: Omit<Parameters<typeof ManagedCatalogComposition.open>[0], 'responsesAvailable'>
  readonly nativeDiscoveryEnvironment?: Readonly<Record<string, string | undefined>>
  readonly providerBindings?: readonly HomeConfigProviderBinding[]
  /** `model-service` declarations, merged into the catalog read from `config.toml`. */
  readonly declaredProviders?: readonly HomeConfigProvider[]
}
export type NativeSubmissionCompletionStage =
  | 'native-submission-completion-start'
  | 'native-submission-resource-analysis-ready'
  | 'native-submission-managed-catalog-ready'
  | 'native-submission-native-catalog-ready'
  | 'native-submission-controller-bound'
export function nativeAppServerIntermediaryPath(): string {
  return fileURLToPath(new URL('../../assets/launcher/native-app-server-intermediary.mjs', import.meta.url))
}

export function nativeSubmissionTransformsForApp(
  appVersion: string,
  buildNumber: string,
  resources: readonly NativeScriptResource[],
): readonly NativeResourceTransform[] {
  return selectAdapterModules([{ identity: `builtin:${builtinAdapter.version}`, bundle: builtinAdapter }], {
    appVersion,
    buildNumber,
    resources,
  }).transforms
}

export async function createNativeSubmissionComposition(
  activation: NativeSubmissionActivation,
  desktopExecutable: string,
  codexHome: string,
  options: NativeSubmissionCatalogOptions & Readonly<{ cacheDirectory?: string }> = {},
): Promise<NativeSubmissionComposition> {
  const bootstrap = await prepareNativeSubmissionBootstrap(desktopExecutable, {
    ...(options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory }),
    ...(options.nativeDiscoveryEnvironment === undefined ? {} : { environment: options.nativeDiscoveryEnvironment }),
  })
  try {
    return await bootstrap.complete(activation, codexHome, options)
  } catch (error) {
    await bootstrap.close()
    throw error
  }
}

/** Resolve only CLI binaries bundled inside the selected Desktop app. */
export async function resolveBundledCodexCliPath(contents: string): Promise<string> {
  for (const relative of ['Resources/codex', 'Resources/codex-cli/bin/codex']) {
    const candidate = path.join(contents, relative)
    let resolved: string
    try {
      resolved = await realpath(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    await access(resolved, constants.X_OK)
    return resolved
  }
  throw new Error('The selected Desktop app does not contain a supported bundled Codex CLI')
}

/** Keep the intermediary inside the selected App's signed runtime chain, without changing the Host's Node. */
export async function resolveBundledCodexNodePath(contents: string): Promise<string> {
  const resources = await realpath(path.join(contents, 'Resources'))
  let runtime: string
  try {
    runtime = await realpath(path.join(resources, 'cua_node/bin/node'))
  } catch (error) {
    throw new Error('The selected Desktop app does not contain its bundled intermediary Node runtime', { cause: error })
  }
  if (!runtime.startsWith(`${resources}${path.sep}`)) {
    throw new Error('The intermediary Node runtime must remain inside the selected Desktop app')
  }
  await access(runtime, constants.X_OK)
  return runtime
}

/** Start only the fail-closed native transport; compatibility discovery continues off the Host launch path. */
export async function prepareNativeSubmissionBootstrap(
  desktopExecutable: string,
  options: Readonly<{
    cacheDirectory?: string
    environment?: Readonly<Record<string, string | undefined>>
  }> = {},
): Promise<NativeSubmissionBootstrap> {
  if (process.platform !== 'darwin') throw new Error('Native managed routing requires a macOS app bundle')
  const executable = await realpath(desktopExecutable)
  const macos = path.dirname(executable)
  if (path.basename(macos) !== 'MacOS' || path.basename(path.dirname(macos)) !== 'Contents') {
    throw new Error('Native routing requires an app-bundle executable')
  }
  const contents = path.dirname(macos)
  const cli = await resolveBundledCodexCliPath(contents)
  const node = await resolveBundledCodexNodePath(contents)
  await access(nativeAppServerIntermediaryPath(), constants.X_OK)
  let capabilities: ReturnType<typeof nativeSubmissionTransforms> | undefined
  const control = await startNativeSubmissionControlServer()
  const agentModels = await startNativeAgentModelsServer().catch(async error => {
    await control.close()
    throw error
  })
  let encryptedReplay: Awaited<ReturnType<typeof startResponsesEncryptedReplay>> | undefined
  let controller: NativeSubmissionController | undefined
  let taskRouting: NativeAgentTaskRouting | undefined
  let agentTasks: NativeAgentTasks | undefined
  let credentials: ReturnType<typeof createNativeProviderCredentialBroker> | undefined
  let terminalProviders: ReturnType<typeof createTerminalProviderAuthority> | undefined
  let managed: ManagedCatalogComposition | undefined
  let dynamic: ReturnType<typeof dynamicConfiguredCatalog> | undefined
  let nativeDiscovery: NativeConfigCatalogDiscovery | undefined
  let nativeManagement: NativeCatalogManagement | undefined
  let management: CatalogManagementAuthority | undefined
  let pluginManagement: PluginPreferenceManagementAdapter | undefined
  let pluginCatalog: () => Promise<readonly NativeModelProviderCatalogEntry[]> = async () => []
  let completion: Promise<NativeSubmissionComposition> | undefined
  let closePromise: Promise<void> | undefined
  let agentBridge: AgentBridge | undefined
  const close = (): Promise<void> =>
    closePromise ??= (async () => {
      await (await capabilities?.catch(() => undefined))?.adapterLifecycle.close()
      await agentBridge?.close()
      await agentModels.close()
      await taskRouting?.close()
      dynamic?.dispose()
      nativeDiscovery?.dispose()
      management?.close?.()
      try {
        await controller?.dispose()
      } finally {
        try {
          terminalProviders?.close()
          await credentials?.close()
          await encryptedReplay?.close()
        } finally {
          try {
            await managed?.close()
          } finally {
            await control.close()
          }
        }
      }
    })()
  const environment = {
    CODEX_CLI_PATH: nativeAppServerIntermediaryPath(),
    // Dot must not open a second connection to the chat intermediary's control socket.
    CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH: options.environment?.CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH || cli,
    CORDISX_NATIVE_CONTROL_SOCKET: control.socketPath,
    CORDISX_NATIVE_CONTROL_NONCE: control.nonce,
    CORDISX_NATIVE_REAL_CODEX_PATH: cli,
    CORDISX_NATIVE_NODE_PATH: node,
    CORDISX_NATIVE_AGENT_MODELS_BINDING: agentModels.bindingPath,
  }
  return {
    environment,
    complete(activation, codexHome, completeOptions = {}) {
      completion ??= (async () => {
        let priorStageAt = performance.now()
        let priorStage: string | undefined
        const reportStage = (stage: NativeSubmissionCompletionStage): void => {
          try {
            const now = performance.now()
            if (priorStage) {
              diagnostic({ event: 'startup-stage-end', phase: priorStage, elapsedMs: Math.round(now - priorStageAt) })
            }
            diagnostic({ event: 'startup-stage-start', phase: stage })
            priorStage = stage
            priorStageAt = now
            completeOptions.onStage?.(stage)
          } catch { /* Diagnostics must not change native submission startup. */ }
        }
        reportStage('native-submission-completion-start')
        let discovered: Pick<NativeSubmissionInstallation, 'transforms' | 'accountCapability' | 'adapterLifecycle'>
        try {
          discovered = await (capabilities ??= nativeSubmissionTransforms(
            contents,
            options.cacheDirectory ?? defaultNativeSubmissionCacheDirectory(),
            adapterStoreRoot(path.dirname(resolveHomeConfigPath({ env: options.environment ?? process.env }))),
          ))
        } catch (error) {
          // Catalog/configuration and credential delivery do not depend on rewriting
          // the native submit function. Preserve them while disabling only takeover.
          console.warn(`[cordisx] enhanced native model switching unavailable: ${String(error)}`)
          discovered = { transforms: [] }
        }
        reportStage('native-submission-resource-analysis-ready')
        if (closePromise !== undefined) throw new Error('Native submission bootstrap was closed')
        const legacyNativePreferenceFile = completeOptions.managedCatalog === undefined
          ? undefined
          : path.join(
            completeOptions.managedCatalog.homeDir,
            'apps',
            'codex',
            'profiles',
            completeOptions.managedCatalog.profileId,
            'native-catalog-management.json',
          )
        if (completeOptions.managedCatalog) {
          try {
            managed = await ManagedCatalogComposition.open({
              ...completeOptions.managedCatalog,
              responsesAvailable: true,
              ...(legacyNativePreferenceFile === undefined ? {} : { legacyNativePreferenceFile }),
            })
          } catch {
            // Preserve stored providers for a later retry without blocking unrelated native providers.
            console.warn('[cordisx] managed Provider catalog is unavailable')
          }
        }
        reportStage('native-submission-managed-catalog-ready')
        let providerSyncEnvironment: Readonly<Record<string, string>> = Object.freeze({})
        if (managed && completeOptions.managedCatalog && completeOptions.providerBindings?.length) {
          const targetProfileRef = Object.freeze({
            adapterId: 'codex' as const,
            hostInstanceId: `codex-${createHash('sha256').update(path.resolve(codexHome)).digest('hex').slice(0, 24)}`,
            profileId: completeOptions.managedCatalog.profileId,
            configRoot: path.resolve(codexHome),
          })
          const bindings: ProviderSyncBindingDefinition[] = completeOptions.providerBindings.map(binding => ({
            ...binding,
            targetProfileRef,
          }))
          const connectionIds = new Set(bindings.map(binding => binding.connectionId))
          const definitions = managed.providerSyncConnections(connectionIds)
          const availableConnectionIds = new Set(definitions.map(definition => definition.connectionId))
          const missing = bindings.filter(binding => !availableConnectionIds.has(binding.connectionId))
          if (missing.length > 0) {
            console.warn(`[cordisx] provider profile sync: ${
              JSON.stringify(missing.map(binding => ({
                code: 'connection-unavailable',
                severity: 'warning',
                bindingId: binding.bindingId,
                localProviderId: binding.localProviderId,
              })))
            }`)
          }
          const result = await syncCodexProviderProfile({
            stateDir: path.join(
              completeOptions.managedCatalog.homeDir,
              'apps',
              'codex',
              'profiles',
              completeOptions.managedCatalog.profileId,
              'provider-sync',
            ),
            targetProfileRef,
            connections: definitions,
            bindings: bindings.filter(binding => availableConnectionIds.has(binding.connectionId)),
          })
          if (result.diagnostics.length > 0) {
            console.warn(`[cordisx] provider profile sync: ${JSON.stringify(result.diagnostics)}`)
          }
          const environment: Record<string, string> = {}
          for (const binding of bindings) {
            const projected = result.projection.providers.find(provider => provider.bindingId === binding.bindingId)
            if (projected?.sync.applied !== true || !binding.enabled) continue
            const native = await managed.nativeConnection(
              `cordisx-${binding.connectionId.slice('cx-connection-'.length)}`,
            )
            try {
              if (native.value.endpoint.auth.scheme === 'bearer') {
                environment[providerSyncCredentialEnvironmentKey(binding.bindingId)] = native.value.endpoint.auth.token
              }
            } finally {
              native.dispose()
            }
          }
          providerSyncEnvironment = Object.freeze(environment)
        }
        nativeDiscovery = new NativeConfigCatalogDiscovery({
          environment: () => completeOptions.nativeDiscoveryEnvironment ?? {},
          enabled: completeOptions.nativeModelDiscovery !== false,
        })
        if (completeOptions.dynamicModelCatalog) {
          dynamic = dynamicConfiguredCatalog({
            codexHome,
            ...(completeOptions.configModelCatalogs === undefined
              ? {}
              : { catalogs: completeOptions.configModelCatalogs }),
            ...(completeOptions.selectorIcons === undefined
              ? {}
              : { selectorIcons: completeOptions.selectorIcons }),
            load: () =>
              nativeDiscovery!.load({
                codexHome,
                ...(completeOptions.configModelCatalogs === undefined
                  ? {}
                  : { catalogs: completeOptions.configModelCatalogs }),
                ...(completeOptions.selectorIcons === undefined
                  ? {}
                  : { selectorIcons: completeOptions.selectorIcons }),
              }),
          })
        }
        const resolveConnection = (id: string) =>
          managed?.owns(id)
            ? managed.nativeConnection(id)
            : activation.prepareNativeConnection(id)
        credentials = createNativeProviderCredentialBroker({ resolve: resolveConnection })
        const hasPluginProvider = (providerId: string) => activation.nativeProviderIds.includes(providerId)
        let lastDiagnostic: string | undefined
        const loadConfigured = async () => {
          let projection
          if (dynamic) {
            await dynamic.refresh()
            projection = dynamic.snapshot()
          } else {
            projection = await nativeDiscovery!.load({
              codexHome,
              ...(completeOptions.configModelCatalogs === undefined
                ? {}
                : { catalogs: completeOptions.configModelCatalogs }),
              ...(completeOptions.selectorIcons === undefined
                ? {}
                : { selectorIcons: completeOptions.selectorIcons }),
            })
          }
          // The selector lists the native tables and the CordisX declarations together:
          // a declaration is the entry the user manages, its native copy the projection.
          if (completeOptions.declaredProviders !== undefined) {
            projection = mergeDeclaredIntoCodexProjection(projection, completeOptions.declaredProviders)
          }
          const diagnostic = JSON.stringify(projection.diagnostics)
          if (diagnostic !== lastDiagnostic && projection.diagnostics.length > 0) {
            console.warn(
              `[cordisx] configModelCatalogs: ${diagnostic}; check the selected CordisX profile's local catalogs`,
            )
          }
          lastDiagnostic = diagnostic
          return projection
        }
        nativeManagement = await NativeCatalogManagement.open({
          load: loadConfigured,
          shadowed: providerId => managed?.owns(providerId) === true || hasPluginProvider(providerId),
          ...(managed === undefined
            ? {}
            : {
              overlayStore: managed.preferenceStore,
            }),
          ...(managed !== undefined || legacyNativePreferenceFile === undefined
            ? {}
            : { stateFile: legacyNativePreferenceFile }),
          refreshBeforeRead: dynamic === undefined,
          discovery: nativeDiscovery,
          ...(dynamic === undefined
            ? {}
            : {
              subscribeSource: listener => dynamic!.subscribe(() => listener(dynamic!.snapshot())),
            }),
        })
        reportStage('native-submission-native-catalog-ready')
        const baseManagement = new CompositeCatalogManagement(nativeManagement, managed)
        management = baseManagement
        if (activation.subscribeNativeProviders) {
          const pluginPreferences = await PluginPreferenceAuthority.open({
            ...pluginPreferenceSource(
              activation as ManagedServiceNativeActivation,
              completeOptions.selectorIcons,
            ),
            overlayStore: nativeManagement.preferenceStore,
          })
          pluginManagement = new PluginPreferenceManagementAdapter(baseManagement, pluginPreferences)
          management = pluginManagement
          pluginCatalog = async () =>
            Object.freeze((await pluginManagement!.catalog()).map(provider =>
              Object.freeze({
                ...provider,
                models: Object.freeze(provider.models.map(model => {
                  const aliases = Reflect.get(model, 'aliases')
                  if (!Array.isArray(aliases) || !aliases.every(alias => typeof alias === 'string')) {
                    throw new Error('plugin model catalog aliases are unavailable')
                  }
                  return Object.freeze({ ...model, aliases: Object.freeze([...aliases]) })
                })),
              })
            ))
        }
        if (pluginManagement === undefined) {
          pluginCatalog = nativeModelProviderCatalog(activation, completeOptions.selectorIcons)
        }
        const catalog = combinedNativeModelProviderCatalog(
          combinedNativeModelProviderCatalog(async () => managed?.catalog() ?? [], pluginCatalog),
          () => nativeManagement!.catalog(),
        )
        const taskExecutionUrl = discovered.transforms.find(transform => transform.taskExecutionUrl)?.taskExecutionUrl
        if (completeOptions.defaultProviderId && completeOptions.defaultModelId) {
          const launchProvider = (await catalog()).find(provider =>
            provider.providerId === completeOptions.defaultProviderId
          )
          if (!launchProvider?.models.some(model => model.id === completeOptions.defaultModelId)) {
            throw new Error('Selected launch service/model is not available in this profile')
          }
        }
        terminalProviders = createTerminalProviderAuthority({
          catalog,
          owns: id => managed?.owns(id) === true || hasPluginProvider(id),
          resolve: resolveConnection,
          credentials,
        })
        const homeConfigPath = completeOptions.managedCatalog === undefined
          ? undefined
          : path.join(completeOptions.managedCatalog.homeDir, 'config.json')
        const cdp = createNativeSubmissionCdpAuthority({
          ...(homeConfigPath === undefined ? {} : {
            modelServices: {
              read: () => readModelServices(homeConfigPath, completeOptions.nativeDiscoveryEnvironment ?? process.env),
              save: async request => {
                const parsed = parseModelServicesSaveRequest(request)
                return parsed === undefined
                  ? { status: 'rejected', code: 'invalid' }
                  : await saveModelServices(homeConfigPath, parsed)
              },
            },
          }),
          taskClaim: input => agentTasks?.claim(input) ?? Promise.resolve(undefined),
          ...(taskExecutionUrl === undefined ? {} : { taskExecutionUrl }),
          submissionAvailable: discovered.transforms.length > 0,
          catalogSubscribe: (listener: () => void) => {
            const subscriptions = [
              nativeManagement!.subscribe(listener),
              managed?.subscribe(listener),
              pluginManagement?.catalogSubscribe(listener),
            ]
            return () => subscriptions.forEach(unsubscribe => unsubscribe?.())
          },
          management,
          catalog,
          isThreadIdle: id => control.isThreadIdle(id),
          ...(completeOptions.defaultProviderId === undefined
            ? {}
            : { defaultProviderId: completeOptions.defaultProviderId }),
          ...(completeOptions.defaultModelId === undefined ? {} : { defaultModelId: completeOptions.defaultModelId }),
        })
        encryptedReplay = await startResponsesEncryptedReplay()
        const prepareConfiguredProvider = configuredEncryptedReplay(codexHome, encryptedReplay.route)
        control.bindConfiguredProvider(prepareConfiguredProvider)
        controller = createNativeSubmissionController({
          prepareConfiguredProvider,
          selection: cdp.selection,
          runtime: cdp.runtime,
          existingThread: control.existingThread,
          credentials: nativeSubmissionCredentialBroker({
            credentials,
            resolveEndpoint: resolveConnection,
            routeEndpoint: encryptedReplay.route,
          }),
          providerSource: providerId =>
            managed?.owns(providerId) || hasPluginProvider(providerId)
              ? 'managed'
              : nativeManagement!.hasProvider(providerId)
              ? 'config'
              : undefined,
          validateSelection: async selection => {
            if (selection.providerId.startsWith('cordisx-')) {
              return await managed?.validateSelection(selection.providerId, selection.model) ?? false
            }
            if (selection.providerId === 'openai' || hasPluginProvider(selection.providerId)) return true
            return nativeManagement!.validateSelection(selection.providerId, selection.model)
          },
        })
        control.bindController(controller)
        taskRouting = new NativeAgentTaskRouting(
          controller,
          async selection =>
            (await catalog()).some(provider =>
              provider.providerId === selection.providerId
              && provider.models.some(model => model.id === selection.model)
            ),
        )
        control.bindTaskRouting(taskRouting)
        agentTasks = new NativeAgentTasks({
          directory: path.join(
            completeOptions.managedCatalog?.homeDir ?? path.dirname(codexHome),
            'apps',
            'codex',
            'profiles',
            completeOptions.managedCatalog?.profileId ?? 'default',
            'agent-task-intents',
          ),
          catalog,
          routing: taskRouting,
          available: () => cdp.taskCreationAvailable(),
          invoke: input => control.invokeTask(input),
        })
        cdp.bindController(controller)
        if (completeOptions.managedCatalog !== undefined) {
          // The agent bridge lets Claude Code sessions read and start threads in this
          // app-server, and lets this app's agents reach Claude. Failing to start it
          // only leaves the cross-app tools unavailable.
          agentBridge = await startAgentBridge({
            cordisxHomeDir: completeOptions.managedCatalog.homeDir,
            codex: { nativeRequest: (method, params) => control.nativeRequest(method, params), catalog },
            codexProfileId: completeOptions.managedCatalog.profileId,
            // Recorded for `integration_status`: which service this launch was started on.
            ...(completeOptions.defaultProviderId === undefined
              ? {}
              : { codexModelServiceId: completeOptions.defaultProviderId }),
            // Starts Claude, when the person allowed it, as `cordisx start claude` would.
            launchClaude: async ({ homeDir, profileId, providerId }) => {
              const { runClaudeDesktopCommand } = await import('../cli/claude-desktop-command.js')
              await runClaudeDesktopCommand(
                {
                  action: 'start',
                  profile: profileId,
                  options: { dryRun: false, ...(providerId === undefined ? {} : { provider: providerId }) },
                },
                { env: { ...process.env, CORDISX_HOME: homeDir }, stdout: () => undefined },
              )
            },
          }).catch(error => {
            console.warn(`[cordisx] agent bridge unavailable: ${String(error)}`)
            return undefined
          })
        }
        agentModels.bind({
          catalog,
          controller,
          sessions: async (app, operation, input) => {
            if (agentBridge === undefined) throw new Error('The CordisX agent bridge is unavailable')
            return await agentBridge.call(app, operation, input)
          },
          // Answers even without a bridge: the report names that as the problem rather than failing.
          integrationStatus: async input =>
            agentBridge === undefined
              ? await createIntegrationStatus({
                cordisxHomeDir: completeOptions.managedCatalog!.homeDir,
                caller: 'codex',
              })(input)
              : await agentBridge.status(input),
          createTask: (input, metadata) => agentTasks!.create(input, metadata),
          taskCreationAvailable: () => cdp.taskCreationAvailable(),
          ...cdp.agentSelection,
          switchThread: async input => {
            if (closePromise !== undefined) throw new Error('Native model tools were closed')
            await control.switchAgentThread(input)
          },
        })
        reportStage('native-submission-controller-bound')
        return {
          terminalProvider: request => terminalProviders!.request(request),
          async modelExport(request) {
            if (closePromise !== undefined || !management || !managed || !completeOptions.managedCatalog) {
              throw new Error('Model export catalog unavailable')
            }
            const home = await loadHomeConfig(path.join(completeOptions.managedCatalog.homeDir, 'config.json'))
            if (closePromise !== undefined) throw new Error('Model export catalog retired')
            return exportCliModelCatalog(management, request, home.environmentVariables)
          },
          installation: { authority: cdp, ...discovered },
          environment: Object.freeze({ ...environment, ...providerSyncEnvironment }),
          close,
        }
      })()
      return completion
    },
    close,
  }
}
