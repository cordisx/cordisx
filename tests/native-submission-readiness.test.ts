import { expect, it, vi } from 'vitest'
import { scheduleNativeSubmissionReadiness } from '../packages/cli/src/renderer/native-submission-readiness.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

it('does not block startup while a lazy native guard is pending, and installs only after it is ready', async () => {
  const ready = deferred<boolean>(), cleanup = vi.fn(), unavailable = vi.fn(() => vi.fn())
  const install = vi.fn(async () => cleanup)
  const dispose = scheduleNativeSubmissionReadiness({ ready: ready.promise, current: () => true, install, unavailable })
  await Promise.resolve()
  expect(install).not.toHaveBeenCalled()
  ready.resolve(true)
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
  await Promise.resolve()
  dispose()
  expect(cleanup).toHaveBeenCalledOnce()
  expect(unavailable).not.toHaveBeenCalled()
})

it('never installs into a retired document, and disposes an installation that finishes after retirement', async () => {
  const ready = deferred<boolean>(), installation = deferred<() => void>(), cleanup = vi.fn()
  const install = vi.fn(() => installation.promise)
  const dispose = scheduleNativeSubmissionReadiness({
    ready: ready.promise,
    current: () => true,
    install,
    unavailable: () => vi.fn(),
  })
  ready.resolve(true)
  await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
  dispose()
  installation.resolve(cleanup)
  await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce())
  const late = deferred<boolean>(), never = vi.fn(async () => vi.fn())
  const retire = scheduleNativeSubmissionReadiness({
    ready: late.promise,
    current: () => true,
    install: never,
    unavailable: () => vi.fn(),
  })
  retire()
  late.resolve(true)
  await Promise.resolve()
  expect(never).not.toHaveBeenCalled()
})

it('reports an unavailable or failed guard without installing a selector', async () => {
  const unavailable = vi.fn(() => vi.fn()), install = vi.fn(async () => vi.fn())
  const dispose = scheduleNativeSubmissionReadiness({
    ready: Promise.resolve(false),
    current: () => true,
    install,
    unavailable,
  })
  await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce())
  expect(install).not.toHaveBeenCalled()
  dispose()
})

it('reports a failed selector installation and cleans the notification on retirement', async () => {
  const cleanup = vi.fn(), unavailable = vi.fn(() => cleanup)
  const dispose = scheduleNativeSubmissionReadiness({
    ready: Promise.resolve(true),
    current: () => true,
    install: async () => {
      throw new Error('installation unavailable')
    },
    unavailable,
  })
  await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce())
  dispose()
  expect(cleanup).toHaveBeenCalledOnce()
})
