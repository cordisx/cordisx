import type { ManagedServiceSourceV1, ManagedServiceSubscriptionV1 } from '@cordisx/protocol/managed-service/v1'
import { expect, it, vi } from 'vitest'
import { createManagedServiceUIBridgeHandler } from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

const owner = { pluginId: 'demo', pluginGeneration: 'plugin' }
const scope = { profileId: 'profile', generation: 'host' }
function source(bindingId: string) {
  const binding = { bindingId, identity: { pluginId: owner.pluginId, serviceId: 'gateway' }, scope }
  const snapshot = vi.fn(async () => ({ status: 'available' as const, projection: { binding, sequence: 0 } }))
  const unsubscribe = vi.fn(async () => ({ reason: 'explicit', subscription: { subscriptionId: bindingId, binding } }))
  const subscribe = vi.fn(async () => ({
    status: 'subscribed' as const,
    subscription: {
      descriptor: { subscriptionId: bindingId, binding, afterSequence: 0, snapshotSequence: 0 },
      pages: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined) }) },
      closed: new Promise(() => undefined),
      unsubscribe,
    } as unknown as ManagedServiceSubscriptionV1,
  }))
  const authenticate = vi.fn(async () => ({ status: 'accepted' }))
  return {
    binding,
    snapshot,
    subscribe,
    authenticate,
    unsubscribe,
    value: { binding, snapshot, subscribe, authenticate } as unknown as ManagedServiceSourceV1,
  }
}
const input = { token: 'token', profileId: scope.profileId, generation: scope.generation }
const get = { requestId: 'get', operation: 'get' as const, serviceId: 'gateway' }

it('distinguishes a declared service before binding and replaces execution sources without retrying operations', async () => {
  const first = source('first'), second = source('second')
  const handler = createManagedServiceUIBridgeHandler({
    ...input,
    services: [],
    declaredServices: [{ ...owner, serviceId: 'gateway' }],
  })
  expect(await handler.handle(owner, get)).toMatchObject({ status: 'unavailable', message: 'binding-unavailable' })
  await handler.replaceServices(owner, [{ ...owner, serviceId: 'gateway', source: first.value }])
  expect(await handler.handle(owner, get)).toMatchObject({ status: 'available', service: { binding: first.binding } })
  await handler.handle(owner, {
    requestId: 'subscribe',
    operation: 'subscribe',
    serviceId: 'gateway',
    binding: first.binding,
    afterSequence: 0,
  })
  let resolve!: (value: unknown) => void
  first.snapshot.mockImplementationOnce(async () =>
    await new Promise(done => {
      resolve = done
    }) as never
  )
  const pending = handler.handle(owner, {
    requestId: 'old-read',
    operation: 'snapshot',
    serviceId: 'gateway',
    binding: first.binding,
  })
  await handler.replaceServices(owner, [{ ...owner, serviceId: 'gateway', source: second.value }])
  resolve({ status: 'available', projection: { binding: first.binding, sequence: 99 } })
  await expect(pending).rejects.toThrow('replaced')
  expect(first.unsubscribe).toHaveBeenCalledOnce()
  expect(await handler.handle(owner, get)).toMatchObject({ service: { binding: second.binding } })
  expect(second.authenticate).not.toHaveBeenCalled()
  expect(second.subscribe).not.toHaveBeenCalled()
  await handler.dispose()
})
it('does not commit invalid or disposed-owner replacement candidates', async () => {
  const first = source('first'), second = source('second')
  const handler = createManagedServiceUIBridgeHandler({
    ...input,
    services: [{ ...owner, serviceId: 'gateway', source: first.value }],
  })
  await expect(
    handler.replaceServices(owner, [{
      pluginId: 'other',
      pluginGeneration: 'plugin',
      serviceId: 'gateway',
      source: second.value,
    }]),
  ).rejects.toThrow('outside')
  expect(await handler.handle(owner, get)).toMatchObject({ service: { binding: first.binding } })
  const replacement = handler.replaceServices(owner, [{ ...owner, serviceId: 'gateway', source: second.value }])
  const disposing = handler.disposeOwner(owner)
  await expect(replacement).rejects.toThrow('revoked')
  await disposing
  await expect(handler.replaceServices(owner, [{ ...owner, serviceId: 'gateway', source: second.value }])).rejects
    .toThrow('revoked')
  await handler.dispose()
})
