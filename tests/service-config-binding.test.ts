import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserServiceConfigBridge } from '../packages/cli/src/renderer/service-config-binding.js'

interface ServiceConfigGlobals {
  __cordisxServiceConfigRequestV1?: (payload: string) => void
  __cordisxServiceConfigReceiveV1?: (payload: string) => void
}

const globals = globalThis as ServiceConfigGlobals

afterEach(() => {
  vi.useRealTimers()
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

  it('does not retry or report cancellation when a dispatched configuration write times out', async () => {
    vi.useFakeTimers()
    const binding = vi.fn()
    globals.__cordisxServiceConfigRequestV1 = binding
    const bridge = BrowserServiceConfigBridge.connect('token', 'smoke', 'generation')
    const pending = bridge.mutate({
      contract: 'cordisx.service-config-mutation/v1',
      schemaVersion: 1,
      identity: { source: 'https://example.test/plugin', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'smoke', generation: 'generation' },
      expectedRevision: 0,
      configuration: {},
    })
    let settled = false
    void pending.finally(() => settled = true).catch(() => {})
    const rejection = expect(pending).rejects.toThrow('write result is unknown')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(71_000)
    await rejection
    expect(binding).toHaveBeenCalledOnce()
    bridge.dispose()
  })
})
