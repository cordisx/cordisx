import type {
  ManagedServiceBindingV1,
  ManagedServiceSourceV1,
  ManagedServiceSubscriptionClosedV1,
  ManagedServiceSubscriptionPageV1,
  ManagedServiceSubscriptionV1,
} from '@cordisx/protocol/managed-service/v1'
import { expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

const owner = { pluginId: 'fixture', pluginGeneration: 'plugin-generation' }
const ownerToken = 'owner-private-' + 'a'.repeat(64)
const binding: ManagedServiceBindingV1 = {
  bindingId: 'binding-1',
  identity: { source: 'https://example.test/fixture', pluginId: owner.pluginId, serviceId: 'gateway' },
  scope: { profileId: 'work', generation: 'runtime' },
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
    serviceId: 'gateway',
    binding,
    ...extra,
  })

function fixture(options: {
  delayedSubscribe?: boolean
  failCleanup?: boolean
  unknownSubscribe?: boolean
  leakOwnerId?: boolean
  shortOwnerId?: boolean
} = {}) {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const subscriptions: Array<{ id: string; unsubscribe: ReturnType<typeof vi.fn> }> = []
  const source = {
    binding,
    snapshot: async () => ({ status: 'available', projection: { binding, sequence: 1 } }),
    subscribe: async (afterSequence: number) => {
      if (options.delayedSubscribe) await gate
      const id = options.shortOwnerId ? 's' : 'upstream-subscription-' + (subscriptions.length + 1)
      const descriptor = { subscriptionId: id, binding, afterSequence, snapshotSequence: 1 }
      const receipt: ManagedServiceSubscriptionClosedV1 = {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-close.v1.schema.json',
        contract: 'cordisx.managed-service-subscription-close/v1',
        schemaVersion: 1,
        subscription: descriptor,
        closedAt: '2026-01-01T00:00:00.000Z',
        reason: 'explicit',
      }
      const page: ManagedServiceSubscriptionPageV1 = {
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-page.v1.schema.json',
        contract: 'cordisx.managed-service-subscription-page/v1',
        schemaVersion: 1,
        subscription: descriptor,
        phase: 'live',
        updates: options.leakOwnerId ? [{ kind: 'state-changed', sequence: 1, delta: { label: id } }] as never : [],
        nextAfterSequence: 1,
        hasMore: false,
      }
      let resolveClosed!: (value: ManagedServiceSubscriptionClosedV1) => void
      const closed = new Promise<ManagedServiceSubscriptionClosedV1>(resolve => {
        resolveClosed = resolve
      })
      let resolveNext!: (value: IteratorResult<ManagedServiceSubscriptionPageV1>) => void
      let first = true
      const unsubscribe = vi.fn(async () => {
        resolveClosed(receipt)
        resolveNext?.({ done: true, value: undefined })
        return receipt
      })
      const subscription = {
        descriptor,
        closed,
        unsubscribe,
        pages: {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (first) {
                first = false
                return { done: false as const, value: page }
              }
              return await new Promise<IteratorResult<ManagedServiceSubscriptionPageV1>>(resolve => {
                resolveNext = resolve
              })
            },
          }),
        },
      } as unknown as ManagedServiceSubscriptionV1
      subscriptions.push({ id, unsubscribe })
      return { status: 'subscribed', subscription }
    },
  } as unknown as ManagedServiceSourceV1
  const handler = createManagedServiceUIBridgeHandler({
    token: ownerToken,
    profileId: 'work',
    generation: 'runtime',
    services: [{ ...owner, serviceId: 'gateway', source }],
  })
  const calls: Array<{ operation: string; subscriptionId?: string }> = []
  const invoke = async (value: string, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const raw = JSON.parse(value)
    calls.push({ operation: raw.operation, ...(raw.subscriptionId ? { subscriptionId: raw.subscriptionId } : {}) })
    if (
      options.failCleanup && raw.operation === 'unsubscribe'
      || options.unknownSubscribe && raw.operation === 'subscribe'
    ) {
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
      capabilities: () => [{ ...owner, token: ownerToken }],
      managedServiceUI: { handleBindingValue: invoke },
    },
  })
  return { bridge, calls, handler, subscriptions, release }
}

