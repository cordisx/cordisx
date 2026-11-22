import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelUserInput } from '@cordisx/channel-runtime'
import type { AgentBridge } from '../packages/cli/src/launcher/agent-bridge.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { channelRemoteHistory } from '../packages/cli/src/launcher/channel-remote-history.js'
import { channelMessageRead } from '../packages/cli/src/launcher/channel-message-read.js'
import { ChannelLiveDirectory } from '../packages/cli/src/launcher/channel-live-directory.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'
import {
  pluginManagementRpcPaths,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'

describe('configured Channel CLI production endpoint', () => {
  it('delivers only the explicit compiled CLI send and never forwards the completed local answer by default', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "channel-cli-user's-"))
    const configPath = path.join(root, 'config.json')
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const sessionId = '01a10000-0000-7000-8000-000000000001'
    const source = {
      ...ref,
      conversationId: 'oc_fixture',
      kind: 'group' as const,
      threadId: 'om_parent',
      semantics: 'reply-chain' as const,
      eventId: 'om_fixture',
      messageId: 'om_fixture',
    }
    const input: ChannelUserInput = {
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text: 'Please reply in a topic through the CLI.' }],
      receivedAt: '2026-11-16T00:00:00Z',
      source: { kind: 'channel', event: source },
    }
    const cli = {
      node: process.execPath,
      entry: fileURLToPath(new URL('../packages/cli/dist/src/cli.js', import.meta.url)),
      home: root,
      profile: 'default',
    }
    const send = {
      account: ref,
      target: { id: source.conversationId, kind: source.kind, replyMode: 'thread', replyTo: source.messageId },
      text: 'Explicit CLI message',
      operationId: 'explicit-send-fixture',
    }
    const command = async (operation: string, value: unknown, context?: string) => {
      const result = await promisify(execFile)(cli.node, [
        cli.entry,
        'channel',
        operation,
        '--profile',
        cli.profile,
        '--input',
        JSON.stringify(value),
        ...(context ? ['--context', context] : []),
      ], {
        env: { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: sessionId },
        timeout: 10_000,
        maxBuffer: 131_072,
      }).catch((error: Error & { stdout?: string }) => {
        throw new Error(error.stdout || error.message)
      })
      return JSON.parse(result.stdout.trim())
    }
    const receipts = new Map<string, { state: string; externalMessageId: string }>()
    const runtime = {
      inputsSince: vi.fn(async (_caller, _filters, cursor) => ({ cursor, messages: [] })),
      notifyOnce: vi.fn(async (_value, _caller, deliveryId: string) => {
        receipts.set(deliveryId, { state: 'sent', externalMessageId: 'om_explicit_result' })
        return { deliveryId }
      }),
      notifyQuestionOnce: vi.fn(async (_value, _caller, deliveryId: string) => {
        receipts.set(deliveryId, { state: 'sent', externalMessageId: 'om_question' })
        return { deliveryId }
      }),
      deliverySnapshot: (deliveryId: string) => receipts.get(deliveryId),
    }
    const remoteList = vi.fn(async () => ({
      code: 0,
      data: {
        has_more: false,
        items: [{
          chat_id: source.conversationId,
          message_id: 'om_previous',
          sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user', sender_name: 'Alice' },
        }],
      },
    }))
    const remoteGet = vi.fn(async ({ path: { message_id } }: { path: { message_id: string } }) => ({
      code: 0,
      data: {
        items: [{
          chat_id: source.conversationId,
          message_id,
          ...(message_id === source.messageId ? { parent_id: 'om_parent' } : {}),
          body: { content: '{"text":"quoted"}' },
          sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user', sender_name: 'Alice' },
        }],
      },
    }))
    const remoteChannel = { rawClient: { im: { v1: { message: { list: remoteList, get: remoteGet } } } } } as never
    const directory = new ChannelLiveDirectory()
    directory.connected(ref, remoteChannel)
    const access = {
      generation: 'fixture-runtime',
      runtime,
      accounts: () => [{ ref, state: 'ready' }],
      remoteHistory: vi.fn((account, request) => channelRemoteHistory(account, request, remoteChannel)),
      readMessage: vi.fn((event, messageId) => channelMessageRead(event, messageId, remoteChannel)),
      messageContext: (message, addressing) => directory.messageContext(message, addressing),
      drain: vi.fn(async () => {}),
    } as unknown as ChannelConversationAccess
    const nativeRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: sessionId, name: 'Fixture chat' } }
      }
      if (method !== 'thread/turns/list') throw new Error('Local assistant items must not be read for delivery')
      return { data: [{ id: 'fixture-turn', status: 'completed' }] }
    })
    let contextToken: string | undefined
    const bridgeCall = vi.fn(
      async (_app: string, _operation: string, request: { prompt: string; operationId: string }) => {
        expect(request.prompt).toContain(cli.entry)
        expect(request.prompt).toContain('Automatic final-response delivery is disabled')
        expect(request.prompt).toContain("send --profile 'default'")
        expect(request.prompt).toContain('remote-history')
        expect(request.prompt).toContain('message-get')
        expect(request.prompt).toContain('"referencedMessage"')
        expect(request.prompt).toContain('"name":"Alice"')
        expect(request.prompt).toContain('quoted')
        contextToken = /--context '([a-f0-9]{48})'/u.exec(request.prompt)?.[1]
        expect(contextToken).toBeDefined()
        native.observedDispatch(request.operationId, sessionId, 'fixture-turn')
        await expect(command('send', send, '0'.repeat(48))).rejects.toThrow()
        expect(runtime.notifyOnce).not.toHaveBeenCalled()
        const remote = {
          account: ref,
          conversationId: source.conversationId,
          kind: source.kind,
          startTime: '1',
          endTime: '2',
        }
        expect(await command('remote-history', remote, contextToken)).toMatchObject({
          status: 'ok',
          source: 'remote',
          messages: [{ messageId: 'om_previous', sender: { id: 'ou_sender', name: 'Alice' } }],
        })
        expect(await command('remote-history', { ...remote, startTime: 1, endTime: 2 }, contextToken)).toMatchObject({
          status: 'ok',
          source: 'remote',
        })
        expect(remoteList).toHaveBeenLastCalledWith({
          params: expect.objectContaining({ start_time: '1', end_time: '2' }),
        })
        expect(remoteList).toHaveBeenCalledTimes(2)
        await expect(command('remote-history', { ...remote, conversationId: 'oc_other' }, contextToken)).rejects
          .toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
        const referenced = {
          account: ref,
          conversationId: source.conversationId,
          kind: source.kind,
          messageId: 'om_parent',
        }
        expect(await command('message-get', referenced, contextToken)).toMatchObject({
          status: 'ok',
          message: { messageId: 'om_parent', sender: { name: 'Alice' }, content: '{"text":"quoted"}' },
        })
        await expect(command('message-get', { ...referenced, conversationId: 'oc_other' }, contextToken)).rejects
          .toThrow('CHANNEL_SOURCE_SCOPE_MISMATCH')
        const ask = {
          account: ref,
          target: { id: source.conversationId, kind: source.kind },
          question: 'Choose?',
          options: [{ label: 'Yes', value: 'Yes' }],
          operationId: 'first-turn-question',
        }
        expect(await command('ask', ask, contextToken)).toMatchObject({
          status: 'ok',
          presentation: 'card',
          receipt: { state: 'sent' },
        })
        expect(await command('receipt', { account: ref, operationId: ask.operationId }, contextToken)).toMatchObject({
          deliveryState: 'sent',
        })
        expect(await command('send', send, contextToken)).toMatchObject({ status: 'ok', receipt: { state: 'sent' } })
        return { status: 'started', sessionId, turnId: 'fixture-turn' }
      },
    )
    const native = new ChannelNativeSessions({
      bridge: () => ({ call: bridgeCall }) as unknown as AgentBridge,
      nativeRequest,
      cwd: root,
      cli,
    })
    await ensureHomeConfig(configPath)
    const before = await readFile(configPath, 'utf8')
    const consumer = await ChannelConversationConsumer.open({
      file: path.join(root, 'consumer.json'),
      profileId: 'default',
      access: () => access,
      native: () => native,
    })
    consumer.setNativeExtras(() => native)
    const tools = new ChannelConversationTools(() => access, consumer)
    const management = configuredChannelManagementToolHandler(tools)
    const channel = vi.fn((operation: string, value: unknown, metadata?: unknown) =>
      management.channel!(operation, value, metadata)
    )
    const identity = await processStartIdentity(process.pid)
    const server = await startPluginManagementRpcServer({
      homeDir: root,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'fixture-launch',
      processStartedAt: identity!,
      service: {} as PluginManagementService,
      channel,
    })
    try {
      await consumer.policySet({ enabled: true }, 0)
      await consumer.receive('inbox:fixture', input, true)
      await consumer.pump()
      await bridgeCall.mock.results[0]!.value
      await consumer.pump()
      await consumer.pump()
      expect(bridgeCall).toHaveBeenCalledOnce()
      expect(consumer.policy().policy.autoReply).toBe(false)
      expect(consumer.status(sessionId).jobs).toMatchObject([{ state: 'completed', turnId: 'fixture-turn' }])
      expect(bridgeCall).toHaveBeenCalledOnce()
      expect(
        nativeRequest.mock.calls.every(([method, params]) =>
          method === 'thread/turns/list' || method === 'thread/read' && params.includeTurns === false
        ),
      ).toBe(true)
      expect(nativeRequest).toHaveBeenCalled()
      expect(runtime.notifyOnce).toHaveBeenCalledOnce()
      expect(runtime.notifyOnce.mock.calls[0]?.[0]).toMatchObject({
        text: send.text,
        target: { ...ref, conversationId: 'oc_fixture', semantics: 'topic', threadId: 'om_fixture' },
      })
      expect(await command('receipt', { account: ref, operationId: send.operationId })).toMatchObject({
        status: 'ok',
        receipt: { state: 'sent', externalMessageId: 'om_explicit_result' },
      })
      await expect(command('send', { ...send, operationId: 'expired-context' }, contextToken)).rejects.toThrow()
      expect(runtime.notifyOnce).toHaveBeenCalledOnce()
      expect(channel.mock.calls.map(([operation]) => operation)).toEqual([
        'send',
        'remote-history',
        'remote-history',
        'remote-history',
        'message-get',
        'message-get',
        'ask',
        'receipt',
        'send',
        'receipt',
        'send',
      ])
      expect(channel).toHaveBeenCalledWith('send', send, {
        'cordisx/channelContext': contextToken,
        'openai/threadId': sessionId,
      })
      expect(await readFile(configPath, 'utf8')).toBe(before)
    } finally {
      directory.clear()
      tools.dispose()
      await consumer.dispose()
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
  it('uses the selected live launcher and rejects a stale process identity before dispatch', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-configured-cli-'))
    const configPath = path.join(root, 'config.json')
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const consumer = {
      agentAccess: { hasPreparation: () => false, preparation: () => false, caller: () => undefined },
      status: () => ({
        status: 'ok',
        revision: 7,
        bindings: [{
          id: 'binding',
          sessionId: 'own-chat',
          state: 'active',
          mode: 'deliver',
          channel: { ...ref, conversationId: 'oc_group', kind: 'group' },
        }],
      }),
    }
    const access = () =>
      ({ generation: 'fixture-runtime', accounts: () => [{ ref, state: 'ready' }] }) as ChannelConversationAccess
    const tools = new ChannelConversationTools(access)
    const inventoryTools = new ChannelConversationTools(access, consumer as never)
    const channel = vi.fn((operation: string, input: unknown) =>
      (operation === 'local-bindings' ? inventoryTools : tools).callLocal(operation, input)
    )
    await ensureHomeConfig(configPath)
    const before = await readFile(configPath, 'utf8')
    const identity = await processStartIdentity(process.pid)
    const server = await startPluginManagementRpcServer({
      homeDir: root,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'fixture-launch',
      processStartedAt: identity!,
      service: {} as PluginManagementService,
      channel,
    })
    vi.stubEnv('CORDISX_HOME', root)
    vi.stubEnv('CODEX_THREAD_ID', '')
    try {
      const output: string[] = []
      await runConfiguredChannelCommand(['connections'], line => output.push(line))
      expect(JSON.parse(output[0]!)).toEqual({
        status: 'ok',
        generation: 'fixture-runtime',
        connections: [{ ref, state: 'ready' }],
      })
      expect(channel).toHaveBeenCalledOnce()
      await runConfiguredChannelCommand([
        'local-bindings',
        '--input',
        JSON.stringify({ account: ref, conversationId: 'oc_group' }),
      ], line => output.push(line))
      expect(JSON.parse(output.at(-1)!)).toMatchObject({
        status: 'ok',
        generation: 'fixture-runtime',
        revision: 7,
        bindings: [{ bindingId: 'binding', sessionId: 'own-chat', state: 'active', mode: 'deliver' }],
      })
      await expect(runConfiguredChannelCommand([
        'reply-mode',
        '--input',
        JSON.stringify({
          sessionId: 'fixture-chat',
          operationId: 'incoming-operation',
          mode: 'thread',
        }),
      ], line => output.push(line))).rejects.toThrow('CHANNEL_OPERATION_REJECTED')
      expect(channel).toHaveBeenLastCalledWith('reply-mode', {
        sessionId: 'fixture-chat',
        operationId: 'incoming-operation',
        mode: 'thread',
      }, undefined)
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: 'unavailable', code: 'CHANNEL_CONSUMER_UNAVAILABLE' })
      expect(await readFile(configPath, 'utf8')).toBe(before)
      await expect(runConfiguredChannelCommand(['connections', '--profile', 'other'], () => {})).rejects.toThrow(
        'PROFILE_UNAVAILABLE',
      )
      const endpointPath = pluginManagementRpcPaths(root, 'codex', 'default').state
      const endpoint = JSON.parse(await readFile(endpointPath, 'utf8'))
      await writeFile(endpointPath, JSON.stringify({ ...endpoint, processStartedAt: 'different-process-start' }), {
        mode: 0o600,
      })
      await expect(runConfiguredChannelCommand(['connections'], () => {})).rejects.toThrow(
        'CHANNEL_HOST_IDENTITY_UNVERIFIABLE',
      )
      const otherSecond = identity!.replace(
        /:(\d{2}) (\d{4})$/u,
        (_match, seconds, year) => `:${String((Number(seconds) + 1) % 60).padStart(2, '0')} ${year}`,
      )
      expect(otherSecond).not.toBe(identity)
      await writeFile(endpointPath, JSON.stringify({ ...endpoint, processStartedAt: otherSecond }), { mode: 0o600 })
      await expect(runConfiguredChannelCommand(['connections'], () => {})).rejects.toThrow(
        'CHANNEL_HOST_IDENTITY_STALE',
      )
      expect(channel).toHaveBeenCalledTimes(3)
      await writeFile(endpointPath, JSON.stringify(endpoint), { mode: 0o600 })
      await expect(runConfiguredChannelCommand(['send', '--input', '{}'], line => output.push(line))).rejects.toThrow(
        'CHANNEL_OPERATION_REJECTED',
      )
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: 'rejected' })
    } finally {
      vi.unstubAllEnvs()
      tools.dispose()
      inventoryTools.dispose()
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
