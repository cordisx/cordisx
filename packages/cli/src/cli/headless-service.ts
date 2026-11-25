import { loadHomeConfig } from '../config/home-config.js'
import { prepareApprovalReviewCatalog } from '../launcher/approval-review-catalog.js'
import { managementMailboxRoot, pluginManagementRpcPaths } from '../launcher/management-rpc.js'
import { HeadlessProjectCatalog } from '../launcher/headless-project-catalog.js'
import { CodexChatConfiguration } from '../launcher/codex-chat-configuration.js'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readServiceConfigState } from '../config/service-config.js'
import { PackagePluginServiceConfigStore } from '../launcher/package-plugin-service-config.js'
import { loadConfig } from '../launcher/config.js'
import { CHANNEL_SERVICE_CONFIG_INITIAL, createLocalChannelService } from '../launcher/channel-service.js'
import { ChannelNativeSessions } from '../launcher/channel-native-sessions.js'
import { channelSteerNotActive } from '../launcher/channel-native-steer-error.js'
import { configuredChannelCliContext } from '../launcher/channel-cli-context.js'
import { configuredPluginDocuments } from '../launcher/plugin-documents.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import { createConfiguredChannelConsumer } from './channel-consumer-composition.js'
import { startHeadlessCodexBackend } from '../launcher/headless-codex-backend.js'
import type { AgentBridge } from '../launcher/agent-bridge.js'
import { ChatExecutionPreferences } from '../launcher/chat-execution-preferences.js'
import { createHeadlessNativeAuthority } from '../launcher/headless-native-authority.js'
import { headlessModelSelection } from '../launcher/headless-model-selection.js'
import { ContextObservations } from '../launcher/context-observations.js'
import { attachNativeContextObserver, NativeContextObserver } from '../launcher/native-context-observer.js'
import { channelMemoryServiceConnection } from '../launcher/channel-user-memory-connection.js'
import { headlessLiveBudgetEnabled, prepareHeadlessStaticCatalog } from '../launcher/headless-static-catalog.js'
import { CHANNEL_PREPARATION_TOOLS, handlePreparationToolCall } from '../launcher/channel-live-dynamic-tools.js'
import type { ChannelConversationTools } from '../launcher/channel-conversation-tools.js'
import { createHeadlessCodexOperations } from '../launcher/headless-codex-operations.js'
import { withoutLauncherSecrets } from '../launcher/secret-resolver.js'
import { parseChannelServiceConfig } from '@cordisx/channel-runtime'
import { availableHeadlessModelServices, prepareHeadlessModelServices } from '../launcher/headless-model-services.js'
import { declarationCatalogEntry, projectModelServicesToCodex } from '../launcher/model-service-projection.js'
import { modelServiceRuntimeEnvironment } from '../launcher/model-service-runtime.js'

const execFileAsync = promisify(execFile)

/** Native approval and execution are supplied by the shared Host authority, never recreated here. */
export interface HeadlessNativeAuthority {
  request(method: string, params: unknown, id?: string | number): unknown | Promise<unknown>
  notification?(method: string, params: unknown): void
  subscribeApprovals?(listener: (event: Record<string, unknown>) => void): () => void
  subscribeContinuationEvents?(listener: (method: string, params: unknown) => void): () => void
  respondApproval?(input: Record<string, unknown>): Promise<unknown>
  execution?: ChatExecutionPreferences
  confirmedWorkMode?(threadId: string): 'default' | 'plan' | undefined
  /** Applies and records the existing execution settings around native calls when available. */
  nativeRequest?(
    method: string,
    params: Readonly<Record<string, unknown>>,
    next: (params: Readonly<Record<string, unknown>>) => Promise<unknown>,
  ): Promise<unknown>
}

