import type {
  ManagedServiceBindingV1,
  ManagedServiceSourceV1,
  ManagedServiceSubscriptionClosedV1,
  ManagedServiceSubscriptionPageV1,
  ManagedServiceSubscriptionV1,
} from '@cordisx/protocol/managed-service/v1'
import { describe, expect, it, vi } from 'vitest'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

const token = 'managed-service-ui-test-token'
const profileId = 'default'
const generation = 'runtime-7'
const owner = { pluginId: 'cli-proxy-api', pluginGeneration: 'plugin-3' }
const binding: ManagedServiceBindingV1 = {
  bindingId: 'binding-9',
  identity: { source: 'https://plugins.example.test/cli-proxy-api', pluginId: owner.pluginId, serviceId: 'gateway' },
  scope: { profileId, generation },
}
const closed: ManagedServiceSubscriptionClosedV1 = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-close.v1.schema.json',
  contract: 'cordisx.managed-service-subscription-close/v1',
  schemaVersion: 1,
  subscription: { subscriptionId: 'subscription-1', binding, afterSequence: 0, snapshotSequence: 1 },
  closedAt: '2026-09-10T00:00:01.000Z',
  reason: 'explicit',
}
const page: ManagedServiceSubscriptionPageV1 = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-subscription-page.v1.schema.json',
  contract: 'cordisx.managed-service-subscription-page/v1',
  schemaVersion: 1,
  subscription: closed.subscription,
  phase: 'live',
  updates: [],
  nextAfterSequence: 1,
  hasMore: false,
}

function subscription(options: { closed?: Promise<ManagedServiceSubscriptionClosedV1> } = {}): {
  value: ManagedServiceSubscriptionV1
  unsubscribe: ReturnType<typeof vi.fn>
} {
  const unsubscribe = vi.fn(async () => closed)
  const value = {
    descriptor: closed.subscription,
    pages: (async function*() {
      yield page
    })(),
    closed: options.closed ?? new Promise<ManagedServiceSubscriptionClosedV1>(() => undefined),
    unsubscribe,
  } as unknown as ManagedServiceSubscriptionV1
  return { value, unsubscribe }
}

function source(sub: ManagedServiceSubscriptionV1): ManagedServiceSourceV1 {
  return {
    binding,
    snapshot: vi.fn(async () => ({ status: 'available', projection: { binding, sequence: 1 } })),
    subscribe: vi.fn(async () => ({ status: 'subscribed', subscription: sub })),
    authenticate: vi.fn(async request => ({ status: 'accepted', requestId: request.requestId, binding, sequence: 2 })),
    logout: vi.fn(async request => ({
      status: 'accepted',
      requestId: request.requestId,
      binding,
      stateAt: 'logged-out',
      sequence: 2,
    })),
    readCatalog: vi.fn(async () => ({ status: 'available', catalog: { binding, providers: [] } })),
    readAccounts: vi.fn(async () => ({ status: 'available', accounts: { binding, accounts: [] } })),
    toggleAccount: vi.fn(async request => ({ status: 'accepted', requestId: request.requestId, binding })),
    startOAuth: vi.fn(async request => ({ status: 'accepted', requestId: request.requestId, binding })),
    pollOAuth: vi.fn(async sessionId => ({ binding, sessionId, state: 'pending' })),
    cancelOAuth: vi.fn(async request => ({ status: 'accepted', requestId: request.requestId, binding })),
  } as unknown as ManagedServiceSourceV1
}

function envelope(operation: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    token,
    requestId: `request-${operation}`,
    operation,
    scope: { profileId, runtimeGeneration: generation, pluginGeneration: owner.pluginGeneration },
    serviceId: 'gateway',
    ...extra,
  }
}

