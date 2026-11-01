import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../launcher/management-rpc.js'
import type { TerminalProviderRequest, TerminalProviderResult } from '../launcher/terminal-provider.js'
import { hasMatchingProcessIdentity } from './supervisor-state.js'
import { TERMINAL_HELP, type TerminalInvocation } from './terminal-parse.js'
import type { CordisXCliRuntime } from './run-runtime.js'
import { prepareSharedTerminalService, sharedTerminalServices } from './terminal-shared-service.js'

/** TOML literals, not shell commands. No provider credential values are accepted here. */
function toml(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(toml).join(', ')}]`
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)} = ${toml(entry)}`).join(', ')} }`
  }
  throw new Error('Invalid Codex provider configuration')
}

export function terminalCodexArguments(
  invocation: TerminalInvocation,
  prepared?: Pick<Extract<TerminalProviderResult, { kind: 'prepared' }>, 'providerId' | 'model' | 'provider'>,
  instructionsFile?: string,
): readonly string[] {
  const reserved = (key: string) =>
    key === 'model' || key === 'model_provider' || key === 'model_providers'
    || key.startsWith('model_providers.') || key === 'model_catalog_json'
  if (prepared) {
    for (let i = 0; i < invocation.codexArgs.length; i++) {
      const arg = invocation.codexArgs[i]!
      if (
        ['--model', '-m', '--oss', '--local-provider', '--remote', '--remote-auth-token-env'].includes(arg)
        || /^(--model|--local-provider|--remote|--remote-auth-token-env)=/u.test(arg)
        || /^-m.+/u.test(arg)
      ) throw new Error('Codex arguments cannot override the selected CordisX service/model')
      let config: string | undefined
      if (arg === '-c' || arg === '--config') config = invocation.codexArgs[++i]
      else if (arg.startsWith('--config=')) config = arg.slice('--config='.length)
      else if (arg.startsWith('-c') && arg.length > 2) config = arg.slice(2)
      if (config !== undefined && reserved(config.split('=')[0]!.trim().replace(/["'\s]/gu, ''))) {
        throw new Error('Codex config cannot override the selected CordisX service/model')
      }
    }
  }
  const result: string[] = []
  if (prepared) {
    result.push(
      '-c',
      `model_provider=${toml(prepared.providerId)}`,
      '-c',
      `model=${toml(prepared.model)}`,
      '-c',
      `model_providers=${toml({ [prepared.providerId]: prepared.provider })}`,
    )
  }
  if (instructionsFile) result.push('-c', `model_instructions_file=${toml(instructionsFile)}`)
  if (!prepared && invocation.model) result.push('--model', invocation.model)
  result.push(...invocation.codexArgs)
  return result
}

export function terminalClaudeArguments(invocation: TerminalInvocation, instructionsFile?: string): readonly string[] {
  if (
    invocation.service
    && invocation.codexArgs.some(arg =>
      ['--model', '--fallback-model', '--settings', '--setting-sources', '--agents', '--agent'].includes(arg)
      || /^(--model|--fallback-model|--settings|--setting-sources|--agents|--agent)=/u.test(arg)
    )
  ) throw new Error('Claude arguments cannot override the selected CordisX service/model')
  return [
    ...(invocation.model ? ['--model', invocation.model] : []),
    ...(instructionsFile ? ['--system-prompt-file', instructionsFile] : []),
    ...invocation.codexArgs,
  ]
}

export async function runTerminalCommand(invocation: TerminalInvocation, runtime: CordisXCliRuntime): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  if (invocation.help) return stdout(TERMINAL_HELP)
  const environment = { ...runtime.env ?? process.env }
  const client = invocation.client ?? 'codex'
  if (client === 'claude-code') {
    delete environment.CLAUDECODE
    delete environment.CLAUDE_CODE_SESSION_ID
    delete environment.CLAUDE_CODE_PLUGIN_DIRS
  }
  // A terminal launched by an agent inside the App is a new CLI instance, not
  // the App's native app-server intermediary or supervisor child.
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith('CORDISX_SUPERVISOR_') || key.startsWith('CORDISX_NATIVE_')
      || key === 'CORDISX_DOCK_ENTRY' || key === 'CORDISX_DOCK_RECORD'
      || [
        'CODEX_CLI_PATH',
        'CODEX_THREAD_ID',
        'CODEX_SESSION_ID',
        'CODEX_TOOL_CALL_ID',
        'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
      ].includes(key)
    ) delete environment[key]
  }
  const cwd = runtime.cwd ?? process.cwd()
  let instructionsFile: string | undefined
  if (invocation.instructionsFile) {
    instructionsFile = await realpath(path.resolve(cwd, invocation.instructionsFile))
    const metadata = await lstat(instructionsFile)
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1_000_000) {
      throw new Error('Instructions must be a nonempty regular file of at most 1 MB')
    }
  }
  let request: ((input: TerminalProviderRequest) => Promise<TerminalProviderResult>) | undefined
  let shared: ReturnType<typeof prepareSharedTerminalService>
  let declared: ReturnType<typeof sharedTerminalServices> = []
  if (invocation.service || invocation.list || invocation.profile) {
    const configPath = resolveHomeConfigPath({
      env: environment,
      ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
    })
    const config = await loadHomeConfig(configPath)
    declared = sharedTerminalServices(config, client)
    if (invocation.service && invocation.model) {
      shared = prepareSharedTerminalService(config, client, invocation.service, invocation.model, environment)
    }
    if (shared) Object.assign(environment, shared.environment)
    const app = config.apps.codex
    const profileId = invocation.profile ?? app?.defaultProfile
    const profile = profileId && Object.hasOwn(app?.profiles ?? {}, profileId) ? app!.profiles[profileId] : undefined
    if (!profile || !profileId) throw new Error('Existing CordisX Codex profile required; CLI never creates profiles')
    if (profile.dataMode === 'host-isolated' && client === 'codex') {
      environment.CODEX_HOME = path.join(path.dirname(configPath), 'apps', 'codex', 'profiles', profileId, 'codex-home')
    }
    const paths = pluginManagementRpcPaths(path.dirname(configPath), 'codex', profileId)
    const endpoint = shared ? undefined : await readPluginManagementRpcEndpoint(paths)
    if (!shared && (invocation.service || invocation.list)) {
      if (
        !endpoint || endpoint.appId !== 'codex' || endpoint.profileId !== profileId
        || path.resolve(endpoint.configPath) !== path.resolve(configPath)
        || !await hasMatchingProcessIdentity(endpoint.pid, endpoint.processStartedAt)
      ) {
        if (!invocation.list) {
          throw new Error(
            'CordisX plugin service selection requires an already-running compatible Host; no App was started',
          )
        }
      } else {
        request = async input => {
          const current = await readPluginManagementRpcEndpoint(paths)
          if (
            !current || current.token !== endpoint.token || current.generation !== endpoint.generation
            || !await hasMatchingProcessIdentity(current.pid, current.processStartedAt)
          ) throw new Error('CordisX owner changed; start a new CLI session')
          return await requestPluginManagementRpc(paths, endpoint, {
            kind: 'terminal-provider',
            request: input,
          }) as TerminalProviderResult
        }
      }
    }
  }
  if (invocation.list) {
    const result = request ? await request({ kind: 'list' }) : { kind: 'list' as const, providers: [] }
    if (result.kind !== 'list') throw new Error('Invalid terminal catalog response')
    stdout(
      JSON.stringify(
        {
          ...result,
          ...(request ? {} : { complete: false }),
          providers: [...result.providers.filter(p => !declared.some(d => d.providerId === p.providerId)), ...declared],
        },
        null,
        2,
      ),
    )
    return
  }
  let prepared: Extract<TerminalProviderResult, { kind: 'prepared' }> | undefined
  let child: ChildProcess | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let renewing = false, failure: Error | undefined
  try {
    if (invocation.service && invocation.model && !shared) {
      const result = await request!({
        kind: 'prepare',
        providerId: invocation.service,
        model: invocation.model,
        ...(client === 'claude-code' ? { client } : {}),
      })
      if (result.kind !== 'prepared' || result.providerId !== invocation.service || result.model !== invocation.model) {
        throw new Error('Invalid terminal provider preparation')
      }
      prepared = result
    }
    if (client === 'claude-code' && prepared) {
      if (!prepared.anthropicBaseUrl) throw new Error('This Host does not provide Claude Code gateway support')
      environment.ANTHROPIC_BASE_URL = prepared.anthropicBaseUrl
      // Claude requires an auth selection even when the local plugin owns login.
      environment.ANTHROPIC_AUTH_TOKEN = 'cordisx-local-gateway'
      delete environment.ANTHROPIC_API_KEY
    }
    let claudeSettings: string | undefined
    if (client === 'claude-code' && invocation.service) {
      environment.CORDISX_TERMINAL_SERVICE_KEY = environment.ANTHROPIC_AUTH_TOKEN
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
      claudeSettings = JSON.stringify({
        apiKeyHelper: `${quote(process.execPath)} ${
          quote(fileURLToPath(new URL('../../assets/launcher/terminal-claude-key.mjs', import.meta.url)))
        }`,
        env: { ANTHROPIC_BASE_URL: environment.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
      })
      delete environment.ANTHROPIC_AUTH_TOKEN
      delete environment.ANTHROPIC_API_KEY
    }
    const args = client === 'codex'
      ? terminalCodexArguments(invocation, prepared ?? shared, instructionsFile)
      : [
        ...terminalClaudeArguments(invocation, instructionsFile),
        ...(claudeSettings ? ['--settings', claudeSettings] : []),
      ]
    child = (runtime.internalSpawnTerminal ?? spawn)(
      invocation.executable ?? (client === 'codex' ? 'codex' : 'claude'),
      [...args],
      {
        cwd,
        env: environment,
        stdio: 'inherit',
        shell: false,
      },
    )
    if (prepared) {
      const leaseId = prepared.leaseId
      timer = setInterval(() => {
        if (renewing) return
        renewing = true
        void request!({ kind: 'renew', leaseId }).then(result => {
          if (result.kind !== 'renewed') throw new Error('Invalid terminal provider renewal')
        }).catch(() => {
          failure = new Error('CordisX provider retired; this CLI session was stopped. Start a new session')
          if (child?.exitCode === null) child.kill('SIGTERM')
        }).finally(() => {
          renewing = false
        })
      }, 10_000)
      timer.unref()
    }
    const abort = () => {
      if (child?.exitCode === null) child.kill('SIGTERM')
    }
    // The foreground terminal delivers SIGINT to the child too. Let Codex decide
    // whether Ctrl-C interrupts a turn or exits; do not turn it into SIGTERM.
    const interrupt = () => undefined
    process.on('SIGINT', interrupt)
    const signals = ['SIGTERM', 'SIGHUP'] as const
    for (const signal of signals) process.on(signal, abort)
    runtime.internalSignal?.addEventListener('abort', abort, { once: true })
    if (runtime.internalSignal?.aborted) abort()
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child!.once('error', () => reject(new Error(`Could not start ${client} CLI; check --executable or PATH`)))
        child!.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
      })
      if (failure) throw failure
      if (code !== 0) throw Object.assign(new Error(`Codex CLI exited with status ${code}`), { exitCode: code })
    } finally {
      process.off('SIGINT', interrupt)
      for (const signal of signals) process.off(signal, abort)
      runtime.internalSignal?.removeEventListener('abort', abort)
    }
  } finally {
    clearInterval(timer)
    if (prepared) await request!({ kind: 'release', leaseId: prepared.leaseId }).catch(() => undefined)
  }
}
