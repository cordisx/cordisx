import { constants } from 'node:fs'
import { access, chmod, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'

export interface IsolatedCodexProfile {
  readonly userDataDir: string
  /** True only for a directory CordisX allocated and can safely sweep on exit. */
  readonly cleanupOwned: boolean
}

export interface CodexProfileLaunchLease {
  readonly userDataDir: string
  release(): Promise<void>
}

export interface IsolatedCodexProfileOptions {
  /** Selected CordisX home; project-scoped Chromium state must remain inside it. */
  readonly cordisxHomeDir: string
  /** Explicit user override, which always wins and is never broadly swept. */
  readonly explicitProfileDir?: string
}

export const ONLINE_DEVTOOLS_ORIGIN = 'https://chrome-devtools-frontend.appspot.com'

interface ProfileLeaseRecord {
  readonly version: 1
  readonly pid: number
  readonly processStartedAt: string
  readonly token: string
  readonly userDataDir: string
}

interface ProcessIdentity {
  readonly pid: number
  readonly parentPid: number
  readonly startedAt: string
}

const launchedProcessOwnership = new WeakMap<ChildProcess, ProcessOwnershipTracker>()

function processTable(): readonly ProcessIdentity[] {
  if (process.platform === 'win32') return []
  return execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8' })
    .split('\n')
    .flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line)
      if (match === null) return []
      const pid = Number(match[1])
      const parentPid = Number(match[2])
      const startedAt = match[3] ?? ''
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0
        ? [{ pid, parentPid, startedAt }]
        : []
    })
}

function liveProcessStartedAt(pid: number): string | undefined {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0)
      return 'live'
    } catch {
      return undefined
    }
  }
  return processTable().find(item => item.pid === pid)?.startedAt
}

async function canonicalProfileLeaseTarget(userDataDir: string): Promise<string> {
  const resolvedProfile = path.resolve(userDataDir)
  try {
    return await realpath(resolvedProfile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = path.dirname(resolvedProfile)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  return path.join(await realpath(parent), path.basename(resolvedProfile))
}

function profileLeasePath(userDataDir: string): string {
  return `${userDataDir}.cordisx-launch-lock`
}

function parseProfileLeaseRecord(source: string): ProfileLeaseRecord | undefined {
  try {
    const value = JSON.parse(source) as Partial<ProfileLeaseRecord>
    if (
      value.version !== 1 || !Number.isInteger(value.pid) || value.pid! <= 0
      || typeof value.processStartedAt !== 'string' || value.processStartedAt === ''
      || typeof value.token !== 'string' || value.token === ''
      || typeof value.userDataDir !== 'string' || !path.isAbsolute(value.userDataDir)
    ) return undefined
    return value as ProfileLeaseRecord
  } catch {
    return undefined
  }
}

/** Exclusively reserve one persistent Chromium profile for this launcher process. */
export async function acquireCodexProfileLaunchLease(userDataDir: string): Promise<CodexProfileLaunchLease> {
  const resolvedProfile = await canonicalProfileLeaseTarget(userDataDir)
  const lockPath = profileLeasePath(resolvedProfile)
  const processStartedAt = liveProcessStartedAt(process.pid)
  if (processStartedAt === undefined) throw new Error('cannot identify the CordisX launcher process')
  for (let attempt = 0; attempt < 1; attempt += 1) {
    let createdLock = false
    try {
      await mkdir(lockPath, { mode: 0o700 })
      createdLock = true
      const record: ProfileLeaseRecord = {
        version: 1,
        pid: process.pid,
        processStartedAt,
        token: randomUUID(),
        userDataDir: resolvedProfile,
      }
      await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify(record)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      let released = false
      let releasing: Promise<void> | undefined
      return Object.freeze({
        userDataDir: resolvedProfile,
        release: async () => {
          if (released) return
          if (releasing !== undefined) return await releasing
          const operation = (async () => {
            const current = parseProfileLeaseRecord(
              await readFile(path.join(lockPath, 'owner.json'), 'utf8').catch(() => ''),
            )
            if (current?.token !== record.token) {
              throw new Error(`Codex profile launch lease ownership changed: ${resolvedProfile}`)
            }
            await rm(lockPath, { recursive: true })
            released = true
          })()
          releasing = operation
          try {
            await operation
          } finally {
            if (!released && releasing === operation) releasing = undefined
          }
        },
      })
    } catch (error) {
      if (createdLock) {
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const owner = parseProfileLeaseRecord(await readFile(path.join(lockPath, 'owner.json'), 'utf8').catch(() => ''))
      if (owner === undefined || owner.userDataDir !== resolvedProfile) {
        throw new Error(`Codex profile is in use or has an unrecognized launch lock: ${resolvedProfile}`)
      }
      if (liveProcessStartedAt(owner.pid) === owner.processStartedAt) {
        throw new Error(`Codex profile is in use by launcher process ${owner.pid}: ${resolvedProfile}`)
      }
      throw new Error(`Codex profile has a stale launch lock that requires inspection: ${resolvedProfile}`)
    }
  }
  throw new Error(`Codex profile launch lease could not be acquired: ${resolvedProfile}`)
}

class ProcessOwnershipTracker {
  private readonly identities = new Map<number, string>()
  private readonly rootStartedAt: string | undefined
  private readonly timer: NodeJS.Timeout

  constructor(private readonly rootPid: number) {
    this.rootStartedAt = liveProcessStartedAt(rootPid)
    if (this.rootStartedAt !== undefined) this.identities.set(rootPid, this.rootStartedAt)
    this.capture()
    this.timer = setInterval(() => this.capture(), 250)
    this.timer.unref()
  }

  stop(): readonly ProcessIdentity[] {
    clearInterval(this.timer)
    this.capture()
    return processTable().filter(item => this.identities.get(item.pid) === item.startedAt)
  }

  captureNow(): void {
    this.capture()
  }

  private capture(): void {
    const table = processTable()
    const live = new Map(table.map(item => [item.pid, item]))
    const owned = new Set<number>()
    for (const [pid, startedAt] of this.identities) {
      if (live.get(pid)?.startedAt === startedAt) owned.add(pid)
    }
    if (this.rootStartedAt !== undefined && live.get(this.rootPid)?.startedAt === this.rootStartedAt) {
      owned.add(this.rootPid)
    }
    let changed = true
    while (changed) {
      changed = false
      for (const item of table) {
        if (owned.has(item.pid) || !owned.has(item.parentPid)) continue
        owned.add(item.pid)
        changed = true
      }
    }
    for (const item of table) {
      if (owned.has(item.pid) && !this.identities.has(item.pid)) this.identities.set(item.pid, item.startedAt)
    }
  }
}

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
      '/Applications/Codex.app/Contents/MacOS/ChatGPT',
      '/Applications/Codex.app/Contents/MacOS/Codex',
      path.join(homedir, 'Applications/Codex.app/Contents/MacOS/ChatGPT'),
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
export async function resolveCodexExecutable(
  explicit?: string,
  candidates: readonly string[] = codexExecutableCandidates(),
): Promise<string> {
  if (explicit !== undefined) {
    const resolved = path.resolve(explicit)
    return await executableFile(resolved)
  }
  const found = await firstExecutable(candidates)
  if (found === undefined) {
    throw new Error('Codex/ChatGPT executable not found; pass --executable <path> or use --attach')
  }
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
  const child = spawn(executable, codexLaunchArgs(debugPort, extraArgs, profile, allowOnlineDevTools), {
    stdio: profile === undefined ? 'inherit' : 'ignore',
    env: environment === undefined ? process.env : { ...process.env, ...environment },
    // A launcher owns exactly one process group, so cleanup can stop the Host
    // tree (including Chromium helpers) without touching an ordinary Host.
    detached: process.platform !== 'win32',
  })
  if (child.pid !== undefined && process.platform !== 'win32') {
    launchedProcessOwnership.set(child, new ProcessOwnershipTracker(child.pid))
  }
  return child
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForExit(child: ChildProcess, milliseconds: number, whileWaiting?: () => void): Promise<boolean> {
  if (exited(child)) return true
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      clearInterval(poll)
      child.removeListener('exit', onExit)
      resolve(false)
    }, milliseconds)
    const poll = setInterval(() => whileWaiting?.(), 50)
    poll.unref()
    const onExit = (): void => {
      clearTimeout(timer)
      clearInterval(poll)
      resolve(true)
    }
    child.once('exit', onExit)
  })
}

