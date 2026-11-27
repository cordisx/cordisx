import { describe, expect, it, vi } from 'vitest'
import {
  accountRouting,
  prepareResponsesRecoveryRequest,
} from '../packages/cli/assets/launcher/native-responses-recovery.mjs'

describe('shared native Responses recovery preparation', () => {
  it('uses the explicit or persisted provider and preserves other request settings', async () => {
    const readThread = vi.fn(async () => ({ thread: { modelProvider: 'saved' } }))
    const prepare = vi.fn(async (id?: string) => ({
      [`model_providers.${id}`]: { base_url: 'http://127.0.0.1:1234/opaque', wire_api: 'responses' },
    }))
    const initial = { modelProvider: 'selected', config: { unrelated: 'kept' } }
    expect(await prepareResponsesRecoveryRequest('thread/start', initial, { readThread, prepare })).toEqual({
      ...initial,
      config: {
        unrelated: 'kept',
        'model_providers.selected': {
          base_url: 'http://127.0.0.1:1234/opaque',
          wire_api: 'responses',
        },
      },
    })
    expect(initial.config).toEqual({ unrelated: 'kept' })
    expect(
      await prepareResponsesRecoveryRequest('thread/resume', { threadId: 'saved-thread' }, { readThread, prepare }),
    )
      .toMatchObject({ config: { 'model_providers.saved': { base_url: 'http://127.0.0.1:1234/opaque' } } })
    expect(readThread).toHaveBeenCalledWith('saved-thread')
    expect(prepare.mock.calls.map(call => call[0])).toEqual(['selected', 'saved'])
  })

  it('leaves ambiguous providers and alternate history paths untouched', async () => {
    const readThread = vi.fn(async () => ({ thread: {} }))
    const prepare = vi.fn(async () => ({ unexpected: true }))
    for (
      const [method, request] of [
        ['thread/resume', { threadId: 'missing' }],
        ['thread/resume', { threadId: 'one', path: '/copy' }],
        ['thread/resume', { threadId: 'one', history: [] }],
        ['thread/start', { modelProvider: 'a', config: { model_provider: 'b' } }],
        ['thread/start', { modelProvider: 'openai', config: { chatgpt_base_url: 'https://regional.example' } }],
        ['thread/start', {
          modelProvider: 'openai',
          config: { 'model_providers.openai.base_url': 'https://custom.example' },
        }],
        ['turn/start', { threadId: 'one' }],
      ] as const
    ) {
      expect(await prepareResponsesRecoveryRequest(method, request, { readThread, prepare })).toBe(request)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('passes only opaque identity digests and the native workspace route to the shared preparation', async () => {
    const raw = {
      account: { type: 'chatgpt', email: 'private@example.test' },
      userId: 'synthetic-user',
      workspaceRouting: {
        chatgptAccountId: 'synthetic-account',
        backendOrigin: 'https://regional.chatgpt.com',
        accountRoutingOverride: 'us',
      },
      accessToken: 'do-not-transfer',
    }
    const prepare = vi.fn(async () => ({ openai_base_url: 'http://127.0.0.1:1234/opaque' }))
    const readAccount = vi.fn(async () => raw)
    const prepared = await prepareResponsesRecoveryRequest('thread/resume', {
      threadId: 'one',
      modelProvider: 'openai',
    }, {
      readThread: async () => ({}),
      readAccount,
      prepare,
    })
    expect(prepared.config).toEqual({ openai_base_url: 'http://127.0.0.1:1234/opaque' })
    expect(prepare).toHaveBeenCalledWith('openai', accountRouting(raw))
    expect(JSON.stringify(prepare.mock.calls)).not.toContain('synthetic-account')
    expect(JSON.stringify(prepare.mock.calls)).not.toContain('private@example.test')
    expect(JSON.stringify(prepare.mock.calls)).not.toContain('do-not-transfer')
  })
})
