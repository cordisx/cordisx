import type { StartupEventV1, StartupObserverV1 } from '@cordisx/protocol/startup/v1'
import { expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

const owner = { pluginId: 'fixture', pluginGeneration: 'plugin-generation' }
const ownerToken = 'private-owner-' + 'a'.repeat(64)
const snapshot = {
  contract: 'cordisx.startup-snapshot/v1' as const,
  cursor: { scopeId: 'plugin-fixture', hostGeneration: 'runtime', epoch: 'epoch', sequence: 0 },
  entries: [],
  pages: [],
}
const context = (id: string, signal: AbortSignal): ManagerRendererChannelContext => ({
  profileId: 'work',
  rendererId: id.repeat(64),
  ownerGeneration: 'owner',
  signal,
})
const request = (token: string, operation: string, requestId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    token,
    operation,
    requestId,
    scope: { profileId: 'work', runtimeGeneration: 'runtime', pluginGeneration: owner.pluginGeneration },
    ...extra,
  })

function fixture(options: { delayedSubscribe?: boolean; failCleanup?: boolean; startup?: boolean } = {}) {
  const listeners = new Set<(event: StartupEventV1) => void>()
  const close = vi.fn()
  let release!: () => void
  const gate = new Promise<void>(resolve => release = resolve)
  const observer: StartupObserverV1 = {
    contract: 'cordisx.startup-observer/v1',
    async read() {
      return snapshot
    },
    async subscribe(listener) {
      if (options.delayedSubscribe) await gate
      listeners.add(listener)
      listener({ kind: 'snapshot', reason: 'initial', snapshot })
      return {
        close() {
          listeners.delete(listener)
          close()
        },
      }
    },
  }
  const handler = createManagedServiceUIBridgeHandler({
    token: ownerToken,
    profileId: 'work',
    generation: 'runtime',
    services: [],
    startupObservers: [{ ...owner, observer }],
  })
  const calls: Array<{ operation: string; subscriptionId?: string }> = []
  const invoke = async (value: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const raw = JSON.parse(value)
    calls.push({ operation: raw.operation, ...(raw.subscriptionId ? { subscriptionId: raw.subscriptionId } : {}) })
    if (options.failCleanup && raw.operation === 'startupClose') {
      return { requestId: raw.requestId, ok: false, code: 'owner-unavailable' }
    }
    try {
      const parsed = parseManagedServiceUIBindingRequest(raw, handler, owner)
      return { requestId: raw.requestId, ok: true, value: await handler.handle(owner, parsed, signal) }
    } catch {
      return { requestId: raw.requestId, ok: false, code: 'owner-unavailable' }
    }
  }
  const bridge = createManagerManagedServiceUIBridge({
    profileId: 'work',
    runtimeGeneration: 'runtime',
    ownerGeneration: 'owner',
    ownerCurrent: () => true,
    readLifecycleFence: () => 1,
    runtime: {
      capabilities: () => [{ ...owner, token: ownerToken, ...(options.startup === false ? {} : { startup: true }) }],
      managedServiceUI: { handleBindingValue: invoke },
    },
  })
  return { bridge, calls, close, handler, listeners, release }
}

