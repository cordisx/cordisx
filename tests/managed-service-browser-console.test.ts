import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service-ui/v1'
import { describe, expect, it, vi } from 'vitest'
import {
  createManagedServiceBrowserConsoleBroker,
  MANAGED_BROWSER_CONSOLE_RESULT_SCHEMA,
  type ManagedBrowserConsoleBoundary,
  type ManagedServiceBrowserConsoleBroker,
} from '../packages/cli/src/launcher/managed-service-browser-console-broker.js'
import type { ManagedServiceRecord } from '../packages/cli/src/launcher/managed-service-runtime-record.js'
import { ManagedServiceSchemaRegistry } from '../packages/cli/src/launcher/managed-service-schema.js'
import { managedServiceLiveHandler } from '../packages/cli/src/launcher/managed-service-live-handler.js'
import { createManagedServiceUIBridgeHandler } from '../packages/cli/src/launcher/managed-service-ui-rpc.js'

const schemas = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/'
const backend = 'http://127.0.0.1:18200'
const webOrigin = 'http://127.0.0.1:18201'
const browserOrigin = 'http://example.cordisx-console.localhost:18202'
const ticket = 'a'.repeat(32)
const generation = 'service-one'
const operationId = 'console.browser-ticket'
const declaration = {
  contract: 'cordisx.managed-service-browser-console-source/v1',
  serviceId: 'gateway',
  operationId,
  redeemPath: '/auth/managed-console/browser',
}
const owner = { pluginId: 'owner', pluginGeneration: 'plugin-one' }
const binding = {
  bindingId: 'binding',
  identity: { source: 'https://example.test/source', pluginId: owner.pluginId, serviceId: 'gateway' },
  scope: { profileId: 'profile', generation: 'host-one' },
} as const
const scope = () => new AbortController().signal

function fixture(fetch: typeof globalThis.fetch = async () => Response.json({ status: 'issued', ticket })) {
  const ownerLifetime = new AbortController()
  const record = {
    binding: {
      identity: binding.identity,
      registrationHandle: 'msr_one',
      serviceHandle: 'mss_one',
      hostGeneration: 'host-one',
      serviceGeneration: generation,
    },
    definition: {
      serviceId: declaration.serviceId,
      httpAuthentication: { mode: 'authorization-header', scheme: 'Bearer', slot: 'key' },
      operations: [{
        operationId,
        method: 'POST',
        path: '/private/issue',
        requestSchema: schemas + 'managed-service-browser-console-request.v1.schema.json',
        responseSchema: MANAGED_BROWSER_CONSOLE_RESULT_SCHEMA,
        timeoutMs: 2000,
      }],
    },
    state: 'ready',
    health: 'ready',
    origin: backend,
    brokerHandle: 'msb_one',
    disposed: false,
    processOwnership: 'host-owned',
    child: { exitCode: null, signalCode: null },
    lifecycle: new AbortController(),
    secrets: new Map([['key', 'private-service-credential']]),
    schemas: new ManagedServiceSchemaRegistry(),
  } as unknown as ManagedServiceRecord
  const entry = {
    serviceGeneration: generation,
    timeoutMs: 100,
    read: vi.fn(async () => ({ status: 'available', origin: webOrigin } as const)),
  }
  const route = { origin: browserOrigin, dispose: vi.fn() } as const
  const boundary = { open: vi.fn<ManagedBrowserConsoleBoundary['open']>(() => route) }
  const broker = createManagedServiceBrowserConsoleBroker({
    record,
    declaration,
    entry,
    ownerSignal: ownerLifetime.signal,
    current: () => !ownerLifetime.signal.aborted,
    endpointOwned: origin => origin === backend,
    fetch,
  })
  return { broker, entry, route, boundary, ownerLifetime }
}

