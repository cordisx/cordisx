import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'

it('the production consumer steers Host reminders into one turn, while only a confirmed CLI send cancels the debounce', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'channel-progress-cli-'))
  const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
  const session = '01a10000-0000-7000-8000-000000000001'
  const source = (id: string) => ({
    ...ref,
    conversationId: 'oc_fixture',
    threadId: 'oc_fixture',
    kind: 'group' as const,
    semantics: 'conversation' as const,
    messageId: id,
    eventId: id,
    actor: { ...ref, userId: 'ou_fixture' },
  })
  const clock = { now: () => new Date() }
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'runtime.json'),
    permissions: { authorize: async () => 'allow' },
    clock,
  })
  const send = vi.fn(async () => ({ externalMessageId: 'om_sent' }))
  const adapter = await runtime.activate({
    descriptor: {
      ref,
      kind: 'feishu',
      implementationStatus: 'experimental',
      configurationRevision: 1,
      secretState: 'ready',
    },
    start: async () => ({ send, stop: async () => {} }),
  }, { source: 'test', pluginId: 'test', generation: 'test' })
  const cli = {
    node: process.execPath,
    entry: fileURLToPath(new URL('../packages/cli/dist/src/cli.js', import.meta.url)),
    home: root,
    profile: 'default',
  }
  const requests: any[] = [], contexts: string[] = []
  const native = new ChannelNativeSessions({
    cli,
    cwd: root,
    bridge: () =>
      ({
        call: async (_app: string, _op: string, request: any) => {
          contexts.push(/--context '([a-f0-9]{48})'/u.exec(request.prompt)![1]!)
          native.observedDispatch(request.operationId, session, 'turn')
          return { status: 'started', sessionId: session, turnId: 'turn' }
        },
      }) as never,
    nativeRequest: async (method, params) => {
      if (method === 'thread/read') return { thread: { id: session, status: { type: 'active' } } }
      if (method === 'thread/turns/list') return { data: [{ id: 'turn', status: 'inProgress' }] }
      if (method === 'turn/steer') {
        requests.push(params)
        const input = (params.input as any[])[0].text
        const token = /--context '([a-f0-9]{48})'/u.exec(input)?.[1]
        if (token) contexts.push(token)
        return { turnId: 'turn' }
      }
      return { data: [] }
    },
  })
  const access: any = {
    generation: 'g1',
    runtime,
    accounts: () => [{ ref, state: 'ready' }],
    drain: async () => {
      await adapter.drainOutbound(10)
    },
    feedbackReact: vi.fn(async (_event: unknown, emojiType: string) => ({ reactionId: emojiType, emojiType })),
    feedbackRemove: vi.fn(async (_event: unknown, reactionId: string) => ({ reactionId, removed: true })),
    feedbackWait: vi.fn(),
  }
  const configPath = path.join(root, 'config.json')
  await ensureHomeConfig(configPath)
  await writeFile(
    path.join(root, 'channel-feedback.json'),
    JSON.stringify({ wait: { mode: 'agent', quietSeconds: 1, repeatSeconds: 1 } }),
  )
  const consumer = await ChannelConversationConsumer.open({
    file: path.join(root, 'consumer.json'),
    profileId: 'default',
    access: () => access,
    native: () => native,
  })
  consumer.setNativeExtras(() => native)
  const tools = new ChannelConversationTools(() => access, consumer)
  const handler = configuredChannelManagementToolHandler(tools)
  const server = await startPluginManagementRpcServer({
    homeDir: root,
    appId: 'codex',
    profileId: 'default',
    configPath,
    generation: 'g1',
    processStartedAt: (await processStartIdentity(process.pid))!,
    service: {} as never,
    channel: handler.channel,
  })
  const settle = async () => {
    await consumer.pump()
    await consumer.pump()
  }
  const receive = async (id: string) => {
    await consumer.receive(id, {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      source: { kind: 'channel', event: source(id) },
      content: [{ type: 'text', text: 'continue work' }],
      receivedAt: new Date().toISOString(),
    }, true)
    await settle()
  }
  const notices = () => requests.filter(request => request.input[0].text.startsWith('[CordisX Host progress reminder'))
  const acknowledgment = async (operation: string, context: string) => {
    const result = await promisify(execFile)(cli.node, [
      cli.entry,
      'channel',
      operation,
      '--context',
      context,
      '--input',
      '{}',
    ], { env: { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: session }, timeout: 10000 })
    return JSON.parse(result.stdout)
  }
  const command = async (input: unknown) => {
    const r = await promisify(execFile)(cli.node, [
      cli.entry,
      'channel',
      'send',
      '--profile',
      'default',
      '--context',
      contexts.at(-1)!,
      '--input',
      JSON.stringify(input),
    ], { env: { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: session }, timeout: 10000 }).catch(
      (error: any) => {
        throw new Error(error.stdout || error.message)
      },
    )
    return JSON.parse(r.stdout)
  }
  try {
    await consumer.policySet({ enabled: true, autoReply: false }, 0)
    await receive('om_first')
    await receive('om_second')
    expect(await acknowledgment('input-status', contexts.at(-1)!)).toMatchObject({
      acknowledgment: 'awaiting-agent',
      consumption: 'unconfirmed',
    })
    expect(await acknowledgment('input-ack', contexts[0]!)).toMatchObject({ acknowledgment: 'not-monitored' })
    expect(await acknowledgment('input-ack', contexts.at(-1)!)).toMatchObject({
      acknowledgment: 'agent-acknowledged',
      consumption: 'acknowledged-by-caller',
    })
    expect(await acknowledgment('input-status', contexts.at(-1)!)).toMatchObject({
      acknowledgment: 'agent-acknowledged',
    })
    await vi.waitFor(() => expect(notices()).toHaveLength(1), { timeout: 3000 })
    expect(notices()[0]).toMatchObject({ threadId: session, expectedTurnId: 'turn' })
    expect(access.feedbackWait).not.toHaveBeenCalled()
    expect(Object.keys(consumer.profileLogicalOwner().store.snapshot().inputs)).toHaveLength(2)
    expect(Object.keys(consumer.profileLogicalOwner().store.snapshot().jobs)).toHaveLength(2)
    const token = /progressToken:"([a-f0-9]+)"/u.exec(notices()[0].input[0].text)![1]!
    // Enqueue is not proof of delivery. A guarded stale message is cancelled before adapter.send.
    await runtime.notifyGuardedOnce(
      { target: source('om_second'), kind: 'reply', text: 'obsolete' },
      { source: 'test', pluginId: 'test', generation: 'test' },
      'delivery:obsolete',
      () => false,
    )
    await adapter.drainOutbound(10)
    expect(send).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(notices()).toHaveLength(2), { timeout: 3000 })
    const result = await command({
      account: ref,
      target: { id: 'oc_fixture', kind: 'group', replyMode: 'conversation' },
      text: 'Actual progress',
      operationId: 'progress',
      progressToken: token,
    })
    expect(result.deliveryState).toBe('sent')
    expect(send).toHaveBeenCalledOnce()
    const count = notices().length
    expect(await acknowledgment('input-status', contexts.at(-1)!)).toMatchObject({ acknowledgment: 'not-monitored' })
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(notices()).toHaveLength(count)
    await expect(
      command({
        account: ref,
        target: { id: 'oc_fixture', kind: 'group', replyMode: 'conversation' },
        text: 'duplicate',
        operationId: 'stale',
        progressToken: token,
      }),
    )
      .rejects.toThrow('CHANNEL_PROGRESS_NOTICE_STALE')
    expect(send).toHaveBeenCalledOnce()
  } finally {
    await server.close()
    tools.dispose()
    await consumer.dispose()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
