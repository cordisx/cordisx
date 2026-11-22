import { describe, expect, it, vi } from 'vitest'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'
import type { AgentBridge } from '../packages/cli/src/launcher/agent-bridge.js'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import { configuredChannelCliContext } from '../packages/cli/src/launcher/channel-cli-context.js'

const input: ChannelUserInput = {
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  content: [{ type: 'text', text: 'requested test' }],
  receivedAt: '2026-11-15T00:00:00Z',
  source: {
    kind: 'channel',
    event: {
      adapterId: 'feishu',
      accountId: 'cli_test',
      tenantId: 'test',
      conversationId: 'oc_test',
      kind: 'direct',
      threadId: 'oc_test',
      semantics: 'conversation',
      eventId: 'om_test',
    },
  },
}

describe('Channel native task delivery', () => {
  it('enriches admitted desktop models with native Fast metadata without expanding admission', async () => {
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/repo',
      nativeRequest: async () => ({}),
      models: async () => ({ providers: [{ providerId: 'openai', models: [{ id: 'allowed' }] }] }),
      configuration: {
        catalog: async () => [{
          providerId: 'openai',
          defaultModelId: 'allowed',
          models: [{ id: 'allowed', supportsFastMode: true }, { id: 'other', supportsFastMode: true }],
        }],
      } as never,
    })
    expect(await sessions.modelOperation('list', {})).toEqual({
      providers: [{
        providerId: 'openai',
        defaultModelId: 'allowed',
        models: [{ id: 'allowed', supportsFastMode: true }],
      }],
    })
  })
  it('retains requested effort after native model selection resets it', async () => {
    let selection = { providerId: 'one', model: 'old', effort: 'high' }
    const set = vi.fn(async () => ({}))
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/repo',
      nativeRequest: async () => ({
        thread: {
          id: 'chat',
          status: { type: 'idle' },
          modelProvider: selection.providerId,
          model: selection.model,
          reasoningEffort: selection.effort,
        },
      }),
      models: async () => {
        selection = { providerId: 'two', model: 'new', effort: 'low' }
        return { status: 'selected' }
      },
      execution: { read: () => ({ revision: 0, override: {} }), set } as never,
    })
    expect(await sessions.applyTaskSelection('chat', { providerId: 'two', model: 'new', effort: 'high' }))
      .toMatchObject({ status: 'selected', application: 'saved' })
    expect(set).toHaveBeenCalledWith('local', 'chat', { effort: 'high' }, 0)
  })
  it('reports native configuration failures instead of inventing an unbound project', async () => {
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/repo',
      nativeRequest: async () => ({ thread: { id: 'chat' } }),
      configuration: { call: async () => ({ status: 'rejected', code: 'CHAT_CONFIGURATION_UNAVAILABLE' }) } as never,
    })
    await expect(sessions.taskSelection('chat')).rejects.toThrow('CHAT_CONFIGURATION_UNAVAILABLE')
  })
  it('applies project and explicit Fast false before Channel first send, using the common creation layer', async () => {
    const call = vi.fn(async () => ({ status: 'started', sessionId: 'chat', turnId: 'turn' }))
    const validateProject = vi.fn(async () => {})
    const sessions = new ChannelNativeSessions({
      bridge: () => ({ call }) as unknown as AgentBridge,
      nativeRequest: async () => ({}),
      cwd: '/outside',
      configuration: { validateProject } as never,
      execution: {
        creationDefaults: async () => ({ settings: { providerId: 'openai', model: 'fast-model', fast: true } }),
        defaults: async () => ({ settings: {} }),
      } as never,
    })
    await sessions.start('configured-first', input, undefined, undefined, undefined, undefined, {
      fast: false,
      projectId: 'repo',
    })
    expect(validateProject).toHaveBeenCalledWith('repo', undefined)
    expect(call).toHaveBeenCalledWith(
      'codex',
      'start_session',
      expect.objectContaining({
        providerId: 'openai',
        model: 'fast-model',
        serviceTier: null,
        projectId: 'repo',
      }),
      undefined,
    )
  })
  it('clears an old Fast tier before switching to a non-Fast provider and revalidates between effects', async () => {
    let current = { providerId: 'one', model: 'old', fast: true }
    const order: string[] = []
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      cwd: '/repo',
      nativeRequest: async () => ({
        thread: { id: 'chat', status: { type: 'idle' }, modelProvider: current.providerId, model: current.model },
      }),
      configuration: {
        call: async () => ({ status: 'ok', revision: 0, effective: { fast: current.fast } }),
        applyChannel: async (_operation: string, patch: { fast: boolean }, before: () => Promise<boolean>) => {
          expect(await before()).toBe(true)
          order.push('fast')
          current.fast = patch.fast
          return { status: 'applied' }
        },
      } as never,
      models: async (_operation, patch, before) => {
        expect(await before!()).toBe(true)
        order.push('provider')
        const selected = patch as { providerId: string; model: string }
        current = { ...current, ...selected }
        return { status: 'selected' }
      },
    })
    expect(
      await sessions.applyTaskSelection('chat', { providerId: 'two', model: 'new', fast: false }, async applied => {
        const expected = { providerId: 'one', model: 'old', fast: true, ...applied }
        return Object.entries(expected).every(([key, value]) => current[key as keyof typeof current] === value)
      }),
    ).toMatchObject({ status: 'selected', application: 'applied' })
    expect(order).toEqual(['fast', 'provider'])
  })
  it('merges Channel creation selection over common defaults without carrying another provider model', async () => {
    const call = vi.fn(async () => ({ status: 'started', sessionId: 'chat', turnId: 'turn' }))
    const sessions = new ChannelNativeSessions({
      bridge: () => ({ call }) as unknown as AgentBridge,
      nativeRequest: async () => ({}),
      cwd: '/tmp',
      execution: {
        creationDefaults: async () => ({ settings: { providerId: 'base', model: 'base-model' } }),
        defaults: async () => ({ settings: {} }),
      } as never,
      models: async () => ({
        providers: [{ providerId: 'channel', defaultModelId: 'channel-model', models: [{ id: 'channel-model' }] }],
      }),
    })
    expect(await sessions.creationSelection()).toEqual({ providerId: 'base', model: 'base-model' })
    await sessions.start('selection', input, undefined, undefined, undefined, undefined, { providerId: 'channel' })
    expect(call).toHaveBeenCalledWith(
      'codex',
      'start_session',
      expect.objectContaining({ providerId: 'channel', model: 'channel-model' }),
      undefined,
    )
  })
  it('expires only the global preparation fence while keeping the known target restricted', async () => {
    vi.useFakeTimers()
    try {
      const sessions = new ChannelNativeSessions({
        bridge: () =>
          ({
            call: async () => ({ status: 'started', sessionId: 'target', turnId: 'prep' }),
          }) as unknown as AgentBridge,
        nativeRequest: async () => ({}),
        cwd: '/tmp',
      })
      await sessions.startContinuation('prepare', 'brief', {} as never, input.source.event, {
        token: 'a'.repeat(64),
        sourceId: 'source',
      })
      expect(sessions.hasPreparation()).toBe(true)
      expect(sessions.isPreparing('target')).toBe(true)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(sessions.hasPreparation()).toBe(false)
      expect(sessions.isPreparing('target')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('redacts live source context tokens from the bounded history even after the source ends', async () => {
    let token = '', notify: ((method: string, params: unknown) => void) | undefined
    const call = vi.fn(async (_app, _operation, args) => {
      token = /--context '([a-f0-9]{48})'/u.exec(args.prompt)?.[1] ?? ''
      return { status: 'started', sessionId: 'source', turnId: 'turn' }
    })
    const sessions = new ChannelNativeSessions({
      bridge: () => ({ call }) as unknown as AgentBridge,
      nativeRequest: async method =>
        method === 'thread/items/list'
          ? { data: [{ item: { type: 'agentMessage', text: `context ${token}` } }] }
          : {},
      cwd: '/tmp',
      cli: configuredChannelCliContext('/tmp/cx', 'profile'),
      subscribeContinuationEvents: listener => {
        notify = listener
        return () => {}
      },
    })
    await sessions.start('operation', input)
    expect(token).toHaveLength(48)
    notify?.('turn/completed', { threadId: 'source', turn: { id: 'turn', status: 'completed' } })
    const page = await sessions.continuationHistory('source', { limit: 8 })
    expect(JSON.stringify(page)).not.toContain(token)
    expect(page.entries[0]?.text).toContain('[context redacted]')
  })
  it('correlates the first native approval before the first-turn acknowledgement and forwards scoped model/effort defaults', async () => {
    const message = structuredClone(input)
    message.source.event = {
      ...message.source.event,
      actor: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'test', userId: 'ou_alice' },
    }
    let sessions!: ChannelNativeSessions
    const nativeRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/start') return { thread: { id: 'chat' }, model: 'model', modelProvider: 'provider' }
      if (method === 'turn/start') {
        expect(sessions.sourceFor('chat', 'turn')?.actor?.userId).toBe('ou_alice')
        expect(params.effort).toBe('high')
        return { turn: { id: 'turn' } }
      }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed' }] }
      return {}
    })
    const handler = createCodexBridgeHandler({
      nativeRequest,
      catalog: async () => [{
        providerId: 'provider',
        pluginId: 'test',
        models: [{ id: 'model', label: 'Model', aliases: [] }],
      }],
      observedDispatch: (id, thread, turn) => sessions.observedDispatch(id, thread, turn),
    }, '/tmp')
    sessions = new ChannelNativeSessions({
      bridge: () => ({ call: (_app, operation, args, signal) => handler(operation, args, signal) }) as AgentBridge,
      nativeRequest,
      cwd: '/tmp',
    })
    expect(
      await sessions.start('first', message, undefined, undefined, undefined, undefined, {
        providerId: 'provider',
        model: 'model',
        effort: 'high',
      }),
    ).toMatchObject({ state: 'running' })
    expect(nativeRequest.mock.calls.find(([method]) => method === 'thread/start')?.[1]).toMatchObject({
      config: { model_reasoning_effort: 'high' },
      modelProvider: 'provider',
      model: 'model',
    })
    await sessions.completion('chat', 'turn')
    expect(sessions.sourceFor('chat')).toBeUndefined()
  })

  it('never reads a saved model override as actual native state and applies effort without changing other execution settings', async () => {
    let live = { providerId: 'two', model: 'new', reasoningEffort: 'low', serviceTier: null }
    const execution = {
      read: vi.fn(() => ({
        revision: 2,
        override: { approval: 'never', effort: 'high' },
        effective: { modelProvider: 'one', model: 'old', reasoningEffort: 'high' },
      })),
      set: vi.fn(async () => ({})),
    }
    const nativeRequest = vi.fn(async () => ({
      thread: { id: 'chat', status: { type: 'idle' }, modelProvider: 'two', model: 'new' },
    }))
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      nativeRequest,
      cwd: '/tmp',
      execution: execution as never,
      sourceConfiguration: async () => live as never,
      models: async () => ({ status: 'selected' }),
    })
    expect(await sessions.taskSelection('chat')).toEqual({
      providerId: 'two',
      model: 'new',
      effort: 'low',
      fast: false,
    })
    expect(await sessions.applyTaskSelection('chat', { providerId: 'two', model: 'new', effort: 'inherit' }))
      .toMatchObject({ status: 'selected' })
    expect(execution.set).toHaveBeenCalledWith('local', 'chat', { approval: 'never' }, 2)
    live = undefined as never
    expect(await sessions.taskSelection('chat')).toEqual({ providerId: 'two', model: 'new' })
  })
  it('passes captured reply defaults and the exact incoming operation to the model without sending', async () => {
    const call = vi.fn(async () => ({ status: 'started', sessionId: 'chat', turnId: 'turn' }))
    const nativeRequest = vi.fn(async () => ({}))
    const sessions = new ChannelNativeSessions({
      bridge: () => ({ call }) as unknown as AgentBridge,
      nativeRequest,
      cwd: '/tmp',
    })
    await expect(sessions.start('incoming-operation', input, undefined, undefined, {
      enabled: true,
      mode: 'agent',
      fallbackMode: 'reply',
    })).resolves.toMatchObject({ state: 'running' })
    const prompt = (call.mock.calls[0] as unknown as [string, string, { prompt: string }])[2].prompt
    expect(prompt).toContain('channel_reply_mode')
    expect(prompt).toContain('"operationId":"incoming-operation"')
    expect(prompt).toContain('"fallbackMode":"reply"')
    expect(prompt).toContain('first select none')
    expect(nativeRequest.mock.calls.every(([method]) => method === 'thread/read')).toBe(true)
  })
  it('instructs default turns to send only through the exact scoped Host CLI and keeps local text local', async () => {
    const call = vi.fn(async () => ({ status: 'started', sessionId: 'chat', turnId: 'turn' }))
    const cli = configuredChannelCliContext("/tmp/Channel user's home", 'own-preview')
    const sessions = new ChannelNativeSessions({
      bridge: () => ({ call }) as unknown as AgentBridge,
      nativeRequest: vi.fn(async () => ({})),
      cwd: '/tmp',
      cli,
    })
    await sessions.start('incoming-default', input)
    const prompt = (call.mock.calls[0] as unknown as [string, string, { prompt: string }])[2].prompt
    expect(prompt).toContain('Automatic final-response delivery is disabled')
    expect(prompt).toContain('commentary and final answers stay here')
    expect(prompt).toMatch(/send --profile 'own-preview' --context '[a-f0-9]{48}' --input/u)
    expect(prompt).toContain("CORDISX_HOME='/tmp/Channel user'\\''s home'")
    expect(prompt).toContain(cli.entry)
    expect(prompt).toContain('"enabled":false')
    expect(prompt).not.toContain('Reply to the sender in your final response')
  })
  it.each(['completed', 'interrupted', 'inProgress'])(
    'default completion reads only the exact turn status %s, never assistant items',
    async status => {
      const nativeRequest = vi.fn(async () => ({ data: [{ id: 'turn', status }] }))
      const sessions = new ChannelNativeSessions({ bridge: () => undefined, nativeRequest, cwd: '/tmp' })
      await expect(sessions.completion('chat', 'turn')).resolves.toMatchObject({
        state: status === 'completed' ? 'completed' : status === 'inProgress' ? 'running' : 'failed',
      })
      expect(nativeRequest).toHaveBeenCalledOnce()
      expect(nativeRequest).toHaveBeenCalledWith('thread/turns/list', expect.objectContaining({ threadId: 'chat' }))
    },
  )
  it('reads only the final response of the exact completed turn', async () => {
    const nativeRequest = vi.fn(async (method: string, _params: unknown) =>
      method === 'thread/turns/list'
        ? { data: [{ id: 'turn', status: 'completed' }] }
        : {
          data: [
            { turnId: 'newer', item: { type: 'agentMessage', phase: 'final_answer', text: 'other' } },
            { turnId: 'turn', item: { type: 'agentMessage', phase: 'final_answer', text: 'reply' } },
            { turnId: 'turn', item: { type: 'agentMessage', phase: 'commentary', text: 'commentary' } },
          ],
        }
    )
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      nativeRequest: nativeRequest as never,
      cwd: '/tmp',
    })
    await expect(sessions.completion('chat', 'turn', true)).resolves.toEqual({ state: 'completed', text: 'reply' })
    expect(nativeRequest.mock.calls.every(([, params]) => (params as { threadId: string }).threadId === 'chat')).toBe(
      true,
    )
  })
  it('falls back on old app-servers only for a missing item method and the exact completed turn', async () => {
    const nativeRequest = vi.fn(async (method: string) => {
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'completed' }] }
      if (method === 'thread/items/list') throw Object.assign(new Error('missing'), { rpcCode: -32601 })
      if (method === 'thread/read') {
        return {
          thread: {
            id: 'chat',
            turns: [
              {
                id: 'other',
                status: 'completed',
                items: [{ type: 'agentMessage', phase: 'final_answer', text: 'wrong' }],
              },
              {
                id: 'turn',
                status: 'completed',
                items: [
                  { type: 'agentMessage', phase: 'commentary', text: 'hidden' },
                  { type: 'agentMessage', phase: 'final_answer', text: 'correct' },
                ],
              },
            ],
          },
        }
      }
      throw new Error('unexpected')
    })
    const sessions = new ChannelNativeSessions({
      bridge: () => undefined,
      nativeRequest: nativeRequest as never,
      cwd: '/tmp',
    })
    await expect(sessions.completion('chat', 'turn', true)).resolves.toEqual({ state: 'completed', text: 'correct' })
    expect(nativeRequest).toHaveBeenCalledWith('thread/read', { threadId: 'chat', includeTurns: true })
    nativeRequest.mockImplementationOnce(async () => ({ data: [{ id: 'turn', status: 'completed' }] }))
    nativeRequest.mockImplementationOnce(async () => {
      throw Object.assign(new Error('denied'), { rpcCode: -32000 })
    })
    await expect(sessions.completion('chat', 'turn', true)).rejects.toThrow('denied')
  })
  it('checks cancellation after async credential preparation and before creating a native thread', async () => {
    const lifetime = new AbortController()
    const nativeRequest = vi.fn(async () => ({}))
    const handler = createCodexBridgeHandler(
      {
        nativeRequest,
        catalog: async () => [{
          providerId: 'test',
          pluginId: 'service',
          models: [{ id: 'model', label: 'model', aliases: [] }],
        }],
      },
      '/tmp',
      {
        providers: async () => [{ kind: 'model-service', id: 'test', apiKeyEnv: 'TEST' } as never],
        secret: async () => {
          lifetime.abort()
          return 'fixture-only'
        },
      },
    )
    const sessions = new ChannelNativeSessions({
      bridge: () => ({ call: (_app, op, args, signal) => handler(op, args, signal) }) as AgentBridge,
      nativeRequest,
      cwd: '/tmp',
      providerId: 'test',
      model: 'model',
    })
    await expect(sessions.start('operation', input, undefined, lifetime.signal)).resolves.toMatchObject({
      state: 'failed',
      code: 'CANCELLED',
    })
    expect(nativeRequest).not.toHaveBeenCalled()
  })
})
