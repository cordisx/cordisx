import { describe, expect, it } from 'vitest'
import { waitForHostExitAfterReadiness } from '../packages/cli/src/cli/run.js'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(next => { resolve = next })
  return { promise, resolve }
}

describe('Host launch readiness', () => {
  it('treats a zero exit before an injected renderer as failure', async () => {
    const exit = deferred()
    const ready = deferred()
    const controller = new AbortController()
    const waiting = waitForHostExitAfterReadiness({
      childExit: exit.promise, ready: ready.promise, signal: controller.signal, sharedHostProfile: true,
    })
    exit.resolve()
    await expect(waiting).rejects.toThrow('当前 Host 已运行且未启用 CordisX 调试；正常退出 Host 后重跑同一 shared 命令')
  })

  it('allows a normal exit after the renderer is ready', async () => {
    const exit = deferred()
    const ready = deferred()
    const controller = new AbortController()
    const waiting = waitForHostExitAfterReadiness({
      childExit: exit.promise, ready: ready.promise, signal: controller.signal, sharedHostProfile: true,
    })
    ready.resolve()
    await Promise.resolve()
    exit.resolve()
    await expect(waiting).resolves.toBeUndefined()
  })
})
