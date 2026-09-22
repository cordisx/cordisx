import { fileURLToPath } from 'node:url'
import { launchFingerprint } from './launch-fingerprint.js'
import { randomBytes } from 'node:crypto'
import { chmod, open, readFile, realpath, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { ensureHomeConfig, type HomeConfigPathOptions, resolveHomeConfigPath } from '../config/home-config.js'
import { resolveProfileSelection } from './profiles.js'
import type { CordisXCliInvocation } from './parse.js'
import type { CordisXCliRuntime } from './run-support.js'
import {
  acquireSupervisorStartLock,
  LegacySupervisorLockError,
  processIdentityStatus,
  processStartIdentity,
  readSupervisorState,
  readSupervisorStateResult,
  removeSupervisorState,
  SupervisorOperationBusyError,
  supervisorPaths,
  writeSupervisorState,
} from './supervisor-state.js'
import { requestDockRefresh, requestShortcutPresentation, requestSupervisorStop } from './supervisor-control.js'
import { resolveOwningPackageVersion } from '../launcher/package-version.js'
import { createShortcut, preflightShortcut, reuseShortcut } from '../shortcuts/create.js'
import { shortcutKey } from '../shortcuts/model.js'
import { registryFor } from '../shortcuts/store.js'
import { openNativeStartupGate } from './startup-gate.js'

const VERSION = await resolveOwningPackageVersion(import.meta.url, 'cordisx')
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
    fingerprint: launchFingerprint({
      source,
      options: invocation.options,
      hostArgs: invocation.hostArgs,
      dataMode: selection.dataMode,
      cwd: runtime.cwd ?? process.cwd(),
      ...(environment.CODEX_HOME
        ? { codexHome: path.resolve(runtime.cwd ?? process.cwd(), environment.CODEX_HOME) }
        : {}),
    }),
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
  const initial = await processIdentityStatus(state.pid, state.processStartedAt)
  if (initial === 'dead') return
  if (initial === 'unknown') throw new Error('unable to verify the CordisX supervisor process identity')
  try {
    process.kill(-state.pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error
  }
  const deadline = Date.now() + SUPERVISOR_STOP_TIMEOUT_MS
  for (;;) {
    const status = await processIdentityStatus(state.pid, state.processStartedAt)
    if (status === 'dead') break
    if (Date.now() > deadline) {
      if (status === 'unknown') throw new Error('unable to verify the CordisX supervisor process identity')
      process.kill(-state.pid, 'SIGKILL')
      break
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
  }
  const final = await processIdentityStatus(state.pid, state.processStartedAt)
  if (final === 'unknown') throw new Error('unable to verify the CordisX supervisor process identity')
  if (final === 'alive') throw new Error('timed out stopping the CordisX-owned process group')
}

async function hostStatus(
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
): Promise<'alive' | 'dead' | 'unknown'> {
  if (state.hostPid === undefined || state.hostProcessStartedAt === undefined) return 'dead'
  return await processIdentityStatus(state.hostPid, state.hostProcessStartedAt)
}

async function waitForOwnedShutdown(
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
): Promise<boolean> {
  const deadline = Date.now() + SUPERVISOR_STOP_TIMEOUT_MS
  for (;;) {
    const supervisor = await processIdentityStatus(state.pid, state.processStartedAt)
    const host = await hostStatus(state)
    if (supervisor === 'dead' && host === 'dead') return true
    if (Date.now() > deadline) {
      if (supervisor === 'unknown' || host === 'unknown') {
        throw new Error('unable to verify a CordisX-owned process identity during shutdown')
      }
      return false
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
  }
}

async function terminateOwnedGroups(
  state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>,
): Promise<void> {
  const currentHost = await hostStatus(state)
  if (currentHost === 'unknown') throw new Error('unable to verify the CordisX Host process identity')
  if (currentHost === 'alive' && state.hostPid !== undefined) {
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
  onHostLaunched?: (state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>) => void | Promise<void>,
): Promise<Awaited<ReturnType<typeof readSupervisorState>>> {
  const deadline = Date.now() + timeoutMs
  let hostPublished = false
  while (Date.now() < deadline) {
    const state = await readSupervisorState(paths)
    if (!hostPublished && state?.hostPid !== undefined && state.hostProcessStartedAt !== undefined) {
      hostPublished = true
      await onHostLaunched?.(state)
    }
    if (state?.phase === 'ready') return state
    if (state?.phase === 'failed') {
      throw new Error(state.failure ?? 'CordisX background supervisor failed before readiness')
    }
    if (state !== undefined) {
      const identity = await processIdentityStatus(state.pid, state.processStartedAt)
      if (identity === 'unknown') throw new Error('unable to verify the CordisX supervisor process identity')
      if (identity === 'dead') {
        throw new Error('CordisX background supervisor exited before renderer readiness')
      }
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
  }
  throw new Error('timed out waiting for CordisX renderer readiness')
}

async function acquireSupervisorOperation(
  paths: ReturnType<typeof supervisorPaths>,
  timeoutMs: number,
  recoverLegacy: boolean,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return await acquireSupervisorStartLock(paths, { recoverLegacy })
    } catch (error) {
      if (!(error instanceof SupervisorOperationBusyError)) throw error
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY))
    }
  }
}

async function readMutableSupervisorState(
  paths: ReturnType<typeof supervisorPaths>,
): Promise<Awaited<ReturnType<typeof readSupervisorState>>> {
  const result = await readSupervisorStateResult(paths)
  if (result.status === 'valid') return result.state
  if (result.status === 'missing') return undefined
  if (result.status === 'invalid') throw new Error('CordisX supervisor state is invalid; refusing automatic recovery')
  throw new Error(
    `CordisX supervisor state is unreadable; refusing automatic recovery: ${failureMessage(result.error)}`,
  )
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

export interface ReadyLaunchResult {
  readonly state: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>
  readonly target: Awaited<ReturnType<typeof selectionFor>>
}

async function finishReady(
  invocation: Extract<CordisXCliInvocation, { readonly action: ManagedAction }>,
  runtime: CordisXCliRuntime,
  ready: ReadyLaunchResult,
): Promise<ReadyLaunchResult> {
  let shortcut: Awaited<ReturnType<typeof createShortcut>> | undefined
  if (invocation.createShortcut) {
    try {
      const launchIdentity = ready.state.hostPid && ready.state.hostProcessStartedAt
        ? {
          supervisorPid: ready.state.pid,
          supervisorStartedAt: ready.state.processStartedAt,
          hostPid: ready.state.hostPid,
          hostStartedAt: ready.state.hostProcessStartedAt,
        }
        : undefined
      const shortcutInput = {
        invocation,
        appId: ready.target.appId,
        profileId: ready.target.selection.profileId,
        dataMode: ready.target.selection.dataMode,
        home: path.dirname(ready.target.configPath),
        cwd: runtime.cwd ?? process.cwd(),
        env: ready.target.environment,
        ...(runtime.internalShortcutOutput ? { output: runtime.internalShortcutOutput } : {}),
        ...(launchIdentity ? { launchIdentity } : {}),
      }
      shortcut = runtime.internalReuseShortcut && launchIdentity
        ? await reuseShortcut({ ...shortcutInput, launchIdentity })
        : undefined
      if (!shortcut) {
        const socket = supervisorPaths(
          path.dirname(ready.target.configPath),
          ready.target.appId,
          ready.target.selection.profileId,
        ).socket
        let displayProfile = await requestShortcutPresentation(socket, ready.state.instanceToken)
        const avatarDeadline = Date.now() + 10_000
        while (displayProfile.status !== 'available' || !displayProfile.avatar) {
          if (Date.now() >= avatarDeadline) break
          await new Promise(resolve => setTimeout(resolve, 250))
          displayProfile = await requestShortcutPresentation(socket, ready.state.instanceToken)
        }
        shortcut = await createShortcut({
          ...(displayProfile.status === 'available' && displayProfile.avatar ? { avatar: displayProfile.avatar } : {}),
          ...shortcutInput,
        })
      }
    } catch (error) {
      throw new Error('Host is ready; shortcut was not updated: ' + failureMessage(error))
    }
  }
  if (invocation.createShortcut || runtime.internalShortcutDockRecordPath) {
    const home = await realpath(path.dirname(ready.target.configPath))
    const id = shortcutKey(home, ready.target.appId, ready.target.selection.profileId, ready.target.selection.dataMode)
    const recordPath = runtime.internalShortcutDockRecordPath
      ?? path.join(runtime.internalShortcutOutput?.registry ?? registryFor(os.homedir()), `${id}.json`)
    const paths = supervisorPaths(
      path.dirname(ready.target.configPath),
      ready.target.appId,
      ready.target.selection.profileId,
    )
    if (!await requestDockRefresh(paths.socket, ready.state.instanceToken, recordPath)) {
      throw new Error(
        'Host is ready, but its Dock icon was not updated; stop this owned profile and reopen the shortcut',
      )
    }
  }
  output(runtime, { ...display(ready.state), ...(shortcut ? { shortcut } : {}) }, invocation.options.json)
  return ready
}

export async function runSupervisorCommand(
  invocation: CordisXCliInvocation,
  runtime: CordisXCliRuntime,
  onState?: (ready: ReadyLaunchResult, phase: 'host-launched' | 'ready') => void | Promise<void>,
): Promise<ReadyLaunchResult | undefined> {
  if (!isManaged(invocation)) throw new Error('not a supervisor command')
  if (invocation.createShortcut) await preflightShortcut(invocation, runtime.cwd ?? process.cwd())
  const target = await selectionFor(invocation, runtime)
  const paths = supervisorPaths(path.dirname(target.configPath), target.appId, target.selection.profileId)
  const json = invocation.options.json
  const initialState = await readSupervisorStateResult(paths)
  if (initialState.status === 'invalid') throw new Error('CordisX supervisor state is invalid')
  if (initialState.status === 'unreadable') {
    throw new Error(`CordisX supervisor state is unreadable: ${failureMessage(initialState.error)}`)
  }
  let state = initialState.status === 'valid' ? initialState.state : undefined
  if (
    invocation.action === 'status'
    && state !== undefined
    && state.phase !== 'failed'
    && await processIdentityStatus(state.pid, state.processStartedAt) === 'dead'
  ) {
    state = {
      ...state,
      phase: 'failed',
      failure: 'CordisX background supervisor exited before renderer readiness',
      failedAt: new Date().toISOString(),
    }
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
  const release = await acquireSupervisorOperation(
    paths,
    readinessTimeout(runtime),
    invocation.recoverStartup === true,
  ).catch(error => {
    if (error instanceof LegacySupervisorLockError) throw error
    if (error instanceof SupervisorOperationBusyError) {
      throw new Error('timed out waiting for another CordisX startup operation')
    }
    throw error
  })
  let operationHeld = true
  const releaseOperation = async (): Promise<void> => {
    if (!operationHeld) return
    operationHeld = false
    await release()
  }
  try {
    state = await readMutableSupervisorState(paths)
    if (state !== undefined && state.phase !== 'failed') {
      const identity = await processIdentityStatus(state.pid, state.processStartedAt)
      if (identity === 'unknown') throw new Error('unable to verify the CordisX supervisor process identity')
      if (identity === 'dead') {
        await markSupervisorFailed(paths, state, 'CordisX background supervisor exited before renderer readiness')
        state = await readMutableSupervisorState(paths)
      }
    }
    if (invocation.action === 'stop' || invocation.action === 'restart') {
      if (state !== undefined) {
        // Ask a ready supervisor to close normally, then fence any remaining
        // launcher-owned helpers through the detached group.
        const requested = await requestSupervisorStop(paths.socket, state.instanceToken)
        if (requested ? !(await waitForOwnedShutdown(state)) : true) await terminateOwnedGroups(state)
      }
      await removeSupervisorState(paths)
      state = undefined
      if (invocation.action === 'stop') {
        output(runtime, { app: target.appId, profile: target.selection.profileId, status: 'stopped' }, json)
        return
      }
    }
    if (state?.phase === 'failed') {
      const identity = await processIdentityStatus(state.pid, state.processStartedAt)
      if (identity === 'unknown') throw new Error('unable to verify the failed CordisX supervisor process identity')
      const failedHost = await hostStatus(state)
      if (failedHost === 'unknown') throw new Error('unable to verify the failed CordisX Host process identity')
      if (identity === 'alive' || failedHost === 'alive') await terminateOwnedGroups(state)
      await removeSupervisorState(paths)
      state = undefined
    }
    if (state !== undefined) {
      if (state.version !== VERSION || state.effectiveConfig !== target.fingerprint) {
        throw new Error('CordisX instance version or effective configuration differs; run `cordisx restart` explicitly')
      }
      await releaseOperation()
      const ready = state.phase === 'ready'
        ? state
        : await waitForState(
          paths,
          readinessTimeout(runtime),
          current => onState?.({ state: current, target }, 'host-launched'),
        )
      if (ready === undefined) throw new Error('background supervisor exited before readiness')
      const result = { state: ready, target }
      await onState?.(result, 'ready')
      return await finishReady(invocation, runtime, result)
    }
    const log = await open(paths.log, 'a', 0o600)
    await chmod(paths.log, 0o600)
    const instanceToken = randomBytes(32).toString('hex')
    await writeFile(paths.bootstrapToken, instanceToken, { mode: 0o600 })
    const args = [fileURLToPath(new URL('../cli.js', import.meta.url)), ...childArgs(invocation)]
    const {
      CORDISX_DOCK_ENTRY: _untrustedDockEntry,
      CORDISX_DOCK_RECORD: _untrustedDockRecord,
      ...launchEnvironment
    } = target.environment
    const childEnvironment = {
      ...launchEnvironment,
      CORDISX_SUPERVISOR_HOME: path.dirname(target.configPath),
      CORDISX_SUPERVISOR_APP: target.appId,
      CORDISX_SUPERVISOR_PROFILE: target.selection.profileId,
      CORDISX_SUPERVISOR_DATA_MODE: target.selection.dataMode,
      CORDISX_SUPERVISOR_FINGERPRINT: target.fingerprint,
      // The path is not authority. The random token stays in a mode-0600
      // bootstrap file rather than appearing in the child environment.
      CORDISX_SUPERVISOR_TOKEN_FILE: paths.bootstrapToken,
    }
    if (invocation.createShortcut || runtime.internalShortcutDockRecordPath) {
      const home = await realpath(path.dirname(target.configPath))
      const id = shortcutKey(home, target.appId, target.selection.profileId, target.selection.dataMode)
      const recordPath = runtime.internalShortcutDockRecordPath
        ?? path.join(runtime.internalShortcutOutput?.registry ?? registryFor(os.homedir()), `${id}.json`)
      if (path.basename(recordPath) !== `${id}.json`) throw new Error('Dock record does not match launch profile')
      Object.assign(childEnvironment, { CORDISX_DOCK_ENTRY: id, CORDISX_DOCK_RECORD: recordPath })
    }
    const child = runtime.internalSpawnSupervisor === undefined
      ? spawn(process.execPath, args, {
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
        env: childEnvironment,
        cwd: runtime.internalShortcutSpawnCwd ?? runtime.cwd ?? process.cwd(),
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
    await releaseOperation()
    let ready: NonNullable<Awaited<ReturnType<typeof readSupervisorState>>>
    try {
      const observedReady = await waitForState(
        paths,
        readinessTimeout(runtime),
        current => onState?.({ state: current, target }, 'host-launched'),
      )
      if (observedReady === undefined) throw new Error('background supervisor exited before readiness')
      ready = observedReady
    } catch (error) {
      const observed = await readSupervisorState(paths)
      if (observed !== undefined && observed.instanceToken === instanceToken && observed.phase !== 'failed') {
        const requested = await requestSupervisorStop(paths.socket, observed.instanceToken)
        if (requested ? !(await waitForOwnedShutdown(observed)) : true) await terminateOwnedGroups(observed)
      }
      const releaseFailureOperation = await acquireSupervisorOperation(paths, readinessTimeout(runtime), false)
      try {
        const current = await readSupervisorState(paths)
        if (current !== undefined && current.phase !== 'failed' && current.instanceToken === instanceToken) {
          try {
            await stopSupervisorProcessGroup(current)
          } finally {
            await markSupervisorFailed(paths, current, failureMessage(error))
          }
        }
      } finally {
        await releaseFailureOperation()
      }
      throw error
    }
    const result = { state: ready, target }
    await onState?.(result, 'ready')
    return await finishReady(invocation, runtime, result)
  } finally {
    await releaseOperation()
  }
}

/** Keep the native Host hidden behind one truthful startup surface until the full launch contract is ready. */
export async function runSupervisorCommandWithStartupGate(
  invocation: CordisXCliInvocation,
  runtime: CordisXCliRuntime,
  onState?: (ready: ReadyLaunchResult, phase: 'host-launched' | 'ready') => void | Promise<void>,
): Promise<ReadyLaunchResult | undefined> {
  if (!isManaged(invocation) || (invocation.action !== 'start' && invocation.action !== 'restart')) {
    return await runSupervisorCommand(invocation, runtime, onState)
  }
  const openGate = runtime.internalOpenStartupGate === false
    ? undefined
    : runtime.internalOpenStartupGate
      ?? (runtime.internalSpawnSupervisor === undefined ? openNativeStartupGate : undefined)
  if (openGate === undefined) return await runSupervisorCommand(invocation, runtime, onState)
  const startedAt = performance.now()
  const gate = await openGate()
  const stderr = runtime.stderr ?? process.stderr
  stderr.write(`[cordisx] startup gate visible: ${Math.round(performance.now() - startedAt)} ms\n`)
  let current = invocation
  try {
    for (;;) {
      await gate.stage('正在检查运行配置')
      try {
        const ready = await runSupervisorCommand(current, runtime, async (state, phase) => {
          if (phase === 'host-launched') {
            if (!state.state.hostPid || !state.state.hostProcessStartedAt) {
              throw new Error('CordisX Host identity is unavailable before renderer readiness')
            }
            await gate.hostLaunched(state.state.hostPid, state.state.hostProcessStartedAt)
            await gate.stage('正在准备模型与界面')
          } else await gate.stage('正在完成启动')
          await onState?.(state, phase)
        })
        if (ready === undefined || !ready.state.hostPid || !ready.state.hostProcessStartedAt) {
          throw new Error('CordisX startup completed without a verified Host identity')
        }
        await gate.ready(ready.state.hostPid, ready.state.hostProcessStartedAt)
        stderr.write(`[cordisx] full application ready: ${Math.round(performance.now() - startedAt)} ms\n`)
        return ready
      } catch (error) {
        const action = await gate.failed(failureMessage(error))
        if (action === 'dismiss') throw error
        current = { ...current, recoverStartup: true }
      }
    }
  } finally {
    await gate.close()
  }
}
