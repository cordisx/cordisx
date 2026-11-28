import { randomBytes } from 'node:crypto'
import { type ChildProcess, spawn } from 'node:child_process'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { managerRendererGatewayPaths } from './manager-renderer-gateway.js'
import { createManagerEntry, recoverManagerEntries, validateManagerEntry } from './manager-entry.js'
import { openManagerOwner, resolveManagerProfile } from './manager-owner.js'
import { startManagerWeb } from './manager-web.js'
import { loadManagerDeploymentConfig, type ManagerDeploymentConfig } from './manager-deployment-config.js'
import { startManagerPublicIngress } from './manager-public-ingress.js'
import {
  requestManagerEntry,
  requestManagerLink,
  requestSupervisorPing,
  requestSupervisorStop,
  startSupervisorControlServer,
} from './supervisor-control.js'
import {
  acquireSupervisorStartLock,
  effectiveConfigFingerprint,
  processIdentityStatus,
  processStartIdentity,
  readSupervisorState,
  readSupervisorStateResult,
  removeSupervisorState,
  removeSupervisorStateIfCurrent,
  type SupervisorPaths,
  supervisorPaths,
  type SupervisorState,
  writeSupervisorState,
} from './supervisor-state.js'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Attempt every startup cleanup and retain both the original and cleanup errors. */
async function rejectManagerStartup(error: unknown, actions: readonly (() => Promise<void>)[]): Promise<never> {
  const failures = [error]
  for (const action of actions) {
    try {
      await action()
    } catch (cleanupError) {
      failures.push(cleanupError)
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, 'MANAGER_STARTUP_CLEANUP_FAILED')
  throw error
}

/** The manager is only an RPC client and must not inherit model credentials. */
export function managerChildEnvironment(environment: NodeJS.ProcessEnv, key: string): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'PATH',
    'TMPDIR',
    'TMP',
    'TEMP',
    'USER',
    'USERNAME',
    'LOGNAME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'SYSTEMROOT',
    'SystemRoot',
    'WINDIR',
    'PATHEXT',
    'COMSPEC',
    'ComSpec',
    'APPDATA',
    'LOCALAPPDATA',
    'CORDISX_HOME',
  ]
  const result: NodeJS.ProcessEnv = { CORDISX_MANAGER_CHILD_KEY: key }
  for (const name of allowed) if (environment[name] !== undefined) result[name] = environment[name]
  return result
}

/** Never signal a reused PID or a child whose original start identity was not captured. */
export async function terminateCreatedManagerChild(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>,
  startedAt: string | undefined,
  identify: typeof processIdentityStatus = processIdentityStatus,
): Promise<boolean> {
  if (!child.pid || !startedAt || child.exitCode !== null || child.signalCode !== null) return false
  if (await identify(child.pid, startedAt) !== 'alive') return false
  return child.kill('SIGTERM')
}

async function lock(paths: SupervisorPaths): Promise<() => Promise<void>> {
  const deadline = Date.now() + 12_000
  for (;;) {
    try {
      return await acquireSupervisorStartLock(paths)
    } catch (error) {
      if ((error as { code?: string }).code !== 'SUPERVISOR_OPERATION_BUSY' || Date.now() >= deadline) throw error
      await wait(50)
    }
  }
}

async function managerPaths(profile?: string): Promise<{ paths: SupervisorPaths; profileId: string; homeDir: string }> {
  const { homeDir, profileId } = await resolveManagerProfile(profile)
  // The owner namespace is run/<app>/<profile>. Keep this sidecar outside it,
  // even if an existing or future adapter itself is named "manager".
  const paths = managerRendererGatewayPaths(homeDir, profileId)
  return {
    paths,
    profileId,
    homeDir,
  }
}

function fingerprint(
  owner: Awaited<ReturnType<typeof openManagerOwner>>,
  deployment?: ManagerDeploymentConfig,
): string {
  return effectiveConfigFingerprint({
    appId: owner.appId,
    generation: owner.generation,
    ...(deployment === undefined ? {} : { deployment: deployment.revision }),
  })
}

