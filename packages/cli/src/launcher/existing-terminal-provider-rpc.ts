import path from 'node:path'
import { hasMatchingProcessIdentity } from '../cli/supervisor-state.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from './management-rpc.js'
import type { TerminalProviderRequest, TerminalProviderResult } from './terminal-provider.js'

export interface ExistingTerminalProviderSource {
  readonly homeDir: string
  readonly profileId: string
}

/** Pin one existing Host. Every request and response remains inside that exact owner lifetime. */
export async function connectExistingTerminalProvider(source: ExistingTerminalProviderSource) {
  const paths = pluginManagementRpcPaths(source.homeDir, 'codex', source.profileId)
  const endpoint = await readPluginManagementRpcEndpoint(paths)
  const configPath = path.resolve(source.homeDir, 'config.json')
  if (
    !endpoint || endpoint.appId !== 'codex' || endpoint.profileId !== source.profileId
    || path.resolve(endpoint.configPath) !== configPath
    || !await hasMatchingProcessIdentity(endpoint.pid, endpoint.processStartedAt)
  ) {
    throw new Error('Existing CordisX provider Host unavailable')
  }
  const check = async () => {
    const current = await readPluginManagementRpcEndpoint(paths)
    if (
      !current || current.appId !== endpoint.appId || current.profileId !== endpoint.profileId
      || path.resolve(current.configPath) !== configPath || current.pid !== endpoint.pid
      || current.processStartedAt !== endpoint.processStartedAt || current.token !== endpoint.token
      || current.generation !== endpoint.generation
      || !await hasMatchingProcessIdentity(current.pid, current.processStartedAt)
    ) {
      throw new Error('CordisX owner changed; start a new session')
    }
  }
  return async (request: TerminalProviderRequest): Promise<TerminalProviderResult> => {
    await check()
    const result = await requestPluginManagementRpc(paths, endpoint, { kind: 'terminal-provider', request })
    await check()
    return result as TerminalProviderResult
  }
}
