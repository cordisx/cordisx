import { readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type HomeConfig, type HomeConfigProvider, loadHomeConfig } from '../config/home-config.js'
import { processIdentityStatus, readSupervisorState, supervisorPaths } from '../cli/supervisor-state.js'
import { agentBridgeBindingPath, codexLaunchRecordPath } from './agent-bridge-paths.js'
import { claudeProfilePidPath, claudeProfileRoot, runningClaudeProfile } from './claude-desktop-process.js'
import { type ClaudeDesktopBinding, claudeDesktopBindingPath } from './claude-host-sessions.js'
import { modelsForApp } from './model-service-projection.js'

/**
 * The read-only answer to "are the CordisX integrations working, and if not
 * what do I fix?" — one report shape, served by both sides of the agent bridge.
 *
 * Everything here is a file read or a probe that already exists (`ps`, the
 * bridge socket, the app-server's own `thread/list`). Nothing launches an app,
 * starts a turn, or writes a file. A model service key is reported only as set
 * or not set; its value never leaves the configuration.
 */

export const INTEGRATION_APPS = ['codex', 'claude'] as const
export type IntegrationApp = typeof INTEGRATION_APPS[number]
export const isIntegrationApp = (value: unknown): value is IntegrationApp =>
  typeof value === 'string' && (INTEGRATION_APPS as readonly string[]).includes(value)
const otherApp = (app: IntegrationApp): IntegrationApp => app === 'codex' ? 'claude' : 'codex'

export type IntegrationCheckStatus =
  | 'ok'
  | 'not-running'
  | 'missing'
  | 'unreachable'
  | 'not-connected'
  | 'not-configured'
  | 'unknown'

/**
 * One judged fact. `reason` is a stable machine-readable code and `remedy` is
 * the sentence an agent can act on; both are absent only where nothing is
 * wrong or the fix is the person's to decide.
 */
export interface IntegrationCheck {
  readonly status: IntegrationCheckStatus
  readonly reason?: string
  readonly remedy?: string
}

/** One app's own side of the bridge: the shared endpoint, its token, and whether it answers. */
export interface IntegrationBridgeCheck extends IntegrationCheck {
  /** Whether the binding carries a token; the value itself is never reported. */
  readonly token: 'present' | 'missing'
  readonly socketPath?: string
}

export interface IntegrationModelServiceApp {
  readonly usable: boolean
  /** The model ids this app may pick on the service, as declared. */
  readonly models: readonly string[]
  readonly reason?: 'disabled' | 'app-not-declared' | 'protocol-unsupported' | 'no-models'
}

/** One `model-service` declaration from the home config. */
export interface IntegrationModelService {
  readonly id: string
  readonly displayName: string
  /** The variable that holds the key. The value is never reported. */
  readonly keyVariable: string
  /** Whether that variable resolves to a non-empty value. */
  readonly keySet: boolean
  readonly apps: Readonly<Record<IntegrationApp, IntegrationModelServiceApp>>
}

export interface IntegrationAppReport {
  readonly app: IntegrationApp
  readonly status: IntegrationCheckStatus
  readonly reason?: string
  readonly remedy?: string
  readonly profileId?: string
  /** The model service the launch recorded, and whether the home config still declares it. */
  readonly modelService?: { readonly id: string; readonly declared: boolean }
  readonly bridge: IntegrationBridgeCheck
}

/** Health that can be judged cheaply, without starting anything. */
export interface IntegrationPluginsReport {
  /** The bridge plus bundled Skills directory `cordisx start claude` assembles in the profile. */
  readonly claudePluginDirectory: IntegrationCheck & { readonly path?: string }
  /** Whether an open Claude session's CordisX plugin is connected to the bridge. */
  readonly claudeSessionTools: IntegrationCheck
  /** Whether the Codex app-server answers a read-only request. */
  readonly codexAppServer: IntegrationCheck
}

export interface IntegrationProblem extends IntegrationCheck {
  /** Where the problem is, e.g. `other.bridge` or `model-service:sub2tok`. */
  readonly area: string
}