async function inspectActiveState(
  paths: SupervisorPaths,
): Promise<{ state: SupervisorState; reachable: boolean } | undefined> {
  const result = await readSupervisorStateResult(paths)
  if (result.status === 'missing') return undefined
  if (result.status !== 'valid') throw new Error('MANAGER_STATE_INVALID')
  const state = result.state
  const identity = await processIdentityStatus(state.pid, state.processStartedAt)
  if (identity === 'unknown') throw new Error('MANAGER_PROCESS_UNVERIFIABLE')
  if (identity === 'dead') return undefined
  return { state, reachable: await requestSupervisorPing(paths.socket, state.instanceToken) }
}

async function activeState(paths: SupervisorPaths): Promise<SupervisorState | undefined> {
  const active = await inspectActiveState(paths)
  if (active && !active.reachable) throw new Error('MANAGER_CONTROL_UNAVAILABLE')
  return active?.state
}

async function waitForManagerExit(state: SupervisorState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await processIdentityStatus(state.pid, state.processStartedAt) === 'dead') return true
    await wait(50)
  }
  return false
}

/** Start or reuse exactly one private manager for the currently selected profile owner. */
export async function ensureManager(
  profile?: string,
  deploymentFile?: string,
): Promise<{ paths: SupervisorPaths; state: SupervisorState }> {
  if (process.platform === 'win32') throw new Error('MANAGER_PRIVATE_ENTRY_UNSUPPORTED')
  const { paths, profileId, homeDir } = await managerPaths(profile)
  const deploymentPath = deploymentFile === undefined ? undefined : path.resolve(deploymentFile)
  let handoffs = 0
  for (;;) {
    const release = await lock(paths)
    let retiring: SupervisorState | undefined
    try {
      const owner = await openManagerOwner(profileId)
      const deployment = deploymentPath === undefined
        ? undefined
        : await loadManagerDeploymentConfig(deploymentPath, owner.managerConsoleOrigins?.length ?? 0)
      const ownerFingerprint = fingerprint(owner)
      const requestedFingerprint = fingerprint(owner, deployment)
      const service = await readSupervisorState(supervisorPaths(homeDir, owner.appId, profileId))
      const serviceOwner = service?.mode === 'service' && service.pid === owner.pid
        && service.processStartedAt === owner.processStartedAt
      if (serviceOwner) {
        if (service.phase === 'starting') throw new Error('MANAGER_OWNER_STARTING')
        if (service.webStatus === 'disabled') throw new Error('MANAGER_SERVICE_WEB_DISABLED')
        if (service.webStatus === 'unavailable') throw new Error('MANAGER_SERVICE_WEB_UNAVAILABLE')
      }
      const active = await inspectActiveState(paths)
      const existing = active?.state
      if (existing) {
        if (existing.phase !== 'ready') throw new Error('MANAGER_NOT_READY')
        if (
          existing.effectiveConfig === requestedFingerprint
          || deploymentPath === undefined && existing.managerOwnerFingerprint === ownerFingerprint
        ) {
          if (!active?.reachable) throw new Error('MANAGER_CONTROL_UNAVAILABLE')
          return { paths, state: existing }
        }
        if (
          existing.effectiveConfig === ownerFingerprint || existing.managerOwnerFingerprint === ownerFingerprint
        ) throw new Error('MANAGER_DEPLOYMENT_MISMATCH')
        if (
          handoffs !== 0 || existing.appId !== 'manager' || existing.profileId !== profileId
          || !await owner.isCurrent()
        ) throw new Error('MANAGER_OWNER_CHANGED')
        // The old sidecar's watchdog owns shutdown. Release the startup lock
        // before waiting so it can finish retiring sessions and remove state.
        retiring = existing
        handoffs++
      } else {
        if (serviceOwner && service.webStatus !== undefined) throw new Error('MANAGER_SERVICE_WEB_UNAVAILABLE')
        await removeSupervisorState(paths)
        await mkdir(path.dirname(paths.socket), { recursive: true, mode: 0o700 })
        await chmod(path.dirname(paths.socket), 0o700)
        const key = randomBytes(32).toString('hex')
        await writeFile(paths.bootstrapToken, key, { flag: 'wx', mode: 0o600 })
        await chmod(paths.bootstrapToken, 0o600)
        const entry = process.argv[1]
        if (!entry) throw new Error('MANAGER_ENTRY_UNAVAILABLE')
        const child = spawn(process.execPath, [
          ...process.execArgv,
          entry,
          'manager',
          '__serve',
          '--profile',
          profileId,
          ...(deploymentPath === undefined ? [] : ['--deployment', deploymentPath]),
        ], {
          detached: true,
          stdio: 'ignore',
          env: managerChildEnvironment(process.env, key),
          windowsHide: true,
        })
        let spawnFailed = false
        child.once('error', () => {
          spawnFailed = true
        })
        const childIdentity = child.pid ? await processStartIdentity(child.pid) : undefined
        child.unref()
        const deadline = Date.now() + 12_000
        while (Date.now() < deadline) {
          const state = await activeState(paths)
          if (state?.phase === 'ready' && state.pid === child.pid && state.effectiveConfig === requestedFingerprint) {
            return { paths, state }
          }
          if (spawnFailed || child.exitCode !== null || child.signalCode !== null) {
            throw new Error('MANAGER_START_FAILED')
          }
          await wait(50)
        }
        // Node's kill ultimately targets a PID: fence it against process reuse.
        await terminateCreatedManagerChild(child, childIdentity)
        throw new Error('MANAGER_START_TIMEOUT')
      }
    } finally {
      await release()
    }
    if (!retiring || !await waitForManagerExit(retiring, 10_000)) throw new Error('MANAGER_STOP_UNCONFIRMED')
  }
}