it('isolates observation streams per renderer and cleans up an in-flight next on retirement', async () => {
  const f = fixture()
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = context('1', firstController.signal)
  const second = context('2', secondController.signal)
  const firstCapability = f.bridge.projectInitial(first)[0]!
  const secondCapability = f.bridge.projectInitial(second)[0]!
  try {
    expect(firstCapability.startup).toBe(true)
    const read = await f.bridge.channel.prepare(request(firstCapability.token, 'startupRead', 'read-1'), first)
      .dispatch()
    expect(read).toMatchObject({ requestId: 'read-1', ok: true, value: snapshot })
    const firstSub = await f.bridge.channel.prepare(
      request(firstCapability.token, 'startupSubscribe', 'subscribe-1', { subscriptionId: 'shared-id' }),
      first,
    ).dispatch()
    const secondSub = await f.bridge.channel.prepare(
      request(secondCapability.token, 'startupSubscribe', 'subscribe-2', { subscriptionId: 'shared-id' }),
      second,
    ).dispatch()
    expect(firstSub).toMatchObject({ ok: true, value: { subscriptionId: 'shared-id' } })
    expect(secondSub).toMatchObject({ ok: true, value: { subscriptionId: 'shared-id' } })
    const upstream = f.calls.filter(call => call.operation === 'startupSubscribe').map(call => call.subscriptionId!)
    expect(upstream).toHaveLength(2)
    expect(upstream[0]).not.toBe(upstream[1])
    expect(JSON.stringify(firstSub)).not.toContain(upstream[0])
    expect(() =>
      f.bridge.channel.prepare(
        request(firstCapability.token, 'startupNext', 'cross-token', { subscriptionId: 'shared-id' }),
        second,
      )
    ).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await expect(
      f.bridge.channel.prepare(
        request(secondCapability.token, 'startupNext', 'cross-id', { subscriptionId: 'not-owned' }),
        second,
      ).dispatch(),
    ).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(
      await f.bridge.channel.prepare(
        request(firstCapability.token, 'startupClose', 'close-1', { subscriptionId: 'shared-id' }),
        first,
      ).dispatch(),
    ).toEqual({ requestId: 'close-1', ok: true, value: null })
    expect(f.close).toHaveBeenCalledTimes(1)
    const next = f.bridge.channel.prepare(
      request(secondCapability.token, 'startupNext', 'next-2', { subscriptionId: 'shared-id' }),
      second,
    )
    expect(next).toMatchObject({ mode: 'read', longLivedRead: true, channelConfigurationIndependent: true })
    const pending = next.dispatch()
    const rejected = expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'startupNext')).toBe(true))
    secondController.abort()
    expect(await f.bridge.waitForRetirement(second.rendererId)).toBe(true)
    await rejected
    expect(f.close).toHaveBeenCalledTimes(2)
    expect(f.listeners.size).toBe(0)
  } finally {
    firstController.abort()
    secondController.abort()
    f.bridge.dispose()
    await f.handler.dispose()
  }
})

it('waits for a late subscription to open and close before confirming retirement', async () => {
  const f = fixture({ delayedSubscribe: true })
  const controller = new AbortController()
  const renderer = context('3', controller.signal)
  const token = f.bridge.projectInitial(renderer)[0]!.token
  try {
    const pending = f.bridge.channel.prepare(
      request(token, 'startupSubscribe', 'subscribe-late', { subscriptionId: 'late' }),
      renderer,
    ).dispatch()
    const rejected = expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'startupSubscribe')).toBe(true))
    controller.abort()
    let retired = false
    const retirement = f.bridge.waitForRetirement(renderer.rendererId).then(value => {
      retired = true
      return value
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(retired).toBe(false)
    f.release()
    expect(await retirement).toBe(true)
    await rejected
    expect(f.close).toHaveBeenCalledOnce()
  } finally {
    f.release()
    controller.abort()
    f.bridge.dispose()
    await f.handler.dispose()
  }
})

it('fences an unconfirmed cleanup and does not grant startup observation without an owner capability', async () => {
  const f = fixture({ failCleanup: true })
  const controller = new AbortController()
  const renderer = context('4', controller.signal)
  const token = f.bridge.projectInitial(renderer)[0]!.token
  try {
    expect(
      await f.bridge.channel.prepare(
        request(token, 'startupSubscribe', 'subscribe', { subscriptionId: 'stream' }),
        renderer,
      ).dispatch(),
    ).toMatchObject({ ok: true })
    const pending = f.bridge.channel.prepare(
      request(token, 'startupNext', 'pending', { subscriptionId: 'stream' }),
      renderer,
    ).dispatch()
    const rejected = expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'startupNext')).toBe(true))
    controller.abort()
    expect(await f.bridge.waitForRetirement(renderer.rendererId)).toBe(false)
    await rejected
  } finally {
    controller.abort()
    f.bridge.dispose()
    await f.handler.dispose()
  }
  const other = fixture({ startup: false })
  const otherController = new AbortController()
  const otherContext = context('5', otherController.signal)
  const otherToken = other.bridge.projectInitial(otherContext)[0]!.token
  try {
    expect(
      await other.bridge.channel.prepare(request(otherToken, 'startupRead', 'not-granted'), otherContext).dispatch(),
    )
      .toEqual({ requestId: 'not-granted', ok: false, code: 'unsupported' })
    expect(other.calls).toHaveLength(0)
  } finally {
    otherController.abort()
    other.bridge.dispose()
    await other.handler.dispose()
  }
})
