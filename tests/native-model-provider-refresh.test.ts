import { expect, it } from 'vitest'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, message, nativeRequest, settle } from './fixtures/native-model-provider-transport-harness.js'

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
