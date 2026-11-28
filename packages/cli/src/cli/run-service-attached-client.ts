import { realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { codexHomeOfPlan, modelServiceLaunchHook } from '../launcher/model-service-projection.js'
import type { NativeSubmissionComposition } from '../launcher/native-submission-composition.js'
import { cleanupPrelaunch } from './injected-host-cleanup.js'
import { ensureClientService } from './client-service-owner.js'
import { nativeSubmissionCatalogOptions } from './native-submission-catalog-options.js'
import type { OwnerAdapterCdpClient } from './owner-adapter-cdp-client.js'
import { OwnerAdapterClient } from './owner-adapter-client.js'
import { createOwnerAdapterNativeSession } from './owner-adapter-native-session.js'
import { prepareProductionHostBootstrap, type ProductionHostBootstrap } from './production-host-bootstrap.js'
import { rendererAgentContext } from './renderer-agent-context.js'
import type { PreparedRunCommand } from './run-command-dispatch.js'
import type { OwnerReconnectionSession } from './run-injected-host.js'
import {
  agentHistoryHost,
  codexHome,
  type CordisXCliRuntime,
  printPlan,
  rootFromConfigPath,
  runInjectedHost,
} from './run-support.js'
import { createStartupLifetime } from './startup-lifetime.js'
import { createSupervisorRuntime } from './supervisor-runtime.js'

/** Shared authorities remain in the verified service process. */
export async function runServiceAttachedClient(
  prepared: PreparedRunCommand,
  runtime: CordisXCliRuntime,
): Promise<void> {
  const { invocation, stdout, environment, configPath, appId } = prepared
  if (appId !== 'codex' || invocation.options.attach || invocation.options.dryRun) {
    throw new Error('service-attached native client is unavailable')
  }
  const homeDir = rootFromConfigPath(configPath)
  const lifetime = createStartupLifetime(runtime.internalSignal)
  const supervisor = await createSupervisorRuntime(environment)
  const managedClient = environment.CORDISX_SUPERVISOR_CLIENT === '1'
  let bootstrap: ProductionHostBootstrap | undefined
  let submission: NativeSubmissionComposition | undefined
  let activeSession: OwnerReconnectionSession | undefined
  let currentOwner: OwnerAdapterClient | undefined
  let disconnected = Promise.resolve(false)
  let publishedFingerprint: string | undefined
  let stableFingerprint: string | undefined
  let handedOff = false
  let detachStartupOwner: (() => void) | undefined
  try {
    await ensureClientService(prepared, runtime)
    const { prepareRunCommand } = await import('./run-command-dispatch.js')
    const refreshed = await prepareRunCommand(invocation, runtime)
    if (
      !refreshed || refreshed.configPath !== configPath || refreshed.appId !== appId
      || refreshed.selection.profileId !== prepared.selection.profileId
      || refreshed.selection.dataMode !== prepared.selection.dataMode
    ) throw new Error('CordisX client selection changed while the service was starting')
    const selection = refreshed.selection
    const context = rendererAgentContext()
    const cwd = await realpath(runtime.cwd ?? process.cwd()).catch(() => path.resolve(runtime.cwd ?? process.cwd()))
    const launch = {
      options: invocation.options,
      hostArgs: invocation.hostArgs,
      dataMode: selection.dataMode,
      cwd,
      ...(environment.CODEX_HOME ? { codexHome: path.resolve(cwd, environment.CODEX_HOME) } : {}),
    }
    type Link = {
      readonly owner: OwnerAdapterClient
      readonly signal: AbortSignal
      participant?: OwnerAdapterCdpClient
      disconnect(): void
    }
    const openLink = async (): Promise<Link> => {
      const lost = new AbortController()
      let link: Link | undefined
      const disconnect = () => {
        link?.participant?.close()
        if (!lost.signal.aborted) lost.abort(new Error('CordisX service disconnected'))
        if (link && currentOwner === link.owner) {
          currentOwner = undefined
          submission?.suspendRemoteProvider?.()
          disconnected = supervisor.markClientDisconnected().catch(() => false)
        }
      }
      const owner = await OwnerAdapterClient.connect({
        homeDir,
        appId,
        profileId: selection.profileId,
        onLost: disconnect,
      })
      link = { owner, signal: lost.signal, disconnect }
      currentOwner = owner
      lost.signal.throwIfAborted()
      return link
    }
    const initial = await openLink()
    const startupOwner = new AbortController()
    const abortStartupOwner = () => startupOwner.abort(initial.signal.reason)
    initial.signal.addEventListener('abort', abortStartupOwner, { once: true })
    detachStartupOwner = () => initial.signal.removeEventListener('abort', abortStartupOwner)
    if (initial.signal.aborted) abortStartupOwner()
    const remoteTerminalProvider = {
      homeDir,
      profileId: selection.profileId,
      appIds: [appId],
      selectedAppId: appId,
      expectedOwner: initial.owner.ownerIdentity,
    }
    const clientRuntime: CordisXCliRuntime = { ...runtime, internalRemoteTerminalProvider: remoteTerminalProvider }
    bootstrap = await prepareProductionHostBootstrap(refreshed, clientRuntime, {
      prelaunch: false,
      prepareNativeSubmission: true,
      signal: AbortSignal.any([lifetime.signal, startupOwner.signal]),
      mainInspector: supervisor.mainInspector,
      markHostLaunched: async (pid, inspectorUrl, port) => await supervisor.markHostLaunched(pid, inspectorUrl, port),
    })
    if (!bootstrap.plan || bootstrap.debugPort === undefined) throw new Error('native client launch plan unavailable')
    const plan = bootstrap.plan
    const debugPort = bootstrap.debugPort
    const buildSession = async (link: Link, reconnecting: boolean) => {
      if (reconnecting && stableFingerprint === undefined) throw new Error('CordisX client launch intent unavailable')
      const session = await createOwnerAdapterNativeSession({
        owner: link.owner,
        ownerSignal: link.signal,
        prepared: refreshed,
        runtime,
        homeDir,
        launch,
        context,
        ...(reconnecting ? { requireStableFingerprint: stableFingerprint! } : {}),
        publishFingerprint: async (expected, next) => {
          const published = await supervisor.refreshClientFingerprint(expected, next)
          if (published && publishedFingerprint === expected) publishedFingerprint = next
          return published
        },
        onParticipant: participant => {
          link.participant = participant
        },
        onReady: async ({ owner, participant, fingerprint, intent, signal }) => {
          try {
            signal.throwIfAborted()
            if (!await owner.admit(async command => await participant.handle(command))) {
              throw new Error('CordisX service rejected the native client')
            }
            signal.throwIfAborted()
            if (reconnecting) {
              await submission?.reconnectRemoteProvider?.(owner.ownerIdentity)
              signal.throwIfAborted()
              if (
                managedClient && (!publishedFingerprint
                  || !await supervisor.markClientReconnected(publishedFingerprint, fingerprint, signal))
              ) {
                throw new Error('CordisX client generation changed during reconnection')
              }
            } else {
              await supervisor.markReady(debugPort, submission?.installation.accountCapability, signal, fingerprint)
            }
            publishedFingerprint = fingerprint
            await intent.markReady()
            signal.throwIfAborted()
          } catch (error) {
            if (reconnecting) link.disconnect()
            throw error
          }
        },
      })
      const close = session.close
      return {
        ...session,
        async close() {
          if (currentOwner === link.owner) {
            currentOwner = undefined
            submission?.suspendRemoteProvider?.()
          }
          await close()
        },
      }
    }
    const first = await buildSession(initial, false)
    activeSession = first
    stableFingerprint = first.stableFingerprint
    if (bootstrap.nativeSubmissionBootstrap) {
      const { managedCatalog: _managedCatalog, providerBindings: _providerBindings, ...catalog } =
        nativeSubmissionCatalogOptions(
          homeDir,
          selection.profileId,
          selection.profile,
          environment,
          plan.environment,
          undefined,
          first.home.environmentVariables,
          first.home.providers,
          invocation.options,
        )
      void _managedCatalog
      void _providerBindings
      submission = await bootstrap.nativeSubmissionBootstrap.complete(
        {
          nativeProviderIds: [],
          prepareNativeConnection() {
            throw new Error('native provider belongs to the CordisX service')
          },
        },
        codexHome({ ...environment, ...plan.environment }),
        {
          ...catalog,
          nativeClientScope: { homeDir, profileId: selection.profileId },
          ownerModelServicesRead: async () =>
            await currentOwner?.modelServicesRead()
              ?? { status: 'rejected' as const, code: 'unavailable' as const },
          remoteTerminalProvider,
          contextObserver: context.observer,
        },
      )
    }
    initial.signal.throwIfAborted()
    detachStartupOwner()
    detachStartupOwner = undefined
    lifetime.signal.throwIfAborted()
    printPlan(plan, stdout, 'launching')
    const history = (runtime.internalAgentHistoryHost ?? agentHistoryHost)(
      { ...environment, ...plan.environment },
      configPath,
      `${appId}:${selection.profileId}:${selection.dataMode}`,
    )
    const reconnectOwner = async (signal: AbortSignal): Promise<OwnerReconnectionSession> => {
      await activeSession?.close()
      activeSession = undefined
      if (managedClient && !await disconnected) throw new Error('CordisX client generation is unavailable')
      let reported = false
      while (!signal.aborted) {
        let link: Link | undefined
        try {
          await delay(1_000, undefined, { signal })
          const current = await prepareRunCommand(invocation, runtime)
          if (
            !current || current.configPath !== configPath || current.appId !== appId
            || current.selection.profileId !== selection.profileId || current.selection.dataMode !== selection.dataMode
          ) throw new Error('CordisX client selection changed while disconnected')
          link = await openLink()
          signal.throwIfAborted()
          const session = await buildSession(link, true)
          if (signal.aborted) {
            await session.close()
            signal.throwIfAborted()
          }
          activeSession = session
          return session
        } catch (error) {
          if (link) {
            link.disconnect()
            await link.owner.close().catch(() => undefined)
          }
          if (signal.aborted) throw error
          if (!reported) {
            stdout('[cordisx] waiting for the matching CordisX service to become available')
            reported = true
          }
        }
      }
      throw signal.reason
    }
    const input: Parameters<typeof runInjectedHost>[0] = {
      ...first.input,
      reconnectOwner,
      ...(submission === undefined ? {} : { nativeSubmission: submission.installation }),
      agentHistoryHost: history,
      executable: plan.executable,
      beforeHostLaunch: modelServiceLaunchHook(first.home, codexHomeOfPlan(plan), invocation.options, stdout),
      debugPort,
      hostArgs: invocation.hostArgs,
      launcher: invocation.options,
      signal: lifetime.signal,
      onHostLaunched: async (pid, inspectorUrl) => await supervisor.markHostLaunched(pid, inspectorUrl, debugPort),
      mainInspector: supervisor.mainInspector,
      ...(supervisor.startupNavigation === undefined ? {} : { startupNavigation: supervisor.startupNavigation }),
      ...(bootstrap.profile === undefined ? {} : { profile: bootstrap.profile }),
      ...(bootstrap.profileLease === undefined ? {} : { profileLease: bootstrap.profileLease }),
      environment: { ...submission?.environment },
      stdout,
    }
    handedOff = true
    await (runtime.internalRunInjectedHost ?? runInjectedHost)(input)
  } catch (error) {
    await supervisor.markFailed(error instanceof Error ? error.message : String(error)).catch(() => undefined)
    throw error
  } finally {
    detachStartupOwner?.()
    lifetime.abort()
    await activeSession?.close().catch(() => undefined)
    await currentOwner?.close().catch(() => undefined)
    await bootstrap?.nativeSubmissionBootstrap?.close().catch(() => undefined)
    if (!handedOff) await cleanupPrelaunch(undefined, bootstrap?.profile, bootstrap?.profileLease?.release)
    await submission?.close().catch(() => undefined)
    await supervisor.close()
    lifetime.close()
  }
}
