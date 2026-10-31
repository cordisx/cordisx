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

/** The directory Claude Desktop uses as its third-party data directory. */
export function claudeProfileDataDir(cordisxHomeDir: string, profileId: string): string {
  return path.join(claudeProfileRoot(cordisxHomeDir, profileId), 'data')
}

function pidFile(cordisxHomeDir: string, profileId: string): string {
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
    pid = Number.parseInt((await readFile(pidFile(cordisxHomeDir, profileId), 'utf8')).trim(), 10)
  } catch {
    return undefined
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
    if (!stdout.includes('Claude.app/Contents/MacOS/Claude')) return undefined
  } catch {
    return undefined
  }
  try {
    const { stdout } = await execFileAsync('ps', ['eww', '-p', String(pid), '-o', 'command='])
    const dataDir = claudeProfileDataDir(cordisxHomeDir, profileId)
    if (!stdout.includes(`CLAUDE_USER_DATA_DIR=${dataDir}`)) return undefined
  } catch {
    return undefined
  }
  return pid
}

/**
 * Starts Claude Desktop on a CordisX-owned data directory and records its pid.
 *
 * `CLAUDE_USER_DATA_DIR` makes the app use `dataDir` itself as its third-party
 * directory. Debug and network-override switches are never passed: the app
 * refuses to start with them.
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
  env.CLAUDE_USER_DATA_DIR = dataDir
  const child = spawn(input.executable, [], { env, detached: true, stdio: 'ignore' })
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('spawn', () => child.pid === undefined ? reject(new Error('Claude exposed no pid')) : resolve(child.pid))
  })
  child.unref()
  await writeFile(pidFile(input.cordisxHomeDir, input.profileId), `${pid}\n`, { mode: 0o600 })
  return pid
}

export async function stopClaudeDesktop(cordisxHomeDir: string, profileId: string): Promise<boolean> {
  const pid = await runningClaudeProfile(cordisxHomeDir, profileId)
  if (pid === undefined) {
    await rm(pidFile(cordisxHomeDir, profileId), { force: true })
    return false
  }
  process.kill(pid, 'SIGTERM')
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    try {
      process.kill(pid, 0)
    } catch {
      break
    }
  }
  await rm(pidFile(cordisxHomeDir, profileId), { force: true })
  return true
}
