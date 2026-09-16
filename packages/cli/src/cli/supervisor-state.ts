import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  /** Sanitized launch diagnosis; detailed output remains in host.log. */
  readonly failure?: string
  readonly failedAt?: string
}

export interface SupervisorPaths {
  readonly directory: string
  readonly state: string
  readonly lock: string
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
    && (item.failure === undefined || typeof item.failure === 'string')
    && (item.failedAt === undefined || typeof item.failedAt === 'string')
}

export async function readSupervisorState(paths: SupervisorPaths): Promise<SupervisorState | undefined> {
  try {
    const document = JSON.parse(await readFile(paths.state, 'utf8')) as unknown
    return validState(document) ? document : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

export async function removeSupervisorState(paths: SupervisorPaths): Promise<void> {
  await Promise.all([
    rm(paths.state, { force: true }),
    rm(paths.socket, { force: true }),
    rm(paths.bootstrapToken, { force: true }),
  ])
}

export async function acquireSupervisorStartLock(paths: SupervisorPaths): Promise<() => Promise<void>> {
  await ensureSupervisorDirectory(paths)
  let handle
  try {
    handle = await open(paths.lock, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('CordisX instance start is already in progress')
    }
    throw error
  }
  return async () => {
    await handle.close()
    await rm(paths.lock, { force: true })
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
  return await hasMatchingProcessIdentity(state.pid, state.processStartedAt)
}

export async function hasMatchingProcessIdentity(pid: number, startedAt: string): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return (await processStartIdentity(pid)) === startedAt
}

export async function stateFileIsPrivate(paths: SupervisorPaths): Promise<boolean> {
  try {
    return ((await stat(paths.state)).mode & 0o077) === 0
  } catch {
    return false
  }
}
