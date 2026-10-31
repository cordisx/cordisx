import os from 'node:os'
import path from 'node:path'
import { ensureHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { seedClaudeDesktopProfile } from '../launcher/claude-desktop-profile.js'
import {
  claudeProfileDataDir,
  claudeProfileRoot,
  launchClaudeDesktop,
  resolveClaudeExecutable,
  runningClaudeProfile,
  stopClaudeDesktop,
} from '../launcher/claude-desktop-process.js'
import { assembleClaudeProfilePlugin, ensureClaudeBridgePermissions } from '../launcher/claude-bridge-plugin.js'
import { writeClaudeDesktopBinding } from '../launcher/claude-host-sessions.js'
import {
  CLAUDE_DEFAULT_PERMISSION_MODE,
  enableClaudeBypassMode,
  writeClaudeManagedSettings,
} from '../launcher/claude-permission-mode.js'
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

  // The agent bridge drives this profile's sessions from outside the app.
  const applied = config.providers.find(provider => provider.id === seeded.appliedProviderId)
  await writeClaudeDesktopBinding(cordisxHomeDir, {
    version: 1,
    profileId,
    homeDir: cordisxHomeDir,
    dataDir,
    ...(applied?.kind === 'model-service'
      ? {
        provider: {
          id: applied.id,
          baseUrl: applied.baseUrl,
          apiKeyEnv: applied.apiKeyEnv,
          ...(applied.models?.claude?.[0] === undefined ? {} : { model: applied.models.claude[0] }),
        },
      }
      : {}),
  })

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
  // Codex starts and messages Claude sessions through tools Claude otherwise asks the person about.
  const permissions = await ensureClaudeBridgePermissions(runtime.homedir ?? os.homedir())
  if (permissions.added.length > 0) {
    stdout(`[cordisx] allowed Claude bridge tools in ~/.claude/settings.json: ${permissions.added.join(', ')}`)
  } else if (permissions.skipped !== undefined) {
    stdout('[cordisx] ~/.claude/settings.json is not valid JSON; Claude bridge permissions were not added')
  }
  // Sessions start in bypass mode: the managed default names it, and the
  // profile's preferences offer it (the app is closed, so they can be written).
  const managedSettings = await writeClaudeManagedSettings({
    profileRoot: claudeProfileRoot(cordisxHomeDir, profileId),
  })
  const bypassAccounts = await enableClaudeBypassMode(dataDir)
  stdout(
    `[cordisx] claude/${profileId} default permission mode: ${CLAUDE_DEFAULT_PERMISSION_MODE}`
      + (bypassAccounts.length === 0 ? ' (offered from the next launch)' : ''),
  )
  const bridge = await assembleClaudeProfilePlugin(claudeProfileRoot(cordisxHomeDir, profileId))
  const hostEnvironment = {
    ...hostModelServiceEnvironment(environment, config.environmentVariables),
    // Claude Desktop passes its own environment to the Claude Code sessions it
    // starts, so the bridge loads in this profile's sessions and nowhere else.
    CLAUDE_CODE_PLUGIN_DIRS: bridge,
    CORDISX_HOME: cordisxHomeDir,
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: managedSettings,
    // How the bridge plugin runs this CLI to start Codex when the person allowed it.
    CORDISX_CLI: JSON.stringify([process.execPath, ...process.execArgv, process.argv[1] ?? '']),
  }
  const pid = await launchClaudeDesktop({ executable, cordisxHomeDir, profileId, environment: hostEnvironment })
  stdout(`[cordisx] launched claude/${profileId} (pid ${pid})`)
}
