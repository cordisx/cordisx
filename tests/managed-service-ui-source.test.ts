import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createManagedServiceSource } from '../packages/cli/src/launcher/managed-service-ui-source.js'
import type {
  ManagedServiceControlResultV1,
  ManagedServiceProjectionV1 as RuntimeManagedServiceProjectionV1,
  ManagedServiceRegistrationHandleV1,
} from '@cordisx/protocol/managed-service-runtime/v1'
import type {
  ManagedServiceLoginRequestV1,
  ManagedServiceLoginResultV1,
  ManagedServiceLogoutRequestV1,
  ManagedServiceLogoutResultV1,
  ManagedServiceProjectionV1,
  ManagedServiceSnapshotResultV1,
  ManagedServiceSubscribeResultV1,
} from '@cordisx/protocol/managed-service/v1'

const DEFINITION_SCHEMA =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-definition.v1.schema.json'

function runtimeProjection(
  overrides: Partial<RuntimeManagedServiceProjectionV1> = {},
): RuntimeManagedServiceProjectionV1 {
  return Object.freeze({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-projection.v1.schema.json',
    contract: 'cordisx.managed-service-projection/v1',
    schemaVersion: 1,
    binding: Object.freeze({
      registrationHandle: 'msr_test' as `msr_${string}`,
      serviceHandle: 'mss_test' as `mss_${string}`,
      identity: Object.freeze({
        source: 'https://plugins.example.test/test-plugin' as `https://${string}`,
        pluginId: 'test-plugin',
        serviceId: 'test-service',
      }),
      hostGeneration: 'host-one',
      serviceGeneration: 'svc-gen',
    }),
    state: 'ready',
    health: 'ready',
    processOwnership: 'host-owned',
    configuration: Object.freeze({ state: 'not-required' as const }),
    authentication: Object.freeze({ state: 'not-required' as const }),
    httpAuthorization: Object.freeze({ state: 'not-required' as const }),
    ...overrides,
  })
}

function fakeRegistrationHandle(
  projection: RuntimeManagedServiceProjectionV1,
  authenticateResult: ManagedServiceControlResultV1 = {
    status: 'accepted',
    projection,
  },
): ManagedServiceRegistrationHandleV1 {
  return {
    binding: projection.binding,
    revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    inspect: vi.fn().mockResolvedValue(projection),
    authenticate: vi.fn().mockResolvedValue(authenticateResult),
    ensureReady: vi.fn().mockResolvedValue({ status: 'ready', projection }),
    restart: vi.fn(),
    publishNativeProvider: vi.fn(),
    dispose: vi.fn(),
  }
}

function baseOptions(overrides: Partial<{
  profileId: string
  runtimeGeneration: string
  healthIntervalMs: number
  authenticationMode: 'none' | 'host-secret' | 'cli'
  logoutAvailable: boolean
}> = {}) {
  const projection = runtimeProjection()
  return {
    profileId: overrides.profileId ?? 'default',
    runtimeGeneration: overrides.runtimeGeneration ?? 'runtime-1',
    registrationHandle: fakeRegistrationHandle(projection),
    healthIntervalMs: overrides.healthIntervalMs ?? 250,
    displayName: 'Test Service',
    serviceKind: 'managed-backend',
    pluginId: 'test-plugin',
    pluginGeneration: 'plugin-1',
    serviceId: 'test-service',
    source: 'https://plugins.example.test/test-plugin' as `https://${string}`,
    authenticationMode: overrides.authenticationMode ?? 'none',
    logoutAvailable: overrides.logoutAvailable ?? false,
  }
}

