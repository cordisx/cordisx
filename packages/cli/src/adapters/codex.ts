import { chmod, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostAdapter, ResolveLaunchPlanInput, ResolvedLaunchPlan } from './contracts.js'
import { resolveCodexExecutable } from '../launcher/process.js'

function profileRoot(homeDir: string, profileId: string): string {
  return path.join(homeDir, 'apps', 'codex', 'profiles', profileId)
}

export function isolatedCodexEnvironment(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const isolatedHome = pathApi.join(root, 'host-home')
  const isolatedCodexHome = pathApi.join(root, 'codex-home')
  if (platform === 'win32') {
    return {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: pathApi.join(isolatedHome, 'AppData', 'Roaming'),
      LOCALAPPDATA: pathApi.join(isolatedHome, 'AppData', 'Local'),
      CODEX_HOME: isolatedCodexHome,
    }
  }
  if (platform === 'linux') {
    return {
      HOME: isolatedHome,
      XDG_CONFIG_HOME: pathApi.join(isolatedHome, '.config'),
      XDG_DATA_HOME: pathApi.join(isolatedHome, '.local', 'share'),
      XDG_CACHE_HOME: pathApi.join(isolatedHome, '.cache'),
      CODEX_HOME: isolatedCodexHome,
    }
  }
  return { HOME: isolatedHome, CODEX_HOME: isolatedCodexHome }
}

export const codexAdapter: HostAdapter = {
  id: 'codex',
  displayName: 'Codex',

  async resolveLaunchPlan(input: ResolveLaunchPlanInput): Promise<ResolvedLaunchPlan> {
    const executable = await resolveCodexExecutable(input.executable)
    const ordinaryHome = os.homedir()
    const ordinaryCodexHome = process.env.CODEX_HOME === undefined
      ? path.join(ordinaryHome, '.codex')
      : path.resolve(process.env.CODEX_HOME)

    if (input.dataMode === 'shared') {
      const root = profileRoot(input.cordisxHomeDir, input.profileId)
      const chromiumProfileDir = path.resolve(input.chromiumProfileDir ?? path.join(root, 'chromium'))
      return {
        version: 1,
        appId: this.id,
        appName: this.displayName,
        profileId: input.profileId,
        dataMode: input.dataMode,
        executable,
        // A CordisX launch always owns a separate Electron/Chromium instance.
        // Its persistent profile is CORDISX_HOME-scoped, while HOME and
        // CODEX_HOME intentionally remain the user's Host roots.
        chromiumProfile: { mode: 'independent', path: chromiumProfileDir },
        environment: {},
        sharedDataRoots: [
          { name: 'HOME', path: ordinaryHome, managed: false },
          { name: 'CODEX_HOME', path: ordinaryCodexHome, managed: false },
        ],
        isolatedDataRoots: [
          { name: 'Chromium profile', path: chromiumProfileDir, managed: input.chromiumProfileDir === undefined },
        ],
      }
    }

    const root = profileRoot(input.cordisxHomeDir, input.profileId)
    const chromiumProfileDir = path.resolve(input.chromiumProfileDir ?? path.join(root, 'chromium'))
    const isolatedEnvironment = isolatedCodexEnvironment(root)
    return {
      version: 1,
      appId: this.id,
      appName: this.displayName,
      profileId: input.profileId,
      dataMode: input.dataMode,
      executable,
      chromiumProfile: { mode: 'independent', path: chromiumProfileDir },
      environment: isolatedEnvironment,
      sharedDataRoots: [],
      isolatedDataRoots: [
        ...Object.entries(isolatedEnvironment).map(([name, path]) => ({ name, path, managed: true })),
        { name: 'Chromium profile', path: chromiumProfileDir, managed: input.chromiumProfileDir === undefined },
      ],
    }
  },

  async prepareLaunch(plan: ResolvedLaunchPlan): Promise<void> {
    await Promise.all(plan.isolatedDataRoots.map(async root => {
      await mkdir(root.path, { recursive: true, mode: 0o700 })
      if (root.managed) await chmod(root.path, 0o700)
    }))
  },
}
