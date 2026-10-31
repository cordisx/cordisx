import path from 'node:path'
import { ensureHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { seedClaudeDesktopProfile } from '../launcher/claude-desktop-profile.js'
import {
  claudeProfileDataDir,
  launchClaudeDesktop,
  resolveClaudeExecutable,
  runningClaudeProfile,
  stopClaudeDesktop,
} from '../launcher/claude-desktop-process.js'
import { claudeBridgePluginDir } from '../launcher/claude-bridge-plugin.js'
import { hostModelServiceEnvironment } from './native-submission-catalog-options.js'
import type { CordisXLauncherOptions } from './parse.js'
import type { CordisXCliRuntime } from './run-support.js'

export const CLAUDE_APP_ID = 'claude'

export interface ClaudeDesktopInvocation {
  readonly action: 'start' | 'run' | 'restart' | 'stop' | 'status'
  readonly profile?: string
  readonly options: Pick<CordisXLauncherOptions, 'provider' | 'executable' | 'dryRun'>
}

/**
 * `cordisx start|run|restart|stop|status claude [profile]`.
 *
 * Claude Desktop refuses debugging switches, so it gets no CDP host: CordisX
 * seeds the profile's provider configuration, starts the app on that profile,
 * and loads the CordisX bridge into its Claude Code sessions.
 */
export async function runClaudeDesktopCommand(
  invocation: ClaudeDesktopInvocation,
  runtime: CordisXCliRuntime,
): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  const environment = runtime.env ?? process.env
  const configPath = resolveHomeConfigPath({
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  })
  const cordisxHomeDir = path.dirname(configPath)
  const profileId = invocation.profile ?? 'default'

  if (invocation.action === 'status') {
    const pid = await runningClaudeProfile(cordisxHomeDir, profileId)
    stdout(
      pid === undefined
        ? `[cordisx] claude/${profileId} is not running`
        : `[cordisx] claude/${profileId} is running (pid ${pid})`,
    )
    return
  }
  if (invocation.action === 'stop' || invocation.action === 'restart') {
    const stopped = await stopClaudeDesktop(cordisxHomeDir, profileId)
    stdout(stopped ? `[cordisx] stopped claude/${profileId}` : `[cordisx] claude/${profileId} was not running`)
    if (invocation.action === 'stop') return
  }

  const config = await ensureHomeConfig(configPath)
  const dataDir = claudeProfileDataDir(cordisxHomeDir, profileId)
  const seeded = await seedClaudeDesktopProfile({
    dataDir,
    providers: config.providers,
    selectedId: invocation.options.provider,
  })
  for (const diagnostic of seeded.diagnostics) {
    stdout(`[cordisx] model service ${diagnostic.providerId}: ${diagnostic.code}`)
  }
  if (seeded.providerIds.length === 0) {
    stdout('[cordisx] no model service in the CordisX configuration speaks anthropic-messages for Claude')
  } else {
    stdout(`[cordisx] claude/${profileId} provider: ${seeded.appliedProviderId ?? 'kept from Claude settings'}`)
  }

  const running = await runningClaudeProfile(cordisxHomeDir, profileId)
  if (running !== undefined) {
    stdout(`[cordisx] claude/${profileId} is already running (pid ${running}); restart it to apply provider changes`)
    return
  }
  const executable = await resolveClaudeExecutable(invocation.options.executable)
  if (invocation.options.dryRun) {
    stdout(`[cordisx] would launch ${executable} with data ${dataDir}`)
    return
  }
  const bridge = await claudeBridgePluginDir()
  const hostEnvironment = {
    ...hostModelServiceEnvironment(environment, config.environmentVariables),
    // Claude Desktop passes its own environment to the Claude Code sessions it
    // starts, so the bridge loads in this profile's sessions and nowhere else.
    CLAUDE_CODE_PLUGIN_DIRS: bridge,
    CORDISX_HOME: cordisxHomeDir,
  }
  const pid = await launchClaudeDesktop({ executable, cordisxHomeDir, profileId, environment: hostEnvironment })
  stdout(`[cordisx] launched claude/${profileId} (pid ${pid})`)
}