it('isolates service subscriptions, projects pages and closes only the retiring renderer', async () => {
  const f = fixture()
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = context('1', firstController.signal)
  const second = context('2', secondController.signal)
  const firstToken = f.bridge.projectInitial(first)[0]!.token
  const secondToken = f.bridge.projectInitial(second)[0]!.token
  try {
    const firstResult = await f.bridge.channel.prepare(
      request(firstToken, 'subscribe', 'first', { afterSequence: 0 }),
      first,
    )
      .dispatch() as any
    const secondResult = await f.bridge.channel.prepare(
      request(secondToken, 'subscribe', 'second', { afterSequence: 0 }),
      second,
    )
      .dispatch() as any
    const firstId = firstResult.value.subscription.subscriptionId as string
    const secondId = secondResult.value.subscription.subscriptionId as string
    expect(firstId).not.toBe(secondId)
    expect(JSON.stringify(firstResult)).not.toContain(f.subscriptions[0]!.id)
    expect(JSON.stringify(secondResult)).not.toContain(f.subscriptions[1]!.id)
    await expect(
      f.bridge.channel.prepare(
        request(secondToken, 'next', 'cross-page', { subscriptionId: firstId }),
        second,
      ).dispatch(),
    ).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    const page = await f.bridge.channel.prepare(request(firstToken, 'next', 'page', { subscriptionId: firstId }), first)
      .dispatch() as any
    expect(page.value.page.subscription.subscriptionId).toBe(firstId)
    expect(JSON.stringify(page)).not.toContain(f.subscriptions[0]!.id)
    const waiting = f.bridge.channel.prepare(
      request(firstToken, 'closed', 'closed', { subscriptionId: firstId }),
      first,
    )
      .dispatch()
    const rejected = expect(waiting).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'closed')).toBe(true))
    firstController.abort()
    expect(await f.bridge.waitForRetirement(first.rendererId)).toBe(true)
    await rejected
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
    expect(f.subscriptions[1]!.unsubscribe).not.toHaveBeenCalled()
    const secondPage = await f.bridge.channel.prepare(
      request(secondToken, 'next', 'second-page', { subscriptionId: secondId }),
      second,
    ).dispatch() as any
    expect(secondPage.value.page.subscription.subscriptionId).toBe(secondId)
    const close = await f.bridge.channel.prepare(
      request(secondToken, 'unsubscribe', 'unsubscribe', { subscriptionId: secondId }),
      second,
    ).dispatch() as any
    expect(close.value.subscription.subscriptionId).toBe(secondId)
    expect(JSON.stringify(close)).not.toContain(f.subscriptions[1]!.id)
    expect(
      await f.bridge.channel.prepare(
        request(secondToken, 'closed', 'closed-again', { subscriptionId: secondId }),
        second,
      ).dispatch(),
    ).toMatchObject({ ok: true, value: { subscription: { subscriptionId: secondId } } })
  } finally {
    firstController.abort()
    secondController.abort()
    f.bridge.dispose()
    await f.handler.dispose()
  }
})

it('waits for a late service subscription to close before confirming retirement', async () => {
  const f = fixture({ delayedSubscribe: true })
  const controller = new AbortController()
  const renderer = context('3', controller.signal)
  const token = f.bridge.projectInitial(renderer)[0]!.token
  try {
    const pending = f.bridge.channel.prepare(request(token, 'subscribe', 'late', { afterSequence: 0 }), renderer)
      .dispatch()
    const rejected = expect(pending).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'subscribe')).toBe(true))
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
    expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce()
  } finally {
    f.release()
    controller.abort()
    f.bridge.dispose()
    await f.handler.dispose()
  }
})

it('does not confirm retirement when service cleanup or the opening result is uncertain', async () => {
  for (const options of [{ failCleanup: true }, { unknownSubscribe: true }]) {
    const f = fixture(options)
    const controller = new AbortController()
    const renderer = context('4', controller.signal)
    const token = f.bridge.projectInitial(renderer)[0]!.token
    try {
      const operation = f.bridge.channel.prepare(request(token, 'subscribe', 'open', { afterSequence: 0 }), renderer)
        .dispatch()
      let rejected: Promise<unknown> | undefined
      if (options.unknownSubscribe) await expect(operation).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
      else {
        const opened = await operation as any
        expect(opened).toMatchObject({ ok: true })
        const waiting = f.bridge.channel.prepare(
          request(token, 'closed', 'pending', { subscriptionId: opened.value.subscription.subscriptionId }),
          renderer,
        ).dispatch()
        rejected = expect(waiting).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
        await vi.waitFor(() => expect(f.calls.some(call => call.operation === 'closed')).toBe(true))
      }
      controller.abort()
      expect(await f.bridge.waitForRetirement(renderer.rendererId)).toBe(false)
      await rejected
    } finally {
      controller.abort()
      f.bridge.dispose()
      await f.handler.dispose()
    }
  }
})

it('closes a stream rather than delivering a page that exposes its owner identifier', async () => {
  const f = fixture({ leakOwnerId: true })
  const controller = new AbortController()
  const renderer = context('5', controller.signal)
  const token = f.bridge.projectInitial(renderer)[0]!.token
  try {
    const opened = await f.bridge.channel.prepare(request(token, 'subscribe', 'open', { afterSequence: 0 }), renderer)
      .dispatch() as any
    const id = opened.value.subscription.subscriptionId
    await expect(f.bridge.channel.prepare(request(token, 'next', 'page', { subscriptionId: id }), renderer).dispatch())
      .rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    await vi.waitFor(() => expect(f.subscriptions[0]!.unsubscribe).toHaveBeenCalledOnce())
    controller.abort()
    expect(await f.bridge.waitForRetirement(renderer.rendererId)).toBe(true)
  } finally {
    controller.abort()
    f.bridge.dispose()
    await f.handler.dispose()
  }
})

it('accepts a short owner identifier without treating unrelated text as the identifier', async () => {
  const f = fixture({ shortOwnerId: true })
  const controller = new AbortController()
  const renderer = context('6', controller.signal)
  const token = f.bridge.projectInitial(renderer)[0]!.token
  try {
    const opened = await f.bridge.channel.prepare(request(token, 'subscribe', 'open', { afterSequence: 0 }), renderer)
      .dispatch() as any
    const id = opened.value.subscription.subscriptionId
    expect(await f.bridge.channel.prepare(request(token, 'next', 'page', { subscriptionId: id }), renderer).dispatch())
      .toMatchObject({ ok: true, value: { status: 'page', page: { subscription: { subscriptionId: id } } } })
  } finally {
    controller.abort()
    await f.bridge.waitForRetirement(renderer.rendererId)
    f.bridge.dispose()
    await f.handler.dispose()
  }
})
