import { createApprovalReviewConfiguration } from '../launcher/approval-review-configuration.js'
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
import { parseCodexCommand } from './codex-command-parse.js'

const help =
  `CordisX supplemental Codex operations (existing native tools remain preferred for ordinary chat operations):
cordisx codex capabilities
cordisx codex providers list
cordisx codex chats provider set [--session <id>] --provider <id> --model <id>
cordisx codex chats settings get [--session <id>]
cordisx codex chats settings set [--session <id>] --revision <n> [--effort <value>] [--work-mode <default|plan|inherit>] [--execution <mode>] [--approval <mode>] [--network <true|false>]
cordisx codex chats settings reset [--session <id>] --revision <n>
cordisx codex defaults get
cordisx codex defaults set --revision <n> [settings flags or --input-file <JSON-file|->]
cordisx codex chats create [--provider <id>] [--model <id>] [--fast <true|false>] [--effort <value>] --message <text> --operation <id> [--project <project-id>] [--title <text>]
  [--environment <local|worktree>] [--starting-state <working-tree|branch>] [--branch <ref>] [--on-missing <error|create-branch>] [--directory-name <name>]
cordisx models services list
cordisx models services save --input-file <JSON-file|->
All commands accept --profile <id>. Chat targets use --session or CODEX_THREAD_ID; no target never changes global defaults.
Settings set replaces the saved override; read its revision first. Defaults affect future chats, settings affect the next turn.
Provider-aware create uses the existing native create_thread path and requires an actual source session/turn (--source-session, --source-turn or CODEX_THREAD_ID, CODEX_TURN_ID). No fabricated source or fallback creation.
Creation effort must be supported by the selected model. Worktree options require an explicit project; --branch requires --starting-state branch. Directory name applies to projectless tasks only.
Channel tasks pass their --context token and retain Channel permissions. Only --host local is supported.
Model-service save replaces the declared services using the revision from list. Keep unrelated services. Keys/header values are write-only; use a private file or stdin. Saved services apply after restart.
cordisx codex defaults model get
cordisx codex defaults model set --revision <n> [--provider <id>] [--model <id>] [--fast <true|false>]
cordisx codex chats fast get [--session <id>]
cordisx codex chats fast set [--session <id>] --revision <n> --fast <true|false>
cordisx codex chats project get [--session <id>]
cordisx codex chats project set [--session <id>] --revision <n> --project <id> [--cwd <path>]
cordisx codex chats reviewer get --session <id>
cordisx codex chats reviewer set --session <id> --revision <n> --reviewer <user|auto_review>
cordisx codex defaults review get
cordisx codex defaults review set --revision <n> --input-file <JSON-file|->
cordisx codex defaults review reset --revision <n>
Review routing uses a complete native model catalog and applies after native restart. It does not enable auto_review or support live per-chat routing.
Reviewer changes are local management only and require an idle chat; they do not change sandbox or approval policy.
Project/Fast writes require an idle loaded chat. Project selection aligns membership, cwd and writable roots; a full-access chat is narrowed to workspace-write. Read revisions before writes. Headless services can use operator-configured workspace projects; these do not create Desktop sidebar membership.`

export function codexRpcError(operation: string, error: unknown): Error {
  if (
    operation === 'capabilities' && error instanceof Error
    && error.message === 'plugin management operation is unsupported'
  ) {
    return new Error('CODEX_RUNTIME_INCOMPATIBLE')
  }
  return new Error('CODEX_RPC_RESULT_UNKNOWN')
}

export class CodexCommandRejected extends Error {
  readonly reported = true
}
export async function runCodexCommand(
  args: readonly string[],
  models = false,
  stdout: (line: string) => void = console.log,
) {
  if (!args.length || args[0] === 'help' || args.includes('--help')) return stdout(help)
  const command = await parseCodexCommand(args, models)
  const configPath = resolveHomeConfigPath({ env: process.env })
  const config = await loadHomeConfig(configPath), appId = 'codex'
  const profileId = command.profile ?? config.apps[appId]?.defaultProfile
  if (!profileId || !config.apps[appId]?.profiles[profileId]) throw new Error('PROFILE_UNAVAILABLE')
  if (command.operation.startsWith('review:')) {
    const callerThreadId = command.sourceSession ?? process.env.CODEX_THREAD_ID
    const result = await createApprovalReviewConfiguration({ configPath, profileId })(
      command.operation.slice(6),
      command.input,
      {
        ...(callerThreadId ? { 'openai/threadId': callerThreadId } : {}),
        ...(command.context ? { 'cordisx/channelContext': command.context } : {}),
      },
    )
    stdout(JSON.stringify(result))
    if (result.status !== 'ok') throw new CodexCommandRejected()
    return
  }
  const paths = pluginManagementRpcPaths(path.dirname(configPath), appId, profileId)
  const endpoint = await readPluginManagementRpcEndpoint(paths)
  if (!endpoint) throw new Error('CODEX_RUNTIME_NOT_RUNNING')
  if (
    endpoint.appId !== appId || endpoint.profileId !== profileId
    || path.resolve(endpoint.configPath) !== path.resolve(configPath)
  ) {
    throw new Error('CODEX_RUNTIME_SCOPE_MISMATCH')
  }
  const namespaced = await usesNamespacedManagementRpc(endpoint)
  if (!namespaced && await processIdentityStatus(endpoint.pid, endpoint.processStartedAt) !== 'alive') {
    throw new Error('CODEX_RUNTIME_OWNER_UNVERIFIABLE')
  }
  let result: unknown
  try {
    const callerThreadId = command.sourceSession ?? process.env.CODEX_THREAD_ID
    const callerTurnId = command.sourceTurn ?? process.env.CODEX_TURN_ID
    result = await (namespaced ? requestNamespacedManagementRpc : requestPluginManagementRpc)(paths, endpoint, {
      kind: 'codex',
      operation: command.operation,
      input: command.input,
      ...(command.context ? { context: command.context } : {}),
      ...(callerThreadId ? { callerThreadId } : {}),
      ...(callerTurnId ? { callerTurnId } : {}),
    })
  } catch (error) {
    throw codexRpcError(command.operation, error)
  }
  stdout(JSON.stringify(result))
  const status = (result as { status?: string })?.status
  if (!['ok', 'selected', 'created', 'pending', 'applied'].includes(status ?? '')) throw new CodexCommandRejected()
}

export function codexCommandError(error: unknown) {
  const raw = error instanceof Error ? error.message : ''
  const code = /^[A-Z][A-Z0-9_]{1,80}$/u.test(raw) ? raw : 'CODEX_COMMAND_FAILED'
  return {
    status: 'failed',
    code,
    automaticRetry: false,
    message: code === 'CODEX_RPC_RESULT_UNKNOWN'
      ? 'The request may have reached the Host. Inspect the target/settings or reuse the exact creation operationId; do not retry blindly.'
      : code === 'CODEX_RUNTIME_INCOMPATIBLE'
      ? 'The running CordisX Host does not support this capability query; a compatible Host is required.'
      : code === 'CODEX_RUNTIME_NOT_RUNNING'
      ? 'Start the selected CordisX Codex profile. This command never starts another App or backend.'
      : 'Run cordisx codex help and inspect the selected profile. No automatic retry was attempted.',
  }
}
