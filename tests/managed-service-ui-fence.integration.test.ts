import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'
import { describe, expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
} from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

function activation(revision: number, moduleGeneration: string) {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: revision === 1 ? 'active' as const : 'candidate' as const,
    ...(revision === 1 ? {} : { transactionId: `transaction-${revision}` }),
    profileId: 'work',
    revision,
    lastGoodRevision: revision === 1 ? 1 : revision - 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'fixture-provider',
      version: `${revision}.0.0`,
      digest: `sha256:${String(revision).repeat(64)}`,
      moduleGeneration,
      enabled: true,
      dependencies: [],
    }],
  }
}

function baseRuntime() {
  const mutations = new Map<string, PluginRuntimeMutation>()
  const observation = (transactionId: string, rollback: boolean) => {
    const mutation = mutations.get(transactionId)!
    return {
      transactionId,
      transactionEpoch: `${transactionId}:epoch`,
      registryEpoch: mutation.candidate.revision,
      active: rollback ? mutation.previous : mutation.candidate,
      disposedAfter: rollback ? mutation.candidate : mutation.previous,
    }
  }
  const base = {
    prepare: vi.fn((transactionId: string) => ({
      transactionEpoch: `${transactionId}:epoch`,
      expectedRegistryEpoch: 1,
    })),
    prepareBrowserGraph: vi.fn(async (transactionId: string) => ({
      transactionEpoch: `${transactionId}:epoch`,
      expectedRegistryEpoch: 1,
    })),
    stage: vi.fn(async (mutation: PluginRuntimeMutation) => {
      mutations.set(mutation.transactionId, mutation)
      return {
        transactionId: mutation.transactionId,
        transactionEpoch: `${mutation.transactionId}:epoch`,
        expectedRegistryEpoch: mutation.previous.revision,
        afterRegistryEpoch: mutation.candidate.revision,
        observation: mutation.candidate,
      }
    }),
    publish: vi.fn(async (transactionId: string) => observation(transactionId, false)),
    complete: vi.fn(async (transactionId: string) => observation(transactionId, false)),
    finalize: vi.fn(async () => {}),
    rollback: vi.fn(async (transactionId: string) => observation(transactionId, true)),
    recoverRollback: vi.fn(async (plan: Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]) => ({
      transactionId: plan.transactionId,
      transactionEpoch: plan.transactionEpoch,
      registryEpoch: plan.rollbackRegistryEpoch,
      active: plan.rollbackTarget,
      disposedAfter: plan.expectedPublished,
    })),
    adoptRecoveredActivation: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
  }
  return base
}

function fixture(
  options: { observeSources?: boolean; throwOnObserve?: boolean; throwOnStop?: boolean; invalidStop?: boolean } = {},
) {
  const base = baseRuntime()
  const listeners = new Map<string, Set<() => void>>()
  const snapshots = new Map<string, ReturnType<typeof vi.fn>>()
  let tokenIndex = 0
  const runtime = new ManagedServicePluginLifecycleRuntime({
    runtime: base as unknown as PluginLifecycleRuntime,
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    createToken: () => `owner-${++tokenIndex}-${'x'.repeat(48)}`,
    activate: async record => {
      const generation = record.plugins[0]!.moduleGeneration
      const binding = {
        bindingId: `binding-${generation}`,
        identity: {
          source: 'https://plugins.example/fixture-provider' as const,
          pluginId: 'fixture-provider',
          serviceId: 'gateway',
        },
        scope: { profileId: 'work', generation: 'runtime-1' },
      }
      const snapshot = vi.fn(async (): Promise<unknown> => ({ status: 'available', projection: { binding } }))
      snapshots.set(generation, snapshot)
      const source = {
        binding,
        snapshot,
        subscribe: vi.fn(),
        authenticate: vi.fn(),
      } as unknown as ManagedServiceSourceV1
      return {
        hostGeneration: 'runtime-1',
        authorities: [],
        sources: [{ pluginId: 'fixture-provider', pluginGeneration: generation, serviceId: 'gateway', source }],
        nativeProviderIds: [],
        subscribeNativeProviders: () => () => {},
        ...(options.observeSources === false ? {} : {
          subscribeSources: (listener: () => void) => {
            if (options.throwOnObserve) throw new Error('observer unavailable')
            const group = listeners.get(generation) ?? new Set<() => void>()
            group.add(listener)
            listeners.set(generation, group)
            if (options.invalidStop) return undefined
            return () => {
              if (options.throwOnStop) throw new Error('observer cleanup unavailable')
              group.delete(listener)
              if (group.size === 0) listeners.delete(generation)
            }
          },
        }),
        prepareNativeConnection: () => {
          throw new Error('not used')
        },
        dispose: async () => {},
      } as unknown as ManagedServiceNodeActivation
    },
  })
  return { runtime, base, snapshots, listeners }
}

