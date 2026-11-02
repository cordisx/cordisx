import { afterEach, expect, it, vi } from 'vitest'
import { startupTransportControlEvaluation } from '../packages/cli/src/launcher/startup-ui-transport-control.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'

const envelope = {
  contract: 'cordisx.startup-transport-control/v1',
  token: 'host-token',
  scope: { profileId: 'profile', runtimeGeneration: 'host' },
  sequence: 1,
  phase: 'reconnected',
}
afterEach(() => {
  delete globalThis.__cordisxManagedServiceUIRequestV1
  delete globalThis.__cordisxManagedServiceUIReceiveV1
})
it('authorizes a narrow Host control and ignores stale, plugin, malformed and replayed controls', async () => {
  globalThis.__cordisxManagedServiceUIRequestV1 = () => {}
  const bridge = BrowserManagedServiceUIBridge.connect(
    [{ pluginId: 'demo', pluginGeneration: 'plugin', token: 'plugin-token', startup: true }],
    'profile',
    'host',
    { token: 'host-token' },
  )
  const disconnect = vi.spyOn(bridge, 'transportDisconnected')
  const requests: Promise<unknown>[] = []
  const request = (id: string) =>
    bridge.request({ kind: 'host', hostGeneration: 'host' }, 'host-token', {
      requestId: id,
      operation: 'startupNext',
      subscriptionId: 'subscription',
    })
  const pending = request('pending')
  requests.push(pending.catch(() => undefined))
  for (
    const invalid of [
      { ...envelope, token: 'plugin-token' },
      { ...envelope, scope: { ...envelope.scope, pluginGeneration: 'plugin' } },
      { ...envelope, scope: { profileId: 'other', runtimeGeneration: 'host' } },
      { ...envelope, sequence: 0 },
      { ...envelope, phase: 'execute' },
      { ...envelope, command: 'authenticate' },
    ]
  ) {
    globalThis.__cordisxManagedServiceUIReceiveV1!(JSON.stringify(invalid))
  }
  expect(disconnect).not.toHaveBeenCalled()
  const expression = startupTransportControlEvaluation({
    token: 'host-token',
    profileId: 'profile',
    generation: 'host',
    sequence: 1,
    phase: 'reconnected',
  })
  expect(globalThis.eval(expression)).toBe(true)
  await expect(pending).rejects.toThrow('transport disconnected')
  expect(disconnect).toHaveBeenCalledOnce()
  const resumed = request('resumed')
  requests.push(resumed.catch(() => undefined))
  globalThis.eval(expression)
  expect(disconnect).toHaveBeenCalledOnce()
  globalThis.eval(
    startupTransportControlEvaluation({
      token: 'host-token',
      profileId: 'profile',
      generation: 'host',
      sequence: 2,
      phase: 'disconnected',
    }),
  )
  await expect(resumed).rejects.toThrow('transport disconnected')
  expect(disconnect).toHaveBeenCalledTimes(2)
  bridge.dispose()
  await Promise.all(requests)
  expect(globalThis.eval(expression)).toBe(false)
})
it('does not pretend to deliver when the renderer receiver is absent', () => {
  const expression = startupTransportControlEvaluation({
    token: 'host-token',
    profileId: 'profile',
    generation: 'host',
    sequence: 1,
    phase: 'disconnected',
  })
  expect(globalThis.eval(expression)).toBe(false)
  expect(() =>
    startupTransportControlEvaluation({
      token: 'host-token',
      profileId: 'profile',
      generation: 'host',
      sequence: -1,
      phase: 'disconnected',
    })
  ).toThrow('sequence')
})
