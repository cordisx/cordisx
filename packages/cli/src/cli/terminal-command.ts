import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
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
  prepared?: Extract<TerminalProviderResult, { kind: 'prepared' }>,
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
  result.push(...invocation.codexArgs)
  return result
}

export async function runTerminalCommand(invocation: TerminalInvocation, runtime: CordisXCliRuntime): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  if (invocation.help) return stdout(TERMINAL_HELP)
  const environment = { ...runtime.env ?? process.env }
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
  if (invocation.service || invocation.list || invocation.profile) {
    const configPath = resolveHomeConfigPath({
      env: environment,
      ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
    })
    const config = await loadHomeConfig(configPath)
    const app = config.apps.codex
    const profileId = invocation.profile ?? app?.defaultProfile
    const profile = profileId && Object.hasOwn(app?.profiles ?? {}, profileId) ? app!.profiles[profileId] : undefined
    if (!profile || !profileId) throw new Error('Existing CordisX Codex profile required; CLI never creates profiles')
    if (profile.dataMode === 'host-isolated') {
      environment.CODEX_HOME = path.join(path.dirname(configPath), 'apps', 'codex', 'profiles', profileId, 'codex-home')
    }
    const paths = pluginManagementRpcPaths(path.dirname(configPath), 'codex', profileId)
    const endpoint = await readPluginManagementRpcEndpoint(paths)
    if (invocation.service || invocation.list) {
      if (
        !endpoint || endpoint.appId !== 'codex' || endpoint.profileId !== profileId
        || path.resolve(endpoint.configPath) !== path.resolve(configPath)
        || !await hasMatchingProcessIdentity(endpoint.pid, endpoint.processStartedAt)
      ) {
        throw new Error('CordisX service selection requires an already-running compatible Host; no App was started')
      }
      request = async input => {
        const current = await readPluginManagementRpcEndpoint(paths)
        if (
          !current || current.token !== endpoint.token || current.generation !== endpoint.generation
          || !await hasMatchingProcessIdentity(current.pid, current.processStartedAt)
        ) {
          throw new Error('CordisX owner changed; start a new CLI session')
        }
        return await requestPluginManagementRpc(paths, endpoint, {
          kind: 'terminal-provider',
          request: input,
        }) as TerminalProviderResult
      }
    }
  }
  if (invocation.list) {
    const result = await request!({ kind: 'list' })
    if (result.kind !== 'list') throw new Error('Invalid terminal catalog response')
    stdout(JSON.stringify(result, null, 2))
    return
  }
  let prepared: Extract<TerminalProviderResult, { kind: 'prepared' }> | undefined
  let child: ChildProcess | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let renewing = false, failure: Error | undefined
  try {
    if (invocation.service && invocation.model) {
      const result = await request!({ kind: 'prepare', providerId: invocation.service, model: invocation.model })
      if (result.kind !== 'prepared' || result.providerId !== invocation.service || result.model !== invocation.model) {
        throw new Error('Invalid terminal provider preparation')
      }
      prepared = result
    }
    const args = terminalCodexArguments(invocation, prepared, instructionsFile)
    child = (runtime.internalSpawnTerminal ?? spawn)(invocation.executable ?? 'codex', [...args], {
      cwd,
      env: environment,
      stdio: 'inherit',
      shell: false,
    })
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
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    for (const signal of signals) process.on(signal, abort)
    runtime.internalSignal?.addEventListener('abort', abort, { once: true })
    if (runtime.internalSignal?.aborted) abort()
    try {
      const code = await new Promise<number>((resolve, reject) => {
        child!.once('error', () => reject(new Error('Could not start Codex CLI; check --codex-executable or PATH')))
        child!.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
      })
      if (failure) throw failure
      if (code !== 0) throw Object.assign(new Error(`Codex CLI exited with status ${code}`), { exitCode: code })
    } finally {
      for (const signal of signals) process.off(signal, abort)
      runtime.internalSignal?.removeEventListener('abort', abort)
    }
  } finally {
    clearInterval(timer)
    if (prepared) await request!({ kind: 'release', leaseId: prepared.leaseId }).catch(() => undefined)
  }
}