describe('private managed browser console broker', () => {
  it('issues on the private verified backend and builds only the confined browser origin URL', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ status: 'issued', ticket }))
    const f = fixture(fetch)
    const result = await f.broker.read(generation, scope(), f.boundary)
    expect(f.boundary.open).toHaveBeenCalledWith(expect.objectContaining({ upstream: webOrigin, generation }))
    expect(result).toMatchObject({
      status: 'available',
      url: browserOrigin + declaration.redeemPath + '?ticket=' + ticket,
    })
    const [[destination, init]] = fetch.mock.calls
    expect(String(destination)).toBe(backend + '/private/issue')
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { Authorization: 'Bearer private-service-credential', 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      binding: expect.stringMatching(/^[a-f0-9]{64}$/u),
      origin: webOrigin,
    })
    expect(f.route.dispose).not.toHaveBeenCalled()
  })

  it.each([
    Response.json({ status: 'issued', ticket: 'invalid' }),
    Response.json({ status: 'issued', ticket, cookie: 'credential' }),
    new Response(null, { status: 302, headers: { location: webOrigin } }),
  ])('refuses invalid or redirected issue results and closes the browser route', async response => {
    const f = fixture(async () => response)
    await expect(f.broker.read(generation, scope(), f.boundary)).resolves.toEqual({
      status: 'unavailable',
      reason: 'failed',
    })
    expect(f.route.dispose).toHaveBeenCalledOnce()
  })

  it('never issues when the route cannot be established and stops after owner cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const f = fixture(fetch)
    f.boundary.open.mockReturnValueOnce(undefined)
    await expect(f.broker.read(generation, scope(), f.boundary)).resolves.toEqual({
      status: 'unavailable',
      reason: 'unsupported',
    })
    f.ownerLifetime.abort()
    await expect(f.broker.read(generation, scope(), f.boundary)).resolves.toEqual({
      status: 'unavailable',
      reason: 'owner-unavailable',
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

function handler(broker: ManagedServiceBrowserConsoleBroker, boundary?: ManagedBrowserConsoleBoundary) {
  return createManagedServiceUIBridgeHandler({
    token: 'token',
    profileId: binding.scope.profileId,
    generation: binding.scope.generation,
    browserConsoleBoundary: () => boundary,
    services: [{
      ...owner,
      serviceId: binding.identity.serviceId,
      source: { binding } as ManagedServiceSourceV1,
      webEntry: {
        serviceGeneration: generation,
        timeoutMs: 100,
        read: async () => ({ status: 'available', origin: webOrigin }),
        browserConsole: broker,
      },
    }],
  })
}

const issue = {
  requestId: 'issue-one',
  operation: 'consoleBrowser',
  serviceId: binding.identity.serviceId,
  binding,
  request: { action: 'issue', viewId: 'view-one', serviceGeneration: generation },
} as const

describe('owner-bound managed browser console RPC', () => {
  it('does not advertise or issue without an admitted browser boundary', async () => {
    const f = fixture()
    const rpc = handler(f.broker)
    await expect(rpc.handle(owner, { requestId: 'get', operation: 'get', serviceId: issue.serviceId }))
      .resolves.toMatchObject({ status: 'available' })
    const result = await rpc.handle(owner, { requestId: 'get', operation: 'get', serviceId: issue.serviceId })
    expect(result).not.toHaveProperty('service.authenticatedConsole')
    await expect(rpc.handle(owner, issue)).resolves.toEqual({ status: 'unavailable', reason: 'unsupported' })
    expect(f.entry.read).not.toHaveBeenCalled()
    await rpc.dispose()
  })

  it('does not expose a late browser URL to a disposed owner and retires the exact route', async () => {
    const f = fixture()
    let finish!: (value: Awaited<ReturnType<ManagedServiceBrowserConsoleBroker['read']>>) => void
    const read = vi.fn<ManagedServiceBrowserConsoleBroker['read']>(() =>
      new Promise(resolve => {
        finish = resolve
      })
    )
    const rpc = handler({ read }, f.boundary)
    await expect(rpc.handle({ ...owner, pluginId: 'another' }, issue)).rejects.toThrow('not declared')
    const pending = rpc.handle(owner, issue)
    await rpc.handle(owner, { ...issue, request: { ...issue.request, action: 'retire' } })
    finish({ status: 'available', route: f.route, url: browserOrigin + '/entry?ticket=' + ticket })
    await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'cancelled' })
    expect(f.route.dispose).toHaveBeenCalledOnce()
    await rpc.dispose()
  })

  it('revokes a live lease when its exact CDP document is destroyed', async () => {
    const f = fixture()
    const rpc = handler(f.broker, f.boundary)
    const page = new AbortController()
    await expect(rpc.handle(owner, issue, page.signal)).resolves.toMatchObject({
      status: 'available',
      binding,
      serviceGeneration: generation,
      origin: browserOrigin,
    })
    await rpc.handle(owner, { ...issue, request: { ...issue.request, action: 'retire' } }, scope())
    expect(f.route.dispose).not.toHaveBeenCalled()
    page.abort()
    expect(f.route.dispose).toHaveBeenCalledOnce()
    await rpc.dispose()
  })

  it('publishes only a browser entry on the adopted production UI route when no native mount exists', async () => {
    const f = fixture()
    const observation = createManagedServiceUIBridgeHandler({
      token: 'fixture-token',
      profileId: binding.scope.profileId,
      generation: binding.scope.generation,
      services: [],
    })
    const live = managedServiceLiveHandler(
      observation,
      () => [{
        ...owner,
        serviceId: binding.identity.serviceId,
        source: { binding } as ManagedServiceSourceV1,
        webEntry: {
          serviceGeneration: generation,
          timeoutMs: 100,
          read: async () => ({ status: 'available', origin: webOrigin }),
          browserConsole: f.broker,
        },
      }],
      async () => [],
      undefined,
      () => f.boundary,
    )
    try {
      await expect(live.handle(owner, { requestId: 'get', operation: 'get', serviceId: issue.serviceId }))
        .resolves.toMatchObject({
          service: { authenticatedConsole: { serviceGeneration: generation, nativeMount: false, browserEntry: true } },
        })
      await expect(live.handle(owner, issue, scope())).resolves.toEqual({
        status: 'available',
        binding,
        serviceGeneration: generation,
        origin: browserOrigin,
        url: browserOrigin + declaration.redeemPath + '?ticket=' + ticket,
      })
    } finally {
      await live.dispose()
    }
    expect(f.route.dispose).toHaveBeenCalledOnce()
  })
})