describe('managed service UI source adapter', () => {
  it('returns a snapshot with a safe projection', async () => {
    const options = baseOptions()
    const source = createManagedServiceSource(options)

    const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    expect(result.status).toBe('available')
    expect(result.projection.binding.bindingId).toBeTypeOf('string')
    expect(result.projection.binding.bindingId).not.toContain('msr_')
    expect(result.projection.binding.bindingId).not.toContain('mss_')
    expect(result.projection.binding.identity.pluginId).toBe('test-plugin')
    expect(result.projection.binding.identity.serviceId).toBe('test-service')
    expect(result.projection.binding.scope.profileId).toBe('default')
    expect(result.projection.binding.scope.generation).toBe('runtime-1')
    expect(result.projection.readiness).toBe('ready')
    expect(result.projection.health.level).toBe('healthy')
    expect(result.projection.auth.state).toBe('missing')
    expect(result.projection.diagnostics).toEqual([])
    expect(result.projection.capabilities.explicitLogin).toBe(false)
    expect(result.projection.capabilities.logout).toBe(false)
    expect(result.projection.userAction.available).toBe(false)
    // No internal sensitive fields
    const serialized = JSON.stringify(result.projection)
    expect(serialized).not.toContain('registrationHandle')
    expect(serialized).not.toContain('serviceHandle')
    expect(serialized).not.toContain('brokerHandle')
    expect(serialized).not.toContain('origin')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('port')
  })

  it('maps readiness from runtime state', async () => {
    const states: Array<[RuntimeManagedServiceProjectionV1['state'], string]> = [
      ['registered', 'starting'],
      ['preparing', 'starting'],
      ['ready', 'ready'],
      ['authentication-required', 'stopped'],
      ['failed', 'failed'],
      ['stopped', 'stopped'],
      ['disposed', 'stopped'],
    ]
    for (const [state, expected] of states) {
      const projection = runtimeProjection({ state, health: state === 'ready' ? 'ready' : 'stopped' })
      const options = { ...baseOptions(), registrationHandle: fakeRegistrationHandle(projection) }
      const source = createManagedServiceSource(options)
      const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      expect(result.projection.readiness).toBe(expected)
    }
  })

  it('maps health levels', async () => {
    const levels: Array<[RuntimeManagedServiceProjectionV1['health'], string]> = [
      ['starting', 'warning'],
      ['ready', 'healthy'],
      ['degraded', 'warning'],
      ['unhealthy', 'critical'],
      ['stopped', 'critical'],
    ]
    for (const [health, expected] of levels) {
      const projection = runtimeProjection({ health })
      const options = { ...baseOptions(), registrationHandle: fakeRegistrationHandle(projection) }
      const source = createManagedServiceSource(options)
      const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
      expect(result.projection.health.level).toBe(expected)
    }
  })

  it('maps auth state from authentication', async () => {
    const projection = runtimeProjection({
      authentication: Object.freeze({ state: 'configured', sessionHandle: 'msa_test' as `msa_${string}` }),
    })
    const options = {
      ...baseOptions({ authenticationMode: 'cli' }),
      registrationHandle: fakeRegistrationHandle(projection),
    }
    const source = createManagedServiceSource(options)
    const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    expect(result.projection.auth.state).toBe('authenticated')
  })

  it('includes diagnostics when present', async () => {
    const projection = runtimeProjection({
      diagnostic: Object.freeze({ code: 'health-check-failed', retryable: true, message: 'unreachable' }),
    })
    const options = { ...baseOptions(), registrationHandle: fakeRegistrationHandle(projection) }
    const source = createManagedServiceSource(options)
    const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    expect(result.projection.diagnostics).toHaveLength(1)
    expect(result.projection.diagnostics[0].code).toBe('health-check-failed')
    expect(result.projection.diagnostics[0].retryable).toBe(true)
  })

  it('exposes logout only when the declared cli helper exists', async () => {
    const projection = runtimeProjection({
      state: 'authentication-required',
      authentication: Object.freeze({ state: 'missing' }),
    })
    const options = {
      ...baseOptions({ authenticationMode: 'cli', logoutAvailable: true }),
      registrationHandle: fakeRegistrationHandle(projection),
    }
    const source = createManagedServiceSource(options)
    const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    expect(result.projection.capabilities.explicitLogin).toBe(true)
    expect(result.projection.capabilities.logout).toBe(true)
    expect(result.projection.userAction.available).toBe(true)
    expect(result.projection.userAction.reason).toBe('ready')
  })

  it('logs out through the runtime handle and projects the explicit logged-out state', async () => {
    const authenticated = runtimeProjection({
      authentication: Object.freeze({ state: 'configured', sessionHandle: 'msa_test' as `msa_${string}` }),
    })
    const loggedOut = runtimeProjection({
      state: 'authentication-required',
      health: 'stopped',
      authentication: Object.freeze({ state: 'missing' }),
    })
    const handle = fakeRegistrationHandle(authenticated, { status: 'accepted', projection: loggedOut })
    const options = {
      ...baseOptions({ authenticationMode: 'cli', logoutAvailable: true }),
      registrationHandle: handle,
    }
    const source = createManagedServiceSource(options)
    const request: ManagedServiceLogoutRequestV1 = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-1',
      binding: source.binding,
      action: 'logout',
      expectedSequence: 0,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    }

    const result = await source.logout!(request) as Extract<ManagedServiceLogoutResultV1, { status: 'accepted' }>
    expect(result).toMatchObject({ status: 'accepted', stateAt: 'logged-out', sequence: 1 })
    expect(handle.authenticate).toHaveBeenCalledWith('logout')
    vi.mocked(handle.inspect).mockResolvedValue(loggedOut)
    const snapshot = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    expect(snapshot.projection).toMatchObject({
      readiness: 'stopped',
      auth: { state: 'logged-out' },
      health: { level: 'critical' },
      capabilities: { logout: true },
    })
  })

  it('returns unavailable without invoking the runtime when no logout helper is declared', async () => {
    const options = baseOptions({ authenticationMode: 'cli' })
    const source = createManagedServiceSource(options)
    const snapshot = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
    const result = await source.logout({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-unavailable',
      binding: source.binding,
      action: 'logout',
      expectedSequence: snapshot.projection.sequence,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    })
    expect(result).toMatchObject({
      status: 'unavailable',
      error: { code: 'service-unavailable' },
    })
    expect(options.registrationHandle.authenticate).not.toHaveBeenCalled()
  })

  it('rejects a stale logout projection sequence before invoking the runtime', async () => {
    const options = baseOptions({ authenticationMode: 'cli', logoutAvailable: true })
    const source = createManagedServiceSource(options)
    await source.snapshot()
    const result = await source.logout({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-stale',
      binding: source.binding,
      action: 'logout',
      expectedSequence: 0,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    })
    expect(result).toMatchObject({ status: 'denied', error: { code: 'stale-revision' } })
    expect(options.registrationHandle.authenticate).not.toHaveBeenCalled()
  })

  it('authenticate succeeds with login action', async () => {
    const projection = runtimeProjection()
    const authResult: ManagedServiceControlResultV1 = { status: 'accepted', projection }
    const handle = fakeRegistrationHandle(projection, authResult)
    const options = { ...baseOptions({ authenticationMode: 'cli' }), registrationHandle: handle }
    const source = createManagedServiceSource(options)

    const loginRequest: ManagedServiceLoginRequestV1 = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
      contract: 'cordisx.managed-service-login-request/v1',
      schemaVersion: 1,
      requestId: 'req-1',
      binding: source.binding,
      action: 'login',
      expectedSequence: 0,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    }

    const result = await source.authenticate(loginRequest) as Extract<
      ManagedServiceLoginResultV1,
      { status: 'accepted' }
    >
    expect(result.status).toBe('accepted')
    expect(result.stateAt).toBe('authenticated')
    expect(handle.authenticate).toHaveBeenCalledWith('login')
  })

  it('authenticate rejects with wrong binding', async () => {
    const projection = runtimeProjection()
    const options = {
      ...baseOptions({ authenticationMode: 'cli' }),
      registrationHandle: fakeRegistrationHandle(projection),
    }
    const source = createManagedServiceSource(options)

    const loginRequest: ManagedServiceLoginRequestV1 = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
      contract: 'cordisx.managed-service-login-request/v1',
      schemaVersion: 1,
      requestId: 'req-1',
      binding: { ...source.binding, bindingId: 'wrong-id' },
      action: 'login',
      expectedSequence: 0,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    }

    const result = await source.authenticate(loginRequest) as Extract<ManagedServiceLoginResultV1, { status: 'failed' }>
    expect(result.status).toBe('failed')
    expect(result.error.code).toBe('binding-replaced')
  })

  it('subscribe creates a live subscription', async () => {
    const projection = runtimeProjection()
    const options = { ...baseOptions({ healthIntervalMs: 50 }), registrationHandle: fakeRegistrationHandle(projection) }
    const source = createManagedServiceSource(options)

    const result = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
    expect(result.status).toBe('subscribed')
    expect(result.subscription.descriptor.subscriptionId).toBeTypeOf('string')
    expect(result.subscription.descriptor.binding.bindingId).toBe(source.binding.bindingId)
    expect(result.subscription.descriptor.afterSequence).toBe(0)

    // Pull the first page (replay phase with snapshot-replaced)
    const pages = result.subscription.pages[Symbol.asyncIterator]()
    const page = await pages.next()
    expect(page.done).toBe(false)
    expect(page.value.phase).toBe('replay')
    expect(page.value.updates).toHaveLength(1)
    expect(page.value.updates[0].kind).toBe('snapshot-replaced')

    // Unsubscribe
    const closed = await result.subscription.unsubscribe()
    expect(closed.reason).toBe('explicit')
  })

  it('accepts logout after unchanged polling without weakening stale sequence rejection', async () => {
    vi.useFakeTimers()
    try {
      const projection = runtimeProjection({ authentication: Object.freeze({ state: 'missing' }) })
      const handle = fakeRegistrationHandle(projection)
      const source = createManagedServiceSource({
        ...baseOptions({ healthIntervalMs: 10, authenticationMode: 'cli', logoutAvailable: true }),
        registrationHandle: handle,
      })
      const subscribed = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
      const pages = subscribed.subscription.pages[Symbol.asyncIterator]()
      const firstPage = pages.next()
      await vi.advanceTimersByTimeAsync(10)
      const page = await firstPage
      expect(page.done).toBe(false)
      await vi.advanceTimersByTimeAsync(10)
      expect(handle.inspect).toHaveBeenCalledTimes(2)

      const result = await source.logout({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
        contract: 'cordisx.managed-service-logout-request/v1',
        schemaVersion: 1,
        requestId: 'logout-after-unchanged-poll',
        binding: source.binding,
        action: 'logout',
        expectedSequence: page.value.nextAfterSequence,
        userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
      })
      expect(result).toMatchObject({ status: 'accepted', stateAt: 'logged-out' })
      expect(handle.authenticate).toHaveBeenCalledWith('logout')
      await subscribed.subscription.unsubscribe()
    } finally {
      vi.useRealTimers()
    }
  })

  it('subscription detects state changes via polling', async () => {
    const initialProjection = runtimeProjection({ state: 'authentication-required' as const })
    const readyProjection = runtimeProjection({ state: 'ready' as const })

    let callCount = 0
    const handle = {
      ...fakeRegistrationHandle(initialProjection),
      inspect: vi.fn().mockImplementation(async () => {
        callCount += 1
        return callCount <= 2 ? initialProjection : readyProjection
      }),
    }

    const options = {
      ...baseOptions({ healthIntervalMs: 50, authenticationMode: 'cli' as const }),
      registrationHandle: handle,
    }
    const source = createManagedServiceSource(options)

    const result = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
    const pages = result.subscription.pages[Symbol.asyncIterator]()

    // First page: replay snapshot
    const page1 = await pages.next()
    expect(page1.value.phase).toBe('replay')
    expect(page1.value.updates[0].kind).toBe('snapshot-replaced')

    // Second page: live state change
    const page2 = await pages.next()
    expect(page2.value.phase).toBe('live')
    expect(page2.value.updates[0].kind).toBe('state-changed')
    expect(page2.value.updates[0].delta.readiness).toBe('ready')

    await result.subscription.unsubscribe()
  })

  it('rejects logout against a projection superseded by a visible polling update', async () => {
    const initialProjection = runtimeProjection({
      state: 'authentication-required',
      authentication: Object.freeze({ state: 'missing' }),
    })
    const readyProjection = runtimeProjection({
      state: 'ready',
      authentication: Object.freeze({ state: 'configured', sessionHandle: 'msa_test' as `msa_${string}` }),
    })
    let callCount = 0
    const handle = {
      ...fakeRegistrationHandle(initialProjection),
      inspect: vi.fn().mockImplementation(async () => ++callCount === 1 ? initialProjection : readyProjection),
    }
    const source = createManagedServiceSource({
      ...baseOptions({ healthIntervalMs: 10, authenticationMode: 'cli', logoutAvailable: true }),
      registrationHandle: handle,
    })
    const subscribed = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
    const pages = subscribed.subscription.pages[Symbol.asyncIterator]()
    const first = await pages.next()
    const changed = await pages.next()
    expect(changed.value.updates[0]).toMatchObject({ kind: 'state-changed', sequence: 2 })

    const result = await source.logout({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-before-visible-change',
      binding: source.binding,
      action: 'logout',
      expectedSequence: first.value.nextAfterSequence,
      userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
    })
    expect(result).toMatchObject({ status: 'denied', error: { code: 'stale-revision' } })
    expect(handle.authenticate).not.toHaveBeenCalled()
    await subscribed.subscription.unsubscribe()
  })

  it('subscription emits closed when service is disposed', async () => {
    const initialProjection = runtimeProjection()
    const disposedProjection = runtimeProjection({ state: 'disposed' as const })

    let callCount = 0
    const handle = {
      ...fakeRegistrationHandle(initialProjection),
      inspect: vi.fn().mockImplementation(async () => {
        callCount += 1
        return callCount <= 2 ? initialProjection : disposedProjection
      }),
    }

    const options = { ...baseOptions({ healthIntervalMs: 50 }), registrationHandle: handle }
    const source = createManagedServiceSource(options)

    const result = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
    const closed = await result.subscription.closed
    expect(closed.reason).toBe('service-disposed')
  })

  it('rejects subscription when disposed', async () => {
    const projection = runtimeProjection({ state: 'disposed' as const })
    const options = { ...baseOptions(), registrationHandle: fakeRegistrationHandle(projection) }
    const source = createManagedServiceSource(options)

    const result = await source.snapshot()
    expect(result.status).toBe('available')
    expect((result as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>).projection.readiness).toBe(
      'stopped',
    )
  })

  it('plugin id mismatch throws', () => {
    const options = { ...baseOptions(), pluginId: 'wrong-plugin' }
    expect(() => createManagedServiceSource(options)).toThrow('plugin id mismatch')
  })

  it('service id mismatch throws', () => {
    const options = { ...baseOptions(), serviceId: 'wrong-service' }
    expect(() => createManagedServiceSource(options)).toThrow('service id mismatch')
  })
})

