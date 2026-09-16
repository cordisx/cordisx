import { resolveHostAdapter } from '../adapters/registry.js'
import { ensureHomeConfig, type HomeConfigPathOptions, resolveHomeConfigPath } from '../config/home-config.js'
import type { CordisXCliInvocation } from './parse.js'
import { type ResolvedProfileSelection, resolveProfileSelection } from './profiles.js'
import { type CordisXCliRuntime, HELP, ownValue, printPlan, rootFromConfigPath, runDevelopment } from './run-support.js'

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
  if (invocation.action !== 'launch') throw new Error(`unsupported CordisX action: ${invocation satisfies never}`)
  return { invocation, stdout, environment, configPath, selection, adapter, appId }
}
