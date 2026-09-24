import { describe, expect, it, vi } from 'vitest'
import { MainInspectorUnavailableError, waitForMainInspectorUrl } from '../packages/cli/src/launcher/main-inspector.js'

const port = 43123
const hostPid = 8123

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } })
}

async function failedReason(fetchEndpoint: typeof fetch): Promise<MainInspectorUnavailableError> {
  const failure = waitForMainInspectorUrl({
    port,
    hostPid,
    hostStatus: () => 'alive',
    helperExited: () => false,
    timeoutMs: 1,
    pollIntervalMs: 0,
    fetch: fetchEndpoint,
  }).catch(error => error as MainInspectorUnavailableError)
  return await failure
}

describe('owned Host main inspector discovery', () => {
  it('accepts only the expected loopback inspector URL', async () => {
    const url = `ws://127.0.0.1:${port}/7ca11da1-17eb-48f1-9262-a48ef08c22ad`
    await expect(waitForMainInspectorUrl({
      port,
      hostPid,
      hostStatus: () => 'alive',
      helperExited: () => false,
      fetch: vi.fn(async () => response(JSON.stringify([{ webSocketDebuggerUrl: url }]))),
    })).resolves.toBe(url)
  })

  it.each(
    [
      ['http-error', vi.fn(async () => response('{}', 503))],
      ['invalid-json', vi.fn(async () => response('{'))],
      ['response-shape-mismatch', vi.fn(async () => response('{}'))],
      ['response-shape-mismatch', vi.fn(async () => response('[null]'))],
      ['missing-websocket-url', vi.fn(async () => response('[{}]'))],
      [
        'websocket-url-mismatch',
        vi.fn(async () => response('[{"webSocketDebuggerUrl":"ws://127.0.0.1:9/not-owned"}]')),
      ],
    ] as const,
  )('reports %s without including response content', async (reason, fetchEndpoint) => {
    const error = await failedReason(fetchEndpoint)
    expect(error).toBeInstanceOf(MainInspectorUnavailableError)
    expect(error.reason).toBe(reason)
    expect(error.message).toContain(`reason=${reason}`)
    expect(error.message).not.toContain('not-owned')
  })

  it('distinguishes connection refusal from other fetch failures', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    })
    expect((await failedReason(vi.fn(async () => await Promise.reject(refused)))).reason).toBe('connection-refused')
    expect((await failedReason(vi.fn(async () => await Promise.reject(new Error('network unavailable'))))).reason)
      .toBe('fetch-failed')
  })

  it('bounds a fetch that never responds', async () => {
    const fetchEndpoint = vi.fn<typeof fetch>(async (_input, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })
    )
    const startedAt = Date.now()
    const error = await waitForMainInspectorUrl({
      port,
      hostPid,
      hostStatus: () => 'alive',
      helperExited: () => false,
      timeoutMs: 10,
      pollIntervalMs: 0,
      fetch: fetchEndpoint,
    }).catch(failure => failure as MainInspectorUnavailableError)

    expect(error.reason).toBe('fetch-failed')
    expect(Date.now() - startedAt).toBeLessThan(500)
  })

  it('stops immediately when the exact Host exits', async () => {
    const fetchEndpoint = vi.fn<typeof fetch>()
    const error = await waitForMainInspectorUrl({
      port,
      hostPid,
      hostStatus: () => 'dead',
      helperExited: () => false,
      fetch: fetchEndpoint,
    }).catch(failure => failure as MainInspectorUnavailableError)

    expect(error.reason).toBe('host-exited')
    expect(fetchEndpoint).not.toHaveBeenCalled()
  })

  it('stops immediately when the launch helper exits first', async () => {
    const error = await waitForMainInspectorUrl({
      port,
      hostPid,
      hostStatus: () => 'unknown',
      helperExited: () => true,
      fetch: vi.fn<typeof fetch>(),
    }).catch(failure => failure as MainInspectorUnavailableError)

    expect(error.reason).toBe('helper-exited')
    expect(error.hostStatus).toBe('unknown')
  })
})