it('extensionFactory with readCatalog exposes readCatalog capability and method', async () => {
  const projection = runtimeProjection()
  const catalogResult = { providers: [{ id: 'traex', models: [{ id: 'model-1', name: 'Model 1' }] }] }
  const extension = {
    readCatalog: vi.fn().mockResolvedValue(catalogResult),
  }
  const options = {
    ...baseOptions(),
    registrationHandle: fakeRegistrationHandle(projection),
    extensionFactory: () => extension,
  }
  const source = createManagedServiceSource(options)
  const result = await source.snapshot() as Extract<ManagedServiceSnapshotResultV1, { status: 'available' }>
  expect(result.projection.capabilities.readCatalog).toBe(true)
  // readCatalog should be callable
  const readCatalog = (source as Record<string, unknown>).readCatalog as
    | (() => Promise<unknown>)
    | undefined
  expect(readCatalog).toBeTypeOf('function')
  const catalog = await readCatalog!()
  expect(catalog).toEqual(catalogResult)
  expect(extension.readCatalog).toHaveBeenCalledOnce()
})

it('extensionFactory with account methods exposes them on source', async () => {
  const projection = runtimeProjection()
  const accounts = { accounts: [{ id: 'acct-1', name: 'Account 1' }] }
  const extension = {
    readAccounts: vi.fn().mockResolvedValue(accounts),
    toggleAccount: vi.fn().mockResolvedValue({ status: 'success' }),
    startOAuth: vi.fn().mockResolvedValue({ sessionId: 'sess-1', authUrl: 'https://example.test/auth' }),
    pollOAuth: vi.fn().mockResolvedValue({ status: 'authenticated' }),
    cancelOAuth: vi.fn().mockResolvedValue({ status: 'cancelled' }),
  }
  const options = {
    ...baseOptions({ authenticationMode: 'cli' }),
    registrationHandle: fakeRegistrationHandle(projection),
    extensionFactory: () => extension,
  }
  const source = createManagedServiceSource(options)
  const src = source as Record<string, unknown>

  expect(src.readAccounts).toBeTypeOf('function')
  expect(src.toggleAccount).toBeTypeOf('function')
  expect(src.startOAuth).toBeTypeOf('function')
  expect(src.pollOAuth).toBeTypeOf('function')
  expect(src.cancelOAuth).toBeTypeOf('function')

  const readResult = await (src.readAccounts as () => Promise<unknown>)()
  expect(readResult).toEqual(accounts)

  const toggleResult = await (src.toggleAccount as (req: unknown) => Promise<unknown>)({ accountId: 'acct-1' })
  expect(toggleResult).toEqual({ status: 'success' })

  const oauthResult = await (src.startOAuth as (req: unknown) => Promise<unknown>)({ providerId: 'traex' })
  expect(oauthResult).toEqual({ sessionId: 'sess-1', authUrl: 'https://example.test/auth' })
})

