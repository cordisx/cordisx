import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'
import { describe, expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'

describe('manager managed-service UI bridge with the real managed runtime', () => {
  it('connects the existing renderer registry to a real owner route while rejecting stateful calls', async () => {
    const ownerToken = `owner-token-${'x'.repeat(48)}`
    const binding = {
      bindingId: 'binding-1',
      identity: {
        source: 'https://plugins.example/sample-provider' as const,
        pluginId: 'sample-provider',
        serviceId: 'gateway',
      },
      scope: { profileId: 'work', generation: 'runtime-1' },
    }
    const snapshot = vi.fn(async () => ({
      status: 'available',
      projection: { binding, auth: { state: 'authenticated' } },
    }))
    const subscribe = vi.fn()
    const authenticate = vi.fn()
    const source = { binding, snapshot, subscribe, authenticate } as unknown as ManagedServiceSourceV1
    const fleet = {
      hostGeneration: 'runtime-1',
      authorities: [],
      sources: [{ pluginId: 'sample-provider', pluginGeneration: 'plugin-1', serviceId: 'gateway', source }],
      nativeProviderIds: [],
      subscribeNativeProviders: () => () => {},
      prepareNativeConnection: () => {
        throw new Error('not used')
      },
      dispose: vi.fn(async () => {}),
    } as unknown as ManagedServiceNodeActivation
    const runtime = new ManagedServicePluginLifecycleRuntime({
      runtime: {} as PluginLifecycleRuntime,
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      createToken: () => ownerToken,
      activate: async () => fleet,
    })
    await runtime.initialize({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'active',
      profileId: 'work',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: 'sample-provider',
        version: '1.0.0',
        digest: `sha256:${'1'.repeat(64)}`,
        moduleGeneration: 'plugin-1',
        enabled: true,
        dependencies: [],
      }],
    })
    const controller = new AbortController()
    const context = {
      profileId: 'work',
      rendererId: '1'.repeat(64),
      ownerGeneration: 'owner-1',
      signal: controller.signal,
    }
    const bridge = createManagerManagedServiceUIBridge({
      profileId: 'work',
      runtimeGeneration: 'runtime-1',
      ownerGeneration: 'owner-1',
      ownerCurrent: () => true,
      readLifecycleFence: () => 1,
      runtime,
    })
    const capabilities = bridge.projectInitial(context)
    const wire: string[] = []
    globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
      wire.push(payload)
      const requestId = (JSON.parse(payload) as { requestId: string }).requestId
      void Promise.resolve().then(async () => {
        try {
          const result = await bridge.channel.prepare(payload, context).dispatch()
          globalThis.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify(result))
        } catch {
          globalThis.__cordisxManagedServiceUIReceiveV1?.(
            JSON.stringify({ requestId, ok: false, code: 'owner-unavailable' }),
          )
        }
      })
    }
    const renderer = BrowserManagedServiceUIBridge.connect(capabilities, 'work', 'runtime-1')
    try {
      const registry = renderer.bind({ pluginId: 'sample-provider', pluginGeneration: 'plugin-1' })!
      const service = await registry.get({ serviceId: 'gateway' })
      expect(service.status).toBe('available')
      if (service.status !== 'available') throw new Error('fixture service unavailable')
      expect(await service.service.snapshot()).toMatchObject({
        status: 'available',
        projection: { auth: { state: 'authenticated' } },
      })
      expect(await renderer.nativeProviders()).toEqual([])
      await expect(service.service.authenticate({} as never)).rejects.toThrow('unsupported')
      expect(snapshot).toHaveBeenCalledOnce()
      expect(subscribe).not.toHaveBeenCalled()
      expect(authenticate).not.toHaveBeenCalled()
      expect(JSON.stringify(capabilities)).not.toContain(ownerToken)
      expect(wire.join('\n')).not.toContain(ownerToken)
      expect(wire.length).toBeGreaterThan(0)
    } finally {
      renderer.dispose()
      globalThis.__cordisxManagedServiceUIRequestV1 = undefined
      controller.abort()
      bridge.dispose()
      await runtime.dispose()
    }
  })
})
