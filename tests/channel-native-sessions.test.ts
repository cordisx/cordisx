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
    expect(prompt).toContain("send --profile 'own-preview' --input")
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