/** Start the Web gateway inside the service owner and retire it with that owner. */
export async function startServiceManager(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly appId: string
  readonly generation: string
  readonly environment: NodeJS.ProcessEnv
  readonly onUnavailable: () => void
}): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const paths = managerRendererGatewayPaths(input.homeDir, input.profileId)
  let handoffs = 0
  for (;;) {
    const release = await lock(paths)
    let retiring: SupervisorState | undefined
    try {
      const owner = await openManagerOwner(input.profileId, input.environment)
      if (owner.appId !== input.appId || owner.generation !== input.generation || !await owner.isCurrent()) {
        throw new Error('MANAGER_OWNER_CHANGED')
      }
      const deploymentFile = input.environment.CORDISX_WEB_DEPLOYMENT
      const deployment = deploymentFile === undefined
        ? undefined
        : await loadManagerDeploymentConfig(path.resolve(deploymentFile), owner.managerConsoleOrigins?.length ?? 0)
      const active = await inspectActiveState(paths)
      if (active) {
        if (active.state.managerOwnerFingerprint === fingerprint(owner) || handoffs !== 0) {
          throw new Error('MANAGER_ALREADY_RUNNING')
        }
        // An older gateway owns its own shutdown. Do not interrupt its process.
        retiring = active.state
        handoffs++
      } else {
        await removeSupervisorState(paths)
        await mkdir(path.dirname(paths.socket), { recursive: true, mode: 0o700 })
        await chmod(path.dirname(paths.socket), 0o700)
        const entryDirectory = path.join(paths.directory, 'entries')
        await recoverManagerEntries(entryDirectory)
        const startedAt = await processStartIdentity(process.pid)
        if (!startedAt) throw new Error('MANAGER_PROCESS_UNVERIFIABLE')
        const instanceToken = randomBytes(32).toString('hex')
        const web = await startManagerWeb(owner, {
          rendererGateway: { pid: process.pid, processStartedAt: startedAt, instanceToken },
          onUnavailable: input.onUnavailable,
          ...(deployment === undefined ? {} : { publicOrigin: deployment.publicOrigin }),
          ...(deployment?.publicConsoleOriginTemplates?.length
            ? { publicConsoleOriginTemplates: deployment.publicConsoleOriginTemplates }
            : {}),
        })
        const ingress = deployment === undefined ? undefined : await startManagerPublicIngress({
          manager: { publicOrigin: web.origin, localOrigin: web.localOrigin },
          ...(web.consoleMapping === undefined ? {} : { consoles: web.consoleMapping }),
          listeners: deployment.listeners,
          onUnavailable: input.onUnavailable,
        }).catch(async error => await rejectManagerStartup(error, [async () => await web.close()]))
        const control = await startSupervisorControlServer({
          socketPath: paths.socket,
          token: instanceToken,
          // The service owns this listener; the Manager command cannot stop it.
          stop: () => {},
          canStop: () => false,
          issueManagerLink: async () => {
            if (!await owner.isCurrent()) throw new Error('MANAGER_OWNER_CHANGED')
            return web.issueUrl()
          },
          issueManagerEntry: async () => {
            if (!await owner.isCurrent()) throw new Error('MANAGER_OWNER_CHANGED')
            return await createManagerEntry(entryDirectory, web)
          },
        }).catch(async error =>
          await rejectManagerStartup(error, [async () => await ingress?.close(), async () => await web.close()])
        )
        const state: SupervisorState = {
          schemaVersion: 1,
          appId: 'manager',
          profileId: input.profileId,
          phase: 'ready',
          pid: process.pid,
          processStartedAt: startedAt,
          instanceToken,
          createdAt: new Date().toISOString(),
          version: 'manager-v1',
          effectiveConfig: fingerprint(owner, deployment),
          managerOwnerFingerprint: fingerprint(owner),
          managerPublicOrigin: web.origin,
          managerOwnedByService: true,
        }
        await writeSupervisorState(paths, state).catch(async error =>
          await rejectManagerStartup(error, [
            async () => await ingress?.close(),
            async () => await web.close(),
            async () => await control.close(),
          ])
        )
        let closed = false
        return {
          origin: web.origin,
          async close() {
            if (closed) return
            closed = true
            const releaseClose = await lock(paths)
            const errors: unknown[] = []
            try {
              const current = await readSupervisorState(paths)
              const same = current?.instanceToken === instanceToken && current.pid === process.pid
              for (
                const close of [
                  async () => await ingress?.close(),
                  async () => await web.close(),
                  async () => await control.close({ preserveSocket: !same }),
                  async () => {
                    if (same) await removeSupervisorStateIfCurrent(paths, state)
                  },
                ]
              ) {
                try {
                  await close()
                } catch (error) {
                  errors.push(error)
                }
              }
            } finally {
              await releaseClose()
            }
            if (errors.length > 0) throw new AggregateError(errors, 'MANAGER_CLEANUP_FAILED')
          },
        }
      }
    } finally {
      await release()
    }
    if (!retiring || !await waitForManagerExit(retiring, 10_000)) throw new Error('MANAGER_STOP_UNCONFIRMED')
  }
}

