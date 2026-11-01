import { execFile, spawn } from 'node:child_process'
import { access, constants, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Trusted install locations; the cwd never contributes a candidate. */
export function claudeExecutableCandidates(homedir = os.homedir()): readonly string[] {
  return [
    '/Applications/Claude.app/Contents/MacOS/Claude',
    path.join(homedir, 'Applications/Claude.app/Contents/MacOS/Claude'),
  ]
}

export async function resolveClaudeExecutable(
  explicit?: string,
  candidates: readonly string[] = claudeExecutableCandidates(),
): Promise<string> {
  for (const candidate of explicit === undefined ? candidates : [path.resolve(explicit)]) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    explicit === undefined
      ? 'Claude Desktop was not found in /Applications; pass --executable <path>'
      : `Claude Desktop executable is not runnable: ${explicit}`,
  )
}

/** Everything a CordisX-owned Claude profile keeps lives below this root. */
export function claudeProfileRoot(cordisxHomeDir: string, profileId: string): string {
  return path.join(cordisxHomeDir, 'apps', 'claude', 'profiles', profileId)
}

/**
 * The directory Claude Desktop uses as its third-party data directory.
 *
 * Claude reads its third-party setup from `<userData>-3p` unless `userData`
 * already ends in `-3p`, so the launcher names the folder that way and passes
 * it as `--user-data-dir`. (Signed builds ignore `CLAUDE_USER_DATA_DIR` and
 * fall back to the user's own data folder, so it is never used.)
 */
export function claudeProfileDataDir(cordisxHomeDir: string, profileId: string): string {
  return path.join(claudeProfileRoot(cordisxHomeDir, profileId), 'data-3p')
}

export function claudeLaunchArgs(dataDir: string): readonly string[] {
  return [`--user-data-dir=${dataDir}`]
}

/** The pid `cordisx start claude` recorded; it outlives the process and is never trusted alone. */
export function claudeProfilePidPath(cordisxHomeDir: string, profileId: string): string {
  return path.join(claudeProfileRoot(cordisxHomeDir, profileId), 'claude.pid')
}

/**
 * The profile's recorded app process, when it is still the Claude process this
 * launcher started for that data directory. A reused pid is never reported.
 */
export async function runningClaudeProfile(
  cordisxHomeDir: string,
  profileId: string,
): Promise<number | undefined> {
  let pid: number
  try {
    pid = Number.parseInt((await readFile(claudeProfilePidPath(cordisxHomeDir, profileId), 'utf8')).trim(), 10)
  } catch {
    return undefined
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  try {
    const { stdout } = await execFileAsync('ps', ['-ww', '-p', String(pid), '-o', 'command='])
    if (!stdout.includes(claudeLaunchArgs(claudeProfileDataDir(cordisxHomeDir, profileId))[0]!)) return undefined
  } catch {
    return undefined
  }
  return pid
}

/**
 * Starts Claude Desktop on a CordisX-owned data directory and records its pid.
 *
 * Only `--user-data-dir` is passed: the app refuses to start with debugging or
 * network-override switches.
 */
export async function launchClaudeDesktop(input: {
  readonly executable: string
  readonly cordisxHomeDir: string
  readonly profileId: string
  readonly environment: Readonly<Record<string, string | undefined>>
}): Promise<number> {
  const dataDir = claudeProfileDataDir(input.cordisxHomeDir, input.profileId)
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.environment)) if (value !== undefined) env[key] = value
  // An inherited CLAUDE_USER_DATA_DIR sends a signed build back to the user's own data folder.
  delete env.CLAUDE_USER_DATA_DIR
  const child = spawn(input.executable, [...claudeLaunchArgs(dataDir)], { env, detached: true, stdio: 'ignore' })
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => child.pid === undefined ? reject(new Error('Claude exposed no pid')) : resolve(child.pid))
  })
  child.unref()
  await writeFile(claudeProfilePidPath(input.cordisxHomeDir, input.profileId), `${pid}\n`, { mode: 0o600 })
  return pid
}

export async function stopClaudeDesktop(cordisxHomeDir: string, profileId: string): Promise<boolean> {
  const pid = await runningClaudeProfile(cordisxHomeDir, profileId)
  if (pid === undefined) {
    await rm(claudeProfilePidPath(cordisxHomeDir, profileId), { force: true })
    return false
  }
  const exited = async (timeoutMs: number): Promise<boolean> => {
    for (let waited = 0; waited < timeoutMs; waited += 200) {
      await new Promise(resolve => setTimeout(resolve, 200))
      try {
        process.kill(pid, 0)
      } catch {
        return true
      }
    }
    return false
  }
  // Claude Desktop saves its windows and sessions on SIGTERM, which can take several seconds.
  process.kill(pid, 'SIGTERM')
  if (!await exited(20_000)) {
    process.kill(pid, 'SIGKILL')
    if (!await exited(5_000)) throw new Error(`Claude (pid ${pid}) did not exit`)
  }
  await rm(claudeProfilePidPath(cordisxHomeDir, profileId), { force: true })
  return true
}
