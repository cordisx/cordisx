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
  processStartIdentity,
  readSupervisorState,
  removeSupervisorState,
  supervisorPaths,
  writeSupervisorState,
} from './supervisor-state.js'
import { requestSupervisorStop } from './supervisor-control.js'

const VERSION = '0.1.0-beta.3'
const RETRY_DELAY = 50
const START_TIMEOUT = 30_000

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

async function waitForState(
  paths: ReturnType<typeof supervisorPaths>,
): Promise<Awaited<ReturnType<typeof readSupervisorState>>> {
  const deadline = Date.now() + START_TIMEOUT
  while (Date.now() < deadline) {
    const state = await readSupervisorState(paths)
    if (state?.phase === 'ready') return state
    if (state !== undefined && !(await hasMatchingProcess(state))) await removeSupervisorState(paths)
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
    pid: state.pid,
    uptime: Math.max(0, Date.now() - Date.parse(state.createdAt)),
    version: state.version,
    cdpEndpoint: state.cdpEndpoint ?? null,
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
  if (state !== undefined && !(await hasMatchingProcess(state))) {
    await removeSupervisorState(paths)
    state = undefined
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
      // Prefer the authenticated private control seat.  Fall back to the
      // detached process group only when the supervisor is still booting.
      if (!(await requestSupervisorStop(paths.socket, state.instanceToken))) process.kill(-state.pid, 'SIGTERM')
      const deadline = Date.now() + START_TIMEOUT
      while (await hasMatchingProcess(state)) {
        if (Date.now() > deadline) throw new Error('timed out stopping the CordisX-owned process group')
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
      }
      await removeSupervisorState(paths)
    }
    if (invocation.action === 'stop') {
      output(runtime, { app: target.appId, profile: target.selection.profileId, status: 'stopped' }, json)
      return
    }
  }
  if (state !== undefined) {
    if (state.version !== VERSION || state.effectiveConfig !== target.fingerprint) {
      throw new Error('CordisX instance version or effective configuration differs; run `cordisx restart` explicitly')
    }
    const ready = state.phase === 'ready' ? state : await waitForState(paths)
    if (ready === undefined) throw new Error('background supervisor exited before readiness')
    output(runtime, display(ready), json)
    return
  }
  const release = await acquireSupervisorStartLock(paths).catch(async error => {
    if (!(error instanceof Error) || error.message !== 'CordisX instance start is already in progress') throw error
    const waited = await waitForState(paths)
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
    const ready = await waitForState(paths)
    if (ready === undefined) throw new Error('background supervisor exited before readiness')
    output(runtime, display(ready), json)
  } finally {
    await release()
  }
}
