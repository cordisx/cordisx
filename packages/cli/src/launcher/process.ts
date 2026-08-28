import { constants } from 'node:fs'
import { access, chmod, mkdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

export interface IsolatedCodexProfile {
  readonly userDataDir: string
  /** True only for a directory CordisX allocated and can safely sweep on exit. */
  readonly cleanupOwned: boolean
}

export interface IsolatedCodexProfileOptions {
  /** Selected CordisX home; project-scoped Chromium state must remain inside it. */
  readonly cordisxHomeDir: string
  /** Explicit user override, which always wins and is never broadly swept. */
  readonly explicitProfileDir?: string
}

export const ONLINE_DEVTOOLS_ORIGIN = 'https://chrome-devtools-frontend.appspot.com'

async function executableFile(candidate: string): Promise<string> {
  const metadata = await stat(candidate)
  if (!metadata.isFile()) throw new Error(`host executable is not a regular file: ${candidate}`)
  await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  return candidate
}

async function firstExecutable(paths: readonly string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await executableFile(candidate).then(() => true).catch(() => false)) return candidate
  }
}

/** Return trusted platform candidates without deriving paths from the cwd. */
export function codexExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir = os.homedir(),
): readonly string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Codex.app/Contents/MacOS/Codex',
      path.join(homedir, 'Applications/Codex.app/Contents/MacOS/Codex'),
      '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      path.join(homedir, 'Applications/ChatGPT.app/Contents/MacOS/ChatGPT'),
    ]
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim()
    if (localAppData === undefined || localAppData === '' || !path.win32.isAbsolute(localAppData)) return []
    return [
      path.win32.join(localAppData, 'Programs', 'Codex', 'Codex.exe'),
      path.win32.join(localAppData, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
    ]
  }
  return []
}

/** Resolve the native Codex executable without reading or changing its profile. */
export async function resolveCodexExecutable(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit)
    return await executableFile(resolved)
  }
  const found = await firstExecutable(codexExecutableCandidates())
  if (found === undefined) throw new Error('Codex/ChatGPT executable not found; pass --executable <path> or use --attach')
  return found
}

/** Find an ephemeral loopback port for an isolated launch. */
export async function findFreeLoopbackPort(): Promise<number> {
  const server = createServer()
  server.unref()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('failed to allocate a loopback CDP port')
  }
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
  return address.port
}

/** Fail before launch when an explicit loopback port is already owned. */
export async function assertLoopbackPortAvailable(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  }).catch((error) => {
    throw new Error(`loopback CDP port is unavailable: ${port}`, { cause: error })
  })
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

/** Derive a readable collision-resistant key for one project checkout. */
export function projectProfileKey(projectRoot: string): string {
  const resolved = path.resolve(projectRoot)
  const readable = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 12)
  return `${readable}-${digest}`
}

/** Resolve the stable, selected-home-scoped Chromium profile used by one project. */
export function defaultIsolatedProfileDir(projectRoot: string, cordisxHomeDir: string): string {
  return path.join(
    path.resolve(cordisxHomeDir),
    'projects',
    projectProfileKey(projectRoot),
    'cache',
    'codex-app-profile',
  )
}

/** Prepare only isolated Chromium state; HOME and CODEX_HOME remain shared. */
export async function prepareIsolatedCodexProfile(
  projectRoot: string,
  options: IsolatedCodexProfileOptions,
): Promise<IsolatedCodexProfile> {
  const userDataDir = path.resolve(
    options.explicitProfileDir ?? defaultIsolatedProfileDir(projectRoot, options.cordisxHomeDir),
  )
  const created = await mkdir(userDataDir, { recursive: true, mode: 0o700 })
  if (created !== undefined && process.platform !== 'win32') await chmod(userDataDir, 0o700)
  return { userDataDir, cleanupOwned: options.explicitProfileDir === undefined }
}

export function codexLaunchArgs(
  debugPort: number,
  extraArgs: readonly string[],
  profile?: IsolatedCodexProfile,
  allowOnlineDevTools = false,
): string[] {
  const origins = [
    `http://127.0.0.1:${debugPort}`,
    ...(allowOnlineDevTools ? [ONLINE_DEVTOOLS_ORIGIN] : []),
  ]
  return [
    ...extraArgs,
    ...(profile === undefined ? [] : [`--user-data-dir=${profile.userDataDir}`]),
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=${origins.join(',')}`,
  ]
}

/** Launch a tracked Codex process with a loopback-only DevTools endpoint. */
export function launchCodex(
  executable: string,
  debugPort: number,
  extraArgs: readonly string[],
  profile?: IsolatedCodexProfile,
  allowOnlineDevTools = false,
  environment?: Readonly<Record<string, string>>,
): ChildProcess {
  return spawn(executable, codexLaunchArgs(debugPort, extraArgs, profile, allowOnlineDevTools), {
    stdio: profile === undefined ? 'inherit' : 'ignore',
    env: environment === undefined ? process.env : { ...process.env, ...environment },
    // A launcher owns exactly one process group, so cleanup can stop the Host
    // tree (including Chromium helpers) without touching an ordinary Host.
    detached: process.platform !== 'win32',
  })
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (exited(child)) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolve(false)
    }, milliseconds)
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

/** Stop only the exact process returned by launchCodex. */
export async function terminateIsolatedCodex(child: ChildProcess, profile?: IsolatedCodexProfile): Promise<void> {
  if (child.pid === undefined) return
  if (!exited(child)) {
    signalLaunchedHost(child, 'SIGTERM')
    if (!await waitForExit(child, 5_000)) {
      signalLaunchedHost(child, 'SIGKILL')
    }
  }
  if (!exited(child) && !await waitForExit(child, 2_000)) {
    throw new Error(`failed to stop launched host process${child.pid === undefined ? '' : ` ${child.pid}`}`)
  }
  if (profile?.cleanupOwned === true) await terminateProfileProcesses(profile.userDataDir)
}

/** Signal only the detached process group created by launchCodex. */
function signalLaunchedHost(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      // Unit callers may pass a process not created by launchCodex; retain the
      // exact-child fallback without ever broadening the target.
      if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) throw error
    }
  }
  child.kill(signal)
}

function profileProcessIds(userDataDir: string): readonly number[] {
  if (process.platform === 'win32') return []
  // Browser Crashpad helpers use `--database=<profile>/Crashpad` rather than
  // `--user-data-dir`, so match the exact managed profile path in either form.
  const profilePath = userDataDir
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
      if (match === null) return []
      const [, rawPid = '', command = ''] = match
      return !command.includes(profilePath) ? [] : [Number(rawPid)]
    })
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
}

/**
 * Chromium helpers such as Crashpad may deliberately leave the Electron
 * process group. They are still fenced by the exact profile path selected by
 * this launcher, so stop only those helpers after the primary Host has exited.
 */
async function terminateProfileProcesses(userDataDir: string): Promise<void> {
  const stop = (signal: NodeJS.Signals): void => {
    for (const pid of profileProcessIds(userDataDir)) {
      try { process.kill(pid, signal) } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
      }
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (profileProcessIds(userDataDir).length === 0) return
    stop('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  stop('SIGKILL')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (profileProcessIds(userDataDir).length === 0) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const remaining = profileProcessIds(userDataDir)
  if (remaining.length > 0) throw new Error(`failed to stop launched Host profile processes: ${remaining.join(', ')}`)
}