/** The parent startup lock fences this entry; its short-lived key is private and single-use. */
export async function serveManager(profile: string, deploymentFile?: string): Promise<void> {
  const { paths, profileId } = await managerPaths(profile)
  const key = process.env.CORDISX_MANAGER_CHILD_KEY
  delete process.env.CORDISX_MANAGER_CHILD_KEY
  if (!key || !/^[a-f0-9]{64}$/u.test(key) || await readFile(paths.bootstrapToken, 'utf8') !== key) {
    throw new Error('MANAGER_CHILD_NOT_AUTHORIZED')
  }
  await rm(paths.bootstrapToken)
  const owner = await openManagerOwner(profileId)
  const deployment = deploymentFile === undefined
    ? undefined
    : await loadManagerDeploymentConfig(deploymentFile, owner.managerConsoleOrigins?.length ?? 0)
  const entryDirectory = path.join(paths.directory, 'entries')
  await recoverManagerEntries(entryDirectory)
  const startedAt = await processStartIdentity(process.pid)
  if (!startedAt) throw new Error('MANAGER_PROCESS_UNVERIFIABLE')
  const instanceToken = randomBytes(32).toString('hex')
  // The proof is only used after the supervisor's ready state and control
  // socket are published; it never crosses the browser HTTP boundary.
  const web = await startManagerWeb(owner, {
    rendererGateway: { pid: process.pid, processStartedAt: startedAt, instanceToken },
    ...(deployment === undefined ? {} : { publicOrigin: deployment.publicOrigin }),
    ...(deployment?.publicConsoleOriginTemplates?.length
      ? { publicConsoleOriginTemplates: deployment.publicConsoleOriginTemplates }
      : {}),
  })
  let finish!: () => void
  const stopped = new Promise<void>(resolve => {
    finish = resolve
  })
  const ingress = deployment === undefined ? undefined : await startManagerPublicIngress({
    manager: { publicOrigin: web.origin, localOrigin: web.localOrigin },
    ...(web.consoleMapping === undefined ? {} : { consoles: web.consoleMapping }),
    listeners: deployment.listeners,
    onUnavailable: finish,
  }).catch(async error => {
    return await rejectManagerStartup(error, [async () => await web.close()])
  })
  const state: SupervisorState = {
    schemaVersion: 1,
    appId: 'manager',
    profileId,
    phase: 'ready',
    pid: process.pid,
    processStartedAt: startedAt,
    instanceToken,
    createdAt: new Date().toISOString(),
    version: 'manager-v1',
    effectiveConfig: fingerprint(owner, deployment),
    managerOwnerFingerprint: fingerprint(owner),
    managerPublicOrigin: web.origin,
  }
  const control = await startSupervisorControlServer({
    socketPath: paths.socket,
    token: instanceToken,
    stop: finish,
    issueManagerLink: async () => {
      if (!await owner.isCurrent()) throw new Error('MANAGER_OWNER_CHANGED')
      return web.issueUrl()
    },
    issueManagerEntry: async () => {
      if (!await owner.isCurrent()) throw new Error('MANAGER_OWNER_CHANGED')
      return await createManagerEntry(entryDirectory, web)
    },
  }).catch(async error => {
    return await rejectManagerStartup(error, [
      async () => {
        await ingress?.close()
      },
      async () => await web.close(),
    ])
  })
  const onSignal = () => finish()
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const watchdog = setInterval(() => {
    void owner.isCurrent().then(current => {
      if (!current) finish()
    }).catch(finish)
  }, 5_000)
  try {
    await writeSupervisorState(paths, state)
    await stopped
  } finally {
    clearInterval(watchdog)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    try {
      await control.close()
    } finally {
      try {
        await ingress?.close()
      } finally {
        await web.close()
      }
    }
    const release = await lock(paths)
    try {
      const current = await readSupervisorState(paths)
      if (current?.pid === process.pid && current.instanceToken === instanceToken) await removeSupervisorState(paths)
    } finally {
      await release()
    }
  }
}

