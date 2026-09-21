import { readFile, rm } from 'node:fs/promises'
import { startSupervisorControlServer, type SupervisorControlServer } from './supervisor-control.js'
import {
  acquireSupervisorStartLock,
  processStartIdentity,
  readSupervisorState,
  readSupervisorStateResult,
  SupervisorOperationBusyError,
  supervisorPaths,
  type SupervisorState,
  writeSupervisorState,
} from './supervisor-state.js'

const SUPERVISOR_PUBLICATION_TIMEOUT_MS = 5_000
const SUPERVISOR_PUBLICATION_RETRY_MS = 20

async function acquirePublishedSupervisor(input: {
  readonly home: string
  readonly app: string
  readonly profile: string
  readonly fingerprint: string
  readonly token: string
  readonly publicationTimeoutMs?: number
}): Promise<{ readonly state: SupervisorState; readonly release: () => Promise<void> }> {
  const startedAt = await processStartIdentity(process.pid)
  if (startedAt === undefined) throw new Error('background supervisor identity is unavailable')
  const paths = supervisorPaths(input.home, input.app, input.profile)
  const deadline = Date.now() + (input.publicationTimeoutMs ?? SUPERVISOR_PUBLICATION_TIMEOUT_MS)
  while (Date.now() < deadline) {
    let release
    try {
      release = await acquireSupervisorStartLock(paths)
    } catch (error) {
      if (!(error instanceof SupervisorOperationBusyError)) throw error
      await new Promise(resolve => setTimeout(resolve, SUPERVISOR_PUBLICATION_RETRY_MS))
      continue
    }
    try {
      const result = await readSupervisorStateResult(paths)
      if (result.status === 'invalid') throw new Error('background supervisor publication is invalid')
      if (result.status === 'unreadable') throw new Error('background supervisor publication is unreadable')
      if (
        result.status === 'valid'
        && !(
          result.state.pid !== process.pid
          || result.state.processStartedAt !== startedAt
          || result.state.appId !== input.app
          || result.state.profileId !== input.profile
          || result.state.effectiveConfig !== input.fingerprint
          || result.state.instanceToken !== input.token
        )
      ) return { state: result.state, release }
    } catch (error) {
      await release()
      throw error
    }
    await release()
    await new Promise(resolve => setTimeout(resolve, SUPERVISOR_PUBLICATION_RETRY_MS))
  }
  throw new Error('timed out waiting for background supervisor publication')
}

/** Binds a detached supervisor child to the normal foreground Host lifecycle. */
export async function createSupervisorRuntime(
  environment: NodeJS.ProcessEnv,
  options: { readonly publicationTimeoutMs?: number } = {},
): Promise<{
  readonly markReady: (debugPort: number) => Promise<void>
  readonly markHostLaunched: (pid: number) => Promise<void>
  readonly close: () => Promise<void>
}> {
  const home = environment.CORDISX_SUPERVISOR_HOME
  const app = environment.CORDISX_SUPERVISOR_APP
  const profile = environment.CORDISX_SUPERVISOR_PROFILE
  const fingerprint = environment.CORDISX_SUPERVISOR_FINGERPRINT
  const tokenFile = environment.CORDISX_SUPERVISOR_TOKEN_FILE
  let control: SupervisorControlServer | undefined
  let supervisorToken: string | undefined
  let releaseStartupOperation: (() => Promise<void>) | undefined
  if (home !== undefined && app !== undefined && profile !== undefined && tokenFile !== undefined) {
    if (fingerprint === undefined) throw new Error('missing background supervisor fingerprint')
    const token = (await readFile(tokenFile, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('invalid transient supervisor bootstrap token')
    const published = await acquirePublishedSupervisor({
      home,
      app,
      profile,
      fingerprint,
      token,
      ...(options.publicationTimeoutMs === undefined ? {} : { publicationTimeoutMs: options.publicationTimeoutMs }),
    })
    releaseStartupOperation = published.release
    try {
      await rm(tokenFile, { force: true })
      supervisorToken = token
      control = await startSupervisorControlServer({
        socketPath: supervisorPaths(home, app, profile).socket,
        token,
        stop: () => process.kill(process.pid, 'SIGTERM'),
      })
    } catch (error) {
      await releaseStartupOperation()
      releaseStartupOperation = undefined
      throw error
    }
  }
  return {
    async markHostLaunched(pid): Promise<void> {
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return
      const current = await readSupervisorState(supervisorPaths(home, app, profile))
      if (
        current === undefined
        || current.pid !== process.pid
        || current.effectiveConfig !== fingerprint
        || current.instanceToken !== supervisorToken
        || control === undefined
      ) throw new Error('background supervisor generation is no longer current')
      const hostProcessStartedAt = await processStartIdentity(pid)
      if (hostProcessStartedAt === undefined) throw new Error('launched Host exited before identity capture')
      await writeSupervisorState(supervisorPaths(home, app, profile), {
        ...current,
        hostPid: pid,
        hostProcessStartedAt,
      })
    },
    async markReady(debugPort): Promise<void> {
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return
      const current = await readSupervisorState(supervisorPaths(home, app, profile))
      if (
        current === undefined
        || current.pid !== process.pid
        || current.effectiveConfig !== fingerprint
        || current.instanceToken !== supervisorToken
        || control === undefined
      ) throw new Error('background supervisor generation is no longer current')
      await writeSupervisorState(supervisorPaths(home, app, profile), {
        ...current,
        phase: 'ready',
        cdpEndpoint: `http://127.0.0.1:${debugPort}`,
      })
      await releaseStartupOperation?.()
      releaseStartupOperation = undefined
    },
    async close(): Promise<void> {
      await control?.close().catch(() => undefined)
      await releaseStartupOperation?.().catch(() => undefined)
      releaseStartupOperation = undefined
    },
  }
}
