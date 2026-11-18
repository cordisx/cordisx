import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readServiceConfigState } from '../config/service-config.js'
import { loadConfig } from '../launcher/config.js'
import { CHANNEL_SERVICE_CONFIG_INITIAL, createLocalChannelService } from '../launcher/channel-service.js'
import { ChannelNativeSessions } from '../launcher/channel-native-sessions.js'
import { configuredChannelCliContext } from '../launcher/channel-cli-context.js'
import { configuredPluginDocuments } from '../launcher/plugin-documents.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadPluginComposition } from '../launcher/plugin-composition.js'
import { createConfiguredChannelConsumer } from './channel-consumer-composition.js'
import { startHeadlessCodexBackend } from '../launcher/headless-codex-backend.js'
import type { AgentBridge } from '../launcher/agent-bridge.js'
import { ChatExecutionPreferences } from '../launcher/chat-execution-preferences.js'
import { createHeadlessNativeAuthority } from '../launcher/headless-native-authority.js'
import { ContextObservations } from '../launcher/context-observations.js'
import { attachNativeContextObserver, NativeContextObserver } from '../launcher/native-context-observer.js'
import { headlessLiveBudgetEnabled, prepareHeadlessStaticCatalog } from '../launcher/headless-static-catalog.js'
import { CHANNEL_PREPARATION_TOOLS, handlePreparationToolCall } from '../launcher/channel-live-dynamic-tools.js'
import type { ChannelConversationTools } from '../launcher/channel-conversation-tools.js'
import { createHeadlessCodexOperations } from '../launcher/headless-codex-operations.js'

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
      return {
        channel: undefined,
        codex: createHeadlessCodexOperations({
          configPath: input.configPath,
          environment: input.environment,
          native: { executionPreferences: () => execution, exists: async () => false },
          closed: () => closing !== undefined,
        }),
        snapshot: () => undefined,
        close,
      }
    }
    const state = await readServiceConfigState({
      profileId: input.profileId,
      pluginId: 'channel',
      serviceId: 'runtime',
      initialConfig: CHANNEL_SERVICE_CONFIG_INITIAL as unknown as Parameters<
        typeof readServiceConfigState
      >[0]['initialConfig'],
    }, input.configPath)
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(plugin.entry),
      ...(plugin.configuredServiceEntry === undefined && plugin.package === undefined
        ? {}
        : { runtimeEntry: plugin.configuredServiceEntry ?? './services/runtime.mjs' as const }),
      dataDir: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-runtime'),
      source: plugin.source ?? pathToFileURL(plugin.entry).href,
      environment: input.environment,
    })
    // Register cleanup before starting: an early failure must not strand the transport.
    const disposeService = () => service.dispose()
    cleanup.push(disposeService)
    // Only the validated app-server version has documented fresh-session default-mode evidence.
    const version = await execFileAsync(input.codexExecutable, ['--version'], {
      env: input.environment,
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
      environment: input.environment,
    })
    if (catalog) cleanup.push(catalog.close)
    let native: ChannelNativeSessions | undefined
    let channelTools: ChannelConversationTools | undefined
    const backend = await startHeadlessCodexBackend({
      codexExecutable: input.codexExecutable,
      codexHome: input.codexHome,
      home: input.userHome,
      environment: input.environment,
      ...(catalog ? { modelCatalogPath: catalog.path } : {}),
      ...(catalog ? { staticCatalog: { ...catalog, nativeVersion: version.replace(/^codex-cli\s+/u, '') } } : {}),
      contextObserver,
      onRequest: (method, params, id) =>
        method === 'item/tool/call'
          ? handlePreparationToolCall(params, native, channelTools)
          : authority.request(method, params, id),
      onDispatch: (operationId, threadId, turnId) => native?.observedDispatch(operationId, threadId, turnId),
      preparationTools: operationId =>
        version === 'codex-cli 0.167.0-alpha.3.2' && native?.isPreparationOperation(operationId)
          ? CHANNEL_PREPARATION_TOOLS
          : undefined,
      ...(authority.nativeRequest ? { nativeRequest: authority.nativeRequest } : {}),
      ...(authority.notification ? { onNotification: authority.notification } : {}),
    })
    cleanup.push(() => backend.close())
    nativeAuthority.setReader(backend.nativeRequest)
    native = new ChannelNativeSessions({
      bridge: () => backend as unknown as AgentBridge,
      nativeRequest: backend.nativeRequest,
      models: backend.models,
      cwd: input.cwd,
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
      profileId: input.profileId,
      native: () => native,
      report: input.report,
      documents: value => configuredPluginDocuments(plugins, value),
    })
    channelTools = channel.tools
    // Consumer disposal owns service disposal from here on.
    cleanup.splice(cleanup.indexOf(disposeService), 1)
    cleanup.push(() => channel.dispose())
    await service.start(state.config)
    const codex = createHeadlessCodexOperations({
      configPath: input.configPath,
      environment: input.environment,
      models: backend.models,
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
