import { describe, expect, it, vi } from 'vitest'
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