export async function managerStatus(profile?: string): Promise<{ status: 'running' | 'stopped'; profile: string }> {
  const { paths, profileId } = await managerPaths(profile)
  const state = await activeState(paths)
  return { status: state?.phase === 'ready' ? 'running' : 'stopped', profile: profileId }
}

export async function managerLink(profile?: string, deploymentFile?: string): Promise<string> {
  const { paths, state } = await ensureManager(profile, deploymentFile)
  const link = await requestManagerLink(paths.socket, state.instanceToken, state.managerPublicOrigin)
  if (!link) throw new Error('MANAGER_LINK_UNAVAILABLE')
  return link
}

/** Return a private HTML filename, whose content is retired on exchange or expiry. */
export async function managerEntry(profile?: string, deploymentFile?: string): Promise<string> {
  const { paths, state } = await ensureManager(profile, deploymentFile)
  const entry = await requestManagerEntry(paths.socket, state.instanceToken)
  if (!entry || !await validateManagerEntry(entry, path.join(paths.directory, 'entries'))) {
    throw new Error('MANAGER_ENTRY_UNAVAILABLE')
  }
  return entry
}

/** Stop only the authenticated manager control endpoint, never the profile owner process. */
export async function stopManager(profile?: string): Promise<boolean> {
  const { paths } = await managerPaths(profile)
  const release = await lock(paths)
  let state: SupervisorState | undefined
  try {
    state = await activeState(paths)
    if (!state) return false
    if (state.managerOwnedByService) throw new Error('MANAGER_SERVICE_OWNED')
    if (!await requestSupervisorStop(paths.socket, state.instanceToken)) throw new Error('MANAGER_STOP_UNCONFIRMED')
  } finally {
    await release()
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await processIdentityStatus(state.pid, state.processStartedAt) === 'dead') return true
    await wait(50)
  }
  throw new Error('MANAGER_STOP_UNCONFIRMED')
}
