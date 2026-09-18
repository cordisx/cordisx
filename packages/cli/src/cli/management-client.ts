import path from 'node:path'
import { loadHomeConfig } from '../config/home-config.js'
import type {
  PluginManagementCatalogDetail,
  PluginManagementCatalogSnapshot,
  PluginManagementCatalogSummary,
  PluginManagementMigrationResult,
  PluginManagementResult,
  PluginManagementSnapshot,
} from '../management/contracts.js'
import { openPluginManagementService, type PluginManagementService } from '../management/service.js'
import {
  type PluginManagementRpcOperation,
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../launcher/management-rpc.js'
import { hasMatchingProcessIdentity } from './supervisor-state.js'

export interface OpenCliPluginManagementClientInput {
  readonly configPath: string
  readonly profileId: string
  readonly homeDir?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Opens the exact active profile backend when published; otherwise uses honest inactive persistence. */
export async function openCliPluginManagementClient(
  input: OpenCliPluginManagementClientInput,
): Promise<PluginManagementService> {
  const homeDir = input.homeDir ?? path.dirname(input.configPath)
  const config = await loadHomeConfig(input.configPath)
  const appId = config.defaultApp
  const paths = pluginManagementRpcPaths(homeDir, appId, input.profileId)
  const endpoint = await readPluginManagementRpcEndpoint(paths)
  if (endpoint !== undefined) {
    const active = endpoint.appId === appId
      && endpoint.profileId === input.profileId
      && path.resolve(endpoint.configPath) === path.resolve(input.configPath)
      && await hasMatchingProcessIdentity(endpoint.pid, endpoint.processStartedAt)
    if (active) {
      const request = async <Value>(operation: PluginManagementRpcOperation): Promise<Value> =>
        await requestPluginManagementRpc(paths, endpoint, operation) as Value
      return {
        query: async () => await request<PluginManagementSnapshot>({ kind: 'query' }),
        refreshCatalog: async sourceUrl =>
          await request<PluginManagementCatalogSnapshot>({
            kind: 'refresh-catalog',
            ...(sourceUrl === undefined ? {} : { sourceUrl }),
          }),
        queryCatalog: async query =>
          await request<readonly PluginManagementCatalogSummary[]>({
            kind: 'query-catalog',
            ...(query === undefined ? {} : { query }),
          }),
        pluginInfo: async query =>
          await request<PluginManagementCatalogDetail | undefined>({
            kind: 'plugin-info',
            query,
          }),
        plan: async operation => await request<PluginManagementResult>({ kind: 'plan', request: operation }),
        execute: async (operation, expectedRevision) =>
          await request<PluginManagementResult>({
            kind: 'execute',
            request: operation,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          }),
        migrateLegacySources: async migration =>
          await request<PluginManagementMigrationResult>({
            kind: 'migrate-legacy-sources',
            input: migration,
          }),
        subscribe: () => () => {},
        close: () => {},
      }
    }
  }
  return await openPluginManagementService({
    configPath: input.configPath,
    homeDir,
    appId,
    profileId: input.profileId,
  })
}