/** Stop only the exact process returned by launchCodex. */
export async function terminateIsolatedCodex(child: ChildProcess, profile?: IsolatedCodexProfile): Promise<void> {
  const ownership = launchedProcessOwnership.get(child)
  if (child.pid === undefined) {
    ownership?.stop()
    launchedProcessOwnership.delete(child)
    return
  }
  if (!exited(child)) {
    ownership?.captureNow()
    signalLaunchedHost(child, 'SIGTERM')
    if (!await waitForExit(child, 5_000, () => ownership?.captureNow())) {
      signalLaunchedHost(child, 'SIGKILL')
    }
  }
  if (!exited(child) && !await waitForExit(child, 2_000, () => ownership?.captureNow())) {
    throw new Error(`failed to stop launched host process${child.pid === undefined ? '' : ` ${child.pid}`}`)
  }
  const ownedProcesses = ownership?.stop() ?? []
  launchedProcessOwnership.delete(child)
  if (profile?.cleanupOwned === true) await terminateOwnedProcesses(ownedProcesses, child.pid)
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
      if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) {
        throw error
      }
    }
  }
  child.kill(signal)
}

/** Stop only identities observed as descendants of the exact launched process. */
async function terminateOwnedProcesses(owned: readonly ProcessIdentity[], rootPid: number): Promise<void> {
  const remaining = (): readonly ProcessIdentity[] => {
    const live = new Map(processTable().map(item => [item.pid, item.startedAt]))
    return owned.filter(item => item.pid !== rootPid && live.get(item.pid) === item.startedAt)
  }
  const stop = (signal: NodeJS.Signals): void => {
    for (const { pid } of remaining()) {
      try {
        process.kill(pid, signal)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
      }
    }
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (remaining().length === 0) return
    stop('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  stop('SIGKILL')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (remaining().length === 0) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const survivors = remaining()
  if (survivors.length > 0) {
    throw new Error(`failed to stop launched Host child processes: ${survivors.map(item => item.pid).join(', ')}`)
  }
}
