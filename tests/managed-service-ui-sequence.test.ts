import { describe, expect, it, vi } from 'vitest'
import type {
  ManagedServiceSnapshotResultV1,
  ManagedServiceSubscribeResultV1,
} from '@cordisx/protocol/managed-service/v1'
import { createManagedServiceSource } from '../packages/cli/src/launcher/managed-service-ui-source.js'
import { baseOptions, fakeRegistrationHandle, runtimeProjection } from './fixtures/managed-service-ui-source.js'

describe('managed service shared sequence', () => {
  it('keeps unchanged snapshots and initial subscriptions at one shared revision', async () => {
    vi.useFakeTimers()
    const projection = runtimeProjection({ authentication: Object.freeze({ state: 'missing' }) })
    const handle = fakeRegistrationHandle(projection)
    const source = createManagedServiceSource({
      ...baseOptions({ healthIntervalMs: 10, authenticationMode: 'cli' }),
      registrationHandle: handle,
    })
    let first: Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }> | undefined
    let second: Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }> | undefined
    try {
      const initial = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      const repeated = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      expect(repeated.projection.sequence).toBe(initial.projection.sequence)
      first = await source.subscribe(0) as typeof first
      second = await source.subscribe(0) as typeof second
      const page1 = first!.subscription.pages[Symbol.asyncIterator]().next()
      const page2 = second!.subscription.pages[Symbol.asyncIterator]().next()
      await vi.advanceTimersByTimeAsync(10)
      expect((await page1).value.nextAfterSequence).toBe(initial.projection.sequence)
      expect((await page2).value.nextAfterSequence).toBe(initial.projection.sequence)
      const result = await source.authenticate({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
        contract: 'cordisx.managed-service-login-request/v1',
        schemaVersion: 1,
        requestId: 'shared-revision-login',
        binding: source.binding,
        action: 'login',
        expectedSequence: initial.projection.sequence,
        userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
      })
      expect(result.status).toBe('accepted')
      expect(handle.authenticate).toHaveBeenCalledOnce()
    } finally {
      await first?.subscription.unsubscribe()
      await second?.subscription.unsubscribe()
      vi.useRealTimers()
    }
  })

  it('rejects a future subscription cursor without changing the shared revision', async () => {
    const source = createManagedServiceSource(baseOptions())
    const before = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    const future = await source.subscribe(before.projection.sequence + 10)
    try {
      expect(future).toEqual({ status: 'unavailable', code: 'stale-generation' })
      const after = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      expect(after.projection.sequence).toBe(before.projection.sequence)
    } finally {
      if (future.status === 'subscribed') await future.subscription.unsubscribe()
    }
  })

  it('emits a full snapshot when the managed service generation changes', async () => {
    vi.useFakeTimers()
    const initial = runtimeProjection()
    let current = initial
    const handle = { ...fakeRegistrationHandle(initial), inspect: vi.fn(async () => current) }
    const source = createManagedServiceSource({ ...baseOptions({ healthIntervalMs: 10 }), registrationHandle: handle })
    const subscribed = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
    try {
      const pages = subscribed.subscription.pages[Symbol.asyncIterator]()
      const first = pages.next()
      await vi.advanceTimersByTimeAsync(10)
      const before = await first
      current = runtimeProjection({ binding: { ...initial.binding, serviceGeneration: 'svc-next' } })
      const changed = pages.next()
      await vi.advanceTimersByTimeAsync(10)
      const after = await changed
      expect(after.value.updates[0]).toMatchObject({
        kind: 'snapshot-replaced',
        projection: { serviceGeneration: 'svc-next' },
      })
      expect(after.value.nextAfterSequence).toBeGreaterThan(before.value.nextAfterSequence)
    } finally {
      await subscribed.subscription.unsubscribe()
      vi.useRealTimers()
    }
  })

  it('serializes concurrent inspections so an older result cannot overtake a newer one', async () => {
    const initial = runtimeProjection({ state: 'authentication-required' })
    const changed = runtimeProjection({ state: 'ready' })
    let release!: () => void
    const pending = new Promise<void>(resolve => release = resolve)
    const inspect = vi.fn()
      .mockImplementationOnce(async () => {
        await pending
        return initial
      })
      .mockResolvedValueOnce(changed)
    const source = createManagedServiceSource({
      ...baseOptions(),
      registrationHandle: { ...fakeRegistrationHandle(initial), inspect },
    })
    const first = source.snapshot()
    const second = source.snapshot()
    try {
      await vi.waitFor(() => expect(inspect).toHaveBeenCalledOnce())
      release()
      const before = await first as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      const after = await second as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      expect(after.projection.sequence).toBeGreaterThan(before.projection.sequence)
      expect(inspect).toHaveBeenCalledTimes(2)
    } finally {
      release()
    }
  })
})
