import type { ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'

const SAFE_INHERITED_ENVIRONMENT = [
  'ComSpec',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'OS',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'WINDIR',
] as const

export interface ManagedServiceChildTerminationTimeouts {
  readonly gracefulMs: number
  readonly forceMs: number
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (exited(child)) return true
  return await new Promise(resolve => {
    const finish = (value: boolean): void => {
      clearTimeout(timeout)
      child.removeListener('exit', onExit)
      child.removeListener('close', onExit)
      resolve(value)
    }
    const onExit = (): void => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    child.once('exit', onExit)
    child.once('close', onExit)
  })
}

export async function terminateManagedServiceChild(
  child: ChildProcess,
  timeouts: ManagedServiceChildTerminationTimeouts = { gracefulMs: 2_000, forceMs: 1_000 },
): Promise<void> {
  if (child.pid === undefined || exited(child)) return
  child.kill('SIGTERM')
  if (await waitForExit(child, timeouts.gracefulMs)) return
  child.kill('SIGKILL')
  if (!await waitForExit(child, timeouts.forceMs)) throw new Error('managed service child did not exit after SIGKILL')
}

export async function runManagedServiceChildAction(input: {
  readonly spawn: typeof nodeSpawn
  readonly executable: string
  readonly arguments: readonly string[]
  readonly cwd: string
  readonly environment: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly terminationTimeouts?: ManagedServiceChildTerminationTimeouts
}): Promise<number> {
  if (input.signal?.aborted) throw input.signal.reason ?? new Error('cancelled')
  const child = input.spawn(input.executable, [...input.arguments], {
    cwd: input.cwd,
    env: input.environment,
    stdio: 'ignore',
  })
  return await new Promise<number>((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
      child.removeListener('error', error)
      child.removeListener('exit', exit)
    }
    const fail = (reason: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      void terminateManagedServiceChild(child, input.terminationTimeouts).then(
        () => reject(reason),
        cleanupError => reject(new AggregateError([reason, cleanupError], 'managed service child cleanup failed')),
      )
    }
    const error = (reason: Error): void => fail(reason)
    const exit = (code: number | null): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(code ?? -1)
    }
    const abort = (): void => fail(input.signal?.reason ?? new Error('cancelled'))
    const timeout = setTimeout(() => fail(new Error('managed service child timed out')), input.timeoutMs)
    input.signal?.addEventListener('abort', abort, { once: true })
    child.once('error', error)
    child.once('exit', exit)
    if (input.signal?.aborted) abort()
  })
}

export function managedServiceHome(
  homeDir: string,
  pluginId: string,
  serviceId: string,
): string {
  return path.join(homeDir, 'managed-services', pluginId, serviceId)
}

export function managedServiceGenerationDirectory(serviceHome: string, serviceGeneration: string): string {
  return path.join(serviceHome, serviceGeneration)
}

export function managedServiceEnvironment(
  serviceHome: string,
  base: NodeJS.ProcessEnv = process.env,
  declared: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of SAFE_INHERITED_ENVIRONMENT) {
    if (base[key] !== undefined) environment[key] = base[key]
  }
  for (const [key, value] of Object.entries(base)) {
    if (key.startsWith('LC_') && value !== undefined) environment[key] = value
  }
  Object.assign(environment, declared)
  environment.HOME = serviceHome
  if (process.platform === 'win32') environment.USERPROFILE = serviceHome
  return environment
}