it('extensionFactory without accounts methods does not expose them', async () => {
  const projection = runtimeProjection()
  const options = {
    ...baseOptions({ authenticationMode: 'cli' }),
    registrationHandle: fakeRegistrationHandle(projection),
  }
  const source = createManagedServiceSource(options)
  const src = source as Record<string, unknown>
  expect(src.readCatalog).toBeUndefined()
  expect(src.readAccounts).toBeUndefined()
  expect(src.toggleAccount).toBeUndefined()
  expect(src.startOAuth).toBeUndefined()
  expect(src.pollOAuth).toBeUndefined()
  expect(src.cancelOAuth).toBeUndefined()
})

it('broadcasts an authenticated delta to every live subscription after login succeeds', async () => {
  const missing = runtimeProjection({
    state: 'authentication-required' as const,
    authentication: Object.freeze({ state: 'missing' as const }),
  })
  const configured = runtimeProjection({
    state: 'registered' as const,
    authentication: Object.freeze({ state: 'configured' as const, sessionHandle: 'msa_test' }),
  })
  let authenticateCalled = false
  const handle: ManagedServiceRegistrationHandleV1 = {
    binding: missing.binding,
    revision: 'sha256:' + '0'.repeat(64),
    inspect: vi.fn().mockImplementation(async () => {
      return authenticateCalled ? configured : missing
    }),
    authenticate: vi.fn().mockImplementation(async () => {
      authenticateCalled = true
      return { status: 'accepted' as const, projection: configured }
    }),
    ensureReady: vi.fn(),
    restart: vi.fn(),
    publishNativeProvider: vi.fn(),
    dispose: vi.fn(),
  }
  const source = createManagedServiceSource({
    ...baseOptions({ healthIntervalMs: 10, authenticationMode: 'cli' }),
    registrationHandle: handle,
  })

  const sub1 = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
  const sub2 = await source.subscribe(0) as Extract<ManagedServiceSubscribeResultV1, { status: 'subscribed' }>
  const pages1 = sub1.subscription.pages[Symbol.asyncIterator]()
  const pages2 = sub2.subscription.pages[Symbol.asyncIterator]()

  expect((await pages1.next()).done).toBe(false)
  expect((await pages2.next()).done).toBe(false)

  await new Promise(resolve => setTimeout(resolve, 30))

  const loginResult = await source.authenticate({
    $schema: 'https://schema.test/login.v1.json',
    contract: 'cordisx.managed-service-login-request/v1',
    schemaVersion: 1,
    requestId: 'req-bc',
    binding: source.binding,
    action: 'login',
    expectedSequence: 0,
    userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
  })
  expect((loginResult as { status: string }).status).toBe('accepted')

  await new Promise(resolve => setTimeout(resolve, 0))

  const next1 = await pages1.next()
  const next2 = await pages2.next()
  expect(next1.done).toBe(false)
  expect(next2.done).toBe(false)

  const auth1 = next1.value.updates.find(
    (u: { kind: string }) => u.kind === 'state-changed',
  ) as { delta: { auth: { state: string } } } | undefined
  const auth2 = next2.value.updates.find(
    (u: { kind: string }) => u.kind === 'state-changed',
  ) as { delta: { auth: { state: string } } } | undefined

  expect(auth1).toBeDefined()
  expect(auth2).toBeDefined()
  expect(auth1!.delta.auth.state).toBe('authenticated')
  expect(auth2!.delta.auth.state).toBe('authenticated')
  expect(next1.value.nextAfterSequence).toBe(next1.value.updates.at(-1)?.sequence)
  expect(next2.value.nextAfterSequence).toBe(next2.value.updates.at(-1)?.sequence)

  await sub1.subscription.unsubscribe()
  await sub2.subscription.unsubscribe()
})
