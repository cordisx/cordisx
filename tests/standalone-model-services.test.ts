import { afterEach, expect, it, vi } from 'vitest'
import { StandaloneModelServices } from '../packages/cli/src/renderer/standalone-model-services.js'

afterEach(() => {
  globalThis.__cordisxModelServicesRequestV1 = undefined
  globalThis.__cordisxModelServicesReceiveV1 = undefined
  vi.useRealTimers()
})

it('uses the owner binding for model-service reads and saves', async () => {
  const requests: Array<{ requestId: string; operation: string }> = []
  globalThis.__cordisxModelServicesRequestV1 = payload => {
    const request = JSON.parse(payload) as { requestId: string; operation: string }
    requests.push(request)
    queueMicrotask(() =>
      globalThis.__cordisxModelServicesReceiveV1?.(JSON.stringify({
        requestId: request.requestId,
        ok: true,
        value: request.operation === 'read'
          ? { status: 'ok', revision: 'r1', services: [] }
          : { status: 'applied', applies: 'app-restart', revision: 'r2' },
      }))
    )
  }
  const client = StandaloneModelServices.connect()!
  try {
    expect(await client.modelServicesRead()).toEqual({ status: 'ok', revision: 'r1', services: [] })
    expect(await client.modelServicesSave({ expectedRevision: 'r1', services: [] }))
      .toEqual({ status: 'applied', applies: 'app-restart', revision: 'r2' })
    expect(requests.map(item => item.operation)).toEqual(['read', 'save'])
  } finally {
    client.dispose()
  }
})

it('reports an in-flight save as unknown if its binding is retired', async () => {
  globalThis.__cordisxModelServicesRequestV1 = () => {}
  const client = StandaloneModelServices.connect()!
  const pending = client.modelServicesSave({ expectedRevision: 'r1', services: [] })
  client.dispose()
  expect(await pending).toEqual({ status: 'unknown', code: 'result-unknown' })
  expect(await client.modelServicesRead()).toEqual({ status: 'rejected', code: 'unavailable' })
})
