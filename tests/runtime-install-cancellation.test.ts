import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installCordisX, installCordisXComposition } from '../packages/cli/src/renderer/runtime-install.js'
import { start } from '../packages/cli/src/renderer/runtime-start.js'
import type { CordisXRuntimeMetadata } from '../packages/cli/src/renderer/runtime-shared.js'

vi.mock('../packages/cli/src/renderer/runtime-start.js', () => ({ start: vi.fn(async () => ({ dispose: vi.fn() })) }))
vi.mock(
  '../packages/cli/src/renderer/react-runtime.js',
  () => ({ installSharedReactRuntime: vi.fn(() => ({ dispose: vi.fn() })) }),
)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('document', { documentElement: {}, head: {}, body: {} })
  vi.clearAllMocks()
})
afterEach(() => {
  globalThis.__cordisxBoot = undefined
  globalThis.__cordisxBootGeneration = undefined
  globalThis.__cordisxRequestedGeneration = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const metadata = { generation: 'fixture' } as CordisXRuntimeMetadata

describe('runtime startup cancellation', () => {
  it('does not start a queued runtime after cancellation', async () => {
    const controller = new AbortController()
    const pending = installCordisX([], metadata, undefined, controller.signal)
    const rejected = expect(pending).rejects.toThrow('canceled')
    controller.abort(Error('canceled'))
    await vi.runAllTimersAsync()
    await rejected
    expect(start).not.toHaveBeenCalled()
  })

  it('does not start or publish after a canceled plugin graph load completes', async () => {
    let resolve!: (value: []) => void
    const load = vi.fn(() =>
      new Promise<[]>(done => {
        resolve = done
      })
    )
    const publish = vi.fn()
    const retire = vi.fn()
    const controller = new AbortController()
    const pending = installCordisXComposition(load, metadata, publish, retire, undefined, controller.signal)
    const rejected = expect(pending).rejects.toThrow('canceled')
    await vi.runAllTimersAsync()
    expect(load).toHaveBeenCalledOnce()
    controller.abort(Error('canceled'))
    resolve([])
    await rejected
    expect(start).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(retire).toHaveBeenCalledOnce()
  })
})