/** A Channel and Codex component under the existing service profile owner. */
export async function startHeadlessService(input: {
  readonly configPath: string
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly userHome: string
  readonly codexHome: string
  readonly codexExecutable: string
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly generation: string
  readonly report: (code: string) => void
}) {
  const cleanup: (() => Promise<void>)[] = []
  let closing: Promise<void> | undefined
  const close = () =>
    closing ??= (async () => {
      const errors: unknown[] = []
      for (const dispose of cleanup.reverse()) {
        try {
          await dispose()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Headless service cleanup failed')
    })()
  try {
    const configured = await loadConfig(input.configPath, { profileId: input.profileId, projectRoot: input.homeDir })
    const store = new PluginActivationStore(input.homeDir, input.profileId, input.generation)
    const activated = await loadPluginComposition(store, await store.loadActive())
    const configuredIds = new Set(configured.plugins.map(plugin => plugin.id))
    if (activated.some(plugin => configuredIds.has(plugin.id))) throw new Error('PLUGIN_ID_COLLISION')
    const plugins = [...configured.plugins, ...activated]
    const plugin = plugins.find(item => item.id === 'channel' && item.enabled)
    if (!plugin) {
      const execution = await ChatExecutionPreferences.open({
        file: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'chat-execution.json'),
        configPath: input.configPath,
        appId: input.appId,
        profileId: input.profileId,
      })
      cleanup.push(() => execution.close())
      const configuration = await CodexChatConfiguration.open({
        preferences: execution,
        file: path.join(
          input.homeDir,
          'apps',
          input.appId,
          'profiles',
          input.profileId,
          'codex-chat-configuration.json',
        ),
        request: async () => {
          throw new Error('CODEX_BACKEND_UNAVAILABLE')
        },
        guard: async (_operation, _args, metadata) =>
          metadata && typeof metadata === 'object'
            && (metadata as Record<string, unknown>)['cordisx/channelContext'] !== undefined
            ? { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
            : undefined,
      })
      cleanup.push(() => configuration.close())
      return {
        channel: undefined,
        codex: createHeadlessCodexOperations({
          configuration: (operation, args, metadata) => configuration.call(operation, args, metadata),
          configPath: input.configPath,
          environment: input.environment,
          native: { executionPreferences: () => execution, exists: async () => false },
          closed: () => closing !== undefined,
        }),
        snapshot: () => undefined,
        close,
      }
    }
    const readChannelConfig = plugin.package === undefined
      ? readServiceConfigState
      : new PackagePluginServiceConfigStore(input.homeDir, input.profileId, input.generation).persistence.read
    const state = await readChannelConfig({
      profileId: input.profileId,
      pluginId: 'channel',
      serviceId: 'runtime',
      initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
        typeof readServiceConfigState
      >[0]['initialConfig'],
    }, input.configPath)
    const channelConfiguration = parseChannelServiceConfig(state.config)
    const homeConfig = await loadHomeConfig(input.configPath)
    const modelServices = prepareHeadlessModelServices(homeConfig, input.environment)
    const credentialEnvironment = withoutLauncherSecrets(modelServices.environment, [
      ...channelConfiguration.connections.map(connection => connection.secretRef),
      ...(channelConfiguration.schemaVersion === 3
        ? channelConfiguration.pendingConnections.map(connection => connection.secretRef)
        : []),
    ])
    const availableServices = availableHeadlessModelServices(modelServices, credentialEnvironment, input.report)
    const backendEnvironment = { ...modelServiceRuntimeEnvironment(availableServices, credentialEnvironment) }
    if (availableServices.length > 0) {
      const projection = await projectModelServicesToCodex(availableServices, input.codexHome)
      if (projection.providerIds.length !== availableServices.length) {
        throw new Error('HEADLESS_MODEL_SERVICE_PROJECTION_FAILED')
      }
    }
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(plugin.entry),
      ...(plugin.configuredServiceEntry === undefined && plugin.package === undefined
        ? {}
        : { runtimeEntry: plugin.configuredServiceEntry ?? './services/runtime.mjs' as const }),
      dataDir: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-runtime'),
      source: plugin.source ?? pathToFileURL(plugin.entry).href,
      environment: input.environment,
      homeDir: input.homeDir,
    })
    // Register cleanup before starting: an early failure must not strand the transport.
    const disposeService = () => service.dispose()
    cleanup.push(disposeService)
    // Only the validated app-server version has documented fresh-session default-mode evidence.
    const version = await execFileAsync(input.codexExecutable, ['--version'], {
      env: backendEnvironment,
      timeout: 5_000,
    }).then(value => value.stdout.trim()).catch(() => '')
    const nativeAuthority = await createHeadlessNativeAuthority({
      homeDir: input.homeDir,
      configPath: input.configPath,
      appId: input.appId,
      profileId: input.profileId,
      report: input.report,
      knownNewThreadDefault: ['codex-cli 0.149.1', 'codex-cli 0.167.0-alpha.3.2'].includes(version),
    })
    cleanup.push(() => nativeAuthority.close())
    const authority = nativeAuthority.authority
    const contextObserver = new NativeContextObserver(new ContextObservations())
    const unsubscribeContext = authority.subscribeContinuationEvents
      ? attachNativeContextObserver(listener => authority.subscribeContinuationEvents!(listener), contextObserver)
      : undefined
    cleanup.push(async () => {
      unsubscribeContext?.()
      contextObserver.dispose()
    })
    const catalog = await prepareHeadlessStaticCatalog({
      enabled: await headlessLiveBudgetEnabled(
        path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-conversations.json'),
      ),
      nativeVersion: version.replace(/^codex-cli\s+/u, ''),
      executable: input.codexExecutable,
      codexHome: input.codexHome,
      userHome: input.userHome,
      cwd: input.cwd,
      environment: backendEnvironment,
    })
    if (catalog) cleanup.push(catalog.close)
    const profileConfig = homeConfig.apps.codex?.profiles[input.profileId]
    if (catalog && profileConfig?.approvalReview?.settings) throw new Error('REVIEW_CATALOG_BUDGET_CONFLICT')
    const reviewCatalog = await prepareApprovalReviewCatalog({
      settings: profileConfig?.approvalReview?.settings ?? undefined,
      configPath: input.configPath,
      nativeVersion: version.replace(/^codex-cli\s+/u, ''),
    })
    if (reviewCatalog) {
      cleanup.push(reviewCatalog.close)
      authority.execution?.bindReviewProvider(reviewCatalog.providerId, reviewCatalog.modelIds)
    }
    let native: ChannelNativeSessions | undefined
    let channelTools: ChannelConversationTools | undefined
    let logicalHistory: ((params: unknown) => Promise<unknown>) | undefined
    let guardNativeSource: ((method: string, params: Readonly<Record<string, unknown>>) => () => void) | undefined
    let guardNativeHandoff: ((method: string, params: Readonly<Record<string, unknown>>) => void) | undefined
    const backend = await startHeadlessCodexBackend({
      codexExecutable: input.codexExecutable,
      codexHome: input.codexHome,
      home: input.userHome,
      environment: backendEnvironment,
      declaredProviders: availableServices.map(service => declarationCatalogEntry(service, 'codex')),
      ...(catalog ? { modelCatalogPath: catalog.path } : {}),
      ...(reviewCatalog ? { modelCatalogPath: reviewCatalog.path, modelCatalogPreserveProvider: true } : {}),
      ...(catalog ? { staticCatalog: { ...catalog, nativeVersion: version.replace(/^codex-cli\s+/u, '') } } : {}),
      contextObserver,
      onRequest: (method, params, id) =>
        method === 'item/tool/call'
          ? native?.isPreparing(String((params as { threadId?: unknown })?.threadId ?? ''))
            ? handlePreparationToolCall(params, native, channelTools)
            : logicalHistory?.(params)
              ?? { success: false, contentItems: [{ type: 'inputText', text: '{"status":"unavailable"}' }] }
          : authority.request(method, params, id),
      onDispatch: (operationId, threadId, turnId) => native?.observedDispatch(operationId, threadId, turnId),
      preparationTools: operationId =>
        version === 'codex-cli 0.167.0-alpha.3.2' && native?.isPreparationOperation(operationId)
          ? CHANNEL_PREPARATION_TOOLS
          : undefined,
      nativeRequest: async (method, params, next) => {
        const release = guardNativeSource?.(method, params)
        let effectPossible = false, settled = false
        try {
          const guarded = (prepared: Readonly<Record<string, unknown>>) => {
            guardNativeHandoff?.(method, prepared)
            effectPossible = true
            return next(prepared)
          }
          const result =
            await (authority.nativeRequest ? authority.nativeRequest(method, params, guarded) : guarded(params))
          settled = true
          return result
        } catch (error) {
          // An RPC error can follow an effect. Keep this writer fence until
          // the owner closes unless the failure happened before dispatch.
          if (
            !effectPossible || method === 'turn/steer' && typeof params.expectedTurnId === 'string'
              && channelSteerNotActive(error, params.expectedTurnId)
          ) settled = true
          throw error
        } finally {
          if (settled) release?.()
        }
      },
      ...(authority.notification ? { onNotification: authority.notification } : {}),
    })
    cleanup.push(() => backend.close())
    nativeAuthority.setReader(backend.nativeRequest)
    const models = headlessModelSelection(backend.models, () => authority.execution)
    const workspace = input.environment.CORDISX_CHANNEL_WORKSPACE
    const headlessProjects = workspace ? await HeadlessProjectCatalog.open(workspace) : undefined
    const chatConfiguration = await CodexChatConfiguration.open({
      preferences: authority.execution!,
      ...(headlessProjects
        ? {
          headlessProjects,
          sandboxAuxiliaryRoot: managementMailboxRoot(
            pluginManagementRpcPaths(input.homeDir, input.appId, input.profileId),
          ),
        }
        : {}),
      file: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'codex-chat-configuration.json'),
      catalog: async () => (await models('list', {})).providers ?? [],
      request: (method, params) => backend.nativeRequest(method, params),
      guard: async (operation, args, metadata) => {
        if (
          !channelTools && metadata && typeof metadata === 'object'
          && (metadata as Record<string, unknown>)['cordisx/channelContext'] !== undefined
        ) return { status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' }
        return channelTools?.executionGuard(operation, args, metadata)
      },
    })
    cleanup.push(() => chatConfiguration.close())
    native = new ChannelNativeSessions({
      memoryConnect: channelMemoryServiceConnection(homeConfig, backendEnvironment),
      bridge: () => backend as unknown as AgentBridge,
      nativeRequest: backend.nativeRequest,
      logicalOwnerIdentity: () => backend.nativeOwnerIdentity(),
      logicalHandoffWriteGuardReady: () => guardNativeHandoff !== undefined,
      models,
      configuration: chatConfiguration,
      cwd: workspace || input.cwd,
      nativeVersion: version,
      cli: configuredChannelCliContext(input.homeDir, input.profileId),
      sectionName: () => undefined,
      name: event => service.conversationAccess()?.name?.(event) ?? Promise.resolve(undefined),
      ...(authority.execution ? { execution: authority.execution } : {}),
      contextObserver,
      ...(authority.confirmedWorkMode ? { confirmedWorkMode: authority.confirmedWorkMode } : {}),
      ...(authority.subscribeApprovals
        ? { subscribeApprovals: authority.subscribeApprovals }
        : {}),
      ...(authority.subscribeContinuationEvents
        ? { subscribeContinuationEvents: authority.subscribeContinuationEvents }
        : {}),
      ...(authority.respondApproval ? { respondApproval: authority.respondApproval } : {}),
      report: input.report,
    })
    const channel = await createConfiguredChannelConsumer({
      service,
      homeDir: input.homeDir,
      appId: input.appId,
      logicalRuntime: true,
      profileId: input.profileId,
      native: () => native,
      report: input.report,
      documents: value => configuredPluginDocuments(plugins, value),
    })
    channelTools = channel.tools
    logicalHistory = channel.consumer ? params => channel.consumer!.logicalHistoryCall(params) : undefined
    guardNativeSource = channel.consumer
      ? (method, params) => channel.consumer!.enterNativeSourceOperation(method, params)
      : undefined
    guardNativeHandoff = channel.consumer
      ? (method, params) => channel.consumer!.assertNativeHandoff(method, params)
      : undefined
    // Consumer disposal owns service disposal from here on.
    cleanup.splice(cleanup.indexOf(disposeService), 1)
    cleanup.push(() => channel.dispose())
    await service.start(state.config)
    const codex = createHeadlessCodexOperations({
      configuration: (operation, value, metadata) => chatConfiguration.call(operation, value, metadata),
      projectsAvailable: headlessProjects !== undefined,
      configPath: input.configPath,
      environment: input.environment,
      models,
      ...(authority.execution
        ? { native: { executionPreferences: () => authority.execution, exists: id => native!.exists(id) } }
        : {}),
      channelTools: () => channelTools,
      preparing: metadata => channel.consumer?.agentAccess.preparation(metadata) === true,
      closed: () => closing !== undefined,
    })
    return { channel, codex, snapshot: () => service.snapshot(), close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Headless startup failed')
    }
    throw error
  }
}
