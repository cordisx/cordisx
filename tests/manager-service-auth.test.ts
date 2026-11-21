import { describe, expect, it, vi } from 'vitest'
import { ManagerServiceAuth, type ManagerServiceAuthRoute } from '../packages/cli/src/launcher/manager-service-auth.js'

const sessionId = 'a'.repeat(64)
const target = { pluginId: 'sample-provider', serviceId: 'gateway' }
const binding = {
  bindingId: 'binding-1',
  identity: target,
  scope: { profileId: 'work', generation: 'host-1' },
}
const operation = (action: string, extra: Record<string, unknown> = {}) => ({
  kind: 'manager-service-auth',
  sessionId,
  action,
  ...extra,
})

describe('manager service login leases', () => {
  it('fails closed at the bounded retired-session limit without reviving old sessions', async () => {
    let now = 1_000_000
    const auth = new ManagerServiceAuth({
      profileId: 'work',
      generation: 'host-1',
      now: () => now,
      targets: async () => [],
      withRoute: async (_id, callback) => await callback(undefined),
    })
    for (let i = 0; i <= 4_096; i += 1) {
      await auth.handle(operation('retire', { sessionId: i.toString(16).padStart(64, '0') }))
    }
    expect(await auth.handle(operation('list', { sessionId: '0'.repeat(64) }))).toMatchObject({
      code: 'SESSION_CAPACITY',
    })
    expect(await auth.handle(operation('list'))).toMatchObject({ code: 'SESSION_CAPACITY' })
    now += 8 * 60 * 60_000 + 1
    expect(await auth.handle(operation('list'))).toEqual({ status: 'available', services: [] })
    auth.close()
  })

  it('starts only once and reports an interrupted response as unknown without blocking a new route', async () => {
    let resolveStarted!: () => void
    const started = new Promise<void>(resolve => {
      resolveStarted = resolve
    })
    let rejectLogin!: (error: Error) => void
    const pending = new Promise<unknown>((_, reject) => {
      rejectLogin = reject
    })
    const authenticate = vi.fn(() => {
      resolveStarted()
      return pending
    })
    const route: ManagerServiceAuthRoute = {
      owner: { pluginId: 'sample-provider', pluginGeneration: 'generation-1' },
      handler: {
        token: 'test-token',
        profileId: 'work',
        generation: 'host-1',
        handle: async (_owner, request) => {
          if (request.operation === 'get') return { status: 'available', service: { binding } }
          if (request.operation === 'snapshot') {
            return {
              status: 'available',
              projection: {
                binding,
                sequence: 1,
                auth: { state: 'missing' },
                readiness: 'stopped',
                capabilities: { explicitLogin: true },
                userAction: { available: true },
              },
            }
          }
          if (request.operation === 'authenticate') return await authenticate()
          throw new Error('unexpected')
        },
        disposeOwner: async () => {},
        dispose: async () => {},
      },
    }
    let active = route
    const auth = new ManagerServiceAuth({
      profileId: 'work',
      generation: 'host-1',
      targets: async () => [target],
      withRoute: async (_id, callback) => await callback(active),
    })
    const prepare = operation('prepare-login', {
      ...target,
      pluginGeneration: 'generation-1',
      bindingId: binding.bindingId,
    })
    const lease = await auth.handle(prepare) as { leaseId: string }
    const first = auth.handle(operation('login', { leaseId: lease.leaseId }))
    await started
    expect(await auth.handle(operation('login', { leaseId: lease.leaseId }))).toMatchObject({
      code: 'LEASE_UNAVAILABLE',
    })
    active = { ...route, owner: { ...route.owner, pluginGeneration: 'generation-2' } }
    expect(await auth.handle(operation('view', target))).toMatchObject({
      status: 'available',
      pluginGeneration: 'generation-2',
    })
    rejectLogin(new Error('synthetic-secret'))
    const result = await first
    expect(result).toEqual({ status: 'unknown', code: 'LOGIN_RESULT_UNKNOWN' })
    expect(JSON.stringify(result)).not.toContain('synthetic-secret')
    expect(authenticate).toHaveBeenCalledOnce()
    auth.close()
  })

  it('rejects a lease if the plugin generation changes before the action starts', async () => {
    const handler = {
      token: 'test-token',
      profileId: 'work',
      generation: 'host-1',
      handle: vi.fn(async (_owner: unknown, request: { operation: string }) =>
        request.operation === 'get'
          ? { status: 'available', service: { binding } }
          : {
            status: 'available',
            projection: {
              binding,
              sequence: 1,
              auth: { state: 'missing' },
              readiness: 'ready',
              capabilities: { explicitLogin: true },
              userAction: { available: true },
            },
          }
      ),
      disposeOwner: async () => {},
      dispose: async () => {},
    }
    let route = {
      owner: { pluginId: 'sample-provider', pluginGeneration: 'generation-1' },
      handler,
    } as ManagerServiceAuthRoute
    const auth = new ManagerServiceAuth({
      profileId: 'work',
      generation: 'host-1',
      targets: async () => [target],
      withRoute: async (_id, callback) => await callback(route),
    })
    const lease = await auth.handle(
      operation('prepare-login', { ...target, pluginGeneration: 'generation-1', bindingId: binding.bindingId }),
    ) as { leaseId: string }
    route = { ...route, owner: { ...route.owner, pluginGeneration: 'generation-2' } }
    expect(await auth.handle(operation('login', { leaseId: lease.leaseId }))).toMatchObject({
      code: 'STALE_GENERATION',
    })
    expect(handler.handle).toHaveBeenCalledTimes(2)
    auth.close()
  })
})
