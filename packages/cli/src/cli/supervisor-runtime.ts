import type { NativeManagedConsoleAdapter } from '../shortcuts/managed-console-agent.js'
import { bindDiagnostic, bindDiagnosticContext, diagnostic, diagnosticRef } from '../diagnostics/context.js'
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
import type { StartupNavigationHandoff } from '../shortcuts/startup-cover.js'
import { shortcutKey } from '../shortcuts/model.js'
import { startSupervisorControlServer, type SupervisorControlServer } from './supervisor-control.js'
import { logHostLifecycle } from './host-lifecycle.js'
import {
  acquireSupervisorStartLock,
  clientSupervisorPaths,
  hasMatchingProcessIdentity,
  processStartIdentity,
  readSupervisorState,
  readSupervisorStateResult,
  SupervisorOperationBusyError,
  supervisorPaths,
  type SupervisorState,
  updateSupervisorState,
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
  readonly client?: boolean
  readonly publicationTimeoutMs?: number
}): Promise<{ readonly state: SupervisorState; readonly release: () => Promise<void> }> {
  const startedAt = await processStartIdentity(process.pid)
  if (startedAt === undefined) throw new Error('background supervisor identity is unavailable')
  const paths = (input.client ? clientSupervisorPaths : supervisorPaths)(input.home, input.app, input.profile)
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
          || (result.state.clientOfService === true) !== (input.client === true)
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
  options: {
    readonly publicationTimeoutMs?: number
    readonly enableManagedConsole?: () => boolean
    /** Host-private seams for deterministic supervisor runtime tests. */
    readonly platform?: NodeJS.Platform
    readonly installMainAgents?: typeof installHostMainAgents
  } = {},
): Promise<{
  readonly markReady: (
    debugPort: number,
    account?: NativeAccountCapabilityDescriptor,
    signal?: AbortSignal,
  ) => Promise<void>
  readonly markServiceReady: (
    modelApiUrl: string,
    signal: AbortSignal,
    web?: { readonly status: 'ready' | 'unavailable' | 'disabled'; readonly origin?: string },
  ) => Promise<void>
  readonly markServiceWebUnavailable: () => Promise<void>
  readonly markClientDisconnected: () => Promise<boolean>
  readonly refreshClientFingerprint: (expected: string, next: string) => Promise<boolean>
  readonly markServiceCleanup: (
    outcome: { readonly ok: true } | { readonly ok: false; readonly failure: string },
  ) => Promise<boolean>
  readonly markHostLaunched: (pid: number, inspectorUrl?: Promise<string>, debugPort?: number) => Promise<boolean>
  /** Record why this generation is exiting while its published record is still current. */
  readonly markFailed: (failure: string) => Promise<void>
  readonly close: () => Promise<void>
  readonly mainInspector: boolean
  readonly managedConsole: () => NativeManagedConsoleAdapter | undefined
  readonly startupNavigation?: Promise<StartupNavigationHandoff | undefined>
}> {
  const emitDiagnostic = bindDiagnostic()
  const client = environment.CORDISX_SUPERVISOR_CLIENT === '1'
  if (environment.CORDISX_SUPERVISOR_CLIENT !== undefined && !client) {
    throw new Error('Invalid supervisor client role')
  }
  const selectedSupervisorPaths = client ? clientSupervisorPaths : supervisorPaths
  const home = environment.CORDISX_SUPERVISOR_HOME
  const app = environment.CORDISX_SUPERVISOR_APP
  const profile = environment.CORDISX_SUPERVISOR_PROFILE
  const dataMode = environment.CORDISX_SUPERVISOR_DATA_MODE
  if (dataMode !== undefined && dataMode !== 'shared' && dataMode !== 'host-isolated') {
    throw new Error('Invalid owned Host data mode')
  }
  const fingerprint = environment.CORDISX_SUPERVISOR_FINGERPRINT
  const tokenFile = environment.CORDISX_SUPERVISOR_TOKEN_FILE
  const selectedHome = home && app === 'codex' && profile && (options.platform ?? process.platform) === 'darwin'
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
      selectedSupervisorPaths(home, 'codex', profile).directory,
    )
    : undefined
  let control: SupervisorControlServer | undefined
  let supervisorToken: string | undefined
  let releaseStartupOperation: (() => Promise<void>) | undefined
  let inspectorUrl: Promise<string> | undefined
  let mainAgents: HostMainAgentController | undefined
  let managedConsole: NativeManagedConsoleAdapter | undefined
  let resolveStartupNavigation: ((handoff: StartupNavigationHandoff | undefined) => void) | undefined
  let rejectStartupNavigation: ((error: unknown) => void) | undefined
  const startupNavigation = selectedHome === undefined
    ? undefined
    : new Promise<StartupNavigationHandoff | undefined>((resolve, reject) => {
      resolveStartupNavigation = resolve
      rejectStartupNavigation = reject
    })
  void startupNavigation?.catch(() => undefined)
  const publishStartupNavigation = (
    handoff: StartupNavigationHandoff | undefined,
    hostPid: number,
  ): void => {
    if (resolveStartupNavigation === undefined) return
    resolveStartupNavigation(handoff)
    logHostLifecycle(
      line => process.stdout.write(`${line}\n`),
      { event: 'startup-handoff-resolved' },
      { hostPid },
      emitDiagnostic,
    )
    resolveStartupNavigation = undefined
    rejectStartupNavigation = undefined
  }
  let dockAgentInstalled = false
  let recoveryAttempt = 0
  const onStartupRecovery = async (waitingForUser: boolean): Promise<void> => {
    if (!home || !app || !profile) throw new Error('Missing startup recovery owner')
    const paths = selectedSupervisorPaths(home, app, profile)
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
    await updateSupervisorState(paths, current, latest =>
      latest.phase !== 'starting' ? undefined : ({
        ...latest,
        startupRecovery: { waitingForUser, attempt: recoveryAttempt, updatedAt: Date.now() },
      }))
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
      ...(client ? { client: true } : {}),
      ...(options.publicationTimeoutMs === undefined ? {} : { publicationTimeoutMs: options.publicationTimeoutMs }),
    })
    releaseStartupOperation = published.release
    try {
      await rm(tokenFile, { force: true })
      supervisorToken = token
      diagnostic({ event: 'supervisor-generation', supervisorGeneration: diagnosticRef(token) })
      control = await startSupervisorControlServer({
        socketPath: selectedSupervisorPaths(home, app, profile).socket,
        token,
        stop: () => {
          logHostLifecycle(
            line => process.stdout.write(`${line}\n`),
            { event: 'supervisor-stop-requested' },
            {},
            emitDiagnostic,
          )
          process.kill(process.pid, 'SIGTERM')
        },
        readPresentation: async () => {
          const paths = selectedSupervisorPaths(home, app, profile)
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
              const paths = selectedSupervisorPaths(home, app, profile)
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
  const runtime: Awaited<ReturnType<typeof createSupervisorRuntime>> = {
    mainInspector: selectedHome !== undefined,
    managedConsole: () => managedConsole,
    ...(startupNavigation === undefined ? {} : { startupNavigation }),
    async markHostLaunched(pid, hostInspectorUrl, debugPort): Promise<boolean> {
      inspectorUrl = hostInspectorUrl
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return false
      const current = await readSupervisorState(selectedSupervisorPaths(home, app, profile))
      if (
        current === undefined
        || current.pid !== process.pid
        || current.effectiveConfig !== fingerprint
        || current.instanceToken !== supervisorToken
        || control === undefined
      ) throw new Error('background supervisor generation is no longer current')
      const hostProcessStartedAt = await processStartIdentity(pid)
      if (hostProcessStartedAt === undefined) throw new Error('launched Host exited before identity capture')
      const published = await updateSupervisorState(
        selectedSupervisorPaths(home, app, profile),
        current,
        latest => latest.phase !== 'starting' ? undefined : ({ ...latest, hostPid: pid, hostProcessStartedAt }),
      )
      if (!published) throw new Error('background supervisor generation is no longer starting')
      if (inspectorUrl) {
        if (debugPort === undefined) throw new Error('Owned Host debug port missing')
        if (!supervisorToken) throw new Error('Owned Host main bootstrap missing')
        if (dock) await prepareOptionalDockImage(dock, { home: selectedHome!, app, profile })
        mainAgents = await (options.installMainAgents ?? installHostMainAgents)({
          inspectorUrl: await inspectorUrl,
          hostPid: pid,
          hostCwd: process.cwd(),
          debugPort,
          hostStartedAt: hostProcessStartedAt,
          readyStatePath: selectedSupervisorPaths(home, app, profile).state,
          readyInstanceToken: supervisorToken,
          onStartupRecovery,
          enableManagedConsole: options.enableManagedConsole?.() === true,
          ...(dock ? { dock: { scope: dock, token: supervisorToken } } : {}),
        })
        managedConsole = mainAgents.managedConsole
        publishStartupNavigation(mainAgents.startupNavigation, pid)
        dockAgentInstalled = dock !== undefined
      } else {
        publishStartupNavigation(undefined, pid)
      }
      return mainAgents !== undefined
    },
    async markReady(debugPort, account, signal): Promise<void> {
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return
      const current = await readSupervisorState(selectedSupervisorPaths(home, app, profile))
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
        mainAgents = await (options.installMainAgents ?? installHostMainAgents)({
          inspectorUrl: await inspectorUrl,
          hostPid: current.hostPid,
          hostCwd: process.cwd(),
          debugPort,
          hostStartedAt: current.hostProcessStartedAt,
          readyStatePath: selectedSupervisorPaths(home, app, profile).state,
          readyInstanceToken: supervisorToken,
          onStartupRecovery,
          enableManagedConsole: options.enableManagedConsole?.() === true,
          ...(dock ? { dock: { scope: dock, token: supervisorToken } } : {}),
        })
        managedConsole = mainAgents.managedConsole
        publishStartupNavigation(mainAgents.startupNavigation, current.hostPid)
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
          const published = await updateSupervisorState(
            selectedSupervisorPaths(home, app, profile),
            current,
            latest => {
              if (signal?.aborted || latest.phase !== 'starting') return undefined
              return {
                ...latest,
                phase: 'ready',
                ...(client ? { clientConnection: 'connected' as const } : {}),
                ...(startupSurface === undefined ? {} : { startupSurface }),
                cdpEndpoint: `http://127.0.0.1:${debugPort}`,
              }
            },
          )
          if (!published) throw new Error('background supervisor generation is no longer starting')
        },
      )
      mainAgents = undefined
      await releaseStartupOperation?.()
      releaseStartupOperation = undefined
    },
    async markServiceReady(modelApiUrl, signal, web) {
      if (!home || !app || !profile || !supervisorToken || !control) throw new Error('Missing service supervisor owner')
      const paths = selectedSupervisorPaths(home, app, profile)
      const owner = await readSupervisorState(paths)
      if (!owner || owner.pid !== process.pid || owner.instanceToken !== supervisorToken || owner.mode !== 'service') {
        throw new Error('Service supervisor generation is no longer current')
      }
      signal.throwIfAborted()
      if (
        !await updateSupervisorState(
          paths,
          owner,
          latest =>
            latest.phase === 'starting' && !signal.aborted
              ? {
                ...latest,
                phase: 'ready',
                modelApiUrl,
                serviceCleanup: 'pending',
                ...(web === undefined ? {} : { webStatus: web.status }),
                ...(web?.origin === undefined ? {} : { managerPublicOrigin: web.origin }),
              }
              : undefined,
        )
      ) throw new Error('Service supervisor is no longer starting')
      await releaseStartupOperation?.()
      releaseStartupOperation = undefined
    },
    async markServiceWebUnavailable() {
      if (!home || !app || !profile || !supervisorToken) return
      const paths = selectedSupervisorPaths(home, app, profile)
      const owner = await readSupervisorState(paths)
      if (!owner || owner.pid !== process.pid || owner.instanceToken !== supervisorToken) return
      await updateSupervisorState(paths, owner, latest => {
        if (latest.mode !== 'service' || latest.phase !== 'ready') return undefined
        const { managerPublicOrigin: _managerPublicOrigin, ...withoutOrigin } = latest
        return { ...withoutOrigin, webStatus: 'unavailable' }
      })
    },
    async markClientDisconnected() {
      if (!client || !home || !app || !profile || !supervisorToken) return false
      const paths = selectedSupervisorPaths(home, app, profile)
      const owner = await readSupervisorState(paths)
      if (!owner || owner.pid !== process.pid || owner.instanceToken !== supervisorToken) return false
      return await updateSupervisorState(paths, owner, latest =>
        latest.clientOfService && latest.phase === 'ready'
          ? { ...latest, clientConnection: 'disconnected' }
          : undefined)
    },
    async refreshClientFingerprint(expected, next) {
      if (
        !client || !home || !app || !profile || !supervisorToken
        || !/^[a-f0-9]{64}$/u.test(expected) || !/^[a-f0-9]{64}$/u.test(next)
      ) return false
      const paths = selectedSupervisorPaths(home, app, profile)
      const owner = await readSupervisorState(paths)
      if (!owner || owner.pid !== process.pid || owner.instanceToken !== supervisorToken) return false
      return await updateSupervisorState(
        paths,
        owner,
        latest =>
          latest.clientOfService && latest.phase === 'ready' && latest.clientConnection === 'connected'
            && latest.effectiveConfig === expected
            ? { ...latest, effectiveConfig: next }
            : undefined,
      )
    },
    async markServiceCleanup(outcome): Promise<boolean> {
      if (!home || !app || !profile || !supervisorToken) return false
      const paths = selectedSupervisorPaths(home, app, profile)
      const owner = await readSupervisorState(paths)
      if (
        !owner || owner.mode !== 'service' || owner.pid !== process.pid
        || owner.instanceToken !== supervisorToken || owner.effectiveConfig !== fingerprint
      ) return false
      return await updateSupervisorState(paths, owner, latest => {
        if (latest.mode !== 'service' || latest.serviceCleanup !== 'pending') return undefined
        const {
          modelApiUrl: _modelApiUrl,
          managerPublicOrigin: _managerPublicOrigin,
          webStatus: _webStatus,
          ...withoutEndpoint
        } = latest
        if (outcome.ok) {
          if (latest.phase !== 'ready') return undefined
          return { ...withoutEndpoint, phase: 'stopping', serviceCleanup: 'completed' }
        }
        if (latest.phase === 'failed') return { ...withoutEndpoint, serviceCleanup: 'failed' }
        return {
          ...withoutEndpoint,
          phase: 'failed',
          serviceCleanup: 'failed',
          failure: outcome.failure,
          failedAt: new Date().toISOString(),
        }
      })
    },
    async markFailed(failure): Promise<void> {
      if (home === undefined || app === undefined || profile === undefined || fingerprint === undefined) return
      const paths = selectedSupervisorPaths(home, app, profile)
      const current = await readSupervisorState(paths)
      if (
        current === undefined
        || current.pid !== process.pid
        || current.effectiveConfig !== fingerprint
        || current.instanceToken !== supervisorToken
        || current.phase === 'failed'
      ) return
      await updateSupervisorState(paths, current, latest => {
        if (latest.phase === 'stopping' || latest.phase === 'failed') return undefined
        const {
          cdpEndpoint: _cdpEndpoint,
          modelApiUrl: _modelApiUrl,
          managerPublicOrigin: _managerPublicOrigin,
          webStatus: _webStatus,
          ...withoutEndpoint
        } = latest
        return {
          ...withoutEndpoint,
          ...(latest.clientOfService ? { clientConnection: 'disconnected' as const } : {}),
          phase: 'failed',
          failure,
          failedAt: new Date().toISOString(),
        }
      })
    },
    async close(): Promise<void> {
      rejectStartupNavigation?.(new Error('Owned startup navigation closed before handoff'))
      resolveStartupNavigation = undefined
      rejectStartupNavigation = undefined
      await managedConsole?.dispose().catch(() => undefined)
      managedConsole = undefined
      await mainAgents?.close().catch(() => undefined)
      await control?.close().catch(() => undefined)
      await releaseStartupOperation?.().catch(() => undefined)
      releaseStartupOperation = undefined
    },
  }
  return {
    ...runtime,
    markHostLaunched: bindDiagnosticContext(runtime.markHostLaunched),
    markReady: bindDiagnosticContext(runtime.markReady),
  }
}
