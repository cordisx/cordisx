import { afterEach, expect, it, vi } from 'vitest'
import { startManagerRendererLifecyclePump } from '../packages/cli/src/independent-manager/lifecycle-pump.js'

const command = { id: 'a'.repeat(64), sequence: 1, method: 'synchronize', payload: {} }
const receipt = { id: command.id, sequence: 1, ok: true as const, value: { verified: true } }
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200 })

afterEach(() => vi.useRealTimers())

function waitForAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error('closed'))
    signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })
  })
}

it('starts polling before admission and delivers each command and receipt exactly once', async () => {
  let allowAdmission!: () => void
  const admission = new Promise<Response>(resolve => allowAdmission = () => resolve(response({ admitted: true })))
  let polls = 0
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return admission
    if (path === '/api/renderer/acknowledge') {
      expect(JSON.parse(String(options.body))).toEqual({ receipt })
      allowAdmission()
      return Promise.resolve(response({ accepted: true }))
    }
    if (path === '/api/renderer/poll' && polls++ === 0) return Promise.resolve(response({ command }))
    return waitForAbort(options.signal!)
  })
  const client = { closed: false, handle: vi.fn(async () => receipt), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    onFailure: failed,
  })
  try {
    expect(await pump.admitted).toBe(true)
    await vi.waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(4))
    expect(fetch.mock.calls.map(call => call[0]).slice(0, 3)).toEqual([
      '/api/renderer/poll',
      '/api/renderer/admit',
      '/api/renderer/acknowledge',
    ])
    expect(client.handle).toHaveBeenCalledOnce()
    for (const [, options] of fetch.mock.calls) {
      expect(options.headers).toEqual({ 'content-type': 'application/json', authorization: `Bearer ${'b'.repeat(64)}` })
      expect(options.body).not.toContain('b'.repeat(64))
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' })
    }
  } finally {
    await pump.close()
    await pump.stopped
  }
  expect(client.close).toHaveBeenCalledOnce()
  expect(failed).not.toHaveBeenCalled()
})

it('closes without replay when an acknowledgement response is lost', async () => {
  let polls = 0
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/acknowledge') return Promise.reject(new Error('connection lost'))
    if (polls++ === 0) return Promise.resolve(response({ command }))
    return waitForAbort(options.signal!)
  })
  const client = { closed: false, handle: vi.fn(async () => receipt), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    onFailure: failed,
  })
  await pump.stopped
  expect(client.handle).toHaveBeenCalledOnce()
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(1)
  expect(client.close).toHaveBeenCalledOnce()
  expect(failed).toHaveBeenCalledOnce()
})

it('keeps an idle page connected after the sidecar confirms a lost poll had no command', async () => {
  let polls = 0
  let drop: (() => void) | undefined
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/poll-recover') {
      expect(JSON.parse(String(options.body))).toEqual({ pollSequence: 2 })
      return Promise.resolve(response({ recovered: true }))
    }
    if (path === '/api/renderer/poll') {
      polls++
      expect(JSON.parse(String(options.body))).toEqual({ timeoutMs: 15_000, pollSequence: polls })
      if (polls === 1) return Promise.resolve(response({ command: null }))
      if (polls === 2) {
        return new Promise<Response>((_, reject) => {
          drop = () => reject(new TypeError('lost poll response'))
          options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
        })
      }
    }
    return waitForAbort(options.signal!)
  })
  const client = { closed: false, handle: vi.fn(), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    canRecoverPoll: () => true,
    onFailure: failed,
  })
  try {
    expect(await pump.admitted).toBe(true)
    await vi.waitFor(() => expect(drop).toBeDefined())
    drop!()
    await vi.waitFor(() => expect(polls).toBe(3))
    expect(client.handle).not.toHaveBeenCalled()
    expect(client.close).not.toHaveBeenCalled()
    expect(failed).not.toHaveBeenCalled()
  } finally {
    await pump.close()
    await pump.stopped
  }
})

it.each([
  { label: 'an in-flight write', canRecover: false, response: { recovered: true }, requests: 0 },
  { label: 'a possibly offered command', canRecover: true, response: { recovered: false }, requests: 1 },
])('retires after a lost poll with $label', async ({ canRecover, response: confirmation, requests }) => {
  let polls = 0
  let drop: (() => void) | undefined
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/poll-recover') return Promise.resolve(response(confirmation))
    if (path === '/api/renderer/poll' && polls++ === 0) return Promise.resolve(response({ command: null }))
    return new Promise<Response>((_, reject) => {
      drop = () => reject(new TypeError('lost poll response'))
      options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
    })
  })
  const client = { closed: false, handle: vi.fn(), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    canRecoverPoll: () => canRecover,
    onFailure: failed,
  })
  expect(await pump.admitted).toBe(true)
  await vi.waitFor(() => expect(drop).toBeDefined())
  drop!()
  await pump.stopped
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll-recover')).toHaveLength(requests)
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(2)
  expect(client.handle).not.toHaveBeenCalled()
  expect(failed).toHaveBeenCalledExactlyOnceWith('poll-transport')
})

