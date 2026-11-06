import type { CdpPluginLifecycleRuntime } from './cdp-plugin-lifecycle-runtime.js'
import type { PluginLifecycleBridgeHandler } from './plugin-lifecycle-rpc.js'
import type { StartupCdpTransport } from './startup-cdp-transport.js'
import { abortable, cdpInstallationAborted, type CdpSession, evaluateRuntimeOperation } from './cdp-session.js'

interface RendererAdmission {
  readonly session: CdpSession
  readonly waitForRuntimeBoot: boolean
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  readonly generationRuntime?: Pick<
    CdpPluginLifecycleRuntime,
    'beginJoin' | 'synchronizeRecoveredActivation' | 'synchronizePluginBundlesFor' | 'synchronizeDevelopmentStatus'
  >
  readonly lifecycle?: {
    readonly coordinator: Pick<PluginLifecycleBridgeHandler['coordinator'], 'recover'>
    readonly bundleCoordinator?: Pick<NonNullable<PluginLifecycleBridgeHandler['bundleCoordinator']>, 'snapshot'>
  }
  readonly transport?: StartupCdpTransport
}

/** Admit a bootstrapped document only within its installation lifetime. */
export async function admitBootstrappedRenderer(input: RendererAdmission): Promise<() => void> {
  const { session, generationRuntime, lifecycle, transport, signal } = input
  const assertActive = (): void => {
    if (signal?.aborted === true) throw cdpInstallationAborted()
  }
  const stage = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    assertActive()
    // Attach the abort race before calling code that could itself abort and
    // later reject. Keep a handler on that late operation even after failure.
    const pending = Promise.resolve().then(() => {
      assertActive()
      return operation()
    })
    const value = await abortable(pending, signal)
    assertActive()
    return value
  }
  let generationJoin: ReturnType<CdpPluginLifecycleRuntime['beginJoin']> | undefined
  let unregisterLifecycleSession = (): void => {}
  let connecting: Promise<void> | undefined
  let connectionSettled = false
  try {
    assertActive()
    if (input.waitForRuntimeBoot) {
      await stage(async () =>
        await evaluateRuntimeOperation(
          session,
          `(async () => { try {
        const boot = globalThis.__cordisxCompositionBoot ?? globalThis.__cordisxBoot
        if (boot === undefined) {
          throw new Error('CordisX renderer composition and runtime boot promises are undefined after injection')
        }
        await boot
        if (globalThis.__cordisxRuntime === undefined) {
          throw new Error('CordisX renderer runtime is undefined after boot')
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }
      } })()`,
          input.timeoutMs,
        )
      )
    }
    if (generationRuntime !== undefined) {
      assertActive()
      // Reserve the boot-ready document for recovery while prepare/register
      // remain fenced until all recovered/private projections are synchronized.
      generationJoin = generationRuntime.beginJoin(session)
      if (lifecycle !== undefined) {
        // Durable recovery may finish after cancellation; this document must
        // stop here instead of joining or advancing any later admission stage.
        await stage(async () => await lifecycle.coordinator.recover())
        await stage(async () => await generationRuntime.synchronizeRecoveredActivation(session))
        const bundleCoordinator = lifecycle.bundleCoordinator
        if (bundleCoordinator !== undefined) {
          const snapshot = await stage(async () => await bundleCoordinator.snapshot())
          await stage(async () => await generationRuntime.synchronizePluginBundlesFor(session, snapshot))
        }
      }
      while (true) {
        const developmentVersion = await stage(async () =>
          await generationRuntime.synchronizeDevelopmentStatus(session)
        )
        assertActive()
        const unregister = generationJoin.commit(developmentVersion)
        if (unregister === undefined) continue
        unregisterLifecycleSession = unregister
        generationJoin = undefined
        break
      }
    }
    if (transport !== undefined) {
      await stage(() => {
        connecting = transport.connected(session)
        void connecting.then(() => connectionSettled = true, () => connectionSettled = true)
        return connecting
      })
    }
    assertActive()
    return unregisterLifecycleSession
  } catch (error) {
    generationJoin?.abort()
    unregisterLifecycleSession()
    if (connecting !== undefined && !connectionSettled && transport !== undefined) {
      // The installer cleans up immediately. If connected cannot be cancelled,
      // remove its late session-local state again once that operation settles.
      void connecting.then(
        async () => await transport.disconnecting(session),
        async () => await transport.disconnecting(session),
      ).catch(() => undefined)
    }
    throw error
  }
}
