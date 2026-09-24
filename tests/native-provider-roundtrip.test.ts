import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexDesktopNativeModelProviderTransport } from '../packages/cli/src/renderer/native-model-provider-transport.js'
import type { NativeProviderSelectionProjection } from '../packages/cli/src/renderer/native-provider-selection-client.js'
import { composer } from './fixtures/native-model-provider-composer.js'

afterEach(() => vi.unstubAllGlobals())

async function harness() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'app://-/index.html' })
  const control = composer(dom.window.document, 'thread', 'shared')
  const props = (control.trigger as any).__reactFiber$test.return.memoizedProps
  props.model = 'shared'
  const message = (value: unknown) =>
    dom.window.dispatchEvent(
      new dom.window.MessageEvent('message', {
        data: { type: 'mcp-response', hostId: 'local', message: value },
        source: dom.window,
      }),
    )
  for (
    const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      location: dom.window.location,
      codexWindowType: 'electron',
      __cordisxNativeSubmitHook: undefined,
      __cordisxNativeSubmissionAuthority: undefined,
      __cordisxNativeServiceTierOverride: undefined,
      electronBridge: {
        sendMessageFromView: async ({ request }: any) => {
          const result = request.method === 'thread/read'
            ? { thread: { id: request.params.threadId, status: { type: 'idle' }, modelProvider: 'provider-a' } }
            : { config: { model_provider: 'provider-a', model: 'shared' } }
          queueMicrotask(() => message({ id: request.id, result }))
        },
      },
    })
  ) vi.stubGlobal(key, value)
  let projection: NativeProviderSelectionProjection = {
    available: true,
    revision: 1,
    effective: { providerId: 'provider-a', model: 'shared' },
  }
  const channel = {
    selectionRead: vi.fn(async () => projection),
    selectionSelect: vi.fn(async (target: { providerId: string; model: string }) => {
      projection = { available: true, revision: projection.revision + 1, effective: target }
      return { ...projection, status: 'accepted' as const, effective: target }
    }),
    submissionPrepare: vi.fn(async () => ({ status: 'pass-through' as const })),
    submissionConfirm: vi.fn(async () => ({ status: 'reject' as const, reason: 'unused' })),
    submissionCancel: vi.fn(),
  }
  const transport = await CodexDesktopNativeModelProviderTransport.connect(true, {
    targetId: 'target',
    rendererGeneration: 'renderer',
  }, channel)
  if (!transport) throw new Error('transport unavailable')
  const resume = (id: string, provider: string, threadId = 'thread') => {
    dom.window.dispatchEvent(
      new dom.window.CustomEvent('codex-message-from-view', {
        detail: {
          type: 'mcp-request',
          hostId: 'local',
          request: {
            id,
            method: 'thread/resume',
            params: { threadId, modelProvider: provider, model: 'shared' },
          },
        },
      }),
    )
    return () => message({ id, result: { thread: { id: threadId }, modelProvider: provider, model: 'shared' } })
  }
  return {
    transport,
    resume,
    dom,
    channel,
    close: () => {
      transport.dispose()
      dom.window.close()
    },
  }
}

describe('native provider roundtrip', () => {
  it('accepts ordinary sequential resumes and keeps background requests independent', async () => {
    const h = await harness()
    try {
      h.resume('outbound', 'deepseek')()
      expect(h.transport.getSnapshot().modelProvider).toBe('deepseek')
      const back = h.resume('return', 'provider-a')
      h.resume('background', 'other', 'other-thread')()
      back()
      expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'shared' })
    } finally {
      h.close()
    }
  })

  it('rejects stale selection replies even when they contain the same model ID', async () => {
    const h = await harness()
    try {
      let finish!: (value: any) => void
      h.channel.selectionSelect.mockImplementationOnce(() =>
        new Promise(resolve => {
          finish = resolve
        })
      )
      const outbound = h.transport.select({ providerId: 'deepseek', model: 'shared' })
      expect(await h.transport.select({ providerId: 'provider-a', model: 'shared' })).toBe('accepted')
      finish({ status: 'accepted', revision: 1, effective: { providerId: 'deepseek', model: 'shared' } })
      expect(await outbound).toBe('unavailable')
      expect(h.transport.getSnapshot().modelProvider).toBe('provider-a')
    } finally {
      h.close()
    }
  })

  it('rejects a resume from a previous navigation to the same thread', async () => {
    const h = await harness()
    try {
      const stale = h.resume('old-navigation', 'deepseek')
      composer(h.dom.window.document, 'other-thread')
      await new Promise(resolve => setTimeout(resolve, 0))
      composer(h.dom.window.document, 'thread')
      await new Promise(resolve => setTimeout(resolve, 0))
      stale()
      expect(h.transport.getSnapshot().modelProvider).toBe('provider-a')
    } finally {
      h.close()
    }
  })

  it('ignores the older same-thread resume after A -> DeepSeek -> A with overlapping IDs', async () => {
    const h = await harness()
    try {
      const deepseek = h.resume('outbound', 'deepseek')
      const back = h.resume('return', 'provider-a')
      back()
      deepseek()
      expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'shared' })
    } finally {
      h.close()
    }
  })

  it('does not overwrite an accepted return selection with an earlier native resume', async () => {
    const h = await harness()
    try {
      const stale = h.resume('old-resume', 'deepseek')
      expect(await h.transport.select({ providerId: 'deepseek', model: 'shared' })).toBe('accepted')
      expect(await h.transport.select({ providerId: 'provider-a', model: 'shared' })).toBe('accepted')
      stale()
      expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'shared' })
    } finally {
      h.close()
    }
  })

  it('retires an older resume when canceling a pending switch back to the displayed provider', async () => {
    const h = await harness()
    try {
      const stale = h.resume('old-resume', 'deepseek')
      h.channel.selectionSelect
        .mockResolvedValueOnce({
          status: 'accepted',
          revision: 2,
          effective: { providerId: 'provider-a', model: 'shared' },
          pending: { providerId: 'deepseek', model: 'shared', generation: 1 },
        })
        .mockResolvedValueOnce({
          status: 'accepted',
          revision: 3,
          effective: { providerId: 'provider-a', model: 'shared' },
        })

      expect(await h.transport.select({ providerId: 'deepseek', model: 'shared' })).toBe('accepted')
      expect(h.transport.getSnapshot()).toMatchObject({
        modelProvider: 'provider-a',
        pendingProviderId: 'deepseek',
      })
      expect(await h.transport.select({ providerId: 'provider-a', model: 'shared' })).toBe('accepted')
      stale()
      expect(h.transport.getSnapshot()).toMatchObject({ modelProvider: 'provider-a', model: 'shared' })
    } finally {
      h.close()
    }
  })
})
