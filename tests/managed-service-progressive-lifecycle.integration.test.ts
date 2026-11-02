import { describe, expect, it, vi } from 'vitest'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { progressiveLifecycleFixture } from './managed-service-progressive-lifecycle-fixture.js'

function serviceRequest(token: string, pluginGeneration = 'one') {
  return JSON.stringify({
    version: 1,
    token,
    requestId: 'get',
    operation: 'get',
    serviceId: 'gateway',
    scope: { profileId: 'work', runtimeGeneration: 'runtime', pluginGeneration },
  })
}

describe('real progressive NodeHost and lifecycle adoption boundaries', () => {
  it('preserves v14 input and defaults, snapshots new configuration only for the atomic candidate generation', async () => {
    const configuration = { one: { root: './selected' }, two: { root: './candidate' } }
    const f = await progressiveLifecycleFixture([
      { pluginId: 'configured', configuration, slowPrepare: true },
      { pluginId: 'legacy', legacy: true, configuration },
      { pluginId: 'defaults' },
    ], true)
    try {
      const session = await f.lifecycle.initialize(f.record())
      await session.coreReady
      await session.adopted
      await vi.waitFor(() =>
        expect(f.configurations.some(item => item.phase === 'prepare' && item.pluginId === 'configured')).toBe(true)
      )
      const one = f.configurations.filter(item => item.pluginId === 'configured')
      expect(one).toHaveLength(2)
      expect(one[0]!.input).toBe(one[1]!.input)
      expect(one[0]!.input).toEqual({
        contract: 'cordisx.managed-service-instance-configuration/v1',
        value: { root: './selected' },
      })
      expect(session.authority.availability({ pluginId: 'configured', capabilityId: 'gateway' }).available).toBe(false)
      for (
        const item of f.configurations.filter(item =>
          ['legacy', 'defaults'].includes(item.pluginId) && item.phase === 'apply'
        )
      ) {
        expect(item.keys).toEqual(['client', 'owner', 'signal'])
        expect(item.input).toBeUndefined()
      }
      configuration.one.root = './mutated'
      const staging = f.lifecycle.stage(
        {
          transactionId: 'config-update',
          previous: f.record(),
          candidate: f.record(2),
          targetId: 'configured',
          operation: 'update',
          affectedPluginIds: ['configured'],
        } as PluginRuntimeMutation,
      )
      const stageFailure: unknown[] = []
      void staging.catch(error => {
        stageFailure.push(error)
      })
      await vi.waitFor(() => {
        expect(stageFailure).toEqual([])
        expect(f.observations).toContain('apply:configured:gateway:two')
      })
      configuration.two.root = './mutated-late'
      expect(f.stage).not.toHaveBeenCalled()
      expect(one[0]!.input).toMatchObject({ value: { root: './selected' } })
      f.releaseCandidate.resolve()
      await staging
      const two = f.configurations.filter(item => item.pluginId === 'configured' && item.generation === 'two')
      expect(two).toHaveLength(2)
      expect(two[0]!.input).toBe(two[1]!.input)
      expect(two[0]!.input).not.toBe(one[0]!.input)
      expect(two[0]!.input).toMatchObject({ value: { root: './candidate' } })
      await f.lifecycle.rollback('config-update')
      expect(f.runtimes[1]!.listRegistrationIdentities()).toEqual([])
      f.release.resolve()
      await expect(session.authority.wait({ pluginId: 'configured', capabilityId: 'gateway' })).resolves.toEqual({
        available: true,
      })
    } finally {
      await f.cleanup()
    }
  })

  it('publishes core and fast execution/source before independent slow apply; retains full transaction barrier', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'slow', slow: true }, { pluginId: 'fast' }], true)
    try {
      const session = await f.lifecycle.initialize(f.record())
      const tokens = f.lifecycle.capabilities()
      const all = vi.fn()
      void session.adopted.then(all)
      await session.coreReady
      await expect(session.authority.wait({ pluginId: 'fast', capabilityId: 'gateway' })).resolves.toEqual({
        available: true,
      })
      expect(all).not.toHaveBeenCalled()
      expect(f.observations).toContain('apply:slow:gateway:one')
      expect(f.observations).not.toContain('prepare:slow:gateway:one')
      const activation = f.lifecycle.nativeActivation()
      expect(activation.nativeProviderIds).toEqual(['fast-gateway'])
      const native = activation.prepareNativeConnection('fast-gateway')
      native.dispose()
      expect(f.nodes[0]!.sources.map(source => source.pluginId)).toEqual(['fast'])
      const fast = tokens.find(token => token.pluginId === 'fast')!
      expect(await f.lifecycle.managedServiceUI.handleBindingValue(serviceRequest(fast.token))).toMatchObject({
        ok: true,
      })
      const slow = tokens.find(token => token.pluginId === 'slow')!
      expect(await f.lifecycle.managedServiceUI.handleBindingValue(serviceRequest(slow.token))).toMatchObject({
        ok: false,
      })
      const changes = vi.fn()
      const stop = f.nodes[0]!.subscribeSources!(changes)
      const previous = f.record()
      const candidate = f.record(2)
      const mutation = {
        transactionId: 'update',
        previous,
        candidate,
        targetId: 'fast',
        operation: 'update',
        affectedPluginIds: ['fast', 'slow'],
      } as PluginRuntimeMutation
      const staging = f.lifecycle.stage(mutation)
      await new Promise(resolve => setImmediate(resolve))
      expect(f.stage).not.toHaveBeenCalled()
      f.release.resolve()
      await session.adopted
      expect(changes).toHaveBeenCalled()
      stop()
      await vi.waitFor(() => expect(f.observations).toContain('apply:slow:gateway:two'))
      expect(f.stage).not.toHaveBeenCalled()
      f.releaseCandidate.resolve()
      await staging
      expect(f.stage).toHaveBeenCalledOnce()
      await f.lifecycle.rollback('update')
      expect(f.lifecycle.capabilities()).toEqual(tokens)
      expect(await f.lifecycle.managedServiceUI.handleBindingValue(serviceRequest(slow.token))).toMatchObject({
        ok: true,
      })
      expect(f.runtimes[1]!.listRegistrationIdentities()).toEqual([])
      await f.lifecycle.dispose()
      expect(f.children.every(child => child.signals.includes('SIGTERM'))).toBe(true)
    } finally {
      await f.cleanup()
    }
  })

  it.each(['siblings', 'context'] as const)(
    'keeps %s in one atomic base adoption and cleanup component',
    async kind => {
      const f = await progressiveLifecycleFixture(
        kind === 'siblings'
          ? [{ pluginId: 'shared', serviceId: 'fast' }, { pluginId: 'shared', serviceId: 'slow', slow: true }]
          : [{ pluginId: 'producer', providesContext: true, slow: true }, {
            pluginId: 'consumer',
            consumesContext: true,
          }],
      )
      try {
        const session = await f.lifecycle.initialize(f.record())
        await session.coreReady
        await vi.waitFor(() => expect(f.observations.length).toBe(2))
        expect(f.nodes[0]!.groups).toHaveLength(1)
        expect(f.nodes[0]!.sources).toEqual([])
        expect(f.observations.some(item => item.startsWith('prepare:'))).toBe(false)
        f.release.resolve()
        await session.adopted
        expect(f.nodes[0]!.sources).toHaveLength(2)
        await f.lifecycle.dispose()
        expect(f.runtimes[0]!.listRegistrationIdentities()).toEqual([])
        if (kind === 'context') {
          expect(f.observations.filter(item => item === 'binding-disposed')).toHaveLength(1)
          expect(f.observations.filter(item => item === 'root-disposed')).toHaveLength(1)
        }
      } finally {
        await f.cleanup()
      }
    },
  )

  it('waits explicit capability dependencies across independent components', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'dependency', slow: true }, {
      pluginId: 'dependent',
      dependsOn: 'dependency',
    }])
    try {
      const session = await f.lifecycle.initialize(f.record())
      await session.coreReady
      await vi.waitFor(() => expect(f.nodes[0]!.sources.map(source => source.pluginId)).toEqual(['dependent']))
      expect(f.observations).not.toContain('prepare:dependent:gateway:one')
      const target = vi.fn()
      const waiting = session.authority.wait({ pluginId: 'dependent', capabilityId: 'gateway' }).then(result => {
        target(result)
      })
      await new Promise(resolve => setImmediate(resolve))
      expect(target).not.toHaveBeenCalled()
      f.release.resolve()
      await waiting
      expect(target).toHaveBeenCalledWith({ available: true })
      expect(f.observations.indexOf('prepare:dependent:gateway:one')).toBeGreaterThan(
        f.observations.indexOf('prepare:dependency:gateway:one'),
      )
    } finally {
      await f.cleanup()
    }
  })

  it('keeps legacy core blocking while an independent v15 target executes', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'legacy', legacy: true, slow: true }, {
      pluginId: 'fast',
    }])
    try {
      const session = await f.lifecycle.initialize(f.record())
      const core = vi.fn()
      void session.coreReady.then(core)
      await expect(session.authority.wait({ pluginId: 'fast', capabilityId: 'gateway' })).resolves.toEqual({
        available: true,
      })
      expect(core).not.toHaveBeenCalled()
      f.lifecycle.nativeActivation().prepareNativeConnection('fast-gateway').dispose()
      f.release.resolve()
      await session.coreReady
      expect(core).toHaveBeenCalledOnce()
    } finally {
      await f.cleanup()
    }
  })

  it('waits the v15 context dependency of a legacy component without waiting an unrelated v15 component', async () => {
    const f = await progressiveLifecycleFixture([
      { pluginId: 'dependency', providesContext: true, slow: true },
      { pluginId: 'legacy', legacy: true, consumesContext: true },
      { pluginId: 'fast' },
    ])
    try {
      const session = await f.lifecycle.initialize(f.record())
      const core = vi.fn()
      void session.coreReady.then(core)
      await expect(session.authority.wait({ pluginId: 'fast', capabilityId: 'gateway' })).resolves.toEqual({
        available: true,
      })
      expect(core).not.toHaveBeenCalled()
      expect(f.nodes[0]!.groups).toHaveLength(2)
      expect(f.nodes[0]!.sources.map(source => source.pluginId)).toEqual(['fast'])
      f.release.resolve()
      await session.coreReady
      expect(f.nodes[0]!.sources).toHaveLength(3)
    } finally {
      await f.cleanup()
    }
  })

  it('preserves awaited initialize for a legacy-only graph', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'legacy', legacy: true, slow: true }])
    try {
      const initialized = vi.fn()
      const pending = f.lifecycle.initialize(f.record()).then(session => {
        initialized()
        return session
      })
      await vi.waitFor(() => expect(f.observations).toContain('apply:legacy:gateway:one'))
      expect(initialized).not.toHaveBeenCalled()
      f.release.resolve()
      const session = await pending
      await session.coreReady
      await session.adopted
      expect(f.nodes[0]!.sources).toHaveLength(1)
    } finally {
      await f.cleanup()
    }
  })

  it('cancels pending base adoption, fences sources and retires the stable early token', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'slow', slow: true }, { pluginId: 'fast' }])
    try {
      const session = await f.lifecycle.initialize(f.record())
      const token = f.lifecycle.capabilities().find(cap => cap.pluginId === 'slow')!.token
      await session.coreReady
      await vi.waitFor(() => expect(f.observations).toContain('apply:slow:gateway:one'))
      const rejected = expect(session.adopted).rejects.toThrow('disposed')
      await f.lifecycle.dispose()
      await rejected
      expect(f.runtimes[0]!.listRegistrationIdentities()).toEqual([])
      expect(f.nodes[0]!.sources).toEqual([])
      expect(f.nodes[0]!.nativeProviderIds).toEqual([])
      expect(f.observations).not.toContain('prepare:slow:gateway:one')
      expect(await f.lifecycle.managedServiceUI.handleBindingValue(serviceRequest(token))).toMatchObject({ ok: false })
      expect(
        await f.lifecycle.managedServiceUI.handleBindingValue(
          JSON.stringify({
            version: 1,
            token,
            requestId: 'retired',
            operation: 'startupRead',
            scope: { profileId: 'work', runtimeGeneration: 'runtime', pluginGeneration: 'one' },
          }),
        ),
      ).toMatchObject({ ok: true, value: { status: 'startup-terminated', reason: 'host-replaced' } })
    } finally {
      await f.cleanup()
    }
  })

  it('retires a pending component without revoking the independent adopted component', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'slow', slow: true }, { pluginId: 'fast' }])
    try {
      const session = await f.lifecycle.initialize(f.record())
      await session.coreReady
      await expect(session.authority.wait({ pluginId: 'fast', capabilityId: 'gateway' })).resolves.toEqual({
        available: true,
      })
      await vi.waitFor(() => expect(f.observations).toContain('apply:slow:gateway:one'))
      const rejected = expect(session.adopted).rejects.toThrow('disposed')
      const slow = f.nodes[0]!.groups!.find(group => group.pluginIds.includes('slow'))!
      await slow.dispose()
      await rejected
      expect(slow.sources).toEqual([])
      expect(session.authority.availability({ pluginId: 'slow', capabilityId: 'gateway' })).toMatchObject({
        available: false,
        reason: 'revoked',
      })
      expect(f.nodes[0]!.sources.map(source => source.pluginId)).toEqual(['fast'])
      f.lifecycle.nativeActivation().prepareNativeConnection('fast-gateway').dispose()
      expect(f.observations).not.toContain('prepare:slow:gateway:one')
    } finally {
      await f.cleanup()
    }
  })

  it('cleans a context root returned after cancellation without applying its component', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'slow', providesContext: true, slowContext: true }, {
      pluginId: 'fast',
    }])
    try {
      const session = await f.lifecycle.initialize(f.record())
      await session.coreReady
      await vi.waitFor(() => expect(f.observations).toContain('context-entered'))
      const rejected = expect(session.adopted).rejects.toThrow('disposed')
      await f.lifecycle.dispose()
      await rejected
      expect(f.observations).not.toContain('apply:slow:gateway:one')
      expect(f.observations.filter(item => item === 'root-disposed')).toHaveLength(1)
      expect(f.runtimes[0]!.listRegistrationIdentities()).toEqual([])
    } finally {
      await f.cleanup()
    }
  })

  it('isolates a failed base component and still publishes the independent fast component', async () => {
    const f = await progressiveLifecycleFixture([{ pluginId: 'failed', fail: true }, { pluginId: 'fast' }])
    try {
      const session = await f.lifecycle.initialize(f.record())
      await session.adopted
      await expect(session.authority.wait({ pluginId: 'fast', capabilityId: 'gateway' })).resolves.toEqual({
        available: true,
      })
      expect(session.authority.availability({ pluginId: 'failed', capabilityId: 'gateway' })).toMatchObject({
        available: false,
        reason: 'failed',
      })
      expect(f.nodes[0]!.sources.map(source => source.pluginId)).toEqual(['fast'])
    } finally {
      await f.cleanup()
    }
  })
})
