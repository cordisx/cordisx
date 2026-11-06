import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createManagedServiceUIBridgeHandler,
  parseManagedServiceUIBindingRequest,
} from '../packages/cli/src/launcher/managed-service-ui-rpc.js'
import { BrowserManagedServiceUIBridge } from '../packages/cli/src/renderer/managed-service-ui-bridge.js'
import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'

const owner = { pluginId: 'console', pluginGeneration: 'module-one' }
const binding = {
  bindingId: 'ui-one',
  identity: { source: 'https://example.test/plugin' as const, pluginId: owner.pluginId, serviceId: 'gateway' },
  scope: { profileId: 'profile', generation: 'host' },
}
const request = {
  contract: 'cordisx.managed-service-web-entry-read/v1' as const,
  binding,
  serviceGeneration: 'service-one',
}

function setup() {
  let serviceGeneration = 'service-one'
  const read = vi.fn(async (_generation: string, _signal: AbortSignal) => ({
    status: 'available' as const,
    origin: 'http://127.0.0.1:1234' as const,
  }))
  const source = { binding } as ManagedServiceSourceV1
  const value = {
    ...owner,
    serviceId: 'gateway',
    source,
    webEntry: {
      get serviceGeneration() {
        return serviceGeneration
      },
      timeoutMs: 1000,
      read,
    },
  }
  const handler = createManagedServiceUIBridgeHandler({
    token: 'token',
    profileId: 'profile',
    generation: 'host',
    services: [value],
  })
  const requests: Record<string, unknown>[] = []
  globalThis.__cordisxManagedServiceUIRequestV1 = payload => {
    const envelope = JSON.parse(payload)
    requests.push(envelope)
    void (async () => {
      try {
        const parsed = parseManagedServiceUIBindingRequest(envelope, handler, owner)
        const result = await handler.handle(owner, parsed)
        globalThis.__cordisxManagedServiceUIReceiveV1?.(
          JSON.stringify({ requestId: envelope.requestId, ok: true, value: result }),
        )
      } catch {
        globalThis.__cordisxManagedServiceUIReceiveV1?.(
          JSON.stringify({ requestId: envelope.requestId, ok: false, code: 'owner-unavailable' }),
        )
      }
    })()
  }
  const bridge = BrowserManagedServiceUIBridge.connect([{ ...owner, token: 'token' }], 'profile', 'host')
  return {
    value,
    read,
    handler,
    bridge,
    requests,
    rotate: () => {
      serviceGeneration = 'service-two'
    },
    get: async () => {
      const result = await bridge.bind(owner)!.get({ serviceId: 'gateway' })
      if (result.status !== 'available') throw new Error('expected available service')
      return result.service
    },
    close: async () => {
      bridge.dispose()
      await handler.dispose()
    },
  }
}

afterEach(() => {
  delete globalThis.__cordisxManagedServiceUIRequestV1
  delete globalThis.__cordisxManagedServiceUIReceiveV1
})