export interface IntegrationStatusReport {
  readonly version: 1
  /** `unavailable` only when this app's own side of the bridge is down. */
  readonly status: 'ok' | 'degraded' | 'unavailable'
  /** The app that asked; `self` is that app. */
  readonly app: IntegrationApp
  readonly cordisxHome: string
  readonly self: IntegrationAppReport
  readonly other: IntegrationAppReport
  readonly modelServices: readonly IntegrationModelService[]
  readonly plugins: IntegrationPluginsReport
  /** Every judgement that is not `ok`, with the remedy, so an agent need not re-derive them. */
  readonly problems: readonly IntegrationProblem[]
}

export interface IntegrationStatusInput {
  readonly cordisxHomeDir: string
  /** Whose perspective a call gets when its arguments name no app. */
  readonly caller: IntegrationApp
  readonly homedir?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** Whether the bridge endpoint answers. Defaults to one token-bearing request to its socket. */
  readonly bridgeAnswers?: () => boolean | Promise<boolean>
  /** Whether the Codex app-server answers a request that reads one thread. */
  readonly codexAppServer?: () => Promise<boolean>
  /** Whether an open Claude session's plugin is polling the bridge. */
  readonly claudePluginPolling?: () => boolean
  readonly runningClaudePid?: (homeDir: string, profileId: string) => Promise<number | undefined>
  /** Whether the Codex Desktop process a profile's supervisor state records is alive. */
  readonly codexHostStatus?: (profileId: string) => Promise<'running' | 'stopped' | 'unknown'>
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const text = (value: unknown, max = 4096): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value : undefined

const check = (
  status: IntegrationCheckStatus,
  reason?: string,
  remedy?: string,
): IntegrationCheck => ({
  status,
  ...(reason === undefined ? {} : { reason }),
  ...(remedy === undefined ? {} : { remedy }),
})

function bridgeCheck(
  binding: Record<string, unknown> | undefined,
  answers: boolean,
  remedy: string,
  status?: IntegrationCheck,
): IntegrationBridgeCheck {
  const token = text(binding?.token, 1024) === undefined ? 'missing' : 'present'
  const socketPath = text(binding?.socketPath)
  return {
    ...(status ?? (answers
      ? check('ok')
      : token === 'missing'
      ? check('missing', 'bridge-binding-missing', remedy)
      : check('unreachable', 'bridge-not-answering', remedy))),
    token,
    ...(socketPath === undefined ? {} : { socketPath }),
  }
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return undefined
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

const PROBE_MS = 1500

/** One token-bearing request to the recorded socket; a refusal, error, or late answer means it is not answering. */
async function probeBridge(socketPath: string, token: string): Promise<boolean> {
  const { request } = await import('node:http')
  return await new Promise<boolean>(resolve => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), PROBE_MS)
    const call = request({
      socketPath,
      path: '/status',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cordisx-bridge-token': token },
      timeout: PROBE_MS,
    }, response => {
      response.resume()
      response.on('end', () => finish(response.statusCode === 200))
    })
    call.on('error', () => finish(false))
    call.on('timeout', () => {
      call.destroy()
      finish(false)
    })
    call.end('{}')
  })
}

/** The Codex host's liveness, from the supervisor state its launch writes. */
async function codexHostState(homeDir: string, profileId: string): Promise<'running' | 'stopped' | 'unknown'> {
  const state = await readSupervisorState(supervisorPaths(homeDir, 'codex', profileId))
  if (state === undefined) return 'unknown'
  if (state.hostPid === undefined || state.hostProcessStartedAt === undefined) return 'stopped'
  return (await processIdentityStatus(state.hostPid, state.hostProcessStartedAt)) === 'alive' ? 'running' : 'stopped'
}

const startCommand = (app: IntegrationApp, profileId: string | undefined): string =>
  `cordisx start ${app} ${profileId ?? '<profile>'}`

