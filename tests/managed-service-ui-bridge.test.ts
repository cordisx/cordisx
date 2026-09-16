import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'

interface ManagedServiceUIGlobals {
  __cordisxManagedServiceUIRequestV1?: (payload: string) => void
  __cordisxManagedServiceUIReceiveV1?: (payload: string) => void
}

const globals = globalThis as ManagedServiceUIGlobals

afterEach(() => {
  delete globals.__cordisxManagedServiceUIRequestV1
  delete globals.__cordisxManagedServiceUIReceiveV1
})

const token = 'managed-service-ui-test-token'
const profileId = 'default'
const generation = 'runtime-7'
const owner = { pluginId: 'cli-proxy-api', pluginGeneration: 'plugin-3' }

describe('browser managed service UI bridge', () => {
  it('sends a get request and returns the Host response', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)

    const promise = bridge.request(owner, token, {
      requestId: 'request-get',
      operation: 'get',
      serviceId: 'gateway',
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      version: 1,
      token,
      requestId: 'request-get',
      operation: 'get',
      serviceId: 'gateway',
      scope: { profileId, runtimeGeneration: generation, pluginGeneration: owner.pluginGeneration },
    })
    globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
      requestId: 'request-get',
      ok: true,
      value: { status: 'available', service: { binding: { bindingId: 'binding-9' } } },
    }))

    await expect(promise).resolves.toEqual({ status: 'available', service: { binding: { bindingId: 'binding-9' } } })
    bridge.dispose()
  })

  it('sends a snapshot request with binding', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const binding = {
      bindingId: 'binding-9',
      identity: {
        source: 'https://plugins.example.test/cli-proxy-api',
        pluginId: owner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }

    const promise = bridge.request(owner, token, {
      requestId: 'request-snapshot',
      operation: 'snapshot',
      serviceId: 'gateway',
      binding,
    })
    expect(requests[0]).toMatchObject({
      operation: 'snapshot',
      binding: { bindingId: 'binding-9' },
    })
    globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
      requestId: 'request-snapshot',
      ok: true,
      value: { status: 'available', projection: {} },
    }))

    await expect(promise).resolves.toEqual({ status: 'available', projection: {} })
    bridge.dispose()
  })

  it('sends a subscribe request with afterSequence', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const binding = {
      bindingId: 'binding-9',
      identity: {
        source: 'https://plugins.example.test/cli-proxy-api',
        pluginId: owner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }

    const promise = bridge.request(owner, token, {
      requestId: 'request-subscribe',
      operation: 'subscribe',
      serviceId: 'gateway',
      binding,
      afterSequence: 0,
    })
    expect(requests[0]).toMatchObject({ operation: 'subscribe', afterSequence: 0 })
    globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
      requestId: 'request-subscribe',
      ok: true,
      value: { status: 'subscribed', subscription: { descriptor: { subscriptionId: 'sub-1' } } },
    }))

    await expect(promise).resolves.toEqual({
      status: 'subscribed',
      subscription: { descriptor: { subscriptionId: 'sub-1' } },
    })
    bridge.dispose()
  })

  it('sends next/closed/unsubscribe with subscriptionId', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const binding = {
      bindingId: 'binding-9',
      identity: {
        source: 'https://plugins.example.test/cli-proxy-api',
        pluginId: owner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }

    for (const operation of ['next', 'closed', 'unsubscribe'] as const) {
      const promise = bridge.request(owner, token, {
        requestId: `request-${operation}`,
        operation,
        serviceId: 'gateway',
        binding,
        subscriptionId: 'sub-1',
      })
      expect(requests[requests.length - 1]).toMatchObject({
        operation,
        subscriptionId: 'sub-1',
      })
      globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
        requestId: `request-${operation}`,
        ok: true,
        value: { status: 'closed' },
      }))
      await expect(promise).resolves.toEqual({ status: 'closed' })
    }
    bridge.dispose()
  })

  it('keeps subscription waits pending beyond the ordinary request timeout', async () => {
    vi.useFakeTimers()
    try {
      const requests: Array<Record<string, unknown>> = []
      globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
        requests.push(JSON.parse(payload) as Record<string, unknown>)
      })
      const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
      const binding = {
        bindingId: 'binding-9',
        identity: {
          source: 'https://plugins.example.test/cli-proxy-api',
          pluginId: owner.pluginId,
          serviceId: 'gateway',
        },
        scope: { profileId, generation },
      }

      const next = bridge.request(owner, token, {
        requestId: 'request-next-long-poll',
        operation: 'next',
        serviceId: 'gateway',
        binding,
        subscriptionId: 'sub-1',
      })
      const closed = bridge.request(owner, token, {
        requestId: 'request-closed-long-poll',
        operation: 'closed',
        serviceId: 'gateway',
        binding,
        subscriptionId: 'sub-1',
      })

      await vi.advanceTimersByTimeAsync(8_001)
      expect(requests).toHaveLength(2)

      globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
        requestId: 'request-next-long-poll',
        ok: true,
        value: { status: 'closed', closed: { reason: 'explicit' } },
      }))
      globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
        requestId: 'request-closed-long-poll',
        ok: true,
        value: { reason: 'explicit' },
      }))

      await expect(next).resolves.toEqual({ status: 'closed', closed: { reason: 'explicit' } })
      await expect(closed).resolves.toEqual({ reason: 'explicit' })
      bridge.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the declared login timeout while ordinary requests stay bounded and disposal cancels login', async () => {
    vi.useFakeTimers()
    try {
      const requests: Array<Record<string, unknown>> = []
      globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
        const request = JSON.parse(payload) as Record<string, unknown>
        requests.push(request)
        if (request.operation === 'get') {
          queueMicrotask(() =>
            globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
              requestId: request.requestId,
              ok: true,
              value: {
                status: 'available',
                service: {
                  $schema:
                    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription.v1.schema.json',
                  contract: 'cordisx.managed-service/v1',
                  schemaVersion: 1,
                  binding: {
                    bindingId: 'binding-login',
                    identity: { pluginId: owner.pluginId, serviceId: 'gateway' },
                    scope: { profileId, generation },
                  },
                  authenticationTimeoutMs: 12_000,
                  capabilities: { logout: true, readCatalog: false, accountControl: false },
                },
              },
            }))
          )
        }
      })
      const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
      const available = await bridge.bind(owner)!.get({ serviceId: 'gateway' })
      expect(available.status).toBe('available')
      if (available.status !== 'available') throw new Error('managed service unavailable')
      const login = available.service.authenticate({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
        contract: 'cordisx.managed-service-login-request/v1',
        schemaVersion: 1,
        requestId: 'login-long',
        binding: available.service.binding,
        action: 'login',
        expectedSequence: 1,
        userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
      })
      const loginRequest = requests.at(-1)!
      await vi.advanceTimersByTimeAsync(8_001)
      globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
        requestId: loginRequest.requestId,
        ok: true,
        value: { status: 'accepted', binding: available.service.binding, stateAt: 'authenticated', sequence: 2 },
      }))
      await expect(login).resolves.toMatchObject({ status: 'accepted', stateAt: 'authenticated' })

      const timedOut = available.service.authenticate({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
        contract: 'cordisx.managed-service-login-request/v1',
        schemaVersion: 1,
        requestId: 'login-timeout',
        binding: available.service.binding,
        action: 'login',
        expectedSequence: 1,
        userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
      })
      const timedOutExpectation = expect(timedOut).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(20_001)
      await timedOutExpectation

      const ordinary = bridge.request(owner, token, {
        requestId: 'ordinary-timeout',
        operation: 'snapshot',
        serviceId: 'gateway',
        binding: available.service.binding,
      })
      const ordinaryExpectation = expect(ordinary).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(8_001)
      await ordinaryExpectation

      const cancelled = available.service.authenticate({
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
        contract: 'cordisx.managed-service-login-request/v1',
        schemaVersion: 1,
        requestId: 'login-cancelled',
        binding: available.service.binding,
        action: 'login',
        expectedSequence: 1,
        userGesture: { kind: 'explicit-click', at: new Date().toISOString() },
      })
      bridge.dispose()
      await expect(cancelled).rejects.toThrow('disposed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends authenticate/logout/toggleAccount/startOAuth/cancelOAuth with request payload', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const binding = {
      bindingId: 'binding-9',
      identity: {
        source: 'https://plugins.example.test/cli-proxy-api',
        pluginId: owner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }

    const ops = [
      ['authenticate', { action: 'login' }],
      ['logout', { action: 'logout', expectedSequence: 1 }],
      ['toggleAccount', { accountId: 'account-1' }],
      ['startOAuth', { provider: 'codex' }],
      ['cancelOAuth', { sessionId: 'oauth-1' }],
    ] as const

    for (const [operation, requestPayload] of ops) {
      const promise = bridge.request(owner, token, {
        requestId: `request-${operation}`,
        operation,
        serviceId: 'gateway',
        binding,
        request: requestPayload,
      })
      expect(requests[requests.length - 1]).toMatchObject({
        operation,
        request: requestPayload,
      })
      globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
        requestId: `request-${operation}`,
        ok: true,
        value: { status: 'accepted', binding },
      }))
      await expect(promise).resolves.toEqual({ status: 'accepted', binding })
    }
    bridge.dispose()
  })

  it('exposes owner-bound service.logout only when the Host advertises it', async () => {
    const requests: Array<Record<string, unknown>> = []
    const binding = {
      bindingId: 'binding-logout',
      identity: {
        source: 'https://plugins.example.test/cli-proxy-api',
        pluginId: owner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      const request = JSON.parse(payload) as Record<string, unknown>
      requests.push(request)
      queueMicrotask(() =>
        globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
          requestId: request.requestId,
          ok: true,
          value: request.operation === 'get'
            ? {
              status: 'available',
              service: {
                $schema:
                  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription.v1.schema.json',
                contract: 'cordisx.managed-service/v1',
                schemaVersion: 1,
                binding,
                capabilities: { logout: true, readCatalog: false, accountControl: false },
              },
            }
            : { status: 'accepted', requestId: 'logout-1', binding, stateAt: 'logged-out', sequence: 2 },
        }))
      )
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const result = await bridge.bind(owner)!.get({ serviceId: 'gateway' })
    expect(result.status).toBe('available')
    if (result.status !== 'available') throw new Error('managed service unavailable')
    expect(result.service.logout).toBeTypeOf('function')
    const logout = await result.service.logout!({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
      contract: 'cordisx.managed-service-logout-request/v1',
      schemaVersion: 1,
      requestId: 'logout-1',
      binding: result.service.binding,
      action: 'logout',
      expectedSequence: 1,
      userGesture: { kind: 'explicit-click', at: '2026-09-13T07:00:00.000Z' },
    })
    expect(logout).toMatchObject({ status: 'accepted', stateAt: 'logged-out' })
    expect(requests[1]).toMatchObject({
      operation: 'logout',
      binding: { bindingId: binding.bindingId },
      request: { requestId: 'logout-1', expectedSequence: 1 },
    })
    bridge.dispose()
  })

  it('sends pollOAuth with sessionId', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const binding = {
      bindingId: 'binding-9',
      identity: {
        source: 'https://plugins.example.test/cli-proxy-api',
        pluginId: owner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }

    const promise = bridge.request(owner, token, {
      requestId: 'request-poll',
      operation: 'pollOAuth',
      serviceId: 'gateway',
      binding,
      sessionId: 'oauth-1',
    })
    expect(requests[0]).toMatchObject({ operation: 'pollOAuth', sessionId: 'oauth-1' })
    globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
      requestId: 'request-poll',
      ok: true,
      value: { state: 'pending' },
    }))

    await expect(promise).resolves.toEqual({ state: 'pending' })
    bridge.dispose()
  })

  it('rejects when the binding is unavailable', async () => {
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    await expect(bridge.request(owner, token, {
      requestId: 'request-get',
      operation: 'get',
      serviceId: 'gateway',
    })).rejects.toThrow('unavailable')
    bridge.dispose()
  })

  it('rejects after dispose', async () => {
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(() => undefined)
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    bridge.dispose()
    await expect(bridge.request(owner, token, {
      requestId: 'request-get',
      operation: 'get',
      serviceId: 'gateway',
    })).rejects.toThrow('unavailable')
  })

  it('clears pending requests on dispose', async () => {
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(() => undefined)
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    const promise = bridge.request(owner, token, {
      requestId: 'request-get',
      operation: 'get',
      serviceId: 'gateway',
    })
    bridge.dispose()
    await expect(promise).rejects.toThrow('disposed')
  })

  it('returns error responses as rejected promises', async () => {
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      const request = JSON.parse(payload) as { readonly requestId: string }
      queueMicrotask(() =>
        globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
          requestId: request.requestId,
          ok: false,
          code: 'stale-generation',
        }))
      )
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    await expect(bridge.request(owner, token, {
      requestId: 'request-get',
      operation: 'get',
      serviceId: 'gateway',
    })).rejects.toThrow('stale-generation')
    bridge.dispose()
  })

  it('does not bind a registry for another plugin generation', () => {
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token }], profileId, generation)
    expect(bridge.bind(owner)).toBeDefined()
    expect(bridge.bind({ ...owner, pluginGeneration: 'plugin-4' })).toBeUndefined()
    bridge.dispose()
  })

  it('stages, publishes, completes, and rolls back generation capabilities atomically', async () => {
    const oldOwner = owner
    const nextOwner = { ...owner, pluginGeneration: 'plugin-4' }
    const nextToken = 'managed-service-ui-next-token'
    globals.__cordisxManagedServiceUIRequestV1 = vi.fn(payload => {
      const request = JSON.parse(payload) as { readonly requestId: string }
      queueMicrotask(() =>
        globals.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify({
          requestId: request.requestId,
          ok: true,
          value: [],
        }))
      )
    })
    const bridge = BrowserManagedServiceUIBridge.connect([{ ...oldOwner, token }], profileId, generation)

    bridge.stage('transaction-1', [owner.pluginId], [{ ...nextOwner, token: nextToken }])
    expect(bridge.bind(oldOwner)).toBeDefined()
    expect(bridge.bind(nextOwner)).toBeDefined()
    await expect(bridge.nativeProviders()).resolves.toEqual([])

    bridge.publish('transaction-1')
    await expect(bridge.request(nextOwner, nextToken, {
      requestId: 'candidate-after-publish',
      operation: 'nativeProviders',
      serviceId: 'catalog',
    })).resolves.toEqual([])
    bridge.rollback('transaction-1')
    expect(bridge.bind(oldOwner)).toBeDefined()
    expect(bridge.bind(nextOwner)).toBeDefined()
    bridge.completeRollback('transaction-1')
    expect(bridge.bind(nextOwner)).toBeUndefined()

    bridge.stage('transaction-2', [owner.pluginId], [{ ...nextOwner, token: nextToken }])
    bridge.publish('transaction-2')
    bridge.complete('transaction-2')
    expect(bridge.bind(oldOwner)).toBeUndefined()
    expect(bridge.bind(nextOwner)).toBeDefined()
    bridge.dispose()
  })
})
