import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'

export interface ProcessIdentity {
  readonly pid: number
  readonly parentPid: number
  readonly startedAt: string
}

export type RecordedProcessStatus = 'alive' | 'dead' | 'unknown'

export const PROCESS_TABLE_MAX_BUFFER_BYTES = 64 * 1024 * 1024

/** Snapshot of every visible process with its parent and start time; empty where `ps` is unavailable. */
export function processTable(): readonly ProcessIdentity[] {
  if (process.platform === 'win32') return []
  return execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
  })
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

/** Start time of one live process, or undefined once it is gone. */
export function liveProcessStartedAt(pid: number): string | undefined {
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

/**
 * Pair a recorded PID with its recorded start time so a reused PID never
 * passes as the recorded process. `unknown` means the table could not be read
 * and must be treated as unsafe by callers that would otherwise act on `dead`.
 */
export function recordedProcessStatus(pid: number, startedAt: string): RecordedProcessStatus {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0)
      return 'alive'
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
    }
  }
  let table: readonly ProcessIdentity[]
  try {
    table = processTable()
  } catch {
    return 'unknown'
  }
  const current = table.find(item => item.pid === pid)
  if (current === undefined) return 'dead'
  return current.startedAt === startedAt ? 'alive' : 'dead'
}

/**
 * Live processes launched with one of the given `--user-data-dir` values, such
 * as a Host tree that outlived a killed launcher. `undefined` means the
 * platform cannot enumerate command lines or a candidate's path is ambiguous,
 * which callers must treat as unsafe. ps is not a lossless argv transport.
 */
export function processesUsingUserDataDir(userDataDirs: readonly string[]): readonly number[] | undefined {
  if (process.platform === 'win32') return undefined
  let output: string
  try {
    output = execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
    })
  } catch {
    return undefined
  }
  const directories = new Set(userDataDirs.map(directory => path.resolve(directory)))
  for (const directory of userDataDirs) {
    try {
      directories.add(realpathSync(directory))
    } catch {
      // Exact spelling can still identify a holder of a not-yet-created profile.
    }
  }
  const holders: number[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (pid === process.pid || !command.includes('--user-data-dir')) continue
    // A final, unquoted, absolute value is the only ps spelling we resolve.
    // Whitespace/quotes, multiple switches or trailing argv cannot be decoded
    // reliably; never mistake a prefix of a spaced alias for an unrelated path.
    const values = [...command.matchAll(/--user-data-dir(?:=|\s+)([^\s'"`]+)(?=\s|$)/gu)]
    const value = values[0]
    if (
      values.length !== 1 || value === undefined || !path.isAbsolute(value[1]!)
      || command.slice(value.index! + value[0].length).trim() !== ''
    ) return undefined
    const directory = value[1]!
    if (directories.has(directory)) {
      holders.push(pid)
      continue
    }
    try {
      if (directories.has(realpathSync(directory))) holders.push(pid)
    } catch {
      return undefined
    }
  }
  return holders
}
