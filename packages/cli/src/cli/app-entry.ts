import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHomeConfig } from '../config/home-config.js'
import { type AppLauncherMenu, type AppLauncherRuntime, validAppLauncherRuntime } from '../app-launcher/model.js'
import { readPrivateJson } from '../shortcuts/store.js'
import { type CordisXManagedInvocation, parseCordisXCli } from './parse.js'
import { type ReadyLaunchResult, runSupervisorCommandWithStartupGate, type StartupPhase } from './supervisor-command.js'
import { type ActivatedOwnedHost, activateOwnedHost } from './activate-owned-host.js'

type AppOperation = 'menu' | 'launch-default' | 'launch-profile'
const PORTABLE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u

async function runtimeFrom(recordPath: string): Promise<AppLauncherRuntime> {
  const runtime = await readPrivateJson(recordPath)
  if (!validAppLauncherRuntime(runtime)) throw new Error('Invalid CordisX app runtime')
  if (
    await realpath(runtime.node) !== await realpath(process.execPath)
    || runtime.entryScript !== fileURLToPath(import.meta.url)
  ) throw new Error('CordisX runtime moved; run `cordisx app` again from the installed runtime')
  return runtime
}

export async function readAppLauncherMenu(runtime: AppLauncherRuntime): Promise<AppLauncherMenu> {
  const config = await loadHomeConfig(path.join(runtime.cordisxHome, 'config.json'))
  const app = Object.hasOwn(config.apps, config.defaultApp) ? config.apps[config.defaultApp] : undefined
  if (!app) throw new Error(`host app is not configured: ${config.defaultApp}`)
  return {
    ok: true,
    appId: config.defaultApp,
    defaultProfile: app.defaultProfile,
    profiles: Object.entries(app.profiles).map(([id, profile]) => ({
      id,
      displayName: profile.displayName,
      dataMode: profile.dataMode,
    })),
  }
}

export interface AppEntryDependencies {
  readonly runSupervisor?: typeof runSupervisorCommandWithStartupGate
  readonly activate?: (ready: ReadyLaunchResult) => Promise<ActivatedOwnedHost>
  readonly onState?: (
    ready: ReadyLaunchResult,
    phase: StartupPhase,
  ) => void | Promise<void>
}

export async function runAppLauncherOperation(
  recordPath: string,
  operation: AppOperation,
  appId?: string,
  profileId?: string,
  dependencies: AppEntryDependencies = {},
): Promise<AppLauncherMenu | ActivatedOwnedHost> {
  const runtime = await runtimeFrom(recordPath)
  if (operation === 'menu') return await readAppLauncherMenu(runtime)
  let invocation: CordisXManagedInvocation
  if (operation === 'launch-default') {
    invocation = parseCordisXCli([]) as CordisXManagedInvocation
  } else {
    if (!appId || !profileId || !PORTABLE_ID.test(appId) || !PORTABLE_ID.test(profileId)) {
      throw new Error('Invalid CordisX profile selection')
    }
    const menu = await readAppLauncherMenu(runtime)
    if (menu.appId !== appId || !menu.profiles.some(profile => profile.id === profileId)) {
      throw new Error('CordisX profile no longer exists')
    }
    invocation = parseCordisXCli(['start', appId, profileId]) as CordisXManagedInvocation
  }
  const run = dependencies.runSupervisor ?? runSupervisorCommandWithStartupGate
  const runRuntime = {
    cwd: runtime.cwd,
    env: {
      ...process.env,
      CORDISX_HOME: runtime.cordisxHome,
      ...(runtime.codexHome ? { CODEX_HOME: runtime.codexHome } : {}),
    },
    stdout: () => {},
    internalShortcutOutput: {
      directory: runtime.cacheDirectory,
      registry: runtime.cacheRegistry,
    },
    internalReuseShortcut: true,
    internalShortcutSpawnCwd: runtime.cwd,
  }
  // Presentation is optional and handled after readiness. A failed launch must
  // never silently create another Host with a different request.
  const ready = await run({ ...invocation, createShortcut: true }, runRuntime, dependencies.onState)
  if (!ready) throw new Error('No ready Host instance returned')
  return await (dependencies.activate ?? activateOwnedHost)(ready)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const operation = process.argv[3] as AppOperation | undefined
  const published = new Set<string>()
  const result = await (operation
    ? runAppLauncherOperation(process.argv[2] ?? '', operation, process.argv[4], process.argv[5], {
      onState: (ready, phase) => {
        const state = ready.state
        if (!state.hostPid || !state.hostProcessStartedAt) return
        const key = `${phase}:${state.hostPid}:${state.hostProcessStartedAt}:${state.startupRecovery?.updatedAt ?? 0}`
        if (published.has(key)) return
        published.add(key)
        process.stdout.write(
          JSON.stringify({
            event: phase,
            hostPid: state.hostPid,
            hostStartedAt: state.hostProcessStartedAt,
          }) + '\n',
        )
      },
    })
    : Promise.reject(new Error('Missing CordisX app operation'))).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : 'CordisX app operation failed',
    }))
  process.stdout.write(JSON.stringify(result) + '\n')
  if (!result.ok) process.exitCode = 1
}