export function createIntegrationStatus(input: IntegrationStatusInput) {
  const homeDir = input.cordisxHomeDir
  const homedir = input.homedir ?? os.homedir()
  const environment = input.environment ?? process.env
  const runningClaudePid = input.runningClaudePid ?? runningClaudeProfile
  const codexHostStatus = input.codexHostStatus ?? ((profileId: string) => codexHostState(homeDir, profileId))

  async function readConfig(): Promise<
    { readonly kind: 'ok'; readonly config: HomeConfig } | { readonly kind: 'missing' | 'invalid' }
  > {
    const file = path.join(homeDir, 'config.json')
    try {
      return { kind: 'ok', config: await loadHomeConfig(file) }
    } catch {
      return { kind: await exists(file) ? 'invalid' : 'missing' }
    }
  }

  /** Whether the key variable resolves, from the launch environment first, as a launch would read it. */
  const keyIsSet = (config: HomeConfig | undefined, name: string): boolean =>
    (environment[name] ?? '').length > 0
    || (config?.environmentVariables ?? []).some(entry =>
      entry.name === name && entry.enabled && entry.value.length > 0
    )

  const declared = (config: HomeConfig | undefined, id: string): boolean =>
    (config?.providers ?? []).some(provider => provider.id === id && provider.kind === 'model-service')

  async function codexReport(
    binding: Record<string, unknown> | undefined,
    config: HomeConfig | undefined,
  ): Promise<IntegrationAppReport> {
    const launch = await readJson(codexLaunchRecordPath(homeDir))
    const profileId = text(launch?.profileId, 128)
    const modelServiceId = text(launch?.modelServiceId, 256)
    const shared = {
      app: 'codex' as const,
      ...(profileId === undefined ? {} : { profileId }),
      ...(modelServiceId === undefined
        ? {}
        : { modelService: { id: modelServiceId, declared: declared(config, modelServiceId) } }),
    }
    const socketPath = text(binding?.socketPath)
    const token = text(binding?.token, 1024)
    const answers = input.bridgeAnswers === undefined
      ? socketPath !== undefined && token !== undefined && await probeBridge(socketPath, token)
      : await input.bridgeAnswers()
    const startRemedy = `Start Codex with \`${startCommand('codex', profileId)}\`; its launch creates the bridge.`
    if (answers) return { ...shared, ...check('ok'), bridge: bridgeCheck(binding, true, startRemedy) }
    const bridge = bridgeCheck(binding, false, startRemedy)
    if (bridge.token === 'missing') {
      return {
        ...shared,
        ...check(
          'not-running',
          'bridge-binding-missing',
          `Start Codex with \`${startCommand('codex', profileId)}\`; its launch creates the bridge.`,
        ),
        bridge,
      }
    }
    const host = profileId === undefined ? 'unknown' : await codexHostStatus(profileId)
    if (host === 'running') {
      return {
        ...shared,
        ...check(
          'unreachable',
          'codex-running-without-bridge',
          `Codex Desktop is running but its agent bridge is not answering. Restart it with \`cordisx restart codex ${
            profileId ?? '<profile>'
          }\`, then check \`cordisx status codex ${profileId ?? '<profile>'}\`.`,
        ),
        bridge,
      }
    }
    return {
      ...shared,
      ...check(
        'not-running',
        host === 'stopped' ? 'launch-record-without-process' : 'codex-not-running',
        `Start Codex with \`${startCommand('codex', profileId)}\`.`,
      ),
      bridge,
    }
  }

  async function claudeReport(
    binding: Record<string, unknown> | undefined,
    config: HomeConfig | undefined,
  ): Promise<IntegrationAppReport> {
    const recorded = await readJson(claudeDesktopBindingPath(homeDir)) as ClaudeDesktopBinding | undefined
    if (recorded === undefined || typeof recorded.profileId !== 'string' || typeof recorded.dataDir !== 'string') {
      const notConfigured = check(
        'not-configured',
        'profile-not-recorded',
        'Run `cordisx start claude <profile>`; it records the profile the bridge drives.',
      )
      return {
        app: 'claude',
        ...notConfigured,
        bridge: bridgeCheck(binding, false, '', {
          ...check('not-connected', 'claude-profile-not-recorded', notConfigured.remedy),
        }),
      }
    }
    const profileHome = recorded.homeDir ?? homeDir
    const pid = await runningClaudePid(profileHome, recorded.profileId)
    const providerId = text(object(recorded.provider)?.id, 256)
    const shared = {
      app: 'claude' as const,
      profileId: recorded.profileId,
      ...(providerId === undefined ? {} : { modelService: { id: providerId, declared: declared(config, providerId) } }),
    }
    if (pid === undefined) {
      const stale = await exists(claudeProfilePidPath(profileHome, recorded.profileId))
      const remedy = `Start Claude with \`${startCommand('claude', recorded.profileId)}\`.`
      return {
        ...shared,
        ...check('not-running', stale ? 'pid-record-without-process' : 'claude-not-running', remedy),
        bridge: bridgeCheck(binding, false, remedy, check('not-connected', 'claude-not-running', remedy)),
      }
    }
    if (input.claudePluginPolling?.() === true) {
      return { ...shared, ...check('ok'), bridge: bridgeCheck(binding, true, '') }
    }
    const pluginRemedy =
      'Open a Code session in Claude; if one is open, restart Claude so the CordisX bridge plugin, which is assembled at launch, loads.'
    return {
      ...shared,
      ...check('ok'),
      bridge: bridgeCheck(
        binding,
        false,
        pluginRemedy,
        check(
          'not-connected',
          input.claudePluginPolling === undefined ? 'claude-plugin-state-unknown' : 'claude-plugin-not-polling',
          pluginRemedy,
        ),
      ),
    }
  }

  /** Enabled declarations that both target this app and speak a protocol it understands. */
  function useOf(provider: HomeConfigProvider, app: IntegrationApp): IntegrationModelServiceApp {
    const models = provider.kind === 'model-service' ? modelsForApp(provider, app) : []
    if (provider.kind !== 'model-service' || provider.enabled === false) {
      return { usable: false, models, reason: 'disabled' }
    }
    if (provider.appliesTo !== undefined && !provider.appliesTo.includes(app)) {
      return { usable: false, models, reason: 'app-not-declared' }
    }
    const protocol = app === 'claude' ? 'anthropic-messages' : 'openai-responses'
    if (!provider.protocols.includes(protocol)) return { usable: false, models, reason: 'protocol-unsupported' }
    if (models.length === 0) return { usable: false, models, reason: 'no-models' }
    return { usable: true, models }
  }

  function modelServices(config: HomeConfig | undefined): readonly IntegrationModelService[] {
    return (config?.providers ?? [])
      .filter(provider => provider.kind === 'model-service')
      .map(provider => ({
        id: provider.id,
        displayName: provider.displayName,
        keyVariable: provider.apiKeyEnv,
        keySet: keyIsSet(config, provider.apiKeyEnv),
        apps: {
          codex: useOf(provider, 'codex'),
          claude: useOf(provider, 'claude'),
        },
      }))
  }

  function serviceProblems(services: readonly IntegrationModelService[]): readonly IntegrationProblem[] {
    return services.flatMap<IntegrationProblem>(service => {
      const usable = service.apps.codex.usable || service.apps.claude.usable
      if (!usable) {
        return [{
          area: `model-service:${service.id}`,
          ...check(
            'not-configured',
            'no-app-can-use-it',
            `Neither app can use ${service.id}: give it an "anthropic-messages" protocol with \`models.claude\` (Claude) or "openai-responses" with \`models.codex\` (Codex) in the CordisX home config, or \`cordisx setup\` to inspect it.`,
          ),
        }]
      }
      return service.keySet ? [] : [{
        area: `model-service:${service.id}`,
        ...check(
          'not-configured',
          'key-not-set',
          `Set ${service.keyVariable} in the CordisX environment variables, or export it before launching.`,
        ),
      }]
    })
  }

  async function plugins(
    claude: IntegrationAppReport,
  ): Promise<{ readonly report: IntegrationPluginsReport; readonly problems: readonly IntegrationProblem[] }> {
    const recorded = await readJson(claudeDesktopBindingPath(homeDir)) as ClaudeDesktopBinding | undefined
    let claudePluginDirectory: IntegrationPluginsReport['claudePluginDirectory'] = check(
      'unknown',
      'claude-profile-not-recorded',
    )
    if (recorded !== undefined && typeof recorded.profileId === 'string') {
      const directory = path.join(claudeProfileRoot(recorded.homeDir ?? homeDir, recorded.profileId), 'cordisx-plugin')
      claudePluginDirectory = await exists(path.join(directory, 'hooks', 'register.ts'))
        ? { ...check('ok'), path: directory }
        : {
          ...check(
            'missing',
            'plugin-not-assembled',
            `Reassemble it by restarting Claude: \`cordisx restart claude ${recorded.profileId}\`.`,
          ),
          path: directory,
        }
    }
    // A plugin that polls the bridge is exactly a session whose session tools connected.
    const claudeSessionTools = claude.bridge.status === 'ok'
      ? check('ok')
      : check('not-connected', claude.bridge.reason, claude.bridge.remedy)
    const codexAppServer = input.codexAppServer === undefined
      ? check('unknown', 'codex-app-server-not-probed')
      : await input.codexAppServer()
      ? check('ok')
      : check(
        'unreachable',
        'codex-app-server-no-answer',
        'Restart the Codex launch; its app-server is not answering the bridge.',
      )
    const report: IntegrationPluginsReport = { claudePluginDirectory, claudeSessionTools, codexAppServer }
    const problems = Object.entries(report).flatMap(([area, value]) =>
      value.status === 'ok' || value.status === 'unknown' ? [] : [{ area: `plugins.${area}`, ...value }]
    )
    return { report, problems }
  }

  return async (rawArgs?: unknown): Promise<IntegrationStatusReport> => {
    const args = object(rawArgs) ?? {}
    const requested = isIntegrationApp(args.app) ? args.app : input.caller
    const loaded = await readConfig()
    const config = loaded.kind === 'ok' ? loaded.config : undefined
    const binding = await readJson(agentBridgeBindingPath(homeDir))

    const codex = await codexReport(binding, config)
    const claude = await claudeReport(binding, config)
    const self = requested === 'codex' ? codex : claude
    const other = requested === 'codex' ? claude : codex

    const services = modelServices(config)
    const pluginHealth = await plugins(claude)

    const problems: IntegrationProblem[] = []
    if (loaded.kind !== 'ok') {
      problems.push({
        area: 'config',
        ...check(
          loaded.kind === 'missing' ? 'missing' : 'unreachable',
          loaded.kind === 'missing' ? 'home-config-missing' : 'home-config-invalid',
          loaded.kind === 'missing'
            ? 'Run `cordisx setup` to create the CordisX home config.'
            : `Fix the JSON in ${path.join(homeDir, 'config.json')}; CordisX will not overwrite an invalid file.`,
        ),
      })
    }
    for (const [area, report] of [['self', self], ['other', other]] as const) {
      if (report.status !== 'ok') problems.push({ area, ...check(report.status, report.reason, report.remedy) })
      if (report.bridge.status !== 'ok') {
        problems.push({
          area: `${area}.bridge`,
          ...check(report.bridge.status, report.bridge.reason, report.bridge.remedy),
        })
      }
    }
    problems.push(...serviceProblems(services), ...pluginHealth.problems)

    return {
      version: 1,
      status: self.bridge.status === 'ok' ? (problems.length === 0 ? 'ok' : 'degraded') : 'unavailable',
      app: requested,
      cordisxHome: homeDir,
      self,
      other,
      modelServices: services,
      plugins: pluginHealth.report,
      problems,
    }
  }
}
