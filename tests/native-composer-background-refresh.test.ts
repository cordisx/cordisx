import { describe, expect, it } from 'vitest'
import { composer } from './fixtures/native-model-provider-composer.js'
import { harness, message, settle } from './fixtures/native-model-provider-transport-harness.js'

describe('native composer background refresh', () => {
  it('updates background metadata when fresh defaults differ without replacing the confirmed binding', async () => {
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
      composer(h.dom.window.document, 'thread-1')
      await settle()
      expect(h.transport.getSnapshot()).toMatchObject({
        available: true,
        modelProvider: 'provider-a',
        model: 'model-a',
      })
      message(h.dom.window, {
        type: 'mcp-response',
        hostId: 'local',
        message: {
          id: pending!.id,
          result: { config: { model_provider: 'other', model_providers: { 'provider-a': { name: 'Provider A' } } } },
        },
      })
      await settle()
      await settle()
      expect(h.transport.getSnapshot()).toMatchObject({
        available: true,
        modelProvider: 'provider-a',
        model: 'model-a',
        providerLabel: 'Provider A',
      })
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it('keeps a confirmed same-thread tuple usable while configuration revalidates, with fresh Send admission', async () => {
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
      composer(h.dom.window.document, 'thread-1')
      await settle()
      expect(pending).toBeDefined()
      expect(h.transport.getSnapshot()).toMatchObject({ available: true, busy: false, threadId: 'thread-1' })
      h.channel.submissionPrepare.mockResolvedValueOnce({ status: 'pass-through' })
      const hook = (globalThis as any).__cordisxNativeSubmitHook
      await expect(hook({
        target: 'local',
        thread: 'thread-1',
        followUp: 'local',
        followUpThread: 'thread-1',
        response: false,
        promptOverride: false,
      }))
        .resolves.toEqual({ allow: true })
      expect(h.channel.submissionPrepare).toHaveBeenCalledTimes(1)
      message(h.dom.window, {
        type: 'mcp-response',
        hostId: 'local',
        message: { id: pending!.id, error: { message: 'offline' } },
      })
      await settle()
      expect(h.transport.getSnapshot()).toMatchObject({ available: true, busy: false, model: 'model-a' })
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })

  it.each(['thread', 'model', 'effort', 'fast'] as const)(
    'keeps a changed native %s fenced until fresh configuration and Host selection arrive',
    async kind => {
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
        const next = composer(h.dom.window.document, kind === 'thread' ? 'thread-2' : 'thread-1')
        const props = (next.trigger as any).__reactFiber$test.return.memoizedProps
        if (kind === 'model') props.model = 'model-b'
        if (kind === 'effort') props.reasoningEffort = 'low'
        if (kind === 'fast') props.selectedServiceTier = 'priority'
        await settle()
        expect(h.transport.getSnapshot().available).toBe(false)
        expect((globalThis as any).__cordisxNativeSubmissionAuthority.snapshot().idle).toBe(false)
        message(h.dom.window, {
          type: 'mcp-response',
          hostId: 'local',
          message: { id: pending!.id, result: { config: { model_provider: 'provider-a', model: 'model-a' } } },
        })
        await settle()
        expect(h.transport.getSnapshot().available).toBe(true)
      } finally {
        h.transport.dispose()
        h.dom.window.close()
      }
    },
  )

  it('never applies delayed background configuration over a newer user choice', async () => {
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
      composer(h.dom.window.document, 'thread-1')
      await settle()
      expect(await h.transport.select({ providerId: 'provider-b', model: 'model-b' })).toBe('accepted')
      const reads = h.channel.selectionRead.mock.calls.length
      message(h.dom.window, {
        type: 'mcp-response',
        hostId: 'local',
        message: { id: pending!.id, result: { config: { model_provider: 'provider-a', model: 'old-model' } } },
      })
      await settle()
      expect(h.channel.selectionRead).toHaveBeenCalledTimes(reads)
      expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-b', model: 'model-b' })
    } finally {
      h.transport.dispose()
      h.dom.window.close()
    }
  })
})
