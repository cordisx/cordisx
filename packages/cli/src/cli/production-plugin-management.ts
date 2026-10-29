import type { NativeSubmissionComposition } from '../launcher/native-submission-composition.js'
import type { ModelExportRequest } from './model-export-parse.js'
import type { CliModelExportResult } from '../launcher/model-catalog/cli-export.js'
import type { PluginLifecycleCoordinator } from '../launcher/plugin-lifecycle.js'
import { openPluginManagementService } from '../management/service.js'
import {
  type PluginManagementBridgeHandler,
  type PluginManagementRpcServer,
  startPluginManagementRpcServer,
} from '../launcher/management-rpc.js'
import { processStartIdentity } from './supervisor-state.js'

export interface ProductionPluginManagementComposition {
  readonly handler: PluginManagementBridgeHandler
  close(): Promise<void>
}
export async function openProductionPluginManagementComposition(input: {
  readonly configPath: string
  readonly homeDir: string
  readonly appId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly token: string
  readonly coordinator: PluginLifecycleCoordinator
  readonly modelExport?: (request: ModelExportRequest) => Promise<CliModelExportResult>
  readonly processStartedAt?: string
}): Promise<ProductionPluginManagementComposition> {
  const service = await openPluginManagementService({
    configPath: input.configPath,
    homeDir: input.homeDir,
    appId: input.appId,
    profileId: input.profileId,
    lifecycle: { coordinator: input.coordinator, runtimeGeneration: input.runtimeGeneration },
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
      service,
      ...(input.modelExport === undefined ? {} : { modelExport: input.modelExport }),
    })
  } catch (error) {
    service.close()
    throw error
  }
  let closed = false
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
