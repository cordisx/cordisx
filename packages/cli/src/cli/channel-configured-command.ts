import path from 'node:path'
import { loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestNamespacedManagementRpc,
  requestPluginManagementRpc,
  usesNamespacedManagementRpc,
} from '../launcher/management-rpc.js'
import { processIdentityStatus } from './supervisor-state.js'

const OPERATIONS = [
  'connections',
  'conversations',
  'bind',
  'unbind',
  'bind-status',
  'local-bindings',
  'admin-pair-begin',
  'admin-pair-status',
  'admin-pair-confirm',
  'admin-pair-cancel',
  'continuation-policy',
  'continuation-policy-set',
  'continuation-start',
  'continuation-checkpoint',
  'continuation-checkpoint-set',
  'continuation-history',
  'continuation-takeover-ready',
  'reply-mode',
  'history',
  'remote-history',
  'message-get',
  'listen',
  'send',
  'send-many',
  'ask',
  'question-cancel',
  'receipt',
  'policy',
  'policy-set',
  'execution-defaults',
  'execution-defaults-set',
  'execution-settings',
  'execution-settings-set',
  'docs',
  'model-list',
  'task-settings',
  'task-settings-set',
  'task-config',
  'task-config-set',
  'task-requests',
]

/** Normal commands use the exact configured launcher. No new SDK, secret input, or inactive fallback. */
export async function runConfiguredChannelCommand(
  args: readonly string[],
  stdout: (line: string) => void,
): Promise<void> {
  const operation = args[0]
  if (!operation || !OPERATIONS.includes(operation)) throw new Error('INVALID_CHANNEL_OPERATION')
  const options: Record<string, string> = {}
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!key || !['--profile', '--input', '--context'].includes(key) || value === undefined || options[key]) {
      throw new Error('INVALID_CHANNEL_OPTIONS')
    }
    options[key] = value
  }
  const configPath = resolveHomeConfigPath({ env: process.env })
  const config = await loadHomeConfig(configPath), appId = config.defaultApp
  const profileId = options['--profile'] ?? config.apps[appId]?.defaultProfile
  if (!profileId || !config.apps[appId]?.profiles[profileId]) throw new Error('PROFILE_UNAVAILABLE')
  const paths = pluginManagementRpcPaths(path.dirname(configPath), appId, profileId)
  const endpoint = await readPluginManagementRpcEndpoint(paths)
  if (!endpoint) throw new Error('CHANNEL_RUNTIME_NOT_RUNNING')
  if (
    endpoint.appId !== appId || endpoint.profileId !== profileId
    || path.resolve(endpoint.configPath) !== path.resolve(configPath)
  ) throw new Error('CHANNEL_RUNTIME_SCOPE_MISMATCH')
  const namespaced = await usesNamespacedManagementRpc(endpoint)
  if (!namespaced) {
    const identity = await processIdentityStatus(endpoint.pid, endpoint.processStartedAt)
    if (identity === 'unknown') throw new Error('CHANNEL_HOST_IDENTITY_UNVERIFIABLE')
    if (identity !== 'alive') throw new Error('CHANNEL_HOST_IDENTITY_STALE')
  }
  let input: unknown
  try {
    input = options['--input'] === undefined ? {} : JSON.parse(options['--input'])
  } catch {
    throw new Error('INVALID_CHANNEL_INPUT')
  }
  let result: unknown
  try {
    result = await (namespaced ? requestNamespacedManagementRpc : requestPluginManagementRpc)(paths, endpoint, {
      kind: 'channel',
      operation,
      input,
      ...(options['--context'] ? { context: options['--context'] } : {}),
      ...(process.env.CODEX_THREAD_ID ? { callerThreadId: process.env.CODEX_THREAD_ID } : {}),
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(
      code === 'EACCES' || code === 'EPERM'
        ? 'CHANNEL_RPC_PERMISSION_DENIED'
        : code === 'ECONNREFUSED' || code === 'ENOENT'
        ? 'CHANNEL_RPC_UNAVAILABLE'
        : 'CHANNEL_RPC_RESULT_UNKNOWN',
    )
  }
  stdout(JSON.stringify(result))
  if ((result as { status?: string }).status !== 'ok') throw new Error('CHANNEL_OPERATION_REJECTED')
}
