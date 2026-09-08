import { describe, expect, it, vi } from 'vitest'
import { PlatformProviderPluginLifecycleRuntime } from '../packages/cli/src/launcher/platform-provider-plugin-lifecycle.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
} from '../packages/cli/src/launcher/plugin-lifecycle-model.js'

function observation() {
  return {
    transactionId: 'transaction-1',
    transactionEpoch: 'epoch-1',
    expectedRegistryEpoch: 0,
    afterRegistryEpoch: 1,
    registryEpoch: 1,
    observation: { profileId: 'default', revision: 1, runtimeGeneration: 'runtime-1', plugins: [] },
    active: { profileId: 'default', revision: 1, runtimeGeneration: 'runtime-1', plugins: [] },
    disposedAfter: { profileId: 'default', revision: 0, runtimeGeneration: 'runtime-1', plugins: [] },
  } as never
}

function mutation(): PluginRuntimeMutation {
  return {
    transactionId: 'transaction-1',
    operation: 'enable',
    previous: { revision: 0, plugins: [] },
    candidate: { revision: 1, plugins: [{ id: 'provider-plugin', enabled: true }] },
    targetId: 'provider-plugin',
    affectedPluginIds: ['provider-plugin'],
  } as never
}

function runtime(overrides: Partial<PluginLifecycleRuntime> = {}) {
  return {
    stage: vi.fn(async () => observation()),
    publish: vi.fn(async () => observation()),
    complete: vi.fn(async () => observation()),
    finalize: vi.fn(async () => undefined),
    rollback: vi.fn(async () => observation()),
    commit: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    ...overrides,
  } as PluginLifecycleRuntime
}

describe('Platform provider plugin lifecycle participant', () => {
  it('prepares before renderer publish and finalizes only after durable completion', async () => {
    const order: string[] = []
    const base = runtime({
      publish: vi.fn(async () => {
        order.push('renderer-publish')
        return observation()
      }),
      finalize: vi.fn(async () => {
        order.push('renderer-finalize')
      }),
    })
    const participant = new PlatformProviderPluginLifecycleRuntime(base)
    participant.connect(async activation => {
      expect(activation.revision).toBe(1)
      order.push('provider-prepare')
      return {
        generation: 'provider-1',
        rollback: async () => order.push('provider-rollback'),
        finalize: async () => order.push('provider-finalize'),
      }
    })
    await participant.stage(mutation())
    await participant.publish('transaction-1')
    await participant.complete('transaction-1')
    await participant.finalize('transaction-1')
    expect(order).toEqual(['provider-prepare', 'renderer-publish', 'renderer-finalize', 'provider-finalize'])
  })

  it('rolls the prepared Fleet back when renderer publication fails', async () => {
    const providerRollback = vi.fn(async () => undefined)
    const base = runtime({
      publish: vi.fn(async () => {
        throw new Error('renderer publish failed')
      }),
    })
    const participant = new PlatformProviderPluginLifecycleRuntime(base)
    participant.connect(async () => ({
      generation: 'provider-1',
      rollback: providerRollback,
      finalize: async () => undefined,
    }))
    await participant.stage(mutation())
    await expect(participant.publish('transaction-1')).rejects.toThrow('renderer publish failed')
    await expect(participant.rollback('transaction-1')).resolves.toEqual(observation())
    expect(providerRollback).toHaveBeenCalledOnce()
    expect(base.rollback).toHaveBeenCalledWith('transaction-1')
  })

  it('settles provider finalize even when renderer finalize remains terminally failed', async () => {
    const providerFinalize = vi.fn(async () => undefined)
    const base = runtime({
      finalize: vi.fn(async () => {
        throw new Error('renderer finalize failed')
      }),
    })
    const participant = new PlatformProviderPluginLifecycleRuntime(base)
    participant.connect(async () => ({
      generation: 'provider-1',
      rollback: async () => undefined,
      finalize: providerFinalize,
    }))
    await participant.stage(mutation())
    await participant.publish('transaction-1')
    await expect(participant.finalize('transaction-1')).rejects.toThrow('participant finalize failed')
    await expect(participant.finalize('transaction-1')).rejects.toThrow('participant finalize failed')
    expect(base.finalize).toHaveBeenCalledTimes(2)
    expect(providerFinalize).toHaveBeenCalledOnce()
  })
})
