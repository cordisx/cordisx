import { describe, expect, it, vi } from 'vitest'
import { progressiveLifecycleFixture } from './managed-service-progressive-lifecycle-fixture.js'

describe('uncooperative progressive preparation cleanup', () => {
  it('disposes after base adoption without waiting for an aborted prepare callback to return', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'pending', uncooperativePrepare: true }])
    let disposal: Promise<void> | undefined
    try {
      const session = await f.lifecycle.initialize(f.record())
      const prepareSignal = await f.prepareEntered.promise
      await session.coreReady
      await session.adopted
      expect(f.observations).toContain('apply:pending:gateway:one')
      expect(f.observations).not.toContain('prepare:pending:gateway:one')
      const stopped = vi.fn()
      disposal = f.lifecycle.dispose().then(stopped)
      expect(prepareSignal.aborted).toBe(true)
      await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce(), { timeout: 200, interval: 10 })
      expect(f.runtimes[0]!.listRegistrationIdentities()).toEqual([])
      expect(f.nodes[0]!.sources).toEqual([])
      expect(f.nodes[0]!.nativeProviderIds).toEqual([])
      f.release.resolve()
      await f.prepareReturned.promise
      await new Promise(resolve => setImmediate(resolve))
      expect(f.nodes[0]!.sources).toEqual([])
      expect(f.nodes[0]!.nativeProviderIds).toEqual([])
    } finally {
      f.release.resolve()
      await disposal
      await f.cleanup()
    }
  })
})
