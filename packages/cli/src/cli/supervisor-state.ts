import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type SupervisorPhase = 'starting' | 'ready' | 'stopping' | 'failed'

/** Durable, deliberately non-secret projection of one transient Host owner. */
export interface SupervisorState {
  readonly schemaVersion: 1
  readonly appId: string
  readonly profileId: string
  readonly phase: SupervisorPhase
  readonly pid: number
  readonly processStartedAt: string
  readonly instanceToken: string
  readonly createdAt: string
  readonly version: string
  readonly effectiveConfig: string
  /** Separate detached group launched by the supervisor, when Host startup reached spawn. */
  readonly hostPid?: number
  readonly hostProcessStartedAt?: string
  readonly cdpEndpoint?: string
  readonly startupSurface?: 'authenticated-ready' | 'auth-required'
  /** Live heartbeat only while the owning window presents Retry/Close. */
  readonly startupRecovery?: { readonly waitingForUser: boolean; readonly attempt: number; readonly updatedAt: number }
  /** Sanitized launch diagnosis; detailed output remains in host.log. */
  readonly failure?: string
  readonly failedAt?: string
}

export interface SupervisorPaths {
  readonly directory: string
  readonly state: string
  readonly lock: string
  readonly mutex: string
  readonly socket: string
  readonly log: string
  readonly bootstrapToken: string
}

export function supervisorPaths(homeDir: string, appId: string, profileId: string): SupervisorPaths {
  const directory = path.join(homeDir, 'run', appId, profileId)
  return {
    directory,
    state: path.join(directory, 'state.json'),
    lock: path.join(directory, 'start.lock'),
    mutex: path.join(directory, 'startup.mutex'),
    socket: path.join(directory, 'control.sock'),
    log: path.join(directory, 'host.log'),
    bootstrapToken: path.join(directory, 'bootstrap.token'),
  }
}

export function effectiveConfigFingerprint(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export async function ensureSupervisorDirectory(paths: SupervisorPaths): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await chmodPrivate(paths.directory)
}

async function chmodPrivate(target: string): Promise<void> {
  // The umask is not a security boundary. Deliberately tighten every authority
  // file after creation, including when an older release created the directory.
  await chmod(target, 0o700)
}

export async function writeSupervisorState(paths: SupervisorPaths, state: SupervisorState): Promise<void> {
  await ensureSupervisorDirectory(paths)
  const temporary = path.join(paths.directory, `.state-${randomBytes(12).toString('hex')}.tmp`)
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, paths.state)
}

function validState(value: unknown): value is SupervisorState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.schemaVersion === 1
    && typeof item.appId === 'string'
    && typeof item.profileId === 'string'
    && (item.phase === 'starting' || item.phase === 'ready' || item.phase === 'stopping' || item.phase === 'failed')
    && Number.isSafeInteger(item.pid) && (item.pid as number) > 0
    && typeof item.processStartedAt === 'string'
    && typeof item.instanceToken === 'string' && /^[a-f0-9]{32,}$/u.test(item.instanceToken)
    && typeof item.createdAt === 'string'
    && typeof item.version === 'string'
    && typeof item.effectiveConfig === 'string'
    && (item.hostPid === undefined || (Number.isSafeInteger(item.hostPid) && (item.hostPid as number) > 0))
    && (item.hostProcessStartedAt === undefined || typeof item.hostProcessStartedAt === 'string')
    && (item.cdpEndpoint === undefined || typeof item.cdpEndpoint === 'string')
    && (item.startupSurface === undefined || item.startupSurface === 'authenticated-ready'
      || item.startupSurface === 'auth-required')
    && (item.startupRecovery === undefined || validStartupRecovery(item.startupRecovery))
    && (item.failure === undefined || typeof item.failure === 'string')
    && (item.failedAt === undefined || typeof item.failedAt === 'string')
}

export type SupervisorStateReadResult =
  | { readonly status: 'valid'; readonly state: SupervisorState }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'unreadable'; readonly error: unknown }

function validStartupRecovery(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return typeof state.waitingForUser === 'boolean' && Number.isSafeInteger(state.attempt)
    && Number(state.attempt) >= 0 && typeof state.updatedAt === 'number' && Number.isFinite(state.updatedAt)
}

