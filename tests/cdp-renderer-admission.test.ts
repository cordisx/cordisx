import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { admitBootstrappedRenderer } from '../packages/cli/src/launcher/cdp-renderer-admission.js'
import { CdpPluginLifecycleRuntime } from '../packages/cli/src/launcher/cdp-plugin-lifecycle-runtime.js'
import { CdpInstallationAbortedError, type CdpSession } from '../packages/cli/src/launcher/cdp-session.js'
import {
  CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  type CordisXPluginBundleManagerSnapshotV1,
} from '../packages/cli/src/plugin-bundle-contracts.js'

function deferred<Value = void>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => resolve = done)
  return { promise, resolve }
}

const snapshot: CordisXPluginBundleManagerSnapshotV1 = {
  $schema: CORDISX_PLUGIN_BUNDLE_MANAGER_SNAPSHOT_SCHEMA_V1,
  schemaVersion: 1,
  profileId: 'fixture',
  revision: 0,
  pluginRevision: 0,
  runtimeGeneration: 'fixture',
  operationsAvailable: true,
  bundles: [],
}

const steps = [
  'boot',
  'recovery',
  'recovered-projection',
  'bundle-snapshot',
  'bundle-projection',
  'development-status',
] as const

function admissionFixture(held: typeof steps[number]) {
  const entered = deferred()
  const release = deferred()
  const calls: string[] = []
  const operation = async (name: string): Promise<void> => {
    calls.push(name)
    if (name === held) {
      entered.resolve()
      await release.promise
    }
  }
  const joinAbort = vi.fn()
  const unregister = vi.fn()
  const commit = vi.fn(() => unregister)
  const session = {
    send: async () => {
      await operation('boot')
      return { result: { value: { ok: true } } }
    },
  } as unknown as CdpSession
  const generationRuntime = {
    beginJoin: vi.fn(() => ({ commit, abort: joinAbort })),
    synchronizeRecoveredActivation: async () => await operation('recovered-projection'),
    synchronizePluginBundlesFor: async () => await operation('bundle-projection'),
    synchronizeDevelopmentStatus: async () => {
      await operation('development-status')
      return 0
    },
  }
  const lifecycle = {
    coordinator: { recover: async () => await operation('recovery') },
    bundleCoordinator: {
      snapshot: async () => {
        await operation('bundle-snapshot')
        return snapshot
      },
    },
  }
  const connected = vi.fn(async () => undefined)
  const transport = { connected, disconnecting: vi.fn(async () => undefined) }
  return { session, generationRuntime, lifecycle, transport, entered, release, calls, joinAbort, commit, unregister }
}

describe('bootstrapped renderer installation lifetime', () => {
  it.each(steps)('rejects cancellation during %s and prevents late admission', async held => {
    const app = admissionFixture(held)
    const controller = new AbortController()
    const pending = admitBootstrappedRenderer({
      ...app,
      waitForRuntimeBoot: true,
      timeoutMs: 1_000,
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toBeInstanceOf(CdpInstallationAbortedError)
    await app.entered.promise
    controller.abort()
    await rejected
    expect(app.commit).not.toHaveBeenCalled()
    expect(app.joinAbort).toHaveBeenCalledTimes(held === 'boot' ? 0 : 1)
    const admittedSteps = [...app.calls]
    app.release.resolve()
    await nextTurn()
    expect(app.calls).toEqual(admittedSteps)
    expect(app.transport.connected).not.toHaveBeenCalled()
    expect(app.commit).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'stops concurrent cancellation and consumes a later operation failure (late failure %s)',
    async lateFailure => {
      const app = admissionFixture('recovery')
      const controller = new AbortController()
      app.lifecycle.coordinator.recover = async () => {
        controller.abort()
        if (lateFailure) {
          await nextTurn()
          throw new Error('late recovery failure')
        }
      }
      await expect(admitBootstrappedRenderer({
        ...app,
        waitForRuntimeBoot: false,
        timeoutMs: 1_000,
        signal: controller.signal,
      })).rejects.toBeInstanceOf(CdpInstallationAbortedError)
      await nextTurn()
      expect(app.calls).toEqual([])
      expect(app.joinAbort).toHaveBeenCalledOnce()
      expect(app.commit).not.toHaveBeenCalled()
    },
  )

  it('releases only the cancelled join while late recovery cannot remove a replacement join', async () => {
    const runtime = new CdpPluginLifecycleRuntime()
    const first = {} as CdpSession
    const replacement = {} as CdpSession
    const recovery = deferred()
    const entered = deferred()
    const controller = new AbortController()
    const pending = admitBootstrappedRenderer({
      session: first,
      generationRuntime: runtime,
      lifecycle: {
        coordinator: {
          recover: async () => {
            entered.resolve()
            await recovery.promise
          },
        },
      },
      waitForRuntimeBoot: false,
      timeoutMs: 1_000,
      signal: controller.signal,
    })
    const rejected = expect(pending).rejects.toBeInstanceOf(CdpInstallationAbortedError)
    await entered.promise
    controller.abort()
    await rejected
    const replacementJoin = runtime.beginJoin(replacement)
    recovery.resolve()
    await nextTurn()
    expect(() => runtime.beginJoin(first)).toThrow(
      'cannot join a CordisX renderer during a plugin generation transaction',
    )
    const unregisterReplacement = replacementJoin.commit(0)!
    expect(() => runtime.prepare('replacement')).not.toThrow()
    runtime.cancelPreparation('replacement')
    unregisterReplacement()
    expect(() => runtime.prepare('empty')).toThrow('no ready CordisX renderer is available')
  })

  it.each(['resolved', 'rejected'] as const)(
    'removes its registration and disconnects a late %s transport without disturbing another session',
    async outcome => {
      const runtime = new CdpPluginLifecycleRuntime()
      const first = {} as CdpSession
      const replacement = {} as CdpSession
      const connection = deferred()
      const entered = deferred()
      const connectedSessions = new Set<CdpSession>()
      const disconnecting = vi.fn(async (session: CdpSession) => {
        connectedSessions.delete(session)
      })
      const transport = {
        connected: async (session: CdpSession) => {
          entered.resolve()
          await connection.promise
          connectedSessions.add(session)
          if (outcome === 'rejected') throw new Error('late transport failure')
        },
        disconnecting,
      }
      const controller = new AbortController()
      const pending = admitBootstrappedRenderer({
        session: first,
        generationRuntime: runtime,
        transport,
        waitForRuntimeBoot: false,
        timeoutMs: 1_000,
        signal: controller.signal,
      })
      const rejected = expect(pending).rejects.toBeInstanceOf(CdpInstallationAbortedError)
      await entered.promise
      controller.abort()
      await rejected
      expect(() => runtime.prepare('cancelled')).toThrow('no ready CordisX renderer is available')
      // The installer disconnects immediately; an uncancellable connected may
      // install session-local state afterwards, requiring the second cleanup.
      await transport.disconnecting(first)
      const unregisterReplacement = runtime.register(replacement)
      connectedSessions.add(replacement)
      connection.resolve()
      await nextTurn()
      expect(disconnecting.mock.calls).toEqual([[first], [first]])
      expect(connectedSessions).toEqual(new Set([replacement]))
      expect(() => runtime.prepare('replacement')).not.toThrow()
      runtime.cancelPreparation('replacement')
      unregisterReplacement()
      expect(() => runtime.prepare('empty')).toThrow('no ready CordisX renderer is available')
    },
  )
})
