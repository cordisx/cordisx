import { describe, expect, it, vi } from 'vitest'
import { createManagerManagedServiceUIBridge } from '../packages/cli/src/cli/manager-managed-service-ui.js'
import type { ManagerRendererChannelContext } from '../packages/cli/src/cli/manager-renderer-sessions.js'

const ownerToken = 'owner-private-' + 'a'.repeat(64)
const consoleOrigin = `http://console-${'a'.repeat(32)}.cordisx-console.localhost:12345`
const ticket = 'b'.repeat(32)
const binding = {
  bindingId: 'service-binding',
  identity: { source: 'https://example.test/plugins', pluginId: 'example', serviceId: 'gateway' },
  scope: { profileId: 'work', generation: 'runtime-1' },
}
const ownerWebBinding = { ...binding, bindingId: 'owner-web-binding' }
const web = {
  contract: 'cordisx.managed-service-web-entry/v1',
  binding: ownerWebBinding,
  serviceGeneration: 'service-1',
  timeoutMs: 5_000,
}
const consoleDescriptor = {
  contract: 'cordisx.managed-service-console/v1',
  serviceGeneration: 'service-1',
  nativeMount: false,
  browserEntry: true,
}
const descriptor = {
  status: 'available',
  service: {
    $schema: 'https://example.test/service',
    contract: 'cordisx.managed-service/v1',
    schemaVersion: 1,
    binding,
    webEntry: web,
    authenticatedConsole: consoleDescriptor,
    capabilities: { logout: false, readCatalog: true },
  },
}
const webResult = (status: 'available' | 'unavailable') => ({
  contract: 'cordisx.managed-service-web-entry-result/v1',
  binding: ownerWebBinding,
  serviceGeneration: 'service-1',
  status,
  ...(status === 'available' ? { origin: 'http://127.0.0.1:12345' } : { code: 'cancelled' }),
})

function fixture() {
  const handle = vi.fn(async (raw: string, _signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const input = JSON.parse(raw)
    const value = input.operation === 'get'
      ? descriptor
      : input.operation === 'consoleBrowser'
      ? input.request.action === 'issue'
        ? {
          status: 'available',
          binding,
          serviceGeneration: 'service-1',
          origin: consoleOrigin,
          url: `${consoleOrigin}/auth/browser?ticket=${ticket}`,
        }
        : { status: 'unavailable', reason: 'cancelled' }
      : webResult(input.operation === 'readWebEntry' ? 'available' : 'unavailable')
    return { requestId: input.requestId, ok: true, value }
  })
  const bridge = createManagerManagedServiceUIBridge({
    profileId: 'work',
    runtimeGeneration: 'runtime-1',
    ownerGeneration: 'owner-1',
    ownerCurrent: () => true,
    readLifecycleFence: () => 1,
    browserConsoleOrigins: [consoleOrigin],
    runtime: {
      capabilities: () => [{ pluginId: 'example', pluginGeneration: 'plugin-1', token: ownerToken }],
      managedServiceUI: { handleBindingValue: handle },
    },
  })
  const context = (id: string): ManagerRendererChannelContext => ({
    profileId: 'work',
    rendererId: id.repeat(64),
    ownerGeneration: 'owner-1',
    signal: new AbortController().signal,
    admitted: true,
  })
  const request = (token: string, operation: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      version: 1,
      token,
      requestId: 'request-1',
      operation,
      scope: { profileId: 'work', runtimeGeneration: 'runtime-1', pluginGeneration: 'plugin-1' },
      serviceId: 'gateway',
      ...extra,
    })
  return { bridge, handle, context, request }
}

