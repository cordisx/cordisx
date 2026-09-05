import { describe, expect, it } from 'vitest'
import { waitForHostExitAfterReadiness } from '../packages/cli/src/cli/run.js'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(next => {
    resolve = next
  })
  return { promise, resolve }
}

describe('Host launch readiness', () => {
  it('treats a zero exit before an injected renderer as failure', async () => {
    const exit = deferred()
    const ready = deferred()
    const controller = new AbortController()
    const waiting = waitForHostExitAfterReadiness({
      childExit: exit.promise,
      ready: ready.promise,
      signal: controller.signal,
    })
    exit.resolve()
    await expect(waiting).rejects.toThrow('Host exited before CordisX CDP became ready')
  })

  it('allows a normal exit after the renderer is ready', async () => {
    const exit = deferred()
    const ready = deferred()
    const controller = new AbortController()
    const waiting = waitForHostExitAfterReadiness({
      childExit: exit.promise,
      ready: ready.promise,
      signal: controller.signal,
    })
    ready.resolve()
    await Promise.resolve()
    exit.resolve()
    await expect(waiting).resolves.toBeUndefined()
  })
})
