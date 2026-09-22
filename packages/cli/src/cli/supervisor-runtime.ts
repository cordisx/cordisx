import { appendFile, lstat, readFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { NativeAccountCapabilityDescriptor } from '../native-account-capability.js'
import { cdpInstallationAborted } from '../launcher/cdp-session.js'
import { readHostShortcutPresentation } from '../launcher/shortcut-presentation.js'
import {
  dockScope,
  type HostMainAgentController,
  installHostMainAgents,
  prepareDockImage,
  prepareOptionalDockImage,
  refreshDockAgent,
} from '../shortcuts/dock.js'
import { shortcutKey } from '../shortcuts/model.js'
import { startSupervisorControlServer, type SupervisorControlServer } from './supervisor-control.js'
import { logHostLifecycle } from './host-lifecycle.js'
import {
  acquireSupervisorStartLock,
  hasMatchingProcessIdentity,
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

/** The one-shot main inspector must be gone before a supervisor can publish ready. */
export async function publishReadyAfterInspectorClose(
  closeInspector: (() => Promise<void>) | undefined,
  publish: () => Promise<void>,
): Promise<void> {
  await closeInspector?.()
  await publish()
}

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
  readonly markReady: (
    debugPort: number,
    account?: NativeAccountCapabilityDescriptor,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly markHostLaunched: (pid: number, inspectorUrl?: Promise<string>, debugPort?: number) => Promise<boolean>
  readonly close: () => Promise<void>
  readonly mainInspector: boolean
}> {
  const home = environment.CORDISX_SUPERVISOR_HOME
  const app = environment.CORDISX_SUPERVISOR_APP
  const profile = environment.CORDISX_SUPERVISOR_PROFILE
  const dataMode = environment.CORDISX_SUPERVISOR_DATA_MODE
  if (dataMode !== undefined && dataMode !== 'shared' && dataMode !== 'host-isolated') {
    throw new Error('Invalid owned Host data mode')
  }
  const fingerprint = environment.CORDISX_SUPERVISOR_FINGERPRINT
  const tokenFile = environment.CORDISX_SUPERVISOR_TOKEN_FILE
  const selectedHome = home && app === 'codex' && profile && process.platform === 'darwin'
    ? await realpath(home)
    : undefined
  const selectedEntry = selectedHome && profile && dataMode
    ? shortcutKey(selectedHome, 'codex', profile, dataMode)
    : undefined
  const dockEntry = environment.CORDISX_DOCK_ENTRY
  const dockRecord = environment.CORDISX_DOCK_RECORD
  if (
    Boolean(dockEntry) !== Boolean(dockRecord)
    || (dockEntry && dockEntry !== selectedEntry) || (dockRecord && (!selectedEntry
      || path.basename(dockRecord) !== `${selectedEntry}.json` || !path.isAbsolute(dockRecord)))
  ) throw new Error('Dock entry identity does not match owned Host')
  const dock = selectedHome && selectedEntry && home && profile && dockEntry === selectedEntry && dockRecord
    ? dockScope(
      selectedEntry,
      dockRecord,
      supervisorPaths(home, 'codex', profile).directory,
    )
    : undefined
  let control: SupervisorControlServer | undefined
  let supervisorToken: string | undefined
  let releaseStartupOperation: (() => Promise<void>) | undefined
  let inspectorUrl: Promise<string> | undefined
  let mainAgents: HostMainAgentController | undefined
  let dockAgentInstalled = false
  let recoveryAttempt = 0
  const onStartupRecovery = async (waitingForUser: boolean): Promise<void> => {
    if (!home || !app || !profile) throw new Error('Missing startup recovery owner')
    const paths = supervisorPaths(home, app, profile)
    const current = await readSupervisorState(paths)
    if (
      !current || current.phase !== 'starting' || current.pid !== process.pid
      || current.instanceToken !== supervisorToken
      || !current.hostPid || !current.hostProcessStartedAt
      || !await hasMatchingProcessIdentity(current.hostPid, current.hostProcessStartedAt)
    ) {
      throw new Error('Startup recovery owner is no longer current')
    }
    if (!waitingForUser) recoveryAttempt++
    await writeSupervisorState(paths, {
      ...current,
      startupRecovery: { waitingForUser, attempt: recoveryAttempt, updatedAt: Date.now() },
    })
  }
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
        stop: () => {
          logHostLifecycle(line => process.stdout.write(`${line}\n`), { event: 'supervisor-stop-requested' })
          process.kill(process.pid, 'SIGTERM')
        },
        readPresentation: async () => {
          const paths = supervisorPaths(home, app, profile)
          const before = await readSupervisorState(paths)
          if (
            before?.pid !== process.pid || before.instanceToken !== token || before.phase !== 'ready'
            || !before.cdpEndpoint || !before.hostPid || !before.hostProcessStartedAt
            || !await hasMatchingProcessIdentity(before.hostPid, before.hostProcessStartedAt)
          ) return { status: 'unavailable' }
          const result = await readHostShortcutPresentation(before.cdpEndpoint)
          const after = await readSupervisorState(paths)
          return after?.instanceToken === token && after.phase === 'ready' && after.hostPid === before.hostPid
            ? result
            : { status: 'unavailable' }
        },
        ...(dock
          ? {
            refreshDock: async (requestedRecord?: string, signal?: AbortSignal) => {
              const paths = supervisorPaths(home, app, profile)
              let stage = 'owner'
              let refreshed = false
              try {
                const state = await readSupervisorState(paths)
                if (
                  state?.pid !== process.pid || state.instanceToken !== token || state.phase !== 'ready'
                  || !state.hostPid || !state.hostProcessStartedAt
                  || !await hasMatchingProcessIdentity(state.hostPid, state.hostProcessStartedAt)
                ) return false
                stage = 'agent-installed'
                if (!dockAgentInstalled) return false
                stage = 'record-identity'
                const recordPath = requestedRecord ?? dock.recordPath
                if (!path.isAbsolute(recordPath) || path.basename(recordPath) !== `${dock.entryId}.json`) return false
                stage = 'record-directory'
                const parent = await lstat(path.dirname(recordPath))
                if (
                  !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.()
                  || (parent.mode & 0o077) !== 0
                ) return false
                const currentDock = { ...dock, recordPath }
                stage = 'image-preparation'
                if (!await prepareDockImage(currentDock, { home: selectedHome!, app, profile }, signal)) return false
                signal?.throwIfAborted()
                stage = 'agent-refresh'
                await refreshDockAgent(dock, token)
                refreshed = true
                return true
              } catch {
                return false
              } finally {
                if (!refreshed) {
                  // Fixed phase names only: no record contents, tokens or image bytes.
                  await appendFile(paths.log, `[cordisx] Dock refresh failed at ${stage}\n`).catch(() => undefined)
                }
              }
            },
          }
          : {}),
      })
    } catch (error) {
      await releaseStartupOperation()
      releaseStartupOperation = undefined
      throw error
    }
  }
  return {
    mainInspector: selectedHome !== undefined,
    async markHostLaunched(pid, hostInspectorUrl, debugPort): Promise<boolean> {
      inspectorUrl = hostInspectorUrl
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return false
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
      if (inspectorUrl) {
        if (debugPort === undefined) throw new Error('Owned Host debug port missing')
        if (!supervisorToken) throw new Error('Owned Host main bootstrap missing')
        if (dock) await prepareOptionalDockImage(dock, { home: selectedHome!, app, profile })
        mainAgents = await installHostMainAgents({
          inspectorUrl: await inspectorUrl,
          hostPid: pid,
          debugPort,
          hostStartedAt: hostProcessStartedAt,
          readyStatePath: supervisorPaths(home, app, profile).state,
          readyInstanceToken: supervisorToken,
          onStartupRecovery,
          ...(dock ? { dock: { scope: dock, token: supervisorToken } } : {}),
        })
        dockAgentInstalled = dock !== undefined
      }
      return mainAgents !== undefined
    },
    async markReady(debugPort, account, signal): Promise<void> {
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return
      const current = await readSupervisorState(supervisorPaths(home, app, profile))
      if (
        current === undefined
        || current.pid !== process.pid
        || current.effectiveConfig !== fingerprint
        || current.instanceToken !== supervisorToken
        || control === undefined
      ) throw new Error('background supervisor generation is no longer current')
      if (inspectorUrl && !mainAgents) {
        if (!current.hostPid || !current.hostProcessStartedAt || !supervisorToken) {
          throw new Error('Owned Host main bootstrap missing')
        }
        if (dock) await prepareOptionalDockImage(dock, { home: selectedHome!, app, profile })
        mainAgents = await installHostMainAgents({
          inspectorUrl: await inspectorUrl,
          hostPid: current.hostPid,
          debugPort,
          hostStartedAt: current.hostProcessStartedAt,
          readyStatePath: supervisorPaths(home, app, profile).state,
          readyInstanceToken: supervisorToken,
          onStartupRecovery,
          ...(dock ? { dock: { scope: dock, token: supervisorToken } } : {}),
        })
        dockAgentInstalled = dock !== undefined
      }
      let startupSurface: 'workspace-ready' | 'authenticated-ready' | 'auth-required' | undefined
      await publishReadyAfterInspectorClose(
        mainAgents
          ? async () => {
            startupSurface = await mainAgents!.revealAndClose(account, signal)
          }
          : undefined,
        async () => {
          if (signal?.aborted) throw cdpInstallationAborted()
          await writeSupervisorState(supervisorPaths(home, app, profile), {
            ...current,
            phase: 'ready',
            ...(startupSurface === undefined ? {} : { startupSurface }),
            cdpEndpoint: `http://127.0.0.1:${debugPort}`,
          })
        },
      )
      mainAgents = undefined
      await releaseStartupOperation?.()
      releaseStartupOperation = undefined
    },
    async close(): Promise<void> {
      await mainAgents?.close().catch(() => undefined)
      await control?.close().catch(() => undefined)
      await releaseStartupOperation?.().catch(() => undefined)
      releaseStartupOperation = undefined
    },
  }
}