it('stops if a write begins before poll recovery is confirmed', async () => {
  let polls = 0
  let drop: (() => void) | undefined
  let confirm: (() => void) | undefined
  let idle = true
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/poll-recover') {
      return new Promise<Response>(resolve => confirm = () => resolve(response({ recovered: true })))
    }
    if (path === '/api/renderer/poll' && polls++ === 0) return Promise.resolve(response({ command: null }))
    return new Promise<Response>((_, reject) => {
      drop = () => reject(new TypeError('lost poll response'))
      options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
    })
  })
  const client = { closed: false, handle: vi.fn(), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    canRecoverPoll: () => idle,
    onFailure: failed,
  })
  expect(await pump.admitted).toBe(true)
  await vi.waitFor(() => expect(drop).toBeDefined())
  drop!()
  await vi.waitFor(() => expect(confirm).toBeDefined())
  idle = false
  confirm!()
  await pump.stopped
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(2)
  expect(failed).toHaveBeenCalledExactlyOnceWith('poll-transport')
})

it('limits consecutive poll recovery attempts', async () => {
  let polls = 0
  let drop: (() => void) | undefined
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/poll-recover') return Promise.resolve(response({ recovered: true }))
    if (path === '/api/renderer/poll') {
      polls++
      if (polls === 1) return Promise.resolve(response({ command: null }))
      if (polls === 3) return Promise.reject(new TypeError('second lost poll'))
    }
    return new Promise<Response>((_, reject) => {
      drop = () => reject(new TypeError('first lost poll'))
      options.signal!.addEventListener('abort', () => reject(new Error('closed')), { once: true })
    })
  })
  const client = { closed: false, handle: vi.fn(), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    canRecoverPoll: () => true,
    onFailure: failed,
  })
  expect(await pump.admitted).toBe(true)
  await vi.waitFor(() => expect(drop).toBeDefined())
  drop!()
  await pump.stopped
  expect(polls).toBe(3)
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll-recover')).toHaveLength(1)
  expect(failed).toHaveBeenCalledExactlyOnceWith('poll-transport')
})

it('bounds a stalled acknowledgement and retires the session without replay', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/acknowledge') return waitForAbort(options.signal!)
    return Promise.resolve(response({ command }))
  })
  const client = { closed: false, handle: vi.fn(async () => receipt), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    onFailure: failed,
  })
  expect(await pump.admitted).toBe(true)
  await vi.advanceTimersByTimeAsync(20_000)
  await pump.stopped
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(1)
  expect(client.close).toHaveBeenCalledOnce()
  expect(failed).toHaveBeenCalledOnce()
})

it('forwards a negative receipt once and stops the renderer', async () => {
  const negative = { id: command.id, sequence: 1, ok: false as const }
  const fetch = vi.fn((path: string) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/acknowledge') return Promise.resolve(response({ accepted: true }))
    return Promise.resolve(response({ command }))
  })
  const client = { closed: false, handle: vi.fn(async () => negative), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    onFailure: failed,
  })
  await pump.stopped
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(1)
  expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/acknowledge')).toHaveLength(1)
  expect(failed).toHaveBeenCalledOnce()
  expect(client.close).toHaveBeenCalledOnce()
})

it('does not report an intentional close as a failure', async () => {
  const fetch = vi.fn((_path: string, options: RequestInit) => waitForAbort(options.signal!))
  const client = { closed: false, handle: vi.fn(), close: vi.fn(async () => {}) }
  const failed = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    onFailure: failed,
  })
  await pump.close()
  expect(await pump.admitted).toBe(false)
  await pump.stopped
  expect(failed).not.toHaveBeenCalled()
  expect(client.close).toHaveBeenCalledOnce()
})

it('closes a quiesced renderer only after the owner accepts its receipt', async () => {
  let accept!: (value: Response) => void
  const acknowledgement = new Promise<Response>(resolve => {
    accept = resolve
  })
  const quiesce = { ...command, method: 'quiesce', payload: { fenceId: 'c'.repeat(64) } }
  const fetch = vi.fn((path: string, options: RequestInit) => {
    if (path === '/api/renderer/admit') return Promise.resolve(response({ admitted: true }))
    if (path === '/api/renderer/acknowledge') return acknowledgement
    if (path === '/api/renderer/poll') return Promise.resolve(response({ command: quiesce }))
    return waitForAbort(options.signal!)
  })
  const client = {
    closed: false,
    quiesced: false,
    handle: vi.fn(async () => {
      client.quiesced = true
      return receipt
    }),
    close: vi.fn(async () => {}),
  }
  const onQuiesced = vi.fn()
  const pump = startManagerRendererLifecyclePump({
    window: { fetch } as never,
    sessionToken: 'b'.repeat(64),
    client,
    onQuiesced,
  })
  try {
    expect(await pump.admitted).toBe(true)
    await vi.waitFor(() => expect(client.handle).toHaveBeenCalledOnce())
    expect(onQuiesced).not.toHaveBeenCalled()
    accept(response({ accepted: true }))
    await pump.stopped
    expect(onQuiesced).toHaveBeenCalledOnce()
    expect(client.close).toHaveBeenCalledOnce()
    expect(fetch.mock.calls.filter(call => call[0] === '/api/renderer/poll')).toHaveLength(1)
  } finally {
    accept(response({ accepted: true }))
    await pump.close()
  }
})
