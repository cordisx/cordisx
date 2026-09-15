import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'
import { describe, expect, it, vi } from 'vitest'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type {
  PluginLifecycleRuntime,
  PluginRuntimeMutation,
  RuntimeCleanupObservation,
  RuntimePublicationObservation,
  RuntimeReadinessObservation,
} from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

function activation(revision: number, moduleGeneration: string): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    ...(revision === 1 ? {} : { transactionId: `transaction-${revision}` }),
    profileId: 'work',
    revision,
    lastGoodRevision: revision === 1 ? 1 : revision - 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'aiden',
      version: `${revision}.0.0`,
      digest: `sha256:${String(revision).repeat(64)}`,
      moduleGeneration,
      enabled: true,
      dependencies: [],
    }],
  }
}

function source(pluginGeneration: string, authState: 'authenticated' | 'missing'): ManagedServiceSourceV1 {
  const binding = {
    bindingId: `binding-${pluginGeneration}`,
    identity: {
      source: 'https://plugins.example/aiden' as const,
      pluginId: 'aiden',
      serviceId: 'gateway',
    },
    scope: { profileId: 'work', generation: 'runtime-1' },
  }
  return {
    binding,
    snapshot: vi.fn(async () => ({ status: 'available', projection: { binding, auth: { state: authState } } })),
    subscribe: vi.fn(),
    authenticate: vi.fn(),
    logout: vi.fn(),
  } as unknown as ManagedServiceSourceV1
}

function fleet(moduleGeneration: string, authState: 'authenticated' | 'missing') {
  const dispose = vi.fn(async () => {})
  const value = {
    hostGeneration: 'runtime-1',
    authorities: [],
    sources: [{
      pluginId: 'aiden',
      pluginGeneration: moduleGeneration,
      serviceId: 'gateway',
      source: source(moduleGeneration, authState),
    }],
    nativeProviderIds: [`provider-${moduleGeneration}`],
    prepareNativeConnection: vi.fn(() => {
      throw new Error('not used')
    }),
    dispose,
  } as unknown as ManagedServiceNodeActivation
  return { value, dispose }
}

class BaseRuntime implements PluginLifecycleRuntime {
  readonly mutations = new Map<string, PluginRuntimeMutation>()

  async stage(mutation: PluginRuntimeMutation): Promise<RuntimeReadinessObservation> {
    this.mutations.set(mutation.transactionId, mutation)
    return {
      transactionId: mutation.transactionId,
      transactionEpoch: `${mutation.transactionId}:epoch`,
      expectedRegistryEpoch: mutation.previous.revision,
      afterRegistryEpoch: mutation.candidate.revision,
      observation: mutation.candidate,
    }
  }

  async publish(transactionId: string): Promise<RuntimePublicationObservation> {
    const mutation = this.mutations.get(transactionId)!
    return {
      transactionId,
      transactionEpoch: `${transactionId}:epoch`,
      registryEpoch: mutation.candidate.revision,
      active: mutation.candidate,
    }
  }

  async complete(transactionId: string): Promise<RuntimeCleanupObservation> {
    const mutation = this.mutations.get(transactionId)!
    return {
      transactionId,
      transactionEpoch: `${transactionId}:epoch`,
      registryEpoch: mutation.candidate.revision,
      active: mutation.candidate,
      disposedAfter: mutation.previous,
    }
  }

  async finalize(transactionId: string): Promise<void> {
    this.mutations.delete(transactionId)
  }

  async rollback(transactionId: string): Promise<RuntimeCleanupObservation> {
    const mutation = this.mutations.get(transactionId)!
    this.mutations.delete(transactionId)
    return {
      transactionId,
      transactionEpoch: `${transactionId}:epoch`,
      registryEpoch: mutation.candidate.revision + 1,
      active: mutation.previous,
      disposedAfter: mutation.candidate,
    }
  }

  async commit(): Promise<void> {}
  async abort(transactionId: string): Promise<void> {
    this.mutations.delete(transactionId)
  }
  async reload(): Promise<void> {}
}

function request(token: string, pluginGeneration: string, operation: 'get' | 'snapshot', binding?: unknown): string {
  return JSON.stringify({
    version: 1,
    token,
    requestId: `${operation}-${pluginGeneration}`,
    operation,
    scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration },
    serviceId: 'gateway',
    ...(binding === undefined ? {} : { binding }),
  })
}

