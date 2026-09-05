import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserServiceConfigBridge } from '../packages/cli/src/renderer/service-config-binding.js'

interface ServiceConfigGlobals {
  __cordisxServiceConfigRequestV1?: (payload: string) => void
  __cordisxServiceConfigReceiveV1?: (payload: string) => void
}

const globals = globalThis as ServiceConfigGlobals

afterEach(() => {
  delete globals.__cordisxServiceConfigRequestV1
  delete globals.__cordisxServiceConfigReceiveV1
})

describe('browser service configuration bridge', () => {
  it('coalesces concurrent descriptor reads for the same plugin', async () => {
    const requests: Array<Record<string, unknown>> = []
    globals.__cordisxServiceConfigRequestV1 = vi.fn(payload => {
      requests.push(JSON.parse(payload) as Record<string, unknown>)
    })
    const bridge = BrowserServiceConfigBridge.connect('token', 'smoke', 'generation')

    const first = bridge.list('cli-proxy-api')
    const second = bridge.list('cli-proxy-api')
    expect(requests).toHaveLength(1)
    globals.__cordisxServiceConfigReceiveV1?.(JSON.stringify({
      requestId: requests[0]!.requestId,
      ok: true,
      value: [],
    }))

    await expect(first).resolves.toEqual([])
    await expect(second).resolves.toEqual([])
    bridge.dispose()
  })

  it('retries only an idempotent descriptor read after a transient unavailable response', async () => {
    let calls = 0
    globals.__cordisxServiceConfigRequestV1 = vi.fn(payload => {
      const request = JSON.parse(payload) as { readonly requestId: string }
      calls += 1
      queueMicrotask(() =>
        globals.__cordisxServiceConfigReceiveV1?.(JSON.stringify(
          calls === 1
            ? { requestId: request.requestId, ok: false, code: 'unavailable' }
            : { requestId: request.requestId, ok: true, value: [] },
        ))
      )
    })
    const bridge = BrowserServiceConfigBridge.connect('token', 'smoke', 'generation')
    await expect(bridge.list('cli-proxy-api')).resolves.toEqual([])
    expect(calls).toBe(2)
    bridge.dispose()
  })
})
