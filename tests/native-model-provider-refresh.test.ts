import { describe, expect, it, vi } from 'vitest'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, message, nativeRequest, settle } from './fixtures/native-model-provider-transport-harness.js'
import { NativeMcpRequestClient } from '../packages/cli/src/renderer/native-mcp-request-client.js'
import { harness as channelHarness } from './fixtures/native-submission-channel-harness.js'

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

it('keeps the same published snapshot when focus reconciliation finds no change', async () => {
  const h = await harness()
  try {
    const before = h.transport.getSnapshot()
    const changed = vi.fn()
    const unsubscribe = h.transport.subscribe(changed)
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'))
    await settle()
    await settle()
    expect(h.transport.getSnapshot()).toBe(before)
    expect(changed).not.toHaveBeenCalled()
    unsubscribe()
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('does not let a delayed focus read replace a later user selection', async () => {
  let hold = false
  let pending: Record<string, unknown> | undefined
  const h = await harness(request => {
    if (hold && request.method === 'config/read') {
      pending = request
      return true
    }
  })
  try {
    hold = true
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'))
    await settle()
    expect(pending).toBeDefined()
    expect(await h.transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
    message(h.dom.window, {
      type: 'mcp-response',
      hostId: 'local',
      message: { id: pending!.id, result: { config: { model_provider: 'provider-a', model: 'model-a' } } },
    })
    await settle()
    expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-b', model: 'model-b' })
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('projects cached labels immediately while withholding a real binding', async () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  } as Storage
  data.set(
    'cordisx.session-display.v1:' + JSON.stringify(['local', 'thread-1']),
    JSON.stringify({
      providerId: 'saved-provider',
      model: 'saved-model',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      updatedAt: 1,
    }),
  )
  let pending: Record<string, unknown> | undefined
  const h = await harness(
    request => {
      if (request.method === 'thread/read') {
        pending = request
        return true
      }
    },
    undefined,
    storage,
  )
  try {
    expect(pending).toBeDefined()
    expect(h.transport.getSnapshot()).toMatchObject({
      available: false,
      threadId: 'thread-1',
      cachedDisplay: { providerId: 'saved-provider', model: 'saved-model', serviceTier: 'priority' },
    })
    expect(h.transport.getSnapshot().modelProvider).toBeUndefined()
    expect(await h.transport.select({ providerId: 'saved-provider', model: 'saved-model' })).toBe('unavailable')
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('does not infer an existing thread Fast setting from global configuration', async () => {
  const h = await harness((request, view) => {
    if (request.method !== 'config/read') return
    queueMicrotask(() =>
      message(view, {
        type: 'mcp-response',
        hostId: 'local',
        message: { id: request.id, result: { config: { model_provider: 'provider-a', service_tier: 'priority' } } },
      })
    )
    return true
  })
  try {
    expect(h.transport.getSnapshot().serviceTier).toBeUndefined()
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('does not promote global provider, model or effort into an unknown existing session', async () => {
  const { nativeComposerBaselineRouting, refreshedNativeComposerSelection } = await import(
    '../packages/cli/src/renderer/native-composer-refresh.js'
  )
  const baseline = {
    thread: undefined,
    config: { model_provider: 'global-provider', model: 'global-model', model_reasoning_effort: 'high' },
  }
  const control = {
    model: '',
    reasoningEffort: '',
    reasoningEfforts: [],
    serviceTier: null,
    serviceTierKnown: false,
    models: [],
    selectModel: async () => {},
  }
  const routing = nativeComposerBaselineRouting(baseline, control, undefined, 'thread')
  expect(routing.provider).toBeUndefined()
  expect(routing.model).toBeUndefined()
  const snapshot = refreshedNativeComposerSelection(
    'thread',
    baseline,
    control,
    { available: false, revision: 1 },
    false,
  )
  expect(snapshot.reasoningEffort).toBeUndefined()
  expect(snapshot.serviceTier).toBeUndefined()
})

it('reconciles an existing Composer with a committed selection changed in another scope', async () => {
  const h = await harness()
  try {
    h.channel.selectionRead.mockImplementation(async () => ({
      available: true,
      revision: 20,
      effective: { providerId: 'provider-b', model: 'model-b' },
    }))
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'))
    await settle()
    await settle()
    expect(h.transport.getSnapshot()).toMatchObject({ available: true, modelProvider: 'provider-b', model: 'model-b' })
    expect(h.selectModel.mock.calls.at(-1)?.[0]).toBe('model-b')
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('updates the native Composer after another bound scope commits its model', async () => {
  const h = await harness()
  const channel = await channelHarness({
    catalog: () => [{
      providerId: 'provider-a',
      pluginId: 'host',
      label: 'A',
      models: [{ id: 'model-a', label: 'A', aliases: [] }, { id: 'model-b', label: 'B', aliases: [] }],
    }],
  })
  const main = { ...channel.draft, composerId: 'main', threadId: 'thread-1' }
  const side = { ...channel.draft, composerId: 'side', threadId: 'thread-1' }
  try {
    channel.setLive(main)
    await channel.channel.selectionRead({ scope: main, effective: { providerId: 'provider-a', model: 'model-a' } })
    channel.setLive(side)
    const other = await channel.channel.selectionRead({
      scope: side,
      effective: { providerId: 'provider-a', model: 'model-a' },
    })
    await channel.channel.selectionSelect({
      scope: side,
      providerId: 'provider-a',
      model: 'model-b',
      expectedRevision: other.revision,
    })
    channel.setLive(main)
    h.channel.selectionRead.mockImplementation(async () => await channel.channel.selectionRead({ scope: main }))
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'))
    await settle()
    await settle()
    expect(h.transport.getSnapshot()).toMatchObject({ available: true, modelProvider: 'provider-a', model: 'model-b' })
    expect(h.selectModel.mock.calls.at(-1)?.[0]).toBe('model-b')
  } finally {
    await channel.installed.dispose()
    h.transport.dispose()
    h.dom.window.close()
  }
})

it('retains a settings event that arrives while a background binding read is pending', async () => {
  const h = await harness()
  let release!: (value: { available: true; revision: number; effective: { providerId: string; model: string } }) => void
  try {
    ;(h.trigger as any).__reactFiber$test.return.memoizedProps.selectedServiceTier = null
    message(h.dom.window, {
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'thread/settings/updated',
        params: { threadId: 'thread-1', settings: { serviceTier: null } },
      },
    })
    await settle()
    await settle()
    h.channel.selectionRead.mockClear()
    h.channel.selectionRead.mockImplementationOnce(() =>
      new Promise(resolve => {
        release = resolve
      })
    )
    h.dom.window.dispatchEvent(new h.dom.window.Event('focus'))
    await settle()
    expect(release).toBeTypeOf('function')
    message(h.dom.window, {
      type: 'mcp-notification',
      hostId: 'local',
      message: {
        method: 'thread/settings/updated',
        params: { threadId: 'thread-1', settings: { serviceTier: 'priority' } },
      },
    })
    expect(h.transport.getSnapshot().serviceTier).toBe('priority')
    release({ available: true, revision: 2, effective: { providerId: 'provider-a', model: 'model-a' } })
    await settle()
    await settle()
    expect(h.transport.getSnapshot().serviceTier).toBe('priority')
    expect(h.channel.selectionRead.mock.calls.length).toBeGreaterThanOrEqual(2)
  } finally {
    h.transport.dispose()
    h.dom.window.close()
  }
})
