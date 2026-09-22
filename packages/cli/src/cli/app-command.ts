import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { ensureHomeConfig, resolveHomeConfigPath } from '../config/home-config.js'
import { appLauncherHelper, nativeOperation, requireAppLauncherHelper } from '../shortcuts/native.js'
import { entryLock, isMissing, privateDirectory, writePrivateJson } from '../shortcuts/store.js'
import type { CordisXCliRuntime } from './run-support.js'

const run = promisify(execFile)
const brand = fileURLToPath(new URL('../../assets/brand/cordisx-mark-dark.svg', import.meta.url))

export interface AppCommandResult {
  readonly status: 'installed' | 'reused'
  readonly path: string
}

function inside(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

async function persistentRuntimePath(candidate: string): Promise<string> {
  const resolved = await realpath(candidate)
  const temporary = await realpath(os.tmpdir())
  if (inside(resolved, temporary) || resolved.split(path.sep).includes('_npx')) {
    throw new Error('Install CordisX and Node in stable locations before running `cordisx app`')
  }
  return resolved
}

export async function runAppCommand(runtime: CordisXCliRuntime): Promise<AppCommandResult> {
  await requireAppLauncherHelper()
  const environment = runtime.env ?? process.env
  const userHome = runtime.homedir ?? os.homedir()
  const configPath = resolveHomeConfigPath({ env: environment, homedir: userHome })
  await ensureHomeConfig({ env: environment, homedir: userHome })
  const cordisxHome = await realpath(path.dirname(configPath))
  const node = await persistentRuntimePath(process.execPath)
  const entryScript = await persistentRuntimePath(fileURLToPath(
    new URL(
      import.meta.url.includes('/dist/') ? './app-entry.js' : '../../dist/src/cli/app-entry.js',
      import.meta.url,
    ),
  ))
  const support = path.join(userHome, 'Library', 'Application Support', 'CordisX', 'app-launcher')
  const cacheDirectory = path.join(support, 'profiles')
  const cacheRegistry = path.join(support, 'records')
  const runtimePath = path.join(support, 'runtime.json')
  const applications = runtime.internalAppOutput?.directory ?? path.join(userHome, 'Applications')
  const target = runtime.internalAppOutput?.path ?? path.join(applications, 'CordisX.app')
  const helperDigest = createHash('sha256').update(await readFile(appLauncherHelper)).digest('hex')
  await privateDirectory(support)
  await privateDirectory(cacheDirectory)
  await privateDirectory(cacheRegistry)
  await mkdir(applications, { recursive: true })
  const release = await entryLock(path.join(support, 'install'))
  let stage: string | undefined
  try {
    let status: AppCommandResult['status'] = 'installed'
    let existing = false
    try {
      const metadata = await lstat(target)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error('An unrelated application already exists at ' + target)
      }
      existing = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (existing) {
      const inspection = await nativeOperation<{
        bundleIdentifier: string
        runtimePath: string
        helperDigest: string
      }>({
        operation: 'inspect-app',
        path: target,
      }).catch(() => {
        throw new Error('An unrelated application already exists at ' + target)
      })
      if (inspection.bundleIdentifier !== 'org.cordisx.launcher' || inspection.runtimePath !== runtimePath) {
        throw new Error('An unrelated application already exists at ' + target)
      }
      await run('/usr/bin/codesign', ['--verify', '--strict', target])
      const installedHelper = path.join(target, 'Contents', 'MacOS', 'CordisXLauncher')
      if (inspection.helperDigest !== helperDigest) {
        stage = await mkdtemp(path.join(applications, '.cordisx-app-update-'))
        const backup = path.join(stage, 'CordisXLauncher.previous')
        const info = path.join(target, 'Contents', 'Info.plist')
        const infoBackup = path.join(stage, 'Info.plist.previous')
        const replacement = path.join(stage, 'CordisXLauncher.next')
        await copyFile(installedHelper, backup)
        await copyFile(info, infoBackup)
        await copyFile(appLauncherHelper, replacement)
        await chmod(replacement, 0o755)
        await rename(replacement, installedHelper)
        try {
          await run('/usr/libexec/PlistBuddy', [
            '-c',
            inspection.helperDigest
              ? `Set :CordisXAppHelperDigest ${helperDigest}`
              : `Add :CordisXAppHelperDigest string ${helperDigest}`,
            info,
          ])
          await run('/usr/bin/codesign', ['--force', '--sign', '-', target])
          await run('/usr/bin/codesign', ['--verify', '--strict', target])
        } catch (error) {
          await copyFile(backup, installedHelper)
          await copyFile(infoBackup, info)
          await chmod(installedHelper, 0o755)
          await run('/usr/bin/codesign', ['--force', '--sign', '-', target])
          throw error
        }
      }
      status = 'reused'
    } else {
      stage = await mkdtemp(path.join(applications, '.cordisx-app-'))
      const icon = path.join(stage, 'CordisX.icns')
      const stagedBundle = path.join(stage, 'CordisX.app')
      await nativeOperation({ operation: 'app-icon', brand, output: icon })
      await nativeOperation({
        operation: 'assemble-app',
        path: stagedBundle,
        helper: appLauncherHelper,
        helperDigest,
        icon,
        runtimePath,
      })
      await run('/usr/bin/codesign', ['--force', '--sign', '-', stagedBundle])
      await run('/usr/bin/codesign', ['--verify', '--strict', stagedBundle])
      await rename(stagedBundle, target)
    }
    await writePrivateJson(runtimePath, {
      schemaVersion: 1,
      node,
      entryScript,
      cordisxHome,
      cwd: userHome,
      cacheDirectory,
      cacheRegistry,
      ...(environment.CODEX_HOME
        ? { codexHome: path.resolve(runtime.cwd ?? process.cwd(), environment.CODEX_HOME) }
        : {}),
    })
    await (runtime.internalOpenApp ?? (async app => await run('/usr/bin/open', [app])))(target)
    const result = { status, path: target }
    ;(runtime.stdout ?? console.log)(JSON.stringify(result, null, 2))
    return result
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true })
    await release()
  }
}
