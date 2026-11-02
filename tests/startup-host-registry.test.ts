import { expect, it, vi } from 'vitest'
import { ManagedServiceStartupAuthority } from '../packages/cli/src/launcher/managed-service-startup-authority.js'
import { createManagedServiceUIBridgeHandler } from '../packages/cli/src/launcher/managed-service-ui-rpc.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'
import { ModelProviderRegistry } from '../packages/cli/src/renderer/model-providers.js'
import { declaration } from './managed-service-runtime-fixture.js'

it('connects the registry through the genuine Host authority scope and disposes observation without granting execution', async () => {
  const authority = new ManagedServiceStartupAuthority({ profileId: 'work', hostGeneration: 'host' })
  const owners = ['first', 'second'].map(pluginId => ({ pluginId, pluginGeneration: 'one' }))
  authority.admit(owners.map(owner => ({
    ...owner,
    source: `https://example.test/${owner.pluginId}`,
    sourceRevision: `sha256:${'a'.repeat(64)}`,
    dependencies: [],
    services: [declaration('gateway', owner.pluginId, [])],
    startup: {
      contract: 'cordisx.startup-declaration/v1',
      pages: [],
      capabilities: [{
        id: 'models',
        serviceId: 'gateway',
        kind: 'provider',
        providerId: owner.pluginId,
        compositionOrigin: 'api',
        dependsOn: [],
        wait: { interactive: 'background', command: 'when-selected' },
        milestones: [],
        success: { allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }] },
      }],
    },
  })))
  authority.selectOwners(owners)
  const observer = authority.observer({ scopeId: 'host-models', authorize: () => true })
  const handler = createManagedServiceUIBridgeHandler({
    token: 'plugin-token',
    profileId: 'work',
    generation: 'host',
    services: [],
    hostStartup: { token: 'host-token', observer },
  })
  const wires: { operation: string; scope: unknown }[] = []
  globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
    wires.push(JSON.parse(payload))
    void handler.hostStartup!.handleBindingValue(payload).then(value =>
      globalThis.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify(value))
    )
  }
  const bridge = BrowserManagedServiceUIBridge.connect([], 'work', 'host', { token: 'host-token' })
  const registry = new ModelProviderRegistry(async () => [])
  try {
    registry.connectStartup(bridge.bindHostStartup()!)
    await vi.waitFor(() =>
      expect(registry.snapshot().providers.map(provider => provider.providerId).sort()).toEqual(['first', 'second'])
    )
    expect(registry.snapshot().startup).toMatchObject({
      connection: 'connected',
      snapshot: { cursor: { scopeId: 'work:host-models' } },
    })
    expect(registry.snapshot().providers.every(provider => provider.startup?.actions.execute.available === false)).toBe(
      true,
    )
    expect(wires[0]!.scope).toEqual({ profileId: 'work', runtimeGeneration: 'host' })
    expect(bridge.bindStartup(owners[0]!)).toBeUndefined()
    const notify = vi.fn()
    registry.subscribe(notify)
    registry.dispose()
    await vi.waitFor(() => expect(wires.some(wire => wire.operation === 'startupClose')).toBe(true))
    const calls = notify.mock.calls.length
    authority.selectOwners([owners[0]!])
    await Promise.resolve()
    expect(notify.mock.calls.length).toBe(calls)
  } finally {
    registry.dispose()
    bridge.dispose()
    await handler.dispose()
    authority.dispose()
    delete globalThis.__cordisxManagedServiceUIRequestV1
    delete globalThis.__cordisxManagedServiceUIReceiveV1
  }
})