describe('web entry owner-bound renderer transport', () => {
  it('captures generation once, refuses old handles and permits a fresh get without resetting other service APIs', async () => {
    const f = setup()
    try {
      const old = await f.get()
      expect(old.webEntry?.serviceGeneration).toBe('service-one')
      expect(Object.isFrozen(old.webEntry?.binding.identity)).toBe(true)
      expect(typeof old.snapshot).toBe('function')
      expect(await old.webEntry!.read()).toMatchObject({
        status: 'available',
        binding: old.webEntry!.binding,
        serviceGeneration: 'service-one',
      })
      f.rotate()
      expect(await old.webEntry!.read()).toMatchObject({
        status: 'unavailable',
        code: 'stale-generation',
        serviceGeneration: 'service-one',
      })
      expect(f.read).toHaveBeenCalledTimes(1)
      const fresh = await f.get()
      expect(fresh.webEntry!.binding.bindingId).not.toBe(old.webEntry!.binding.bindingId)
      expect(
        await f.handler.handle(owner, {
          requestId: 'retarget',
          operation: 'readWebEntry',
          serviceId: 'gateway',
          binding: old.webEntry!.binding,
          request: { ...request, binding: old.webEntry!.binding, serviceGeneration: fresh.webEntry!.serviceGeneration },
        }),
      )
        .toMatchObject({ status: 'unavailable', code: 'binding-replaced' })
      expect(await fresh.webEntry!.read()).toMatchObject({ status: 'available', serviceGeneration: 'service-two' })
      expect(
        f.requests.filter(request => request.operation === 'readWebEntry').map(value =>
          (value.request as typeof request).serviceGeneration
        ),
      )
        .toEqual(['service-one', 'service-one', 'service-two'])
    } finally {
      await f.close()
    }
  })

  it('leaves capability absent for an undeclared source and returns unsupported to a forged read', async () => {
    const f = setup()
    try {
      await f.handler.replaceServices(owner, [{ ...owner, serviceId: 'gateway', source: f.value.source }])
      expect((await f.get()).webEntry).toBeUndefined()
      expect(
        await f.handler.handle(owner, {
          requestId: 'forged',
          operation: 'readWebEntry',
          serviceId: 'gateway',
          binding,
          request,
        }),
      )
        .toMatchObject({ status: 'unavailable', code: 'unsupported' })
      expect(f.read).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })

  it('cancels only the caller request and sends no arbitrary source authority', async () => {
    const f = setup()
    const signals: AbortSignal[] = []
    f.read.mockImplementation(async (_generation, signal) => {
      signals.push(signal)
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'available', origin: 'http://127.0.0.1:1234' }
    })
    try {
      const service = await f.get()
      const controller = new AbortController()
      const first = service.webEntry!.read({ signal: controller.signal })
      const second = service.webEntry!.read()
      await vi.waitFor(() => expect(signals).toHaveLength(2))
      controller.abort()
      expect(await first).toMatchObject({ status: 'unavailable', code: 'cancelled' })
      expect(signals[0]!.aborted).toBe(true)
      expect(signals[1]!.aborted).toBe(false)
      expect(f.requests.find(value => value.operation === 'cancelWebEntry')).toBeDefined()
      expect(f.requests.filter(value => value.operation === 'readWebEntry')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ origin: expect.anything() })]),
      )
      await f.handler.disposeOwner(owner)
      expect((await second).status).toBe('unavailable')
      expect(signals[1]!.aborted).toBe(true)
    } finally {
      await f.close()
    }
  })

  it.each(['replace', 'dispose', 'revoke'])('does not publish a late result after %s', async mode => {
    const f = setup()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    f.read.mockImplementation(async () => {
      entered()
      await new Promise<void>(resolve => {
        release = resolve
      })
      return { status: 'available', origin: 'http://127.0.0.1:1234' }
    })
    try {
      const pending = (await f.get()).webEntry!.read()
      await started
      if (mode === 'replace') {
        await f.handler.replaceServices(owner, [{
          ...f.value,
          source: { binding: { ...binding, bindingId: 'ui-two' } } as ManagedServiceSourceV1,
        }])
      }
      if (mode === 'dispose') await f.handler.dispose()
      if (mode === 'revoke') await f.handler.disposeOwner(owner)
      release()
      expect((await pending).status).toBe('unavailable')
    } finally {
      await f.close()
    }
  })

  it.each([{ origin: 'http://127.0.0.1:9999' }, { operationId: 'arbitrary' }, { token: 'foreign' }, {
    request: { ...request, arbitrary: true },
  }, { request: { ...request, binding: { ...binding, bindingId: 'foreign' } } }])(
    'rejects forged wire fields',
    extra => {
      const f = setup()
      const wire = {
        version: 1,
        token: 'token',
        requestId: 'request',
        operation: 'readWebEntry',
        serviceId: 'gateway',
        binding,
        request,
        scope: { profileId: 'profile', runtimeGeneration: 'host', pluginGeneration: owner.pluginGeneration },
        ...extra,
      }
      expect(() => parseManagedServiceUIBindingRequest(wire, f.handler, owner)).toThrow()
      void f.close()
    },
  )
})