async function initialize(runtime: ManagedServicePluginLifecycleRuntime) {
  const first = activation(1, 'old')
  const session = await runtime.initialize(first)
  await Promise.all([session.adopted, session.coreReady])
  await vi.waitFor(() => expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number)))
  return first
}

function mutation(previous: ReturnType<typeof activation>, candidate: ReturnType<typeof activation>) {
  return {
    transactionId: candidate.transactionId!,
    operation: 'update' as const,
    previous,
    candidate,
    targetId: 'fixture-provider',
    affectedPluginIds: ['fixture-provider'],
  }
}

function unrelatedMutation(previous: ReturnType<typeof activation>): PluginRuntimeMutation {
  const candidate = {
    ...previous,
    recordKind: 'candidate' as const,
    transactionId: 'unrelated',
    revision: 2,
    lastGoodRevision: 1,
    plugins: [...previous.plugins, {
      id: 'unrelated',
      version: '1.0.0',
      digest: 'sha256:' + 'a'.repeat(64),
      moduleGeneration: 'unrelated-1',
      enabled: false,
      dependencies: [],
    }],
  }
  return {
    transactionId: 'unrelated',
    operation: 'install',
    previous,
    candidate,
    targetId: 'unrelated',
    affectedPluginIds: ['unrelated'],
  } as unknown as PluginRuntimeMutation
}

function recoveryPlan(first: ReturnType<typeof activation>, transactionId: string) {
  return {
    transactionId,
    transactionEpoch: `${transactionId}:epoch`,
    rollbackRegistryEpoch: 1,
    rollbackTarget: first,
    expectedPublished: first,
  } as Parameters<NonNullable<PluginLifecycleRuntime['recoverRollback']>>[0]
}