describe('managed service UI launcher RPC', () => {
  it('exposes native providers only through an authorized live owner and safe projection', async () => {
    const sub = subscription()
    const readNativeProviders = vi.fn(async () => [{ providerId: 'p', pluginId: owner.pluginId, models: [] }])
    const handler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      readNativeProviders,
      services: [{ ...owner, serviceId: 'gateway', loginTimeoutMs: 300_000, source: source(sub.value) }],
    })
    const request = parseManagedServiceUIBindingRequest(envelope('nativeProviders'), handler, owner)
    expect(await handler.handle(owner, request)).toEqual([{ providerId: 'p', pluginId: owner.pluginId, models: [] }])
    await expect(handler.handle(owner, { requestId: 'get-timeout', operation: 'get', serviceId: 'gateway' }))
      .resolves.toMatchObject({ service: { authenticationTimeoutMs: 300_000 } })
    expect(() => parseManagedServiceUIBindingRequest(envelope('nativeProviders', { token: 'wrong' }), handler, owner))
      .toThrow()
    await handler.dispose()
    await expect(handler.handle(owner, request)).rejects.toThrow('disposed')
  })

  it('keeps native provider catalogs and services inside each plugin owner boundary', async () => {
    const traexOwner = { pluginId: 'traex', pluginGeneration: 'traex-generation-1' }
    const traexBinding = {
      bindingId: 'binding-traex',
      identity: {
        source: 'https://plugins.example.test/traex' as const,
        pluginId: traexOwner.pluginId,
        serviceId: 'gateway',
      },
      scope: { profileId, generation },
    }
    const readNativeProviders = vi.fn(async () => [
      {
        providerId: 'plugin:cli-proxy',
        pluginId: owner.pluginId,
        models: [{ id: 'cli-proxy-model', label: 'CLIProxy' }],
      },
      { providerId: 'plugin:traex', pluginId: traexOwner.pluginId, models: [{ id: 'traex-model', label: 'TraeX' }] },
    ])
    const cliProxySource = source(subscription().value)
    const traexSource = {
      ...source(subscription().value),
      binding: traexBinding,
      snapshot: vi.fn(async () => ({
        status: 'available',
        projection: { binding: traexBinding, auth: { state: 'authenticated' } },
      })),
    } as unknown as ManagedServiceSourceV1
    const cliProxyHandler = createManagedServiceUIBridgeHandler({
      token: 'a'.repeat(32),
      profileId,
      generation,
      readNativeProviders,
      services: [{ ...owner, serviceId: 'gateway', source: cliProxySource }],
    })
    const traexHandler = createManagedServiceUIBridgeHandler({
      token: 't'.repeat(32),
      profileId,
      generation,
      readNativeProviders,
      services: [{ ...traexOwner, serviceId: 'gateway', source: traexSource }],
    })

    await expect(cliProxyHandler.handle(owner, {
      requestId: 'cli-proxy-catalog',
      operation: 'nativeProviders',
      serviceId: 'catalog',
    })).resolves.toEqual([
      {
        providerId: 'plugin:cli-proxy',
        pluginId: owner.pluginId,
        models: [{ id: 'cli-proxy-model', label: 'CLIProxy' }],
      },
    ])
    await expect(traexHandler.handle(traexOwner, {
      requestId: 'traex-catalog',
      operation: 'nativeProviders',
      serviceId: 'catalog',
    })).resolves.toEqual([
      { providerId: 'plugin:traex', pluginId: traexOwner.pluginId, models: [{ id: 'traex-model', label: 'TraeX' }] },
    ])
    await expect(cliProxyHandler.handle(traexOwner, {
      requestId: 'foreign-service',
      operation: 'snapshot',
      serviceId: 'gateway',
      binding: traexBinding,
    })).rejects.toThrow('not declared')
    await expect(traexHandler.handle(owner, {
      requestId: 'foreign-binding',
      operation: 'snapshot',
      serviceId: 'gateway',
      binding,
    })).rejects.toThrow('not declared')
    expect(readNativeProviders).toHaveBeenCalledTimes(2)
  })

  it('keeps a healthy owner catalog available when another provider is absent', async () => {
    const healthy = { providerId: 'plugin:cli-proxy', pluginId: owner.pluginId, models: [] }
    const traexOwner = { pluginId: 'traex', pluginGeneration: 'traex-generation-1' }
    const readNativeProviders = vi.fn(async () => [healthy])
    const handler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      readNativeProviders,
      services: [{ ...owner, serviceId: 'gateway', source: source(subscription().value) }],
    })
    const traexBinding = {
      ...binding,
      bindingId: 'binding-traex',
      identity: { ...binding.identity, pluginId: traexOwner.pluginId },
    }
    const traexHandler = createManagedServiceUIBridgeHandler({
      token: 't'.repeat(32),
      profileId,
      generation,
      readNativeProviders,
      services: [{
        ...traexOwner,
        serviceId: 'gateway',
        source: { ...source(subscription().value), binding: traexBinding } as ManagedServiceSourceV1,
      }],
    })

    await expect(handler.handle(owner, {
      requestId: 'partial-catalog',
      operation: 'nativeProviders',
      serviceId: 'catalog',
    })).resolves.toEqual([healthy])
    await expect(traexHandler.handle(traexOwner, {
      requestId: 'missing-provider-catalog',
      operation: 'nativeProviders',
      serviceId: 'catalog',
    })).resolves.toEqual([])
  })
  it('fences the trusted owner, token, profile, generations, declaration, and current binding', async () => {
    const sub = subscription()
    const handler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      services: [{ ...owner, serviceId: 'gateway', source: source(sub.value) }],
    })
    const get = parseManagedServiceUIBindingRequest(envelope('get'), handler, owner)
    await expect(handler.handle(owner, get)).resolves.toMatchObject({
      status: 'available',
      service: { binding, capabilities: { logout: true, readCatalog: true, accountControl: true } },
    })
    expect(() => parseManagedServiceUIBindingRequest({ ...envelope('get'), pluginId: 'other' }, handler, owner))
      .toThrow(/pluginId is unsupported/)
    expect(() => parseManagedServiceUIBindingRequest({ ...envelope('get'), token: 'wrong' }, handler, owner))
      .toThrow(/not authorized/)
    expect(() =>
      parseManagedServiceUIBindingRequest(
        {
          ...envelope('get'),
          scope: { profileId: 'other', runtimeGeneration: generation, pluginGeneration: owner.pluginGeneration },
        },
        handler,
        owner,
      )
    ).toThrow(/stale or spoofed/)
    expect(() =>
      parseManagedServiceUIBindingRequest(
        {
          ...envelope('get'),
          scope: { profileId, runtimeGeneration: generation, pluginGeneration: 'old-plugin' },
        },
        handler,
        owner,
      )
    ).toThrow(/stale or spoofed/)
    await expect(handler.handle(owner, { ...get, serviceId: 'other' })).rejects.toThrow(/not declared/)

    const stale = { ...binding, bindingId: 'binding-old' }
    const snapshot = parseManagedServiceUIBindingRequest(envelope('snapshot', { binding: stale }), handler, owner)
    await expect(handler.handle(owner, snapshot)).rejects.toThrow(/replaced/)
  })

  it('uses subscriptionId for pages and closure, defaults afterSequence, and unsubscribes idempotently', async () => {
    const sub = subscription()
    const managedSource = source(sub.value)
    const handler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      services: [{ ...owner, serviceId: 'gateway', source: managedSource }],
    })
    const subscribe = parseManagedServiceUIBindingRequest(envelope('subscribe', { binding }), handler, owner)
    expect(subscribe).toMatchObject({ operation: 'subscribe', afterSequence: 0 })
    await expect(handler.handle(owner, subscribe)).resolves.toEqual({
      status: 'subscribed',
      subscription: closed.subscription,
    })
    expect(managedSource.subscribe).toHaveBeenCalledWith(0)
    const next = parseManagedServiceUIBindingRequest(
      envelope('pull', { binding, subscriptionId: closed.subscription.subscriptionId }),
      handler,
      owner,
    )
    await expect(handler.handle(owner, next)).resolves.toEqual({ status: 'page', page })
    const unsubscribe = parseManagedServiceUIBindingRequest(
      envelope('unsubscribe', { binding, subscriptionId: closed.subscription.subscriptionId }),
      handler,
      owner,
    )
    await expect(handler.handle(owner, unsubscribe)).resolves.toEqual(closed)
    await expect(handler.handle(owner, unsubscribe)).resolves.toEqual(closed)
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1)
    await expect(handler.handle({ pluginId: 'other', pluginGeneration: owner.pluginGeneration }, unsubscribe))
      .rejects.toThrow(/not declared/)
  })

  it('validates explicit-click requests and brokers the renderer-safe CLIProxy operations', async () => {
    const sub = subscription()
    const managedSource = source(sub.value)
    const handler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      services: [{ ...owner, serviceId: 'gateway', source: managedSource }],
    })
    const at = '2026-09-10T00:00:00.000Z'
    const request = {
      $schema: '',
      contract: '',
      schemaVersion: 1,
      requestId: 'action-1',
      binding,
      userGesture: { kind: 'explicit-click', at },
    }
    expect(() =>
      parseManagedServiceUIBindingRequest(
        envelope('authenticate', {
          binding,
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
            contract: 'cordisx.managed-service-login-request/v1',
            action: 'login',
            expectedSequence: 1,
            userGesture: { kind: 'automatic', at },
          },
        }),
        handler,
        owner,
        Date.parse(at),
      )
    ).toThrow(/explicit-click/)
    expect(() => parseManagedServiceUIBindingRequest(envelope('unknown', { binding }), handler, owner))
      .toThrow(/operation is invalid/)

    for (
      const [operation, extra] of [
        ['authenticate', {
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
            contract: 'cordisx.managed-service-login-request/v1',
            action: 'login',
            expectedSequence: 1,
          },
        }],
        ['logout', {
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
            contract: 'cordisx.managed-service-logout-request/v1',
            action: 'logout',
            expectedSequence: 1,
          },
        }],
        ['toggleAccount', {
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-account-toggle.v1.schema.json',
            contract: 'cordisx.managed-service-cli-proxy-account-toggle/v1',
            accountId: 'account-1',
            disabled: true,
            expectedRevision: 1,
          },
        }],
        ['startOAuth', {
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-oauth-start.v1.schema.json',
            contract: 'cordisx.managed-service-cli-proxy-oauth-start/v1',
            provider: 'codex',
            expectedRevision: 1,
          },
        }],
        ['cancelOAuth', {
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-oauth-cancel.v1.schema.json',
            contract: 'cordisx.managed-service-cli-proxy-oauth-cancel/v1',
            sessionId: 'oauth-1',
            expectedRevision: 1,
          },
        }],
      ] as const
    ) {
      const parsed = parseManagedServiceUIBindingRequest(
        envelope(operation, { binding, ...extra }),
        handler,
        owner,
        Date.parse(at),
      )
      await expect(handler.handle(owner, parsed)).resolves.toMatchObject({ status: 'accepted', binding })
    }
    const catalog = parseManagedServiceUIBindingRequest(envelope('readCatalog', { binding }), handler, owner)
    await expect(handler.handle(owner, catalog)).resolves.toMatchObject({ catalog: { binding } })
    const accounts = parseManagedServiceUIBindingRequest(envelope('readAccounts', { binding }), handler, owner)
    await expect(handler.handle(owner, accounts)).resolves.toMatchObject({ accounts: { binding } })
    const poll = parseManagedServiceUIBindingRequest(
      envelope('pollOAuth', { binding, sessionId: 'oauth-1' }),
      handler,
      owner,
    )
    await expect(handler.handle(owner, poll)).resolves.toMatchObject({ binding })

    expect(() =>
      parseManagedServiceUIBindingRequest(
        envelope('authenticate', {
          binding,
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
            contract: 'cordisx.managed-service-login-request/v1',
            action: 'login',
            expectedSequence: 1,
            secret: 'forbidden',
          },
        }),
        handler,
        owner,
        Date.parse(at),
      )
    ).toThrow(/secret is unsupported/)
    expect(() =>
      parseManagedServiceUIBindingRequest(
        envelope('authenticate', {
          binding,
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-login-request.v1.schema.json',
            contract: 'cordisx.managed-service-login-request/v1',
            action: 'logout',
            expectedSequence: 1,
          },
        }),
        handler,
        owner,
        Date.parse(at),
      )
    ).toThrow(/authentication action is invalid/)
    expect(() =>
      parseManagedServiceUIBindingRequest(
        envelope('logout', {
          binding,
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
            contract: 'cordisx.managed-service-logout-request/v1',
            action: 'logout',
            expectedSequence: -1,
          },
        }),
        handler,
        owner,
        Date.parse(at),
      )
    ).toThrow(/expectedSequence is invalid/)
    expect(() =>
      parseManagedServiceUIBindingRequest(
        envelope('logout', {
          binding,
          request: {
            ...request,
            $schema:
              'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-logout-request.v1.schema.json',
            contract: 'cordisx.managed-service-logout-request/v1',
            action: 'login',
            expectedSequence: 1,
          },
        }),
        handler,
        owner,
        Date.parse(at),
      )
    ).toThrow(/logout action is invalid/)
  })

  it('disposes every owner subscription without returning the Host source or runtime handles', async () => {
    const first = subscription()
    const managedSource = source(first.value) as ManagedServiceSourceV1 & { secret?: string; runtimeHandle?: object }
    managedSource.secret = 'must-not-cross'
    managedSource.runtimeHandle = { port: 4312 }
    const handler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      services: [{ ...owner, serviceId: 'gateway', source: managedSource }],
    })
    const get = parseManagedServiceUIBindingRequest(envelope('get'), handler, owner)
    const result = await handler.handle(owner, get)
    expect(JSON.stringify(result)).not.toContain('must-not-cross')
    expect(JSON.stringify(result)).not.toContain('4312')
    await handler.handle(owner, parseManagedServiceUIBindingRequest(envelope('subscribe', { binding }), handler, owner))
    await handler.disposeOwner(owner)
    expect(first.unsubscribe).toHaveBeenCalledTimes(1)
    await expect(handler.handle(owner, get)).rejects.toThrow('not declared')
    await expect(handler.handle(owner, {
      requestId: 'retired-catalog',
      operation: 'nativeProviders',
      serviceId: 'catalog',
    })).rejects.toThrow('unavailable')

    const second = subscription()
    const secondHandler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      services: [{ ...owner, serviceId: 'gateway', source: source(second.value) }],
    })
    await secondHandler.handle(
      owner,
      parseManagedServiceUIBindingRequest(envelope('subscribe', { binding }), secondHandler, owner),
    )
    await secondHandler.dispose()
    await secondHandler.dispose()
    expect(second.unsubscribe).toHaveBeenCalledTimes(1)
    await expect(secondHandler.handle(owner, get)).rejects.toThrow(/disposed/)

    const naturallyClosed = subscription({ closed: Promise.resolve(closed) })
    const closedHandler = createManagedServiceUIBridgeHandler({
      token,
      profileId,
      generation,
      services: [{ ...owner, serviceId: 'gateway', source: source(naturallyClosed.value) }],
    })
    await closedHandler.handle(
      owner,
      parseManagedServiceUIBindingRequest(envelope('subscribe', { binding }), closedHandler, owner),
    )
    await Promise.resolve()
    const closedRequest = parseManagedServiceUIBindingRequest(
      envelope('closed', { binding, subscriptionId: closed.subscription.subscriptionId }),
      closedHandler,
      owner,
    )
    await expect(closedHandler.handle(owner, closedRequest)).resolves.toEqual(closed)
  })
})