describe('standalone Manager managed web entry', () => {
  it('projects separate renderer bindings and a generation-bound browser route', async () => {
    const f = fixture()
    const a = f.context('1')
    const b = f.context('2')
    const aToken = f.bridge.projectInitial(a)[0]!.token
    const bToken = f.bridge.projectInitial(b)[0]!.token
    const aGet = await f.bridge.channel.prepare(f.request(aToken, 'get'), a).dispatch() as any
    const bGet = await f.bridge.channel.prepare(f.request(bToken, 'get'), b).dispatch() as any
    const aWeb = aGet.value.service.webEntry
    const bWeb = bGet.value.service.webEntry
    expect(aWeb.binding.bindingId).not.toBe(ownerWebBinding.bindingId)
    expect(aWeb.binding.bindingId).not.toBe(bWeb.binding.bindingId)
    expect(aGet.value.service.authenticatedConsole).toEqual(consoleDescriptor)
    const read = (token: string, entry: typeof aWeb) =>
      f.request(token, 'readWebEntry', {
        binding: entry.binding,
        request: {
          contract: 'cordisx.managed-service-web-entry-read/v1',
          binding: entry.binding,
          serviceGeneration: entry.serviceGeneration,
        },
      })
    expect(() => f.bridge.channel.prepare(read(bToken, aWeb), b)).toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    const result = await f.bridge.channel.prepare(read(aToken, aWeb), a).dispatch() as any
    expect(result.value).toMatchObject({ status: 'available', binding: aWeb.binding, origin: 'http://127.0.0.1:12345' })
    const sent = JSON.parse(f.handle.mock.calls.at(-1)![0])
    expect(sent).toMatchObject({ token: ownerToken, binding: ownerWebBinding })
    expect(sent.requestId).not.toBe('request-1')
    expect(JSON.stringify(result)).not.toContain(ownerToken)
    const issue = f.request(aToken, 'consoleBrowser', {
      binding,
      request: { action: 'issue', viewId: 'view-1', serviceGeneration: 'service-1' },
    })
    expect(await f.bridge.channel.prepare(issue, a).dispatch()).toMatchObject({
      ok: true,
      value: { status: 'available', origin: consoleOrigin },
    })
    const ownerViewId = JSON.parse(f.handle.mock.calls.at(-1)![0]).request.viewId
    expect(ownerViewId).not.toBe('view-1')
    f.bridge.retire(a)
    expect(await f.bridge.waitForRetirement(a.rendererId)).toBe(true)
    expect(
      f.handle.mock.calls.map(call => JSON.parse(call[0])).some(call =>
        call.operation === 'consoleBrowser' && call.request.action === 'retire' && call.request.viewId === ownerViewId
      ),
    ).toBe(true)
    f.bridge.dispose()
  })

  it('cancels only the requesting renderer and drains pending reads at retirement', async () => {
    const f = fixture()
    const pending = new Map<string, (value: Record<string, unknown>) => void>()
    f.handle.mockImplementation(async raw => {
      const input = JSON.parse(raw)
      if (input.operation === 'get') return { requestId: input.requestId, ok: true, value: descriptor }
      if (input.operation === 'readWebEntry') {
        return await new Promise(resolve => pending.set(input.requestId, resolve))
      }
      if (input.operation === 'cancelWebEntry') {
        pending.get(input.targetRequestId)?.({
          requestId: input.targetRequestId,
          ok: true,
          value: webResult('unavailable'),
        })
        return { requestId: input.requestId, ok: true, value: webResult('unavailable') }
      }
      throw new Error('unexpected operation')
    })
    const a = f.context('1')
    const token = f.bridge.projectInitial(a)[0]!.token
    const get = await f.bridge.channel.prepare(f.request(token, 'get'), a).dispatch() as any
    const entry = get.value.service.webEntry
    const readRequest = {
      contract: 'cordisx.managed-service-web-entry-read/v1',
      binding: entry.binding,
      serviceGeneration: entry.serviceGeneration,
    }
    const reading = f.bridge.channel.prepare(
      f.request(token, 'readWebEntry', { binding: entry.binding, request: readRequest }),
      a,
    ).dispatch()
    const cancelled = await f.bridge.channel.prepare(
      f.request(token, 'cancelWebEntry', {
        requestId: 'cancel-1',
        binding: entry.binding,
        request: readRequest,
        targetRequestId: 'request-1',
      }),
      a,
    ).dispatch()
    expect(cancelled).toMatchObject({ ok: true, value: { status: 'unavailable', code: 'cancelled' } })
    expect(await reading).toMatchObject({ ok: true, value: { status: 'unavailable', binding: entry.binding } })
    const ownerCancel = JSON.parse(f.handle.mock.calls.at(-1)![0])
    expect(ownerCancel.targetRequestId).not.toBe('request-1')
    const next = f.bridge.channel.prepare(
      f.request(token, 'readWebEntry', {
        requestId: 'request-2',
        binding: entry.binding,
        request: readRequest,
      }),
      a,
    ).dispatch()
    f.bridge.retire(a)
    await expect(next).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    expect(await f.bridge.waitForRetirement(a.rendererId)).toBe(true)
    f.bridge.dispose()
  })

  it('rejects a browser route outside the owner gateway', async () => {
    const f = fixture()
    const a = f.context('1')
    const token = f.bridge.projectInitial(a)[0]!.token
    await f.bridge.channel.prepare(f.request(token, 'get'), a).dispatch()
    f.handle.mockImplementationOnce(async raw => {
      const input = JSON.parse(raw)
      return {
        requestId: input.requestId,
        ok: true,
        value: {
          status: 'available',
          binding,
          serviceGeneration: 'service-1',
          origin: 'http://127.0.0.1:9',
          url: 'http://127.0.0.1:9/',
        },
      }
    })
    const issue = f.request(token, 'consoleBrowser', {
      binding,
      request: { action: 'issue', viewId: 'view-1', serviceGeneration: 'service-1' },
    })
    await expect(f.bridge.channel.prepare(issue, a).dispatch()).rejects.toThrow('MANAGED_SERVICE_UI_UNAVAILABLE')
    f.bridge.dispose()
  })
})