describe('managed-service owner UI lifecycle fence', () => {
  it('does not expose provisional startup routes until progressive adoption finishes', async () => {
    let finish!: () => void
    const adoption = new Promise<void>(resolve => {
      finish = resolve
    })
    const runtime = new ManagedServicePluginLifecycleRuntime({
      runtime: baseRuntime() as unknown as PluginLifecycleRuntime,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      readStartupAdmissions: async () => [{
        pluginId: 'fixture-provider',
        pluginGeneration: 'old',
        source: 'https://plugins.example/fixture-provider',
        sourceRevision: `sha256:${'1'.repeat(64)}`,
        services: [],
        dependencies: [],
        startup: { contract: 'cordisx.startup-declaration/v1', capabilities: [], pages: [] },
      }],
      activate: async () => {
        await adoption
        return undefined
      },
    })
    const session = await runtime.initialize(activation(1, 'old'))
    expect(runtime.capabilities()).toHaveLength(1)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    const waiting = runtime.waitForInitialManagedServiceUI(new AbortController().signal)
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    const canceled = new AbortController()
    const canceledWait = runtime.waitForInitialManagedServiceUI(canceled.signal)
    canceled.abort()
    await expect(canceledWait).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(settled).toBe(false)
    finish()
    await Promise.all([session.adopted, session.coreReady])
    await waiting
    expect(settled).toBe(true)
    await vi.waitFor(() => expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number)))
    await runtime.dispose()
  })

  it('holds fences closed through prepare, stage, publication and confirmed rollback, including ABA', async () => {
    const { runtime, base } = fixture()
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    const first = await initialize(runtime)
    const initial = runtime.readManagedServiceUIFence()!
    const oldCapability = runtime.capabilities()[0]!
    const next = activation(2, 'next')
    runtime.prepare(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    const staged = runtime.stage(mutation(first, next))
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await staged
    await runtime.publish(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    const rollback = runtime.rollback(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await rollback
    expect(runtime.capabilities()[0]).toEqual(oldCapability)
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(initial)
    expect(base.prepare).toHaveBeenCalledOnce()
    await runtime.dispose()
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
  })

  it('proves continuity across a settled transaction that retains the same managed fleet', async () => {
    const { runtime, listeners } = fixture()
    const first = await initialize(runtime)
    const original = runtime.capabilities()
    const reservation = runtime.reserveManagedServiceUIContinuity()
    expect(listeners.get('old')?.size).toBe(2)
    runtime.prepare('unrelated')
    await runtime.stage(unrelatedMutation(first))
    await runtime.publish('unrelated')
    await runtime.complete('unrelated')
    await runtime.finalize('unrelated')
    const fence = runtime.readManagedServiceUIFence()
    expect(runtime.capabilities()).toEqual(original)
    expect(reservation.finish()).toBe(fence)
    expect(listeners.get('old')?.size).toBe(1)
    await runtime.dispose()
  })

  it('does not certify a managed route replacement followed by rollback to the same token', async () => {
    const { runtime, listeners } = fixture()
    const first = await initialize(runtime)
    const original = runtime.capabilities()
    const reservation = runtime.reserveManagedServiceUIContinuity()
    const next = activation(2, 'next')
    runtime.prepare(next.transactionId!)
    await runtime.stage(mutation(first, next))
    await runtime.publish(next.transactionId!)
    await runtime.rollback(next.transactionId!)
    expect(runtime.capabilities()).toEqual(original)
    expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number))
    expect(reservation.finish()).toBeUndefined()
    expect(listeners.get('old')?.size).toBe(1)
    await runtime.dispose()
  })

  it('closes the owner UI fence if a temporary continuity observer cannot be removed', async () => {
    const { runtime } = fixture({ throwOnStop: true })
    await initialize(runtime)
    const reservation = runtime.reserveManagedServiceUIContinuity()
    expect(reservation.cancel()).toBe(false)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.dispose()
  })

  it('drains existing Manager reads and resumes both pages after an unrelated transaction', async () => {
    const { runtime, snapshots } = fixture()
    const first = await initialize(runtime)
    const bridge = createManagerManagedServiceUIBridge({
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      readLifecycleFence: () => runtime.readManagedServiceUIFence(),
      runtime,
    })
    const a = {
      profileId: 'work',
      rendererId: '1'.repeat(64),
      ownerGeneration: 'owner-1',
      signal: new AbortController().signal,
    }
    const b = { ...a, rendererId: '2'.repeat(64), signal: new AbortController().signal }
    const third = { ...a, rendererId: '3'.repeat(64), signal: new AbortController().signal }
    try {
      const firstToken = bridge.projectInitial(a)[0]!.token
      const secondToken = bridge.projectInitial(b)[0]!.token
      const request = (token: string, operation: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({
          version: 1,
          token,
          requestId: 'request-1',
          operation,
          scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'old' },
          serviceId: 'gateway',
          ...extra,
        })
      const service = await bridge.channel.prepare(request(firstToken, 'get'), a).dispatch() as {
        value: { service: { binding: unknown } }
      }
      let finish!: (value: unknown) => void
      const snapshot = snapshots.get('old')!
      snapshot.mockImplementationOnce(async () => await new Promise(done => finish = done))
      const pending = bridge.channel.prepare(
        request(firstToken, 'snapshot', { binding: service.value.service.binding }),
        a,
      )
        .dispatch()
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce())
      const reserving = bridge.reserveTransition(2_000)
      expect(() => bridge.channel.prepare(request(secondToken, 'get'), b)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      expect(() => bridge.projectInitial(third)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      finish({ status: 'available', projection: { binding: service.value.service.binding } })
      await expect(pending).resolves.toMatchObject({ ok: true })
      const held = await reserving
      runtime.prepare('unrelated')
      await runtime.stage(unrelatedMutation(first))
      await runtime.publish('unrelated')
      await runtime.complete('unrelated')
      await runtime.finalize('unrelated')
      expect(held.resume()).toBe(true)
      expect(bridge.projectInitial(a)[0]!.token).toBe(firstToken)
      expect(bridge.projectInitial(b)[0]!.token).toBe(secondToken)
      await expect(bridge.channel.prepare(request(firstToken, 'get'), a).dispatch()).resolves.toMatchObject({
        ok: true,
      })
      await expect(bridge.channel.prepare(request(secondToken, 'get'), b).dispatch()).resolves.toMatchObject({
        ok: true,
      })
    } finally {
      bridge.dispose()
      await runtime.dispose()
    }
  })

  it('retires both Manager projections if the managed route changed and then rolled back', async () => {
    const { runtime } = fixture()
    const first = await initialize(runtime)
    const bridge = createManagerManagedServiceUIBridge({
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      readLifecycleFence: () => runtime.readManagedServiceUIFence(),
      runtime,
    })
    const a = {
      profileId: 'work',
      rendererId: '1'.repeat(64),
      ownerGeneration: 'owner-1',
      signal: new AbortController().signal,
    }
    const b = { ...a, rendererId: '2'.repeat(64), signal: new AbortController().signal }
    try {
      bridge.projectInitial(a)
      bridge.projectInitial(b)
      const held = await bridge.reserveTransition()
      const next = activation(2, 'next')
      runtime.prepare(next.transactionId!)
      await runtime.stage(mutation(first, next))
      await runtime.publish(next.transactionId!)
      await runtime.rollback(next.transactionId!)
      expect(held.resume()).toBe(false)
      expect(() => bridge.projectInitial(a)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      expect(() => bridge.projectInitial(b)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      await expect(bridge.waitForRetirement(a.rendererId)).resolves.toBe(true)
      await expect(bridge.waitForRetirement(b.rendererId)).resolves.toBe(true)
    } finally {
      bridge.dispose()
      await runtime.dispose()
    }
  })

  it('drops a real managed runtime read that spans publish and rollback to the same owner token', async () => {
    const { runtime, snapshots } = fixture()
    const first = await initialize(runtime)
    const firstFence = runtime.readManagedServiceUIFence()!
    const original = runtime.capabilities()[0]!
    const source = runtime.nativeActivation()
    expect(source).toBeDefined()
    const context = {
      profileId: 'work',
      rendererId: '1'.repeat(64),
      ownerGeneration: 'owner-1',
      signal: new AbortController().signal,
    }
    const bridge = createManagerManagedServiceUIBridge({
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      readLifecycleFence: () => runtime.readManagedServiceUIFence(),
      runtime,
    })
    const alias = bridge.projectInitial(context)[0]!.token
    const getRequest = JSON.stringify({
      version: 1,
      token: alias,
      requestId: 'get-1',
      operation: 'get',
      scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'old' },
      serviceId: 'gateway',
    })
    const service = await bridge.channel.prepare(getRequest, context).dispatch() as {
      value: { service: { binding: unknown } }
    }
    let resolve!: (value: unknown) => void
    const snapshot = snapshots.get('old')!
    snapshot.mockImplementationOnce(async () =>
      await new Promise(done => {
        resolve = done
      })
    )
    const request = JSON.stringify({
      ...JSON.parse(getRequest),
      requestId: 'snapshot-1',
      operation: 'snapshot',
      binding: service.value.service.binding,
    })
    const pending = bridge.channel.prepare(request, context).dispatch()
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce())
    const next = activation(2, 'next')
    await runtime.stage(mutation(first, next))
    await runtime.publish(next.transactionId!)
    await runtime.rollback(next.transactionId!)
    expect(runtime.capabilities()[0]).toEqual(original)
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(firstFence)
    resolve({ status: 'available', projection: { binding: service.value.service.binding } })
    await expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(() => bridge.channel.prepare(getRequest, context)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    bridge.dispose()
    await runtime.dispose()
  })

  it('keeps a failed rollback unavailable until a confirmed retry', async () => {
    const { runtime, base } = fixture()
    const first = await initialize(runtime)
    const initial = runtime.readManagedServiceUIFence()!
    const next = activation(2, 'next')
    await runtime.stage(mutation(first, next))
    await runtime.publish(next.transactionId!)
    base.rollback.mockRejectedValueOnce(new Error('cleanup uncertain'))
    await expect(runtime.rollback(next.transactionId!)).rejects.toThrow('cleanup uncertain')
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.rollback(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(initial)
    await runtime.dispose()
  })

  it('opens a new fence only after complete and finalize settle', async () => {
    const { runtime } = fixture()
    const first = await initialize(runtime)
    const initial = runtime.readManagedServiceUIFence()!
    const next = activation(2, 'next')
    await runtime.stage(mutation(first, next))
    await runtime.publish(next.transactionId!)
    await runtime.complete(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    const finalizing = runtime.finalize(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await finalizing
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(initial)
    expect(runtime.capabilities()[0]!.pluginGeneration).toBe('next')
    await runtime.dispose()
  })

  it('requires a successful abort after an uncertain preparation', async () => {
    const { runtime, base } = fixture()
    await initialize(runtime)
    const initial = runtime.readManagedServiceUIFence()!
    base.prepare.mockImplementationOnce(() => {
      throw new Error('uncertain preparation')
    })
    expect(() => runtime.prepare('prepare-failure')).toThrow('uncertain preparation')
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    base.abort.mockRejectedValueOnce(new Error('abort failed'))
    await expect(runtime.abort('prepare-failure')).rejects.toThrow('abort failed')
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.abort('prepare-failure')
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(initial)
    await runtime.dispose()
  })

  it('fences prepareBrowserGraph, successful abort, source changes and terminal loss', async () => {
    const { runtime, listeners } = fixture()
    const first = await initialize(runtime)
    const initial = runtime.readManagedServiceUIFence()!
    const prepared = runtime.prepareBrowserGraph('prepare-1', first)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await prepared
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    const abort = runtime.abort('prepare-1')
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await abort
    const afterAbort = runtime.readManagedServiceUIFence()!
    expect(afterAbort).toBeGreaterThan(initial)
    for (const listener of listeners.get('old') ?? []) listener()
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(afterAbort)
    runtime.terminal(new Error('renderer lost'))
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.dispose()
  })

  it('detects source replacement in an earlier synchronous listener before its own notification', async () => {
    const listeners = new Set<() => void>()
    const subscribeSources = (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
    const binding = {
      bindingId: 'binding-old',
      identity: {
        source: 'https://plugins.example/fixture-provider' as const,
        pluginId: 'fixture-provider',
        serviceId: 'gateway',
      },
      scope: { profileId: 'work', generation: 'runtime-1' },
    }
    const source = {
      binding,
      snapshot: vi.fn(),
      subscribe: vi.fn(),
      authenticate: vi.fn(),
    } as unknown as ManagedServiceSourceV1
    let sources = [{ pluginId: 'fixture-provider', pluginGeneration: 'old', serviceId: 'gateway', source }]
    let reentrantFence: number | undefined
    let runtime!: ManagedServicePluginLifecycleRuntime
    const group = {
      pluginIds: ['fixture-provider'],
      activeLoopbackPorts: [],
      exclusiveServiceKeys: [],
      hostGeneration: 'runtime-1',
      authorities: [],
      get sources() {
        return sources
      },
      nativeProviderIds: [],
      subscribeSources,
      subscribeNativeProviders: (listener: () => void) =>
        subscribeSources(() => {
          reentrantFence = runtime.readManagedServiceUIFence()
          listener()
        }),
      prepareNativeConnection: () => {
        throw new Error('not used')
      },
      dispose: async () => {},
    }
    runtime = new ManagedServicePluginLifecycleRuntime({
      runtime: baseRuntime() as unknown as PluginLifecycleRuntime,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      activate: async () => ({ ...group, groups: [group] }) as unknown as ManagedServiceNodeActivation,
    })
    await initialize(runtime)
    const first = runtime.readManagedServiceUIFence()!
    Object.defineProperty(source, 'snapshot', { value: vi.fn(), writable: true, configurable: true })
    const afterHandlerReplacement = runtime.readManagedServiceUIFence()!
    expect(afterHandlerReplacement).toBeGreaterThan(first)
    sources = []
    for (const listener of listeners) listener()
    expect(reentrantFence).toBeGreaterThan(afterHandlerReplacement)
    sources = [{ pluginId: 'fixture-provider', pluginGeneration: 'old', serviceId: 'gateway', source }]
    for (const listener of listeners) listener()
    let armed = true
    Object.defineProperty(source, 'binding', {
      get() {
        if (armed) {
          armed = false
          runtime.prepare('reentrant-prepare')
        }
        return binding
      },
    })
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.abort('reentrant-prepare')
    await runtime.dispose()
  })

  it('does not expose a fence when an active fleet cannot report source replacement', async () => {
    const { runtime } = fixture({ observeSources: false })
    const session = await runtime.initialize(activation(1, 'old'))
    await Promise.all([session.adopted, session.coreReady])
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.dispose()
  })

  it('keeps normal lifecycle usable when source observation or its cleanup fails', async () => {
    const failed = fixture({ throwOnObserve: true })
    const session = await failed.runtime.initialize(activation(1, 'old'))
    await Promise.all([session.adopted, session.coreReady])
    expect(failed.runtime.capabilities()).toHaveLength(1)
    expect(failed.runtime.readManagedServiceUIFence()).toBeUndefined()
    await failed.runtime.dispose()

    const missingStop = fixture({ invalidStop: true })
    const missingSession = await missingStop.runtime.initialize(activation(1, 'old'))
    await Promise.all([missingSession.adopted, missingSession.coreReady])
    expect(missingStop.runtime.readManagedServiceUIFence()).toBeUndefined()
    await missingStop.runtime.dispose()

    const cleanup = fixture({ throwOnStop: true })
    await initialize(cleanup.runtime)
    await expect(cleanup.runtime.dispose()).resolves.toBeUndefined()
    expect(cleanup.runtime.readManagedServiceUIFence()).toBeUndefined()
  })

  it('does not let a prior queued abort clear a later stage for the same transaction', async () => {
    const { runtime, base } = fixture()
    const first = await initialize(runtime)
    const next = activation(2, 'next')
    let release!: () => void
    base.abort.mockImplementationOnce(async () =>
      await new Promise<void>(resolve => {
        release = resolve
      })
    )
    const abort = runtime.abort(next.transactionId!)
    const staged = runtime.stage(mutation(first, next))
    await vi.waitFor(() => expect(base.abort).toHaveBeenCalledOnce())
    release()
    await abort
    await staged
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.rollback(next.transactionId!)
    expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number))
    await runtime.dispose()
  })

  it('does not let an abort certify an older prepare that finishes after it', async () => {
    const { runtime, base } = fixture()
    const first = await initialize(runtime)
    let release!: () => void
    base.prepareBrowserGraph.mockImplementationOnce(async transactionId => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      return { transactionEpoch: `${transactionId}:epoch`, expectedRegistryEpoch: 1 }
    })
    const preparing = runtime.prepareBrowserGraph('overlap', first)
    await vi.waitFor(() => expect(base.prepareBrowserGraph).toHaveBeenCalledOnce())
    await runtime.abort('overlap')
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    release()
    await preparing
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.abort('overlap')
    expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number))
    await runtime.dispose()
  })

  it('does not let a faster reload hide a failure in an older in-flight reload', async () => {
    const { runtime, base } = fixture()
    await initialize(runtime)
    let reject!: (error: Error) => void
    base.reload.mockImplementationOnce(async () =>
      await new Promise<void>((_resolve, fail) => {
        reject = fail
      })
    )
    const input = { pluginId: 'fixture-provider', moduleGeneration: 'old', runtimeGeneration: 'runtime-1' }
    const old = runtime.reload(input)
    const rejected = expect(old).rejects.toThrow('reload uncertain')
    await runtime.reload(input)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    reject(new Error('reload uncertain'))
    await rejected
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.reload(input)
    expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number))
    await runtime.dispose()
  })

  it('does not treat a failed recovered rollback as adopted', async () => {
    const { runtime, base } = fixture()
    const first = await initialize(runtime)
    const initial = runtime.readManagedServiceUIFence()!
    const plan = recoveryPlan(first, 'recovery-1')
    base.recoverRollback.mockRejectedValueOnce(new Error('recovery failed'))
    await expect(runtime.recoverRollback(plan)).rejects.toThrow('recovery failed')
    await runtime.adoptRecoveredActivation(first, 1)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.recoverRollback(plan)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.adoptRecoveredActivation(first, 1)
    expect(runtime.readManagedServiceUIFence()).toBeGreaterThan(initial)
    await runtime.dispose()
  })

  it('leaves recovered state fenced if the underlying optional adoption hook is absent', async () => {
    const { runtime, base } = fixture()
    const first = await initialize(runtime)
    Reflect.deleteProperty(base, 'adoptRecoveredActivation')
    const plan = recoveryPlan(first, 'recovery-without-adoption')
    await runtime.recoverRollback(plan)
    await expect(runtime.adoptRecoveredActivation(first, 1)).resolves.toBeUndefined()
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.dispose()
  })

  it('does not certify multiple recoveries or a mismatched adoption', async () => {
    const { runtime } = fixture()
    const first = await initialize(runtime)
    await runtime.recoverRollback(recoveryPlan(first, 'recovery-a'))
    await runtime.recoverRollback(recoveryPlan(first, 'recovery-b'))
    await runtime.adoptRecoveredActivation(first, 1)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.abort('recovery-a')
    await runtime.adoptRecoveredActivation(first, 2)
    expect(runtime.readManagedServiceUIFence()).toBeUndefined()
    await runtime.adoptRecoveredActivation(first, 1)
    expect(runtime.readManagedServiceUIFence()).toEqual(expect.any(Number))
    await runtime.dispose()
  })
})
