import path from 'node:path'
import { pathToFileURL } from 'node:url'
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
import type { ChatExecutionPreferences } from '../launcher/chat-execution-preferences.js'
import { createHeadlessNativeAuthority } from '../launcher/headless-native-authority.js'

/** Native approval and execution are supplied by the shared Host authority, never recreated here. */
export interface HeadlessNativeAuthority {
  request(method: string, params: unknown, id?: string | number): unknown | Promise<unknown>
  notification?(method: string, params: unknown): void
  subscribeApprovals?(listener: (event: Record<string, unknown>) => void): () => void
  respondApproval?(input: Record<string, unknown>): Promise<unknown>
  execution?: ChatExecutionPreferences
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
    if (!plugin) return undefined
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
      dataDir: path.join(input.homeDir, 'apps', input.appId, 'profiles', input.profileId, 'channel-runtime'),
      source: plugin.source ?? pathToFileURL(plugin.entry).href,
      environment: input.environment,
    })
    // Register cleanup before starting: an early failure must not strand the transport.
    const disposeService = () => service.dispose()
    cleanup.push(disposeService)
    const nativeAuthority = await createHeadlessNativeAuthority({
      homeDir: input.homeDir,
      configPath: input.configPath,
      appId: input.appId,
      profileId: input.profileId,
      report: input.report,
    })
    cleanup.push(() => nativeAuthority.close())
    const authority = nativeAuthority.authority
    const backend = await startHeadlessCodexBackend({
      codexExecutable: input.codexExecutable,
      codexHome: input.codexHome,
      home: input.userHome,
      environment: input.environment,
      onRequest: (method, params, id) => authority.request(method, params, id),
      ...(authority.nativeRequest ? { nativeRequest: authority.nativeRequest } : {}),
      ...(authority.notification ? { onNotification: authority.notification } : {}),
    })
    cleanup.push(() => backend.close())
    nativeAuthority.setReader(backend.nativeRequest)
    const native = new ChannelNativeSessions({
      bridge: () => backend as unknown as AgentBridge,
      nativeRequest: backend.nativeRequest,
      models: backend.models,
      cwd: input.cwd,
      cli: configuredChannelCliContext(input.homeDir, input.profileId),
      sectionName: () => undefined,
      name: event => service.conversationAccess()?.name?.(event) ?? Promise.resolve(undefined),
      ...(authority.execution ? { execution: authority.execution } : {}),
      ...(authority.subscribeApprovals
        ? { subscribeApprovals: authority.subscribeApprovals }
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
    // Consumer disposal owns service disposal from here on.
    cleanup.splice(cleanup.indexOf(disposeService), 1)
    cleanup.push(() => channel.dispose())
    await service.start(state.config)
    return { channel, snapshot: () => service.snapshot(), close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Headless startup failed')
    }
    throw error
  }
}
