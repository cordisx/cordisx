import type { NativeSubmissionComposition } from '../launcher/native-submission-composition.js'
import type { TerminalProviderRequest, TerminalProviderResult } from '../launcher/terminal-provider.js'
import type { ModelExportRequest } from './model-export-parse.js'
import type { CliModelExportResult } from '../launcher/model-catalog/cli-export.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import type { RendererConfigOperation, RendererConfigResult } from '../launcher/renderer-config-management.js'
import type { ManagerServiceAuthOperation } from '../launcher/manager-service-auth.js'
import type { ManagerChannelCredentialOperation } from '../launcher/manager-channel-credentials.js'
import { applyManagementPermissionReview } from '../launcher/permission-review-management.js'
import { openPluginManagementService } from '../management/service.js'
import {
  type PluginManagementBridgeHandler,
  type PluginManagementRpcServer,
  startPluginManagementRpcServer,
} from '../launcher/management-rpc.js'
import { processStartIdentity } from './supervisor-state.js'
import { createManagerRendererGatewayAuthenticator } from './manager-renderer-gateway.js'
import { createManagerRendererManagementChannel } from './manager-renderer-management.js'
import { dispatchManagerRendererOperation } from './manager-renderer-rpc.js'
import { ManagerRendererSessions } from './manager-renderer-sessions.js'

export interface ProductionPluginManagementComposition {
  readonly handler: PluginManagementBridgeHandler
  close(): Promise<void>
}
export async function openProductionPluginManagementComposition(input: {
  readonly mode?: 'service'
  readonly configPath: string
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly token: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly modelExport?: (request: ModelExportRequest) => Promise<CliModelExportResult>
  readonly terminalProvider?: (request: TerminalProviderRequest) => Promise<TerminalProviderResult>
  readonly channel?: (operation: string, input: unknown) => Promise<unknown>
  readonly codex?: (operation: string, input: unknown, metadata?: unknown) => Promise<unknown>
  readonly rendererConfiguration?: (operation: RendererConfigOperation) => Promise<RendererConfigResult>
  readonly managerServiceAuth?: (operation: ManagerServiceAuthOperation) => Promise<unknown>
  readonly managerChannelCredentials?: (operation: ManagerChannelCredentialOperation) => Promise<unknown>
  readonly processStartedAt?: string
}): Promise<ProductionPluginManagementComposition> {
  const service = await openPluginManagementService({
    configPath: input.configPath,
    homeDir: input.homeDir,
    appId: input.appId,
    profileId: input.profileId,
    lifecycle: {
      coordinator: input.coordinator,
      runtimeGeneration: input.runtimeGeneration,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
    },
  })
  let closed = false
  const rendererSessions = new ManagerRendererSessions({
    profileId: input.profileId,
    ownerGeneration: input.runtimeGeneration,
    ownerCurrent: () => !closed,
    authenticateGateway: createManagerRendererGatewayAuthenticator({
      homeDir: input.homeDir,
      profileId: input.profileId,
      ownerAppId: input.appId,
      ownerGeneration: input.runtimeGeneration,
    }),
    channels: new Map([['plugin-management', createManagerRendererManagementChannel(service)]]),
  })
  let server: PluginManagementRpcServer
  try {
    const processStartedAt = input.processStartedAt ?? await processStartIdentity(process.pid)
    if (processStartedAt === undefined) throw new Error('cannot identify the CordisX management owner process')
    server = await startPluginManagementRpcServer({
      homeDir: input.homeDir,
      appId: input.appId,
      profileId: input.profileId,
      configPath: input.configPath,
      generation: input.runtimeGeneration,
      processStartedAt,
      ...(input.mode === 'service' ? { sandboxMailbox: true } : {}),
      service,
      managerRenderer: async operation => await dispatchManagerRendererOperation(rendererSessions, operation),
      permissionReview: async operation =>
        await applyManagementPermissionReview({
          coordinator: input.coordinator,
          profileId: input.profileId,
          generation: input.runtimeGeneration,
          operation,
        }),
      ...(input.modelExport === undefined ? {} : { modelExport: input.modelExport }),
      ...(input.terminalProvider === undefined ? {} : { terminalProvider: input.terminalProvider }),
      ...(input.channel === undefined ? {} : { channel: input.channel }),
      ...(input.codex === undefined ? {} : { codex: input.codex }),
      ...(input.rendererConfiguration === undefined ? {} : { rendererConfiguration: input.rendererConfiguration }),
      ...(input.managerServiceAuth === undefined ? {} : { managerServiceAuth: input.managerServiceAuth }),
      ...(input.managerChannelCredentials === undefined
        ? {}
        : { managerChannelCredentials: input.managerChannelCredentials }),
    })
  } catch (error) {
    rendererSessions.dispose()
    service.close()
    throw error
  }
  return {
    handler: {
      token: input.token,
      profileId: input.profileId,
      generation: input.runtimeGeneration,
      service,
      ...(input.modelExport === undefined ? {} : { modelExport: input.modelExport }),
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      rendererSessions.dispose()
      try {
        await server.close()
      } finally {
        service.close()
      }
    },
  }
}

/** Resolve the live composition at request time, including late bootstrap completion. */
export function nativeCatalogExport(current: () => NativeSubmissionComposition | undefined) {
  return async (request: ModelExportRequest): Promise<CliModelExportResult> => {
    const composition = current()
    if (!composition?.modelExport) throw new Error('Model export catalog unavailable in this runtime')
    return composition.modelExport(request)
  }
}

export function nativeTerminalProvider(current: () => NativeSubmissionComposition | undefined) {
  return async (request: TerminalProviderRequest): Promise<TerminalProviderResult> => {
    const composition = current()
    if (!composition?.terminalProvider) throw new Error('Terminal provider unavailable in this runtime')
    return composition.terminalProvider(request)
  }
}

/** Late native bootstrap and replacement are resolved for every command, never cached as availability. */
export function nativeCodexOperations(current: () => NativeSubmissionComposition | undefined) {
  return async (operation: string, input: unknown, metadata?: unknown): Promise<unknown> =>
    await current()?.codex?.(operation, input, metadata)
      ?? { status: 'unavailable', code: 'CODEX_RUNTIME_UNAVAILABLE' }
}
