import { resolveHostAdapter } from '../adapters/registry.js'
import { ensureHomeConfig, type HomeConfigPathOptions, resolveHomeConfigPath } from '../config/home-config.js'
import { type CordisXCliInvocation, parseCordisXCli } from './parse.js'
import { runFeedbackCommand } from './feedback-command.js'
import { runManagementCommand } from './management-command.js'
import { isSupervisorCommand, runSupervisorCommandWithStartupGate } from './supervisor-command.js'
import { type ResolvedProfileSelection, resolveProfileSelection } from './profiles.js'
import { type CordisXCliRuntime, HELP, ownValue, printPlan, rootFromConfigPath, runDevelopment } from './run-support.js'
import { runAppCommand } from './app-command.js'
import { activateOwnedHost } from './activate-owned-host.js'

export interface PreparedRunCommand {
  readonly invocation: Extract<CordisXCliInvocation, { readonly action: 'launch' }>
  readonly stdout: (line: string) => void
  readonly environment: NodeJS.ProcessEnv
  readonly configPath: string
  readonly selection: ResolvedProfileSelection
  readonly adapter: ReturnType<typeof resolveHostAdapter>
  readonly appId: string
}

export async function prepareRunCommand(
  invocation: CordisXCliInvocation,
  runtime: CordisXCliRuntime,
): Promise<PreparedRunCommand | undefined> {
  const stdout = runtime.stdout ?? console.log
  const cwd = runtime.cwd ?? process.cwd()
  const environment = runtime.env ?? process.env
  const homeConfigOptions: HomeConfigPathOptions = {
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  }
  const configPath = resolveHomeConfigPath(homeConfigOptions)
  if (invocation.action === 'help') {
    stdout(HELP)
    return
  }
  if (invocation.action === 'setup' || invocation.action === 'config') {
    const config = await ensureHomeConfig(homeConfigOptions)
    stdout(`[cordisx] configuration${invocation.action === 'setup' ? ' ready' : ''}: ${configPath}`)
    stdout(JSON.stringify(config, null, 2))
    return
  }
  if (invocation.action === 'dev') {
    await runDevelopment(invocation, cwd, stdout, environment, configPath, homeConfigOptions, runtime)
    return
  }

  const config = await ensureHomeConfig(homeConfigOptions)
  const appId = invocation.action === 'launch' ? invocation.app ?? config.defaultApp : config.defaultApp
  const adapter = resolveHostAdapter(appId)
  if (
    invocation.action === 'launch' && invocation.options.attach && (
      invocation.profile !== undefined || invocation.dataMode !== undefined
    )
  ) throw new Error('--attach cannot select or override a named profile')
  if (invocation.action === 'launch' && invocation.options.system) {
    const app = ownValue(config.apps, appId)
    if (app === undefined) throw new Error(`host app is not configured: ${appId}`)
    const profileId = invocation.profile ?? app.defaultProfile
    const mode = invocation.dataMode ?? ownValue(app.profiles, profileId)?.dataMode ?? 'shared'
    if (mode === 'host-isolated') throw new Error('--system cannot enforce a host-isolated profile')
  }
  const selection = await resolveProfileSelection({
    config,
    configPath,
    appId,
    ...(invocation.action === 'launch' && invocation.profile !== undefined ? { profileId: invocation.profile } : {}),
    ...(invocation.action === 'launch' && invocation.dataMode !== undefined ? { dataMode: invocation.dataMode } : {}),
  })
  if (invocation.action === 'doctor') {
    try {
      printPlan(
        await adapter.resolveLaunchPlan({
          cordisxHomeDir: rootFromConfigPath(configPath),
          profileId: selection.profileId,
          dataMode: selection.dataMode,
        }),
        stdout,
      )
    } catch (error) {
      stdout(JSON.stringify(
        {
          status: 'unavailable',
          appId,
          profileId: selection.profileId,
          dataMode: selection.dataMode,
          diagnostic: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ))
    }
    return
  }
  if (invocation.action !== 'launch') throw new Error(`unsupported CordisX action: ${invocation.action}`)
  return { invocation, stdout, environment, configPath, selection, adapter, appId }
}

export async function prepareCliCommand(
  argv: readonly string[],
  runtime: CordisXCliRuntime,
): Promise<PreparedRunCommand | undefined> {
  if (argv[0] === 'source-trust') {
    const { runSourceTrust } = await import('./source-trust.js')
    await runSourceTrust(
      argv,
      rootFromConfigPath(
        resolveHomeConfigPath({
          env: runtime.env ?? process.env,
          ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
        }),
      ),
      runtime.stdout ?? console.log,
    )
    return
  }
  const parsedInvocation = parseCordisXCli(argv)
  if (parsedInvocation.action === 'feedback') {
    await runFeedbackCommand(parsedInvocation, runtime)
    return
  }
  if (parsedInvocation.action === 'management') {
    await runManagementCommand(parsedInvocation, runtime)
    return
  }
  if (parsedInvocation.action === 'app') {
    await runAppCommand(runtime)
    return
  }
  const internalForeground = [
    runtime.internalRunInjectedHost,
    runtime.internalAgentHistoryHost,
    runtime.internalBuiltinSkillSourceDir,
    runtime.internalBuiltinSkillsSourceRootDir,
    runtime.internalSharedHomeDir,
    runtime.internalBuildRendererBundle,
    runtime.internalObserveOwnerDocuments,
  ].some(value => value !== undefined)
  const foregroundStart = parsedInvocation.action === 'start'
    && (parsedInvocation.options.dryRun || parsedInvocation.options.attach || internalForeground)
  if (isSupervisorCommand(parsedInvocation) && !foregroundStart) {
    const ready = await runSupervisorCommandWithStartupGate(parsedInvocation, runtime)
    if (ready !== undefined && (parsedInvocation.action === 'start' || parsedInvocation.action === 'restart')) {
      const activated = await activateOwnedHost(ready)
      if (activated.warning !== undefined) (runtime.stdout ?? console.log)(`[cordisx] ${activated.warning}`)
    }
    return
  }
  const foregroundInvocation = (parsedInvocation.action === 'run' || foregroundStart
    ? { ...parsedInvocation, action: 'launch' as const }
    : parsedInvocation) as Exclude<
      typeof parsedInvocation,
      { readonly action: 'run' | 'start' | 'status' | 'logs' | 'stop' | 'restart' }
    >
  return prepareRunCommand(foregroundInvocation, runtime)
}
