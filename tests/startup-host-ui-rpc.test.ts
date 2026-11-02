import type { StartupEventV1, StartupObserverV1, StartupSnapshotV1 } from '@cordisx/protocol/startup/v1'
import { afterEach, expect, it, vi } from 'vitest'
import { createManagedServiceUIBridgeHandler } from '../packages/cli/src/launcher/managed-service-ui-rpc.js'
import { safeStartupEvent } from '../packages/cli/src/launcher/startup-ui-projection.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'

const snapshot: StartupSnapshotV1 = {
  contract: 'cordisx.startup-snapshot/v1',
  cursor: { scopeId: 'host-scope', hostGeneration: 'host', epoch: 'epoch', sequence: 0 },
  entries: [],
  pages: [],
}
const observer: StartupObserverV1 = {
  contract: 'cordisx.startup-observer/v1',
  read: async () => snapshot,
  subscribe: async listener => {
    listener({ kind: 'connection', connection: { state: 'connected' } })
    listener({ kind: 'snapshot', reason: 'initial', snapshot })
    return { close() {} }
  },
}
afterEach(() => {
  delete globalThis.__cordisxManagedServiceUIRequestV1
  delete globalThis.__cordisxManagedServiceUIReceiveV1
})

it('uses a distinct Host scope and rejects plugin credentials, plugin scope and private response fields', async () => {
  const handler = createManagedServiceUIBridgeHandler({
    token: 'plugin-token',
    profileId: 'profile',
    generation: 'host',
    services: [],
    hostStartup: { token: 'host-token', observer },
  })
  const payload = {
    version: 1,
    token: 'host-token',
    requestId: 'host-read',
    operation: 'startupRead',
    scope: { profileId: 'profile', runtimeGeneration: 'host' },
  }
  expect(await handler.hostStartup!.handleBindingValue(JSON.stringify(payload))).toMatchObject({
    ok: true,
    value: snapshot,
  })
  for (
    const invalid of [{ ...payload, token: 'plugin-token' }, {
      ...payload,
      scope: { ...payload.scope, pluginGeneration: 'plugin' },
    }, { ...payload, serviceId: 'gateway' }]
  ) {
    expect(await handler.hostStartup!.handleBindingValue(JSON.stringify(invalid))).toMatchObject({ ok: false })
  }
  expect(safeStartupEvent({ kind: 'connection', connection: { state: 'disconnected', reason: 'timeout' } })).toEqual({
    kind: 'connection',
    connection: { state: 'disconnected', reason: 'timeout' },
  })
  expect(() =>
    safeStartupEvent(
      { kind: 'connection', connection: { state: 'connected', token: 'private' } } as unknown as StartupEventV1,
    )
  ).toThrow('private')
  await handler.dispose()
})
it('provides Host observation independently from every plugin and never borrows a plugin owner', async () => {
  const handler = createManagedServiceUIBridgeHandler({
    token: 'plugin-token',
    profileId: 'profile',
    generation: 'host',
    services: [],
    hostStartup: { token: 'host-token', observer },
  })
  const wires: Record<string, unknown>[] = []
  globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
    wires.push(JSON.parse(payload))
    void handler.hostStartup!.handleBindingValue(payload).then(result =>
      globalThis.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify(result))
    )
  }
  const bridge = BrowserManagedServiceUIBridge.connect([], 'profile', 'host', { token: 'host-token' })
  expect(bridge.bindStartup({ pluginId: 'demo', pluginGeneration: 'plugin' })).toBeUndefined()
  expect(await bridge.bindHostStartup()!.read()).toEqual(snapshot)
  expect(wires[0]!.scope).toEqual({ profileId: 'profile', runtimeGeneration: 'host' })
  expect(await bridge.nativeProviders()).toEqual([])
  const events: StartupEventV1[] = []
  const sub = await bridge.bindHostStartup()!.subscribe(event => events.push(event))
  await vi.waitFor(() => expect(events.some(event => event.kind === 'snapshot')).toBe(true))
  sub.close()
  bridge.dispose()
  await handler.dispose()
})
