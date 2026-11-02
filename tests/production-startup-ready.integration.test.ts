import { expect, it, vi } from 'vitest'
import { productionStartupReady } from '../packages/cli/src/cli/production-startup-ready.js'
import { startupTerminalRequests } from '../packages/cli/src/launcher/startup-provider-admission.js'
import { progressiveLifecycleFixture } from './managed-service-progressive-lifecycle-fixture.js'

it('production onReady publishes with slow v15 apply pending while caller waits only for its exact target', async () => {
  const f = await progressiveLifecycleFixture([{ pluginId: 'slow', slow: true }, { pluginId: 'fast' }], true)
  try {
    const session = await f.lifecycle.initialize(f.record())
    const applied = vi.fn(async () => {})
    const published = vi.fn(async () => {})
    const adopted = vi.fn()
    void session.adopted.then(adopted)
    await productionStartupReady(session, applied, published)()
    expect(applied).toHaveBeenCalledOnce()
    expect(published).toHaveBeenCalledOnce()
    expect(adopted).not.toHaveBeenCalled()
    const request = startupTerminalRequests(session.authority, () => undefined)
    expect(await request({ kind: 'wait', waiterId: 'ordinary' })).toEqual({ kind: 'ready' })
    expect(await request({ kind: 'wait', providerId: 'fast-gateway', model: 'model', waiterId: 'fast' }))
      .toEqual({ kind: 'ready' })
    const connection = f.lifecycle.nativeActivation().prepareNativeConnection('fast-gateway')
    connection.dispose()
    const slowDone = vi.fn()
    const slow = request({ kind: 'wait', providerId: 'slow-gateway', model: 'model', waiterId: 'slow' }).then(slowDone)
    await new Promise(resolve => setImmediate(resolve))
    expect(slowDone).not.toHaveBeenCalled()
    expect(adopted).not.toHaveBeenCalled()
    expect(published).toHaveBeenCalledOnce()
    f.release.resolve()
    await slow
    expect(slowDone).toHaveBeenCalledWith({ kind: 'ready' })
    await session.adopted
  } finally {
    await f.cleanup()
  }
})

it('production onReady retains the legacy component barrier in a mixed graph', async () => {
  const f = await progressiveLifecycleFixture(
    [{ pluginId: 'legacy', legacy: true, slow: true }, { pluginId: 'fast' }],
    true,
  )
  try {
    const session = await f.lifecycle.initialize(f.record())
    const applied = vi.fn(async () => {})
    const published = vi.fn(async () => {})
    const ready = productionStartupReady(session, applied, published)()
    await vi.waitFor(() => expect(f.observations).toContain('apply:legacy:gateway:one'))
    expect(applied).not.toHaveBeenCalled()
    expect(published).not.toHaveBeenCalled()
    f.release.resolve()
    await ready
    expect(applied).toHaveBeenCalledOnce()
    expect(published).toHaveBeenCalledOnce()
  } finally {
    await f.cleanup()
  }
})

it('cancels a production core waiter without publishing or cancelling shared adoption', async () => {
  const f = await progressiveLifecycleFixture(
    [{ pluginId: 'legacy', legacy: true, slow: true }, { pluginId: 'fast' }],
    true,
  )
  try {
    const session = await f.lifecycle.initialize(f.record())
    const applied = vi.fn(async () => {})
    const published = vi.fn(async () => {})
    const caller = new AbortController()
    const ready = productionStartupReady(session, applied, published)(caller.signal)
    const rejected = expect(ready).rejects.toThrow('aborted')
    caller.abort()
    await rejected
    expect(applied).not.toHaveBeenCalled()
    expect(published).not.toHaveBeenCalled()
    f.release.resolve()
    await session.adopted
    await productionStartupReady(session, applied, published)()
    expect(published).toHaveBeenCalledOnce()
  } finally {
    await f.cleanup()
  }
})
