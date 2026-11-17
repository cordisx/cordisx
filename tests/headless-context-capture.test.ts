import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'
import { NativeContextObserver } from '../packages/cli/src/launcher/native-context-observer.js'
import { HeadlessContextCapture } from '../packages/cli/src/launcher/headless-context-capture.js'

describe('same-server prepared context capture', () => {
  it('binds the exact submitted request and verifies the native usable-window observation', async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        models: [{
          slug: 'm',
          context_window: 100_000,
          max_context_window: 100_000,
          auto_compact_token_limit: 80_000,
          effective_context_window_percent: 80,
        }],
      }),
    )
    const startup = {
      nativeVersion: '0.167.0-alpha.3.2',
      serverId: 'server',
      providerKind: 'openai-compatible' as const,
      providerId: 'openai',
      catalogBytes: bytes,
      catalogSha256: createHash('sha256').update(bytes).digest('hex'),
    }
    let submitted: Record<string, unknown> | undefined
    const server = {
      generation: 'server',
      close: async () => {},
      request: async (method: string) =>
        method === 'config/read'
          ? {
            config: {
              model: 'm',
              model_provider: 'openai',
              features: {},
              model_context_window: null,
              model_auto_compact_token_limit: null,
            },
          }
          : { requirements: { featureRequirements: null } },
      requestWithReceipt: async (
        _method: string,
        params: Record<string, unknown>,
        _signal: unknown,
        onId: (id: number) => void,
      ) => {
        onId(7)
        submitted = structuredClone(params)
        return {
          requestId: 7,
          responseRequestId: 7,
          result: { thread: { id: 's' }, model: 'm', modelProvider: 'openai' },
        }
      },
    }
    const observations = new ContextObservations(() => 100),
      observer = new NativeContextObserver(observations, () => 100)
    const capture = new HeadlessContextCapture(server as never, startup, observer)
    const next = vi.fn(async () => ({}))
    await capture.dispatch(
      'thread/start',
      { cwd: '/tmp', model: 'm', config: { model_reasoning_effort: 'high' } },
      next,
    )
    expect(submitted).toMatchObject({
      model: 'm',
      config: { model_reasoning_effort: 'high', model_context_window: 100_000, model_auto_compact_token_limit: 80_000 },
    })
    expect(next).not.toHaveBeenCalled()
    observer.notification('thread/tokenUsage/updated', {
      threadId: 's',
      turnId: 't',
      tokenUsage: { last: { totalTokens: 40_000 }, modelContextWindow: 80_000 },
    })
    expect(observations.read('s')).toMatchObject({ usedTokens: 40_000, budget: { status: 'resolved', tokens: 80_000 } })
    observer.notification('thread/settings/updated', {
      threadId: 's',
      threadSettings: { model: 'm', modelProvider: 'openai' },
    })
    observer.notification('thread/tokenUsage/updated', {
      threadId: 's',
      turnId: 't',
      tokenUsage: { last: { totalTokens: 40_000 }, modelContextWindow: 80_000 },
    })
    expect(observations.read('s')?.budget).toMatchObject({ status: 'resolved', tokens: 80_000 })
    await capture.dispatch('thread/resume', { threadId: 's' }, next)
    observer.notification('thread/tokenUsage/updated', {
      threadId: 's',
      turnId: 't',
      tokenUsage: { last: { totalTokens: 40_000 }, modelContextWindow: 80_000 },
    })
    expect(observations.read('s')?.budget).toEqual({ status: 'unavailable', reason: 'unknown' })
    observer.dispose()
  })
})
