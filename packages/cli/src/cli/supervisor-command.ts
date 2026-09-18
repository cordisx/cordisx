import { randomBytes } from 'node:crypto'
import { chmod, open, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { ensureHomeConfig, type HomeConfigPathOptions, resolveHomeConfigPath } from '../config/home-config.js'
import { resolveProfileSelection } from './profiles.js'
import type { CordisXCliInvocation } from './parse.js'
import type { CordisXCliRuntime } from './run-support.js'
import {
  acquireSupervisorStartLock,
  effectiveConfigFingerprint,
  hasMatchingProcess,
  hasMatchingProcessIdentity,
  processStartIdentity,
  readSupervisorState,
  removeSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from './supervisor-state.js'
import { requestSupervisorStop } from './supervisor-control.js'

const VERSION = '0.1.0-beta.8'
const RETRY_DELAY = 50
/** Product launch budget; deliberately independent from shutdown escalation. */
export const RENDERER_READINESS_TIMEOUT_MS = 60_000
const SUPERVISOR_STOP_TIMEOUT_MS = 30_000

type ManagedAction = 'start' | 'status' | 'logs' | 'stop' | 'restart'

function isManaged(invocation: CordisXCliInvocation): invocation is Extract<CordisXCliInvocation, {
  readonly action: ManagedAction
}> {
  return ['start', 'status', 'logs', 'stop', 'restart'].includes(invocation.action)
}

export function isSupervisorCommand(invocation: CordisXCliInvocation): boolean {
  return isManaged(invocation)
}

function output(runtime: CordisXCliRuntime, value: unknown, json: boolean): void {
  const stdout = runtime.stdout ?? console.log
  stdout(json ? JSON.stringify(value) : typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

async function selectionFor(
  invocation: Extract<CordisXCliInvocation, { readonly action: ManagedAction }>,
  runtime: CordisXCliRuntime,
) {
  const environment = runtime.env ?? process.env
  const options: HomeConfigPathOptions = {
    env: environment,
    ...(runtime.homedir === undefined ? {} : { homedir: runtime.homedir }),
  }
  const configPath = resolveHomeConfigPath(options)
  const config = await ensureHomeConfig(options)
  const appId = invocation.app ?? config.defaultApp
  const selection = await resolveProfileSelection({
    config,
    configPath,
    appId,
    ...(invocation.profile === undefined ? {} : { profileId: invocation.profile }),
    ...(invocation.dataMode === undefined ? {} : { dataMode: invocation.dataMode }),
  })
  const source = await readFile(configPath, 'utf8')
  return {
    environment,
    configPath,
    appId,
    selection,
    fingerprint: effectiveConfigFingerprint({ source, options: invocation.options, hostArgs: invocation.hostArgs }),
  }
}

function readinessTimeout(runtime: CordisXCliRuntime): number {
  return runtime.internalSupervisorReadinessTimeoutMs ?? RENDERER_READINESS_TIMEOUT_MS
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function markSupervisorFailed(
  paths: ReturnType<typeof supervisorPaths>,
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
  failure: string,
): Promise<void> {
  const { cdpEndpoint: _cdpEndpoint, ...withoutEndpoint } = state
  await writeSupervisorState(paths, {
    ...withoutEndpoint,
    phase: 'failed',
    failure,
    failedAt: new Date().toISOString(),
  })
}

async function stopSupervisorProcessGroup(
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
): Promise<void> {
  if (!(await hasMatchingProcess(state))) return
  try {
    process.kill(-state.pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
  }
  const deadline = Date.now() + SUPERVISOR_STOP_TIMEOUT_MS
  while (await hasMatchingProcess(state)) {
    if (Date.now() > deadline) {
      process.kill(-state.pid, 'SIGKILL')
      break
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
  }
  if (await hasMatchingProcess(state)) throw new Error('timed out stopping the CordisX-owned process group')
}

async function hostStillRunning(state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>): Promise<boolean> {
  return state.hostPid !== undefined
    && state.hostProcessStartedAt !== undefined
    && await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
}

async function waitForOwnedShutdown(
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
): Promise<boolean> {
  const deadline = Date.now() + SUPERVISOR_STOP_TIMEOUT_MS
  while (await hasMatchingProcess(state) || await hostStillRunning(state)) {
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
  }
  return true
}

async function terminateOwnedGroups(
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
): Promise<void> {
  if (await hostStillRunning(state) && state.hostPid !== undefined) {
    try {
      process.kill(-state.hostPid, 'SIGTERM')
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
    }
  }
  await stopSupervisorProcessGroup(state)
  if (!await waitForOwnedShutdown(state)) throw new Error('timed out stopping the CordisX-owned process groups')
}

async function waitForState(
  paths: ReturnType<typeof supervisorPaths>,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof readSupervisorState>>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await readSupervisorState(paths)
    if (state?.phase === 'ready') return state
    if (state?.phase === 'failed') {
      throw new Error(state.failure ?? 'CordisX background supervisor failed before readiness')
    }
    if (state !== undefined && !(await hasMatchingProcess(state))) {
      await markSupervisorFailed(paths, state, 'CordisX background supervisor exited before renderer readiness')
      throw new Error('CordisX background supervisor exited before renderer readiness')
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
  }
  throw new Error('timed out waiting for CordisX renderer readiness')
}

function childArgs(invocation: Extract<CordisXCliInvocation, { readonly action: ManagedAction }>): string[] {
  const args = ['run']
  if (invocation.app !== undefined) args.push(invocation.app)
  if (invocation.profile !== undefined) args.push(invocation.profile)
  if (invocation.dataMode !== undefined) args.push('--data', invocation.dataMode)
  if (invocation.options.system) args.push('--system')
  if (invocation.options.profileDir !== undefined) args.push('--profile-dir', invocation.options.profileDir)
  if (invocation.options.executable !== undefined) args.push('--executable', invocation.options.executable)
  if (invocation.options.debugPort !== undefined) args.push('--debug-port', String(invocation.options.debugPort))
  if (invocation.options.onlineDevtools) args.push('--online-devtools')
  if (invocation.hostArgs.length > 0) args.push('--', ...invocation.hostArgs)
  return args
}

function display(state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>) {
  return {
    app: state.appId,
    profile: state.profileId,
    status: state.phase,
    pid: state.phase === 'failed' ? null : state.pid,
    uptime: Math.max(0, Date.now() - Date.parse(state.createdAt)),
    version: state.version,
    cdpEndpoint: state.cdpEndpoint ?? null,
    ...(state.failure === undefined ? {} : { failure: state.failure }),
  }
}

async function followLog(paths: ReturnType<typeof supervisorPaths>, runtime: CordisXCliRuntime): Promise<void> {
  const stdout = runtime.stdout ?? console.log
  let offset = 0
  while (!runtime.internalSignal?.aborted) {
    try {
      const contents = await readFile(paths.log, 'utf8')
      if (contents.length < offset) offset = 0
      if (contents.length > offset) {
        const appended = contents.slice(offset)
        offset = contents.length
        for (const line of appended.split(/\r?\n/u)) if (line !== '') stdout(line)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

export async function runSupervisorCommand(
  invocation: CordisXCliInvocation,
  runtime: CordisXCliRuntime,
): Promise<void> {
  if (!isManaged(invocation)) throw new Error('not a supervisor command')
  const target = await selectionFor(invocation, runtime)
  const paths = supervisorPaths(path.dirname(target.configPath), target.appId, target.selection.profileId)
  const json = invocation.options.json
  let state = await readSupervisorState(paths)
  if (state !== undefined && state.phase !== 'failed' && !(await hasMatchingProcess(state))) {
    await markSupervisorFailed(paths, state, 'CordisX background supervisor exited before renderer readiness')
    state = await readSupervisorState(paths)
  }
  if (invocation.action === 'status') {
    output(
      runtime,
      state === undefined
        ? {
          app: target.appId,
          profile: target.selection.profileId,
          status: 'stopped',
          pid: null,
          uptime: 0,
          version: VERSION,
          cdpEndpoint: null,
        }
        : display(state),
      json,
    )
    return
  }
  if (invocation.action === 'logs') {
    if (invocation.follow === true) {
      if (json) throw new Error('--json and --follow cannot be combined')
      await followLog(paths, runtime)
      return
    }
    try {
      output(runtime, await readFile(paths.log, 'utf8'), json)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') output(runtime, '', json)
      else throw error
    }
    return
  }
  if (invocation.action === 'stop' || invocation.action === 'restart') {
    if (state !== undefined) {
      // Ask a ready supervisor to close normally, then fence any remaining
      // launcher-owned helpers through the detached group.
      const requested = await requestSupervisorStop(paths.socket, state.instanceToken)
      if (requested ? !(await waitForOwnedShutdown(state)) : true) await terminateOwnedGroups(state)
      await removeSupervisorState(paths)
    }
    if (invocation.action === 'stop') {
      output(runtime, { app: target.appId, profile: target.selection.profileId, status: 'stopped' }, json)
      return
    }
  }
  if (state !== undefined) {
    if (state.phase === 'failed') state = undefined
  }
  if (state !== undefined) {
    if (state.version !== VERSION || state.effectiveConfig !== target.fingerprint) {
      throw new Error('CordisX instance version or effective configuration differs; run `cordisx restart` explicitly')
    }
    const ready = state.phase === 'ready' ? state : await waitForState(paths, readinessTimeout(runtime))
    if (ready === undefined) throw new Error('background supervisor exited before readiness')
    output(runtime, display(ready), json)
    return
  }
  const release = await acquireSupervisorStartLock(paths).catch(async error => {
    if (!(error instanceof Error) || error.message !== 'CordisX instance start is already in progress') throw error
    const waited = await waitForState(paths, readinessTimeout(runtime))
    if (waited === undefined) throw error
    output(runtime, display(waited), json)
    return undefined
  })
  if (release === undefined) return
  try {
    const log = await open(paths.log, 'a', 0o600)
    await chmod(paths.log, 0o600)
    const instanceToken = randomBytes(32).toString('hex')
    await writeFile(paths.bootstrapToken, instanceToken, { mode: 0o600 })
    const args = [process.argv[1]!, ...childArgs(invocation)]
    const childEnvironment = {
      ...target.environment,
      CORDISX_SUPERVISOR_HOME: path.dirname(target.configPath),
      CORDISX_SUPERVISOR_APP: target.appId,
      CORDISX_SUPERVISOR_PROFILE: target.selection.profileId,
      CORDISX_SUPERVISOR_FINGERPRINT: target.fingerprint,
      // The path is not authority. The random token stays in a mode-0600
      // bootstrap file rather than appearing in the child environment.
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    }
    const child = runtime.internalSpawnSupervisor === undefined
      ? spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: childEnvironment,
      })
      : runtime.internalSpawnSupervisor({ args, env: childEnvironment, logFd: log.fd })
    log.close()
    const startedAt = await processStartIdentity(child.pid!)
    if (startedAt === undefined) throw new Error('background supervisor exited before identity capture')
    await writeSupervisorState(paths, {
      schemaVersion: 1,
      appId: target.appId,
      profileId: target.selection.profileId,
      phase: 'starting',
      pid: child.pid!,
      processStartedAt: startedAt,
      instanceToken,
      createdAt: new Date().toISOString(),
      version: VERSION,
      effectiveConfig: target.fingerprint,
    })
    child.unref()
    try {
      const ready = await waitForState(paths, readinessTimeout(runtime))
      if (ready === undefined) throw new Error('background supervisor exited before readiness')
      output(runtime, display(ready), json)
    } catch (error) {
      const current = await readSupervisorState(paths)
      if (current !== undefined && current.phase !== 'failed') {
        try {
          await stopSupervisorProcessGroup(current)
        } finally {
          await markSupervisorFailed(paths, current, failureMessage(error))
        }
      }
      throw error
    }
  } finally {
    await release()
  }
}
