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
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'
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
      threadId: 'oc_fixture',
      semantics: 'conversation' as const,
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
    const command = async (operation: string, value: unknown) => {
      const result = await promisify(execFile)(cli.node, [
        cli.entry,
        'channel',
        operation,
        '--profile',
        cli.profile,
        '--input',
        JSON.stringify(value),
      ], { env: { ...process.env, CORDISX_HOME: root }, timeout: 10_000, maxBuffer: 131_072 })
      return JSON.parse(result.stdout.trim())
    }
    const receipts = new Map<string, { state: string; externalMessageId: string }>()
    const runtime = {
      inputsSince: vi.fn(async (_caller, _filters, cursor) => ({ cursor, messages: [] })),
      notifyOnce: vi.fn(async (_value, _caller, deliveryId: string) => {
        receipts.set(deliveryId, { state: 'sent', externalMessageId: 'om_explicit_result' })
        return { deliveryId }
      }),
      deliverySnapshot: (deliveryId: string) => receipts.get(deliveryId),
    }
    const access = {
      generation: 'fixture-runtime',
      runtime,
      accounts: () => [{ ref, state: 'ready' }],
      drain: vi.fn(async () => {}),
    } as unknown as ChannelConversationAccess
    const nativeRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/read' && params.includeTurns === false) {
        return { thread: { id: sessionId, name: 'Fixture chat' } }
      }
      if (method !== 'thread/turns/list') throw new Error('Local assistant items must not be read for delivery')
      return { data: [{ id: 'fixture-turn', status: 'completed' }] }
    })
    const bridgeCall = vi.fn(async (_app: string, _operation: string, request: { prompt: string }) => {
      expect(request.prompt).toContain(cli.entry)
      expect(request.prompt).toContain('Automatic final-response delivery is disabled')
      expect(request.prompt).toContain("send --profile 'default'")
      expect(await command('send', send)).toMatchObject({ status: 'ok', receipt: { state: 'sent' } })
      return { status: 'started', sessionId, turnId: 'fixture-turn' }
    })
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
    const tools = new ChannelConversationTools(() => access, consumer)
    const channel = vi.fn((operation: string, value: unknown) => tools.call(operation, value))
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
      await consumer.pump()
      await consumer.pump()
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
      expect(channel.mock.calls.map(([operation]) => operation)).toEqual(['send', 'receipt'])
      expect(await readFile(configPath, 'utf8')).toBe(before)
    } finally {
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
    const tools = new ChannelConversationTools(() =>
      ({ generation: 'fixture-runtime', accounts: () => [{ ref, state: 'ready' }] }) as ChannelConversationAccess
    )
    const channel = vi.fn((operation: string, input: unknown) => tools.call(operation, input))
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
    try {
      const output: string[] = []
      await runConfiguredChannelCommand(['connections'], line => output.push(line))
      expect(JSON.parse(output[0]!)).toEqual({
        status: 'ok',
        generation: 'fixture-runtime',
        connections: [{ ref, state: 'ready' }],
      })
      expect(channel).toHaveBeenCalledOnce()
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
      })
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
      expect(channel).toHaveBeenCalledTimes(2)
      await writeFile(endpointPath, JSON.stringify(endpoint), { mode: 0o600 })
      await expect(runConfiguredChannelCommand(['send', '--input', '{}'], line => output.push(line))).rejects.toThrow(
        'CHANNEL_OPERATION_REJECTED',
      )
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ status: 'rejected' })
    } finally {
      vi.unstubAllEnvs()
      tools.dispose()
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
