import { readFile, rm } from 'node:fs/promises'
import { startSupervisorControlServer, type SupervisorControlServer } from './supervisor-control.js'
import { readSupervisorState, supervisorPaths, writeSupervisorState } from './supervisor-state.js'

/** Binds a detached supervisor child to the normal foreground Host lifecycle. */
export async function createSupervisorRuntime(environment: NodeJS.ProcessEnv): Promise<{
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
  if (home !== undefined && app !== undefined && profile !== undefined && tokenFile !== undefined) {
    const token = (await readFile(tokenFile, 'utf8')).trim()
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error('invalid transient supervisor bootstrap token')
    await rm(tokenFile, { force: true })
    control = await startSupervisorControlServer({
      socketPath: supervisorPaths(home, app, profile).socket,
      token,
      stop: () => process.kill(process.pid, 'SIGTERM'),
    })
  }
  return {
    async markHostLaunched(pid): Promise<void> {
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return
      const current = await readSupervisorState(supervisorPaths(home, app, profile))
      if (current === undefined || current.pid !== process.pid || current.effectiveConfig !== fingerprint) return
      const { processStartIdentity } = await import('./supervisor-state.js')
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
      if (current === undefined || current.pid !== process.pid || current.effectiveConfig !== fingerprint) return
      await writeSupervisorState(supervisorPaths(home, app, profile), {
        ...current,
        phase: 'ready',
        cdpEndpoint: `http://127.0.0.1:${debugPort}`,
      })
    },
    async close(): Promise<void> {
      await control?.close().catch(() => undefined)
    },
  }
}