describe('managed service plugin lifecycle participant', () => {
  it('stages isolated owner tokens, publishes the candidate, retires old sources, and restores rollback', async () => {
    const base = new BaseRuntime()
    const activations = new Map<string, ReturnType<typeof fleet>>()
    const runtime = new ManagedServicePluginLifecycleRuntime({
      runtime: base,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      createToken: (() => {
        let index = 0
        return () => `token-${++index}-${'x'.repeat(32)}`
      })(),
      activate: async record => {
        const generation = record.plugins[0]!.moduleGeneration
        if (generation === 'aiden-activation-fail') throw new Error('token=private /private/runtime/path')
        const created = fleet(generation, record.revision === 2 ? 'authenticated' : 'missing')
        activations.set(generation, created)
        return created.value
      },
    })
    const first = activation(1, 'aiden-old')
    await runtime.initialize(first)
    const oldCapability = runtime.capabilities()[0]!
    expect(oldCapability.pluginGeneration).toBe('aiden-old')

    const second = activation(2, 'aiden-new')
    await runtime.stage({
      transactionId: second.transactionId!,
      operation: 'update',
      previous: first,
      candidate: second,
      targetId: 'aiden',
      affectedPluginIds: ['aiden'],
    })
    const candidateCapability = base.mutations.get(second.transactionId!)!.managedServiceUICapabilities?.[0]!
    expect(candidateCapability.pluginGeneration).toBe('aiden-new')
    expect(candidateCapability.token).not.toBe(oldCapability.token)
    expect(await runtime.managedServiceUI.handleBindingValue(request(oldCapability.token, 'aiden-old', 'get')))
      .toMatchObject({ ok: true })
    const candidateSource = activations.get('aiden-new')!.value.sources[0]!.source
    expect(
      await runtime.managedServiceUI.handleBindingValue(
        request(candidateCapability.token, 'aiden-new', 'snapshot', candidateSource.binding),
      ),
    ).toMatchObject({ ok: true, value: { projection: { auth: { state: 'authenticated' } } } })

    await runtime.publish(second.transactionId!)
    expect(runtime.nativeActivation().nativeProviderIds).toEqual(['provider-aiden-new'])
    await runtime.complete(second.transactionId!)
    await runtime.finalize(second.transactionId!)
    expect(activations.get('aiden-old')!.dispose).toHaveBeenCalledOnce()
    expect(await runtime.managedServiceUI.handleBindingValue(request(oldCapability.token, 'aiden-old', 'get')))
      .toMatchObject({ ok: false, code: 'owner-unavailable' })
    expect(await runtime.managedServiceUI.handleBindingValue(request(candidateCapability.token, 'aiden-new', 'get')))
      .toMatchObject({ ok: true })

    const third = activation(3, 'aiden-failing')
    await runtime.stage({
      transactionId: third.transactionId!,
      operation: 'update',
      previous: second,
      candidate: third,
      targetId: 'aiden',
      affectedPluginIds: ['aiden'],
    })
    const rollbackCapability = base.mutations.get(third.transactionId!)!.managedServiceUICapabilities?.[0]!
    await runtime.publish(third.transactionId!)
    expect(runtime.nativeActivation().nativeProviderIds).toEqual(['provider-aiden-failing'])
    const rollbackSource = activations.get('aiden-failing')!.value.sources[0]!.source
    expect(
      await runtime.managedServiceUI.handleBindingValue(
        request(rollbackCapability.token, 'aiden-failing', 'snapshot', rollbackSource.binding),
      ),
    ).toMatchObject({ ok: true, value: { projection: { auth: { state: 'missing' } } } })
    await runtime.rollback(third.transactionId!)
    expect(runtime.nativeActivation().nativeProviderIds).toEqual(['provider-aiden-new'])
    expect(activations.get('aiden-failing')!.dispose).toHaveBeenCalledOnce()
    expect(
      await runtime.managedServiceUI.handleBindingValue(
        request(rollbackCapability.token, 'aiden-failing', 'get'),
      ),
    ).toMatchObject({ ok: false, code: 'owner-unavailable' })
    expect(await runtime.managedServiceUI.handleBindingValue(request(candidateCapability.token, 'aiden-new', 'get')))
      .toMatchObject({ ok: true })

    const fourth = activation(4, 'aiden-activation-fail')
    await expect(runtime.stage({
      transactionId: fourth.transactionId!,
      operation: 'update',
      previous: second,
      candidate: fourth,
      targetId: 'aiden',
      affectedPluginIds: ['aiden'],
    })).rejects.toThrow('managed service candidate activation failed: token=[redacted] [path redacted]')
    expect(base.mutations.has(fourth.transactionId!)).toBe(true)
    await runtime.rollback(fourth.transactionId!)
    expect(runtime.nativeActivation().nativeProviderIds).toEqual(['provider-aiden-new'])
    await runtime.dispose()
  })
})
