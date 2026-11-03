import { describe, expect, it, vi } from 'vitest'
import {
  cleanupErrorAfterOwnedBrowserExit,
  ViteLoopbackPermissionRestoreError,
} from '../packages/cli/src/launcher/loopback-permissions.js'
import { settleInjectedHostCleanup } from '../packages/cli/src/cli/injected-host-cleanup.js'

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
} {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('injected Host cleanup', () => {
  it.each([true, false])(
    'reconciles only a permission restore failure after successful owned termination: %s',
    async terminated => {
      const permission = new Error('permission cleanup', {
        cause: new ViteLoopbackPermissionRestoreError([new Error('closed')], 'restore'),
      })
      const unrelated = new Error('renderer disposal failed')
      const result = await settleInjectedHostCleanup({
        beforeHostTermination: [Promise.reject(new AggregateError([permission, unrelated], 'cleanup'))],
        terminateHost: async () => {
          if (!terminated) throw new Error('still alive')
        },
        recoverAfterHostTermination: cleanupErrorAfterOwnedBrowserExit,
      })
      const first = result[0] as PromiseRejectedResult
      expect(first.status).toBe('rejected')
      expect(first.reason.errors).toEqual(terminated ? [unrelated] : [permission, unrelated])
    },
  )

  it('does not convert a permission restoration failure to success without a terminated Host', async () => {
    const error = new ViteLoopbackPermissionRestoreError([], 'restore')
    const result = await settleInjectedHostCleanup({
      beforeHostTermination: [Promise.reject(error)],
      recoverAfterHostTermination: cleanupErrorAfterOwnedBrowserExit,
    })
    expect(result).toEqual([{ status: 'rejected', reason: error }])
    const exited = await settleInjectedHostCleanup({
      beforeHostTermination: [Promise.reject(error)],
      terminateHost: async () => {},
      recoverAfterHostTermination: cleanupErrorAfterOwnedBrowserExit,
    })
    expect(exited.every(entry => entry.status === 'fulfilled')).toBe(true)
  })

  it('keeps the Host alive until renderer cleanup settles, then preserves failures from both phases', async () => {
    const renderer = deferred()
    const rendererFailure = new Error('renderer cleanup failed')
    const terminationFailure = new Error('Host termination failed')
    const terminateHost = vi.fn(async () => {
      throw terminationFailure
    })
    const cleanup = settleInjectedHostCleanup({
      beforeHostTermination: [renderer.promise],
      terminateHost,
    })

    await Promise.resolve()
    expect(terminateHost).not.toHaveBeenCalled()
    renderer.reject(rendererFailure)

    await expect(cleanup).resolves.toEqual([
      { status: 'rejected', reason: rendererFailure },
      { status: 'rejected', reason: terminationFailure },
    ])
    expect(terminateHost).toHaveBeenCalledOnce()
  })
})