export async function readSupervisorStateResult(paths: SupervisorPaths): Promise<SupervisorStateReadResult> {
  try {
    const document = JSON.parse(await readFile(paths.state, 'utf8')) as unknown
    return validState(document) ? { status: 'valid', state: document } : { status: 'invalid' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    if (error instanceof SyntaxError) return { status: 'invalid' }
    return { status: 'unreadable', error }
  }
}

export async function readSupervisorState(paths: SupervisorPaths): Promise<SupervisorState | undefined> {
  const result = await readSupervisorStateResult(paths)
  return result.status === 'valid' ? result.state : undefined
}

export async function removeSupervisorState(paths: SupervisorPaths): Promise<void> {
  await Promise.all([
    rm(paths.state, { force: true }),
    rm(paths.socket, { force: true }),
    rm(paths.bootstrapToken, { force: true }),
  ])
}

export type ProcessIdentityStatus = 'alive' | 'dead' | 'unknown'

export class SupervisorOperationBusyError extends Error {
  readonly code = 'SUPERVISOR_OPERATION_BUSY'

  constructor() {
    super('another CordisX startup operation is already in progress')
  }
}

export class LegacySupervisorLockError extends Error {
  readonly code = 'LEGACY_SUPERVISOR_LOCK'

  constructor() {
    super(
      'legacy CordisX start lock is present; retry with --recover-startup only after all older CordisX starts have exited',
    )
  }
}

function operationLockCommand(fd: number): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform === 'darwin') return { command: '/usr/bin/lockf', args: ['-s', '-t', '0', String(fd)] }
  if (process.platform === 'linux') {
    return { command: '/usr/bin/flock', args: ['--exclusive', '--nonblock', '--conflict-exit-code', '75', String(fd)] }
  }
  throw new Error(`CordisX background supervision is unsupported on ${process.platform}: no kernel lock backend`)
}

async function ensureLegacyFence(paths: SupervisorPaths, recoverLegacy: boolean): Promise<void> {
  try {
    const metadata = await lstat(paths.lock)
    if (metadata.isDirectory()) {
      await chmod(paths.lock, 0o700)
      return
    }
    if (!metadata.isFile() || !recoverLegacy) throw new LegacySupervisorLockError()
    await rm(paths.lock)
    await mkdir(paths.lock, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      await mkdir(paths.lock, { mode: 0o700 })
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      const metadata = await lstat(paths.lock)
      if (!metadata.isDirectory()) throw new LegacySupervisorLockError()
    }
  }
  await chmod(paths.lock, 0o700)
}

export async function acquireSupervisorStartLock(
  paths: SupervisorPaths,
  options: { readonly recoverLegacy?: boolean } = {},
): Promise<() => Promise<void>> {
  await ensureSupervisorDirectory(paths)
  const flags = constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
  const handle = await open(paths.mutex, flags, 0o600)
  try {
    await chmod(paths.mutex, 0o600)
    const invocation = operationLockCommand(3)
    const locked = spawnSync(invocation.command, invocation.args, {
      stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      encoding: 'utf8',
    })
    if (locked.error !== undefined) throw locked.error
    if (locked.status === 75) throw new SupervisorOperationBusyError()
    if (locked.status !== 0) {
      throw new Error(
        `failed to acquire CordisX startup operation lock (${
          locked.status ?? locked.signal ?? 'unknown'
        }): ${locked.stderr.trim()}`,
      )
    }
    await ensureLegacyFence(paths, options.recoverLegacy === true)
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
  let released = false
  return async () => {
    if (released) return
    released = true
    await handle.close()
  }
}

/**
 * PID reuse is rejected by pairing the PID with the operating-system start
 * timestamp captured by the owning supervisor. Darwin/Linux expose this via
 * `ps`; unsupported platforms intentionally report an unknown identity.
 */
export async function processStartIdentity(pid: number): Promise<string | undefined> {
  try {
    const { execFile } = await import('node:child_process')
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        (error, stdout) => error === null ? resolve(stdout.trim()) : reject(error),
      )
    })
    return output === '' ? undefined : output
  } catch {
    return undefined
  }
}

export async function hasMatchingProcess(state: SupervisorState): Promise<boolean> {
  return (await processIdentityStatus(state.pid, state.processStartedAt)) === 'alive'
}

export async function hasMatchingProcessIdentity(pid: number, startedAt: string): Promise<boolean> {
  return (await processIdentityStatus(pid, startedAt)) === 'alive'
}

export async function processIdentityStatus(pid: number, startedAt: string): Promise<ProcessIdentityStatus> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
  const current = await processStartIdentity(pid)
  if (current === undefined) return 'unknown'
  return current === startedAt ? 'alive' : 'dead'
}

export async function stateFileIsPrivate(paths: SupervisorPaths): Promise<boolean> {
  try {
    return ((await stat(paths.state)).mode & 0o077) === 0
  } catch {
    return false
  }
}
