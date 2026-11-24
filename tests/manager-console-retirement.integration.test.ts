import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service-ui/v1'
import { expect, it } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'
import type {
  ManagedBrowserConsoleBoundary,
  ManagedServiceBrowserConsoleBroker,
} from '../packages/cli/src/launcher/managed-service-browser-console-broker.js'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

it('waits for a late console issue to retire without disrupting another renderer', async () => {
  const gateways = [await openManagedConsoleBrowserGateway(), await openManagedConsoleBrowserGateway()]
  const disposed = new Set<string>()
  const boundary: ManagedBrowserConsoleBoundary = {
    open(input) {
      for (const gateway of gateways) {
        const route = gateway.boundary.open(input)
        if (route) {
          return {
            origin: route.origin,
            admit: ticket => route.admit(ticket),
            dispose() {
              disposed.add(route.origin)
              route.dispose()
            },
          }
        }
      }
      return undefined
    },
  }
  let release!: () => void
  let started!: () => void
  const waiting = new Promise<void>(resolve => release = resolve)
  const firstStarted = new Promise<void>(resolve => started = resolve)
  const origins: string[] = []
  const ticket = 'a'.repeat(32)
  const broker: ManagedServiceBrowserConsoleBroker = {
    async read(generation, signal, browserBoundary) {
      const route = browserBoundary.open({
        service: 'fixture',
        generation,
        upstream: 'http://127.0.0.1:9',
        redeemPath: '/auth/browser',
        signal,
        verify: async () => true,
      })
      if (!route?.admit(ticket)) return { status: 'unavailable', reason: 'failed' }
      origins.push(route.origin)
      if (origins.length === 1) {
        started()
        await waiting
      }
      return { status: 'available', route, url: route.origin + '/auth/browser?ticket=' + ticket }
    },
  }
  const owner = { pluginId: 'example', pluginGeneration: 'plugin-1' }
  const binding = {
    bindingId: 'service-binding',
    identity: { source: 'https://example.test/plugins', pluginId: 'example', serviceId: 'gateway' },
    scope: { profileId: 'work', generation: 'runtime-1' },
  } as const
  const token = 'owner-private-' + 'a'.repeat(64)
  const handler = createManagedServiceUIBridgeHandler({
    token,
    profileId: 'work',
    generation: 'runtime-1',
    browserConsoleBoundary: () => boundary,
    services: [{
      ...owner,
      serviceId: 'gateway',
      source: { binding } as ManagedServiceSourceV1,
      webEntry: {
        serviceGeneration: 'service-1',
        timeoutMs: 5_000,
        read: async () => ({ status: 'available', origin: 'http://127.0.0.1:9' }),
        browserConsole: broker,
      },
    }],
  })
  const bridge = createManagerManagedServiceUIBridge({
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    readLifecycleFence: () => 1,
    browserConsoleOrigins: gateways.map(gateway => gateway.origin),
    runtime: {
      capabilities: () => [{ ...owner, token }],
      managedServiceUI: {
        async handleBindingValue(raw, signal) {
          const input = JSON.parse(raw)
          const request = parseManagedServiceUIBindingRequest(input, handler, owner)
          return { requestId: input.requestId, ok: true, value: await handler.handle(owner, request, signal) }
        },
      },
    },
  })
  const context = (id: string): ManagerRendererChannelContext => ({
    profileId: 'work',
    rendererId: id.repeat(64),
    ownerGeneration: 'owner-1',
    signal: new AbortController().signal,
    admitted: true,
  })
  const first = context('1')
  const second = context('2')
  const request = (sessionToken: string, operation: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      token: sessionToken,
      requestId: 'request-1',
      operation,
      scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'plugin-1' },
      serviceId: 'gateway',
      ...extra,
    })
  const issue = (sessionToken: string, viewId: string) =>
    request(sessionToken, 'consoleBrowser', {
      binding,
      request: { action: 'issue', viewId, serviceGeneration: 'service-1' },
    })
  const firstToken = bridge.projectInitial(first)[0]!.token
  const secondToken = bridge.projectInitial(second)[0]!.token
  try {
    await bridge.channel.prepare(request(firstToken, 'get'), first).dispatch()
    await bridge.channel.prepare(request(secondToken, 'get'), second).dispatch()
    const pending = bridge.channel.prepare(issue(firstToken, 'first'), first).dispatch().then(() => true, () => false)
    await firstStarted
    expect(await bridge.channel.prepare(issue(secondToken, 'second'), second).dispatch()).toMatchObject({
      ok: true,
      value: { status: 'available', origin: origins[1] },
    })
    expect(origins[0]).not.toBe(origins[1])
    bridge.retire(first)
    let finished = false
    const retirement = bridge.waitForRetirement(first.rendererId).then(result => {
      finished = true
      return result
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(finished).toBe(false)
    release()
    expect(await retirement).toBe(true)
    expect(await pending).toBe(false)
    expect(disposed.has(origins[0]!)).toBe(true)
    expect(disposed.has(origins[1]!)).toBe(false)
    bridge.retire(second)
    expect(await bridge.waitForRetirement(second.rendererId)).toBe(true)
    expect(disposed.has(origins[1]!)).toBe(true)
  } finally {
    release()
    bridge.dispose()
    await handler.dispose()
    await Promise.all(gateways.map(async gateway => await gateway.close()))
  }
})
