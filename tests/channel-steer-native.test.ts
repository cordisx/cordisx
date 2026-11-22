import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import type { AgentBridge } from '../packages/cli/src/launcher/agent-bridge.js'
import { ChannelAgentAccess } from '../packages/cli/src/launcher/channel-agent-access.js'
import { ChannelInboundResources } from '../packages/cli/src/launcher/channel-inbound-resources.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { JsonLineRpcError } from '../packages/cli/src/providers/json-line-rpc.js'

const account = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'tenant' }
function message(id: string, text: string): ChannelUserInput {
  return {
    contract: 'cordisx.channel-user-input/v1',
    schemaVersion: 1,
    role: 'user',
    source: {
      kind: 'channel',
      event: {
        ...account,
        conversationId: 'oc_one',
        kind: 'direct',
        threadId: 'oc_one',
        semantics: 'conversation',
        eventId: id,
        messageId: id,
        actor: { ...account, userId: 'alice' },
      },
    },
    receivedAt: '2026-11-23T00:00:00Z',
    content: [{ type: 'text', text }],
  }
}
const cli = { node: '/node', entry: '/entry', home: '/home', profile: 'default' }
const token = (prompt: string) => /--context '([a-f0-9]+)'/u.exec(prompt)?.[1]

describe('Channel native insertion', () => {
  it('associates each input and its sender with its own context while retaining one native turn', async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = []
    const call = vi.fn(async () => ({ status: 'sent', sessionId: 'session', turnId: 'turn' }))
    const sessions = new ChannelNativeSessions({
      cwd: '/repo',
      cli,
      bridge: () => ({ call }) as unknown as AgentBridge,
      nativeRequest: async (method, params) => {
        requests.push({ method, params: { ...params } })
        return method === 'turn/steer' ? { turnId: 'turn' } : { thread: { id: 'session', status: { type: 'idle' } } }
      },
    })
    const first = message('one', 'initial'), second = message('two', 'adjustment')
    Object.assign(second.source.event, { threadId: 'quote-chain', semantics: 'reply-chain' })
    expect((await sessions.start('job-one', first, 'session')).state).toBe('running')
    expect((await sessions.steer('job-two', second, 'session', 'turn')).state).toBe('accepted')
    const submitted = requests.find(entry => entry.method === 'turn/steer')!.params
    expect(submitted).toMatchObject({ threadId: 'session', expectedTurnId: 'turn', clientUserMessageId: 'job-two' })
    const contents = submitted.input as Array<{ text: string }>
    const contextToken = token(contents[0]!.text)
    expect(contextToken).toBeTruthy()
    expect(sessions.sourceFor('session', 'turn')).toEqual(first.source.event)
    expect(await sessions.sourceForLogicalTurn('session', 'turn')).toEqual(first.source.event)
    const state = () => ({ inputs: { one: { input: first }, two: { input: second } }, jobs: {}, bindings: {} }) as never
    const access = new ChannelAgentAccess(state, () => sessions)
    expect(access.caller({ 'cordisx/channelContext': contextToken })?.source).toEqual(second.source.event)
    expect(access.requestText({ 'cordisx/channelContext': contextToken })).toBe('adjustment')
    const third = message('three', 'quoted again')
    Object.assign(third.source.event, { threadId: 'different-chain', semantics: 'reply-chain' })
    expect((await sessions.steer('job-third', third, 'session', 'turn')).state).toBe('accepted')
    expect(access.caller({ 'cordisx/channelContext': contextToken, 'openai/threadId': 'another' })).toBeUndefined()
    const bob = message('four', 'different sender')
    const other = {
      ...bob,
      source: {
        ...bob.source,
        event: {
          ...bob.source.event,
          actor: { ...account, userId: 'bob' },
        },
      },
    }
    expect((await sessions.steer('job-three', other, 'session', 'turn')).state).toBe('rejected')
  })
  it('forwards actual image attachments in a steer request', async () => {
    const resources = new ChannelInboundResources()
    try {
      const input = message('image', 'look at this')
      const image = await resources.ingest(
        input.source.event,
        Readable.from([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])]),
        'image',
      )
      const combined = { ...input, content: [...input.content, image] }
      const request = vi.fn(async method =>
        method === 'turn/steer'
          ? { turnId: 'turn' }
          : { thread: { id: 'session', status: { type: 'idle' } } }
      )
      const sessions = new ChannelNativeSessions({
        cwd: '/repo',
        bridge: () => ({ call: async () => ({ status: 'sent', sessionId: 'session', turnId: 'turn' }) }) as never,
        nativeRequest: request,
      })
      await sessions.start('original', message('first', 'initial'), 'session')
      expect((await sessions.steer('image-job', combined, 'session', 'turn')).state).toBe('accepted')
      expect(request).toHaveBeenCalledWith(
        'turn/steer',
        expect.objectContaining({
          input: expect.arrayContaining([expect.objectContaining({ type: 'localImage', path: expect.any(String) })]),
        }),
      )
    } finally {
      await resources.dispose()
    }
  })
  it('distinguishes a native rejection from an unknown transport result', async () => {
    let failure: Error = new JsonLineRpcError('no active turn to steer', -32600)
    const sessions = new ChannelNativeSessions({
      cwd: '/repo',
      bridge: () => ({ call: async () => ({ status: 'sent', sessionId: 'session', turnId: 'turn' }) }) as never,
      nativeRequest: async method => {
        if (method === 'thread/read') return { thread: { id: 'session', status: { type: 'idle' } } }
        throw failure
      },
    })
    await sessions.start('original', message('initial', 'first'), 'session')
    expect((await sessions.steer('rejected', message('one', 'late'), 'session', 'turn')).state).toBe('rejected')
    failure = new Error('connection lost')
    expect(await sessions.steer('unknown', message('two', 'unknown'), 'session', 'turn'))
      .toMatchObject({ state: 'reconciliation-required', code: 'NATIVE_STEER_UNCERTAIN' })
  })
  it('requires positive evidence of this exact input in the expected turn to resolve uncertainty', async () => {
    let text = '{"operationId":"job-two","source":{}}'
    const sessions = new ChannelNativeSessions({
      cwd: '/repo',
      bridge: () => undefined,
      nativeRequest: async () => ({
        data: [{ turnId: 'turn', item: { type: 'userMessage', content: [{ type: 'text', text }] } }],
      }),
    })
    expect(await sessions.steerObserved('job-two', 'session', 'turn')).toBe(true)
    expect(await sessions.steerObserved('job-two', 'session', 'another')).toBe(false)
    text = '{"operationId":"different","source":{}}'
    expect(await sessions.steerObserved('job-two', 'session', 'turn')).toBe(false)
  })
  it('uses bounded turn pages only when the native item API is unsupported', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/items/list') throw new JsonLineRpcError('unsupported', -32601)
      return {
        data: [{
          id: 'turn',
          items: [{ type: 'userMessage', content: [{ type: 'text', text: '{"operationId":"recover","source":{}}' }] }],
        }],
      }
    })
    const sessions = new ChannelNativeSessions({ cwd: '/repo', bridge: () => undefined, nativeRequest: request })
    expect(await sessions.steerObserved('recover', 'session', 'turn')).toBe(true)
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'session',
      limit: 1,
      itemsView: 'full',
      sortDirection: 'desc',
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/read')).toBe(false)
    request.mockImplementation(async () => {
      throw Error('transport lost')
    })
    expect(await sessions.steerObserved('recover', 'session', 'turn')).toBe(false)
    expect(request.mock.calls.at(-1)?.[0]).toBe('thread/items/list')
  })
})
