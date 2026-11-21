import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareApprovalReviewCatalog } from '../launcher/approval-review-catalog.js'
import os from 'node:os'
import { installConfiguredSkills } from '../launcher/configured-skills.js'
import { randomUUID } from 'node:crypto'
import { type ChildProcess, spawn } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { mcpServersForApp } from '../config/home-config-mcp.js'
import { mergeHomeEnvironment } from '../config/home-config-environment.js'
import { prepareClaudeMcp, projectMcpToCodex } from '../launcher/mcp-projection.js'
import { codexHome } from './run-support.js'
import type { HomeConfig } from '../config/home-config.js'
import { MODEL_SERVICE_HEADER_ENV_PREFIX } from '../config/model-service-runtime-options.js'
import {
  connectExistingTerminalProvider,
  type ExistingTerminalProviderSource,
  TerminalOwnerDiscoveryError,
} from '../launcher/existing-terminal-provider-rpc.js'
import type { TerminalProviderRequest, TerminalProviderResult } from '../launcher/terminal-provider.js'
import { TERMINAL_HELP, type TerminalInvocation } from './terminal-parse.js'
import type { CordisXCliRuntime } from './run-runtime.js'
import { prepareTerminalCodexProviderLayer } from './terminal-codex-provider-layer.js'
import { prepareSharedTerminalService, sharedTerminalServices } from './terminal-shared-service.js'
import { checkTerminalClient, terminalClientName, terminalClientStartupError } from './terminal-client-check.js'

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
  nativeProfile?: string,
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
  const result: string[] = nativeProfile === undefined ? [] : ['--profile', nativeProfile]
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
      || key.startsWith(MODEL_SERVICE_HEADER_ENV_PREFIX)
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
  let host: ExistingTerminalProviderSource | undefined
  let shared: ReturnType<typeof prepareSharedTerminalService>
  let declared: ReturnType<typeof sharedTerminalServices> = []
  let homeConfig: HomeConfig | undefined
  const configPath = resolveHomeConfigPath({
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  })
  try {
    await lstat(configPath)
    homeConfig = await loadHomeConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!invocation.list && homeConfig) {
    Object.assign(environment, mergeHomeEnvironment(environment, homeConfig.environmentVariables))
  }
  if (invocation.service || invocation.list || invocation.profile || invocation.ownerApp) {
    const config = homeConfig ?? await loadHomeConfig(configPath)
    declared = sharedTerminalServices(config, client)
    if (invocation.service && invocation.model) {
      shared = prepareSharedTerminalService(config, client, invocation.service, invocation.model, environment)
    }
    if (shared && invocation.ownerApp) {
      throw new Error('--owner-app does not apply to a shared model-service declaration')
    }
    if (shared) Object.assign(environment, shared.environment)
    const app = invocation.ownerApp === undefined
      ? config.apps.codex ?? config.apps[config.defaultApp]
      : config.apps[invocation.ownerApp]
    if (invocation.ownerApp !== undefined && app === undefined) throw new Error('CordisX owner app is not configured')
    const profileId = invocation.profile ?? app?.defaultProfile
    const matchingProfiles = profileId === undefined
      ? []
      : Object.values(config.apps).flatMap(value =>
        Object.hasOwn(value.profiles, profileId) ? [value.profiles[profileId]!] : []
      )
    const profile = profileId === undefined ? undefined : invocation.ownerApp === undefined
      ? config.apps.codex?.profiles[profileId] ?? config.apps[config.defaultApp]?.profiles[profileId]
        ?? (matchingProfiles.length === 1 ? matchingProfiles[0] : undefined)
      : app?.profiles[profileId]
    if (!profile || !profileId) throw new Error('Existing CordisX profile required; CLI never creates profiles')
    const codexProfile = Object.hasOwn(config.apps.codex?.profiles ?? {}, profileId)
      ? config.apps.codex!.profiles[profileId]
      : undefined
    if (client === 'codex' && codexProfile === undefined && profile.dataMode === 'host-isolated') {
      throw new Error('An isolated Codex profile must be configured explicitly for this profile ID')
    }
    if (codexProfile?.dataMode === 'host-isolated' && client === 'codex') {
      environment.CODEX_HOME = path.join(path.dirname(configPath), 'apps', 'codex', 'profiles', profileId, 'codex-home')
    }
    if (!shared && (invocation.service || invocation.list)) {
      host = {
        homeDir: path.dirname(configPath),
        profileId,
        appIds: Object.entries(config.apps).filter(([, value]) => Object.hasOwn(value.profiles, profileId)).map((
          [id],
        ) => id),
        ...(invocation.ownerApp === undefined ? {} : { selectedAppId: invocation.ownerApp }),
      }
    }
  }
  const executable = invocation.list ? undefined : await (runtime.internalCheckTerminalClient ?? checkTerminalClient)(
    invocation.executable ?? (client === 'codex' ? 'codex' : 'claude'),
    { cwd, env: environment, client, ...(runtime.internalSignal ? { signal: runtime.internalSignal } : {}) },
  )
  if (host) {
    try {
      request = await connectExistingTerminalProvider(host)
    } catch (error) {
      if (error instanceof TerminalOwnerDiscoveryError && error.reason !== 'no-owner') throw error
      if (invocation.ownerApp !== undefined) {
        throw new Error('No verified CordisX owner matches --owner-app and the selected profile')
      }
      if (!invocation.list) {
        throw new Error(
          'CordisX plugin service selection requires an already-running compatible Host; no App was started',
        )
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
  const nativeInspection = invocation.codexArgs.some(arg => ['--help', '-h', '--version', '-V'].includes(arg))
    || ['mcp', 'help', 'list'].includes(invocation.codexArgs[0] ?? '')
  if (homeConfig?.skills?.length && !nativeInspection) {
    const home = runtime.homedir ?? environment.HOME ?? os.homedir()
    const clientRoot = client === 'claude-code'
      ? (environment.CLAUDE_CONFIG_DIR || path.join(home, '.claude'))
      : path.join(home, '.agents')
    await installConfiguredSkills({
      sources: homeConfig.skills,
      cacheDir: path.join(path.dirname(configPath), 'cache', 'skills'),
      skillsDir: path.join(clientRoot, 'skills'),
      report: stdout,
      env: environment,
    })
  }
  let prepared: Extract<TerminalProviderResult, { kind: 'prepared' }> | undefined
  let child: ChildProcess | undefined
  let reviewCatalog: Awaited<ReturnType<typeof prepareApprovalReviewCatalog>>
  let nativeLayer: Awaited<ReturnType<typeof prepareTerminalCodexProviderLayer>>
  let claudeMcp: Awaited<ReturnType<typeof prepareClaudeMcp>> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let renewing = false, failure: Error | undefined
  try {
    if (invocation.service && invocation.model && !shared) {
      runtime.internalSignal?.throwIfAborted()
      const waiterId = randomUUID()
      let cancelled = false
      const cancelWait = () => {
        cancelled = true
        void request!({ kind: 'cancel-wait', waiterId }).catch(() => undefined)
      }
      runtime.internalSignal?.addEventListener('abort', cancelWait, { once: true })
      process.once('SIGTERM', cancelWait)
      process.once('SIGHUP', cancelWait)
      let result: TerminalProviderResult
      try {
        result = await request!({
          kind: 'prepare',
          waiterId,
          providerId: invocation.service,
          model: invocation.model,
          ...(client === 'claude-code' ? { client } : {}),
        })
      } finally {
        runtime.internalSignal?.removeEventListener('abort', cancelWait)
        process.off('SIGTERM', cancelWait)
        process.off('SIGHUP', cancelWait)
      }
      if (result.kind === 'prepared') prepared = result
      if (cancelled) throw new Error('Terminal provider wait cancelled')
      if (result.kind === 'unavailable') {
        throw new Error(
          `Terminal provider unavailable: ${
            result.startup.status === 'unavailable' ? result.startup.reason : result.startup.status
          }`,
        )
      }
      runtime.internalSignal?.throwIfAborted()
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
    const sharedCodex = shared?.provider === undefined ? undefined : { ...shared, provider: shared.provider }
    if (client === 'codex' && sharedCodex) {
      nativeLayer = await prepareTerminalCodexProviderLayer(sharedCodex, environment, invocation.codexArgs)
    }
    const effectiveShared = nativeLayer && sharedCodex
      ? { ...sharedCodex, provider: nativeLayer.provider }
      : sharedCodex
    if (!nativeInspection) {
      const managed = Object.keys(mcpServersForApp(homeConfig?.mcp, client)).length > 0
      if (
        managed && client === 'claude-code'
        && invocation.codexArgs.some(arg =>
          arg === '--strict-mcp-config' || arg === '--mcp-config' || arg.startsWith('--mcp-config=')
        )
      ) throw new Error('CordisX MCP cannot be combined with native --mcp-config or --strict-mcp-config')
      if (managed && client === 'codex') {
        for (let index = 0; index < invocation.codexArgs.length; index++) {
          const arg = invocation.codexArgs[index]!
          const raw = arg === '-c' || arg === '--config'
            ? invocation.codexArgs[++index]
            : arg.startsWith('--config=')
            ? arg.slice(9)
            : arg.startsWith('-c')
            ? arg.slice(2)
            : undefined
          const key = raw?.split('=')[0]?.replace(/["'\s]/gu, '')
          if (key === 'mcp_servers' || key?.startsWith('mcp_servers.')) {
            throw new Error('Codex MCP overrides cannot replace CordisX-managed servers')
          }
        }
      }
      if (client === 'codex') await projectMcpToCodex(homeConfig?.mcp, codexHome(environment), environment)
      else claudeMcp = await prepareClaudeMcp(homeConfig?.mcp, environment, cwd)
    }
    if (client === 'codex' && !nativeInspection && homeConfig) {
      const app = homeConfig.apps.codex
      const profile = app?.profiles[invocation.profile ?? app.defaultProfile]
      const settings = profile?.approvalReview?.settings
      if (settings) {
        if (invocation.service !== settings.providerId) throw new Error('REVIEW_PROVIDER_SCOPE_MISMATCH')
        if (!invocation.model) throw new Error('REVIEW_PARENT_MODEL_REQUIRED')
        if (invocation.codexArgs.some(arg => arg === '--profile' || arg.startsWith('--profile=') || /^-p/u.test(arg))) {
          throw new Error('REVIEW_NATIVE_PROFILE_UNSUPPORTED')
        }
        const version = await promisify(execFile)(executable!, ['--version'], { env: environment, timeout: 5000 })
        reviewCatalog = await prepareApprovalReviewCatalog({
          settings,
          configPath,
          nativeVersion: version.stdout.trim().replace(/^codex-cli\s+/u, ''),
        })
        if (invocation.model && !reviewCatalog?.modelIds.includes(invocation.model)) {
          throw new Error('REVIEW_PARENT_MODEL_NOT_IN_CATALOG')
        }
      }
    }
    const args = client === 'codex'
      ? terminalCodexArguments(invocation, prepared ?? effectiveShared, instructionsFile, nativeLayer?.name)
      : [
        ...terminalClaudeArguments(invocation, instructionsFile),
        ...(claudeSettings ? ['--settings', claudeSettings] : []),
        ...(claudeMcp?.file ? ['--mcp-config', claudeMcp.file] : []),
      ]
    try {
      child = (runtime.internalSpawnTerminal ?? spawn)(
        executable!,
        [...(reviewCatalog ? ['-c', `model_catalog_json=${toml(reviewCatalog.path)}`] : []), ...args],
        {
          cwd,
          env: environment,
          stdio: 'inherit',
          shell: false,
        },
      )
    } catch (error) {
      throw terminalClientStartupError(client, executable!, error)
    }
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
        child!.once(
          'error',
          error => reject(terminalClientStartupError(client, executable!, error)),
        )
        child!.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)))
      })
      if (failure) throw failure
      if (code !== 0) {
        throw Object.assign(new Error(`${terminalClientName(client)} CLI exited with status ${code}`), {
          exitCode: code,
        })
      }
    } finally {
      process.off('SIGINT', interrupt)
      for (const signal of signals) process.off(signal, abort)
      runtime.internalSignal?.removeEventListener('abort', abort)
    }
  } finally {
    clearInterval(timer)
    if (prepared) await request!({ kind: 'release', leaseId: prepared.leaseId }).catch(() => undefined)
    await reviewCatalog?.close()
    await nativeLayer?.close()
    await claudeMcp?.close()
  }
}
