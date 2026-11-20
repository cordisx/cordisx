import path from 'node:path'
import { loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import {
  type PluginManagementRpcEndpoint,
  type PluginManagementRpcOperation,
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  usesNamespacedManagementRpc,
} from '../launcher/management-rpc.js'
import { processIdentityStatus } from './supervisor-state.js'

/** A sandbox mailbox is not local-administrator authority. */
export async function managerOwnerIsLocal(
  endpoint: PluginManagementRpcEndpoint,
  namespaced: typeof usesNamespacedManagementRpc = usesNamespacedManagementRpc,
  identify: typeof processIdentityStatus = processIdentityStatus,
): Promise<boolean> {
  if (await namespaced(endpoint)) return false
  return await identify(endpoint.pid, endpoint.processStartedAt) === 'alive'
}

/** Attach to the existing profile owner. Never start or replace an owner here. */
export async function resolveManagerProfile(profile?: string, env: NodeJS.ProcessEnv = process.env) {
  const configPath = resolveHomeConfigPath({ env })
  const config = await loadHomeConfig(configPath)
  const profileId = profile ?? config.apps[config.defaultApp]?.defaultProfile
  if (!profileId || !Object.values(config.apps).some(app => app.profiles[profileId])) {
    throw new Error('PROFILE_UNAVAILABLE')
  }
  return { configPath, config, profileId, homeDir: path.dirname(configPath) }
}

export async function openManagerOwner(profile?: string, env: NodeJS.ProcessEnv = process.env) {
  const { configPath, config, profileId } = await resolveManagerProfile(profile, env)
  const candidates = await Promise.all(
    Object.entries(config.apps).flatMap(([appId, app]) => {
      if (!app.profiles[profileId]) return []
      return [(async () => {
        const paths = pluginManagementRpcPaths(path.dirname(configPath), appId, profileId)
        const endpoint = await readPluginManagementRpcEndpoint(paths)
        if (!endpoint) return undefined
        if (
          endpoint.appId !== appId || endpoint.profileId !== profileId
          || path.resolve(endpoint.configPath) !== path.resolve(configPath)
        ) throw new Error('MANAGER_OWNER_SCOPE_MISMATCH')
        // The sandbox mailbox explicitly does not confer local administrator authority.
        if (!await managerOwnerIsLocal(endpoint)) return undefined
        return { appId, paths, endpoint }
      })()]
    }),
  )
  const active = candidates.filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== undefined)
  if (active.length === 0) throw new Error('MANAGER_OWNER_NOT_RUNNING')
  if (active.length !== 1) throw new Error('MANAGER_OWNER_AMBIGUOUS')
  const { appId, paths, endpoint } = active[0]!
  return {
    appId,
    profileId,
    generation: endpoint.generation,
    async isCurrent(): Promise<boolean> {
      const current = await readPluginManagementRpcEndpoint(paths)
      return current?.generation === endpoint.generation && current.token === endpoint.token
        && await processIdentityStatus(endpoint.pid, endpoint.processStartedAt) === 'alive'
    },
    async request(operation: PluginManagementRpcOperation): Promise<unknown> {
      const current = await readPluginManagementRpcEndpoint(paths)
      if (!current || current.generation !== endpoint.generation || current.token !== endpoint.token) {
        throw new Error('MANAGER_OWNER_CHANGED')
      }
      if (await processIdentityStatus(endpoint.pid, endpoint.processStartedAt) !== 'alive') {
        throw new Error('MANAGER_OWNER_UNAVAILABLE')
      }
      return await requestPluginManagementRpc(paths, endpoint, operation)
    },
  }
}

export type ManagerOwner = Awaited<ReturnType<typeof openManagerOwner>>
