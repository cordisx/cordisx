import { describe, expect, it, vi } from 'vitest'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, message, nativeRequest, settle } from './fixtures/native-model-provider-transport-harness.js'
import { NativeMcpRequestClient } from '../packages/cli/src/renderer/native-mcp-request-client.js'

// Request completion must not depend on a native dispatch acknowledgement.
describe('native model request completion', () => {
  it('dispatches independently of an existing native coalesced read waiter', async () => {
    vi.useFakeTimers()
    const params = { threadId: 'synthetic-thread', includeTurns: false }
    const nativeWaiter = { id: 'native-pending-read', method: 'thread/read', params }
    const sharedWaiters = [nativeWaiter]
    const dispatched = vi.fn()
    const client = new NativeMcpRequestClient({
      sendMessageFromView: value => {
        const envelope = value as {
          coalesce?: boolean
          request: typeof nativeWaiter
        }
        if (envelope.coalesce !== false) {
          sharedWaiters.push(envelope.request)
          return
        }
        dispatched(envelope.request)
        queueMicrotask(() =>
          client.receive({
            id: envelope.request.id,
            result: { thread: { id: params.threadId } },
          })
        )
      },
    }, 'local')
    try {
      const observed = vi.fn()
      const rejected = vi.fn()
      const result = client.request('thread/read', params).then(value => {
        observed(value)
        return value
      }, rejected)
      await vi.advanceTimersByTimeAsync(0)
      expect(observed).toHaveBeenCalledWith({ thread: { id: params.threadId } })
      expect(rejected).not.toHaveBeenCalled()
      expect(dispatched).toHaveBeenCalledOnce()
      expect(dispatched).toHaveBeenCalledWith({
        id: expect.stringMatching(/^cordisx-native-model-provider:/),
        method: 'thread/read',
        params,
      })
      expect(sharedWaiters).toEqual([nativeWaiter])
      await expect(result).resolves.toEqual({ thread: { id: params.threadId } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('observes a native response while the dispatch promise remains pending', async () => {
    vi.useFakeTimers()
    const requests: { request: { id: string } }[] = []
    const client = new NativeMcpRequestClient({
      sendMessageFromView: value => {
        requests.push(value as (typeof requests)[number])
        return new Promise(() => {})
      },
    }, 'local')
    try {
      const result = client.request('thread/read', { threadId: 'synthetic-thread', includeTurns: false })
      const observed = vi.fn()
      void result.then(observed)
      expect(client.receive({ id: requests[0]!.request.id, result: { thread: { id: 'synthetic-thread' } } })).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(observed).toHaveBeenCalledWith({ thread: { id: 'synthetic-thread' } })
      await expect(result).resolves.toEqual({ thread: { id: 'synthetic-thread' } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it.each([false, true])('enforces the response deadline when dispatch pending is %s', async pendingDispatch => {
    vi.useFakeTimers()
    const client = new NativeMcpRequestClient({
      sendMessageFromView: () => pendingDispatch ? new Promise(() => {}) : undefined,
    }, 'local')
    try {
      const observed = vi.fn()
      const result = client.request('thread/read', { threadId: 'synthetic-thread', includeTurns: false }).catch(
        error => {
          observed(error)
          return error
        },
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(observed).toHaveBeenCalledOnce()
      expect(await result).toMatchObject({ message: 'Codex Desktop thread/read timed out' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('disposes an outstanding request without waiting for dispatch', async () => {
    vi.useFakeTimers()
    const send = vi.fn(() => new Promise(() => {}))
    const client = new NativeMcpRequestClient({ sendMessageFromView: send }, 'local')
    try {
      const observed = vi.fn()
      const result = client.request('thread/read', { threadId: 'synthetic-thread' }).catch(error => {
        observed(error)
        return error
      })
      client.dispose()
      await vi.advanceTimersByTimeAsync(0)
      expect(observed).toHaveBeenCalledOnce()
      expect(await result).toMatchObject({ message: 'Native model provider transport disposed' })
      expect(vi.getTimerCount()).toBe(0)
      await expect(client.request('thread/read', {})).rejects.toThrow('Native model provider transport unavailable')
      expect(send).toHaveBeenCalledOnce()
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it.each(['throw', 'reject'])('preserves a dispatch error delivered by %s', async delivery => {
    vi.useFakeTimers()
    const error = new Error('synthetic dispatch failure')
    const client = new NativeMcpRequestClient({
      sendMessageFromView: () => {
        if (delivery === 'throw') throw error
        return Promise.reject(error)
      },
    }, 'local')
    try {
      await expect(client.request('thread/read', { threadId: 'synthetic-thread' })).rejects.toBe(error)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('does not apply a late dispatch failure or response to a subsequent request', async () => {
    vi.useFakeTimers()
    const requests: { request: { id: string } }[] = []
    let rejectFirst: (error: Error) => void = () => undefined
    const client = new NativeMcpRequestClient({
      sendMessageFromView: value => {
        requests.push(value as (typeof requests)[number])
        if (requests.length === 1) return new Promise((_resolve, reject) => rejectFirst = reject)
        return undefined
      },
    }, 'local')
    try {
      const timedOut = client.request('thread/read', { threadId: 'synthetic-first' }).catch(error => error)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(await timedOut).toMatchObject({ message: 'Codex Desktop thread/read timed out' })
      const current = client.request('thread/read', { threadId: 'synthetic-second' })
      rejectFirst(new Error('late synthetic dispatch rejection'))
      await Promise.resolve()
      expect(client.receive({ id: requests[0]!.request.id, result: { thread: { id: 'synthetic-first' } } })).toBe(false)
      expect(client.receive({ id: requests[1]!.request.id, result: { thread: { id: 'synthetic-second' } } })).toBe(true)
      await expect(current).resolves.toEqual({ thread: { id: 'synthetic-second' } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('preserves an accepted response when dispatch subsequently rejects', async () => {
    const requests: { request: { id: string } }[] = []
    let rejectSend: (error: Error) => void = () => undefined
    const client = new NativeMcpRequestClient({
      sendMessageFromView: value => {
        requests.push(value as (typeof requests)[number])
        return new Promise((_resolve, reject) => rejectSend = reject)
      },
    }, 'local')
    try {
      const result = client.request('thread/read', { threadId: 'synthetic-thread' })
      expect(client.receive({ id: requests[0]!.request.id, result: { thread: { id: 'synthetic-thread' } } })).toBe(true)
      await expect(result).resolves.toEqual({ thread: { id: 'synthetic-thread' } })
      rejectSend(new Error('late synthetic dispatch rejection'))
      await Promise.resolve()
      expect(client.receive({ id: requests[0]!.request.id, result: { thread: { id: 'other-thread' } } })).toBe(false)
    } finally {
      client.dispose()
    }
  })
})

it('keeps a confirmed provider, model and effort while refreshing the same native thread', async () => {
  let hold = false
  let pending: Record<string, unknown> | undefined
  const h = await harness(request => {
    if (hold && request.method === 'config/read') {
      pending = request
      return true
    }
  })
  try {
    expect(await h.transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    await settle()
    hold = true
    const observed: ReturnType<typeof h.transport.getSnapshot>[] = []
    h.transport.subscribe(() => observed.push(h.transport.getSnapshot()))
    const replacement = composer(h.dom.window.document, 'thread-1')
    await settle()
    expect(pending).toBeDefined()
    expect(h.transport.getSnapshot()).toMatchObject({
      available: false,
      modelProvider: 'provider-b',
      model: 'model-b',
      reasoningEffort: 'none',
    })
    message(h.dom.window, {
      type: 'mcp-response',
      hostId: 'local',
      message: { id: pending!.id, result: { config: { model_provider: 'openai', model: 'native' } } },
    })
    await settle()
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(state => state.modelProvider === 'provider-b' && state.model === 'model-b')).toBe(true)
    expect(h.transport.getSnapshot()).toMatchObject({ available: true, modelProvider: 'provider-b', model: 'model-b' })
    expect(replacement.selectModel).toHaveBeenCalledWith('model-b', undefined)
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('publishes the returned new-thread binding without an intermediate official provider', async () => {
  const h = await harness()
  try {
    composer(h.dom.window.document, null)
    await settle()
    await h.transport.select({ providerId: 'provider-b', model: 'model-b' })
    h.channel.selectionRead.mockImplementation(async ({ scope }) => ({
      available: true,
      revision: 100,
      effective: scope.threadId === 'created'
        ? { providerId: 'provider-b', model: 'model-b' }
        : { providerId: 'provider-a', model: 'model-a' },
    }))
    const observed: ReturnType<typeof h.transport.getSnapshot>[] = []
    h.transport.subscribe(() => observed.push(h.transport.getSnapshot()))
    // Native resolves creation before React mounts the returned thread composer.
    nativeRequest(h.dom.window, { id: 'create', method: 'thread/start', params: {} })
    message(h.dom.window, {
      type: 'mcp-response',
      hostId: 'local',
      message: { id: 'create', result: { thread: { id: 'created' }, modelProvider: 'provider-b', model: 'model-b' } },
    })
    composer(h.dom.window.document, 'created')
    await settle()
    expect(h.transport.getSnapshot()).toMatchObject({
      available: true,
      threadId: 'created',
      modelProvider: 'provider-b',
      model: 'model-b',
    })
    expect(observed.filter(state => state.available).every(state => state.modelProvider === 'provider-b')).toBe(true)
    expect(observed.some(state => state.modelProvider === 'openai')).toBe(false)
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('does not retain a previous thread choice when the next thread binding read fails', async () => {
  const h = await harness()
  try {
    await h.transport.select({ providerId: 'provider-b', model: 'model-b' })
    h.channel.selectionRead.mockRejectedValueOnce(new Error('unavailable'))
    composer(h.dom.window.document, 'unrelated')
    await settle()
    expect(h.transport.getSnapshot()).toMatchObject({ available: false, threadId: 'unrelated' })
    expect(h.transport.getSnapshot().modelProvider).toBeUndefined()
    expect(h.transport.getSnapshot().pendingProviderId).toBeUndefined()
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})
