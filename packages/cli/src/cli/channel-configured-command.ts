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
import { prepareChannelSendInput } from './channel-send-payload.js'
import { parseChannelMediaPrepareArgv, validateChannelMediaPrepareRequest } from './channel-media-prepare-payload.js'

const OPERATIONS = [
  'forward',
  'merge-forward',
  'forward-receipt',
  'memory',
  'memory-authority-set',
  'memory-persona-profile',
  'memory-persona-bind',
  'memory-persona-context',
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
  'logical-mode-default',
  'logical-mode-default-set',
  'logical-mode-conversation',
  'logical-mode-conversation-set',
  'logical-status',
  'logical-chain',
  'logical-abandon',
  'continuation-checkpoint',
  'continuation-checkpoint-set',
  'continuation-history',
  'continuation-takeover-ready',
  'reply-mode',
  'history',
  'remote-history',
  'thread-history',
  'message-search',
  'message-get',
  'message-capabilities',
  'message-operation-receipt',
  'message-edit',
  'message-recall',
  'pin-add',
  'pin-remove',
  'pin-list',
  'read-users',
  'reaction-list',
  'card-update',
  'listen',
  'send',
  'send-many',
  'media-prepare',
  'ask',
  'question-cancel',
  'receipt',
  'reaction',
  'policy',
  'policy-set',
  'user-access',
  'user-access-set',
  'group-block',
  'group-block-set',
  'group-access',
  'input-ack',
  'input-status',
  'group-access-set',
  'execution-defaults',
  'execution-defaults-set',
  'execution-settings',
  'execution-settings-set',
  'docs',
  'model-list',
  'model-priority',
  'model-priority-set',
  'failure-notices',
  'failure-notices-set',
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
  if (operation === 'media-prepare' && args[1] && !args[1].startsWith('--')) {
    const parsed = parseChannelMediaPrepareArgv(args.slice(1))
    return runConfiguredChannelCommand([
      'media-prepare',
      ...(parsed.profile === undefined ? [] : ['--profile', parsed.profile]),
      ...(parsed.context === undefined ? [] : ['--context', parsed.context]),
      '--input',
      JSON.stringify(parsed.input),
    ], stdout)
  }
  if (operation === 'memory' && args[1] && !args[1].startsWith('--')) {
    const action = args[1], remaining = args.slice(2), inputIndex = remaining.indexOf('--input')
    let input: Record<string, unknown> = {}
    if (inputIndex >= 0) {
      input = JSON.parse(remaining[inputIndex + 1] ?? '') as Record<string, unknown>
      if (!input || typeof input !== 'object' || Array.isArray(input) || 'action' in input) {
        throw new Error('MEMORY_INVALID_REQUEST')
      }
      remaining.splice(inputIndex, 2)
    }
    return runConfiguredChannelCommand([
      'memory',
      ...remaining,
      '--input',
      JSON.stringify({ ...input, action }),
    ], stdout)
  }
  if (!operation || !OPERATIONS.includes(operation)) throw new Error('INVALID_CHANNEL_OPERATION')
  const options: Record<string, string> = {}
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1]
    if (!key || !['--profile', '--input', '--context'].includes(key) || value === undefined || options[key]) {
      throw new Error('INVALID_CHANNEL_OPTIONS')
    }
    options[key] = value
  }
  let input: unknown
  try {
    input = options['--input'] === undefined ? {} : JSON.parse(options['--input'])
  } catch {
    throw new Error('INVALID_CHANNEL_INPUT')
  }
  if (operation === 'send' || operation === 'send-many') input = prepareChannelSendInput(input)
  if (operation === 'media-prepare') input = validateChannelMediaPrepareRequest(input)
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
  const request = {
    kind: 'channel' as const,
    operation,
    input,
    ...(options['--context'] ? { context: options['--context'] } : {}),
    ...(process.env.CODEX_THREAD_ID ? { callerThreadId: process.env.CODEX_THREAD_ID } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') + 1 >= 256 * 1024) {
    throw new Error('CHANNEL_RPC_INPUT_TOO_LARGE')
  }
  let result: unknown
  try {
    result = await (namespaced ? requestNamespacedManagementRpc : requestPluginManagementRpc)(paths, endpoint, request)
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
