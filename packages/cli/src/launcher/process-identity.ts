import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'

export interface ProcessIdentity {
  readonly pid: number
  readonly parentPid: number
  readonly startedAt: string
}

export type RecordedProcessStatus = 'alive' | 'dead' | 'unknown'

export type UserDataDirInspectionFailure =
  | 'unsupported-platform'
  | 'ps-exception'
  | 'target-realpath-error'
  | 'quote-boundary'
  | 'candidate-limit'
  | 'realpath-error'
  | 'target-ambiguity'

export interface UserDataDirProcessInspection {
  readonly availability: 'available' | 'unavailable'
  readonly holders: readonly number[]
  readonly reason?: UserDataDirInspectionFailure
  readonly errorCode?: string
  readonly processCount: number
  readonly relevantProcessCount: number
  readonly candidateCount: number
  readonly skippedOverlongCandidateCount: number
  readonly failurePid?: number
  readonly failureCommandBytes?: number
}

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

function containsUnparsedUserDataDir(command: string, directory: string): boolean {
  for (const prefix of ['--user-data-dir=', '--user-data-dir ']) {
    let index = command.indexOf(prefix)
    while (index >= 0) {
      const before = command[index - 1]
      const valueStart = index + prefix.length
      if (
        (index === 0 || before === undefined || /\s/u.test(before))
        && command.startsWith(directory, valueStart)
      ) {
        const after = command[valueStart + directory.length]
        if (after === undefined || /\s/u.test(after)) return true
      }
      index = command.indexOf(prefix, index + prefix.length)
    }
  }
  return false
}

const USER_DATA_DIR_PATH_CANDIDATE_LIMIT = 64
const USER_DATA_DIR_PATH_MAX_BYTES = process.platform === 'darwin' ? 1024 : 4096
const USER_DATA_DIR_PATH_COMPONENT_MAX_BYTES = 255

function unavailableInspection(
  reason: UserDataDirInspectionFailure,
  counts: Pick<
    UserDataDirProcessInspection,
    'processCount' | 'relevantProcessCount' | 'candidateCount' | 'skippedOverlongCandidateCount'
  >,
  details: Partial<Pick<UserDataDirProcessInspection, 'errorCode' | 'failurePid' | 'failureCommandBytes'>> = {},
): UserDataDirProcessInspection {
  return { availability: 'unavailable', holders: [], reason, ...counts, ...details }
}

function userDataDirValues(
  command: string,
): { readonly values: readonly string[]; readonly reason?: 'quote-boundary' | 'candidate-limit' } {
  const values: string[] = []
  const markers = [...command.matchAll(/(?:^|\s)--user-data-dir(?:=|\s+)/gu)]
  let candidateCount = 0
  for (const marker of markers) {
    const valueStart = marker.index + marker[0].length
    const quote = command[valueStart]
    if (quote === '"' || quote === "'") {
      const valueEnd = command.indexOf(quote, valueStart + 1)
      if (valueEnd < 0) return { values, reason: 'quote-boundary' }
      const afterQuote = command[valueEnd + 1] ?? ''
      if (afterQuote !== '' && !/^\s$/u.test(afterQuote)) return { values, reason: 'quote-boundary' }
      if (candidateCount >= USER_DATA_DIR_PATH_CANDIDATE_LIMIT) return { values, reason: 'candidate-limit' }
      candidateCount += 1
      values.push(command.slice(valueStart + 1, valueEnd))
      continue
    }
    const valueSource = command.slice(valueStart).trimEnd()
    const boundaries = [...valueSource.matchAll(/\s+(?=\S)/gu)].map(match => match.index)
    for (const valueEnd of [...boundaries, valueSource.length]) {
      if (candidateCount >= USER_DATA_DIR_PATH_CANDIDATE_LIMIT) return { values, reason: 'candidate-limit' }
      candidateCount += 1
      values.push(valueSource.slice(0, valueEnd).trimEnd())
    }
  }
  return { values }
}

function viablePathCandidate(value: string): boolean {
  return Buffer.byteLength(value) < USER_DATA_DIR_PATH_MAX_BYTES
    && value.split(path.sep).every(component => Buffer.byteLength(component) <= USER_DATA_DIR_PATH_COMPONENT_MAX_BYTES)
}

/**
 * Live processes launched with one of the given `--user-data-dir` values, such
 * as a Host tree that outlived a killed launcher. `undefined` means the
 * platform cannot enumerate command lines or a target profile reference is
 * ambiguous, which callers must treat as unsafe. ps is not a lossless argv
 * transport, so unrelated undecodable arguments must not block recovery.
 */
export function inspectProcessesUsingUserDataDir(
  userDataDirs: readonly string[],
  readProcessList: () => string = () =>
    execFileSync('ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: PROCESS_TABLE_MAX_BUFFER_BYTES,
    }),
): UserDataDirProcessInspection {
  const counts = { processCount: 0, relevantProcessCount: 0, candidateCount: 0, skippedOverlongCandidateCount: 0 }
  if (process.platform === 'win32') return unavailableInspection('unsupported-platform', counts)
  let output: string
  try {
    output = readProcessList()
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
    return unavailableInspection(
      'ps-exception',
      counts,
      typeof errorCode === 'string' ? { errorCode } : {},
    )
  }
  const directories = new Set(userDataDirs.map(directory => path.resolve(directory)))
  for (const directory of userDataDirs) {
    try {
      directories.add(realpathSync(directory))
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code
      if (errorCode !== 'ENOENT') {
        return unavailableInspection(
          'target-realpath-error',
          counts,
          typeof errorCode === 'string' ? { errorCode } : {},
        )
      }
      // Exact spelling can still identify a holder of a not-yet-created profile.
    }
  }
  const holders: number[] = []
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    counts.processCount += 1
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (pid === process.pid || !command.includes('--user-data-dir')) continue
    counts.relevantProcessCount += 1
    const parsed = userDataDirValues(command)
    counts.candidateCount += parsed.values.length
    let holdsProfile = false
    for (const directory of parsed.values) {
      if (!path.isAbsolute(directory)) continue
      if (!viablePathCandidate(directory)) {
        counts.skippedOverlongCandidateCount += 1
        continue
      }
      if (directories.has(directory)) {
        holdsProfile = true
        break
      }
      try {
        if (directories.has(realpathSync(directory))) {
          holdsProfile = true
          break
        }
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code
        if (errorCode !== 'ENOENT') {
          return unavailableInspection('realpath-error', counts, {
            ...(typeof errorCode === 'string' ? { errorCode } : {}),
            failurePid: pid,
            failureCommandBytes: Buffer.byteLength(command),
          })
        }
        // An absent unrelated directory cannot currently alias an existing target profile.
      }
    }
    if (holdsProfile) {
      holders.push(pid)
      continue
    }
    if (parsed.reason !== undefined) {
      return unavailableInspection(parsed.reason, counts, {
        failurePid: pid,
        failureCommandBytes: Buffer.byteLength(command),
      })
    }
    if ([...directories].some(directory => containsUnparsedUserDataDir(command, directory))) {
      return unavailableInspection('target-ambiguity', counts, {
        failurePid: pid,
        failureCommandBytes: Buffer.byteLength(command),
      })
    }
  }
  return { availability: 'available', holders, ...counts }
}

export function processesUsingUserDataDir(userDataDirs: readonly string[]): readonly number[] | undefined {
  const inspection = inspectProcessesUsingUserDataDir(userDataDirs)
  return inspection.availability === 'available' ? inspection.holders : undefined
}
