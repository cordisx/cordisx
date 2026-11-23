import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime, type ChannelUserInput } from '../packages/channel-runtime/src/index.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { JsonLineRpcClient } from '../packages/cli/src/providers/json-line-rpc.js'

it.each(['sent', 'unknown'])(
  'long native history stays off the RPC connection and three steered inputs produce one %s final delivery',
  async delivery => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-final-rpc-'))
    const account = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
    const session = '01a10000-0000-7000-8000-000000000001'
    const source = {
      ...account,
      conversationId: 'oc_fixture',
      threadId: 'oc_fixture',
      semantics: 'conversation' as const,
      kind: 'direct' as const,
    }
    let active = false
    const input = new PassThrough(), output = new PassThrough()
    const requests: { method: string; params: Record<string, unknown> }[] = []
    const target = {
      id: 'target',
      status: 'completed',
      items: [
        { type: 'commandExecution', output: 'x'.repeat(55 * 1024) },
        { type: 'agentMessage', phase: 'commentary', text: 'hidden progress' },
        { type: 'agentMessage', phase: 'final_answer', text: 'EXACT_FINAL' },
      ],
    }
    const unrelated = {
      id: 'newer',
      status: 'completed',
      items: [{ type: 'agentMessage', phase: 'final_answer', text: 'WRONG_TURN' }],
    }
    const entireHistory = {
      thread: {
        id: session,
        turns: [...Array.from({ length: 50 }, (_, i) => ({ ...target, id: 'old-' + i })), target, unrelated],
      },
    }
    expect(Buffer.byteLength(JSON.stringify(entireHistory))).toBeGreaterThan(2 * 1024 * 1024)
    const client = new JsonLineRpcClient({ input, output, timeoutMs: 2000 })
    output.on('data', bytes => {
      const request = JSON.parse(String(bytes))
      requests.push(request)
      const params = request.params
      let result: unknown
      if (request.method === 'thread/items/list') {
        queueMicrotask(() =>
          input.write(
            JSON.stringify({
              id: request.id,
              error: { code: -32601, message: 'thread/items/list is not supported yet' },
            }) + '\n',
          )
        )
        return
      }
      if (request.method === 'thread/read') {
        result = params.includeTurns
          ? entireHistory
          : { thread: { id: session, status: { type: active ? 'active' : 'idle' } } }
      } else if (request.method === 'turn/steer') result = { turnId: 'target' }
      else if (request.method === 'thread/turns/list') {
        if (active) result = { data: [{ id: 'target', status: 'inProgress' }] }
        else if (params.limit !== 1) {
          result = { data: [{ id: 'newer', status: 'completed' }, { id: 'target', status: 'completed' }] }
        } else if (params.cursor === undefined) {
          result = { data: [{ id: 'newer', status: 'completed' }], nextCursor: 'target-page' }
        } else result = { data: [params.itemsView === 'full' ? target : { id: 'target', status: 'completed' }] }
      } else result = {}
      queueMicrotask(() => input.write(JSON.stringify({ id: request.id, result }) + '\n'))
    })
    const runtime = await ChannelRuntime.open({
      storePath: path.join(root, 'runtime.json'),
      permissions: { authorize: async () => 'allow' },
    })
    const send = vi.fn(async () => delivery === 'sent' ? { externalMessageId: 'om_final' } : {} as never)
    const adapter = await runtime.activate({
      descriptor: {
        ref: account,
        kind: 'feishu',
        implementationStatus: 'experimental',
        configurationRevision: 1,
        secretState: 'ready',
      },
      start: async () => ({ send, stop: async () => {} }),
    }, { source: 'test', pluginId: 'fixture', generation: 'test' })
    const bridge = vi.fn(async () => {
      active = true
      return { status: 'sent', sessionId: session, turnId: 'target' }
    })
    const native = new ChannelNativeSessions({
      cwd: root,
      bridge: () => ({ call: bridge }) as never,
      nativeRequest: (method, params) => client.request(method, params),
    })
    const consumer = await ChannelConversationConsumer.open({
      file: path.join(root, 'consumer.json'),
      profileId: 'test',
      native: () => native,
      access: () =>
        ({
          generation: 'test',
          runtime,
          accounts: () => [{ ref: account, state: 'ready' }],
          drain: async () => {
            await adapter.drainOutbound(10)
          },
        }) as never,
    })
    consumer.setNativeExtras(() => native)
    const message = (id: string): ChannelUserInput => ({
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      receivedAt: new Date().toISOString(),
      source: {
        kind: 'channel',
        event: { ...source, messageId: id, eventId: id, actor: { ...account, userId: 'alice' } },
      },
      content: [{ type: 'text', text: 'synthetic input ' + id }],
    })
    const settle = async () => {
      await consumer.pump()
      await consumer.pump()
    }
    try {
      await consumer.policySet({ enabled: true, autoReply: true }, 0)
      await consumer.bind({ channel: source, mode: 'deliver', autoReply: true, replyMode: 'conversation' }, session)
      for (const id of ['one', 'two', 'three']) {
        await consumer.receive(id, message(id))
        await settle()
      }
      await consumer.receive('three', message('three'))
      expect(bridge).toHaveBeenCalledOnce()
      expect(requests.filter(row => row.method === 'turn/steer')).toHaveLength(2)
      active = false
      await settle()
      await settle()
      expect(send).toHaveBeenCalledOnce()
      expect(send.mock.calls[0]?.[0]).toMatchObject({ text: 'EXACT_FINAL' })
      const jobs = consumer.status().jobs
      expect(jobs).toHaveLength(3)
      expect(jobs.filter(job => job.state === 'replying')).toHaveLength(delivery === 'unknown' ? 1 : 0)
      expect(jobs.filter(job => job.state === 'completed')).toHaveLength(delivery === 'unknown' ? 2 : 3)
      expect(requests.some(row => row.method === 'thread/read' && row.params.includeTurns === true)).toBe(false)
      expect(
        requests.filter(row => row.params.itemsView === 'full').every(row =>
          row.params.limit === 1 && row.params.cursor === 'target-page'
        ),
      ).toBe(true)
      expect(await client.request('thread/read', { threadId: session, includeTurns: false })).toMatchObject({
        thread: { id: session },
      })
    } finally {
      await consumer.dispose()
      await runtime.dispose()
      client.close()
      input.destroy()
      output.destroy()
      await rm(root, { recursive: true, force: true })
    }
  },
)
