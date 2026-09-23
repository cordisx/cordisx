import { lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CordisXCliRuntime } from '../cli/run-support.js'
import { validAppLauncherRuntime } from './model.js'
import { readPrivateJson } from '../shortcuts/store.js'

export interface AppPostinstallOptions {
  readonly platform?: NodeJS.Platform
  readonly globalInstall?: boolean
  readonly homedir?: string
  readonly warn?: (message: string) => void
  /** Test-only isolated App installation source. */
  readonly internalAppOutput?: CordisXCliRuntime['internalAppOutput']
}

/** Refresh only an existing owned App; package installation never creates or opens one. */
export async function refreshInstalledAppAfterUpgrade(options: AppPostinstallOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const globalInstall = options.globalInstall ?? process.env.npm_config_global === 'true'
  if (platform !== 'darwin' || !globalInstall) return false

  const homedir = options.homedir ?? os.homedir()
  const app = path.join(homedir, 'Applications', 'CordisX.app')
  try {
    const metadata = await lstat(app)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    const detail = error instanceof Error ? error.message : String(error)
    ;(options.warn ?? console.warn)(`[cordisx] Could not check CordisX.app during upgrade: ${detail}`)
    return false
  }

  const runtimePath = path.join(homedir, 'Library', 'Application Support', 'CordisX', 'app-launcher', 'runtime.json')
  try {
    const runtime = await readPrivateJson(runtimePath)
    if (!validAppLauncherRuntime(runtime)) throw new Error('Invalid CordisX app runtime')
    const { runAppCommand } = await import('../cli/app-command.js')
    await runAppCommand({
      homedir,
      cwd: runtime.cwd,
      env: {
        HOME: homedir,
        CORDISX_HOME: runtime.cordisxHome,
        ...(runtime.codexHome ? { CODEX_HOME: runtime.codexHome } : {}),
      },
      ...(options.internalAppOutput ? { internalAppOutput: options.internalAppOutput } : {}),
      internalOpenApp: () => {},
      stdout: () => {},
    })
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ;(options.warn ?? console.warn)(
      `[cordisx] Existing CordisX.app was not upgraded: ${detail}. Run \`cordisx app\` to repair it.`,
    )
    return false
  }
}
