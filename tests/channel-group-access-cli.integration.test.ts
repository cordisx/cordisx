import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef, ChannelUserInput } from '@cordisx/channel-runtime'
import type { AgentBridge } from '../packages/cli/src/launcher/agent-bridge.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import type { PluginManagementService } from '../packages/cli/src/management/service.js'

describe('current group access through the real compiled CLI', () => {
  it('uses the dispatched sender context and admits only new mentioned tasks after an administrator enables the group', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-group-cli-'))
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
    const session = '01a10000-0000-7000-8000-000000000001'
    const event = (id: string, sender = 'ou_admin', group = 'oc_group'): ChannelEventRef => ({
      ...ref,
      conversationId: group,
      kind: 'group',
      threadId: group,
      semantics: 'conversation',
      eventId: id,
      messageId: id,
      actor: { ...ref, userId: sender },
    })
    const message = (source: ChannelEventRef, text: string): ChannelUserInput => ({
      contract: 'cordisx.channel-user-input/v1',
      schemaVersion: 1,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'channel', event: source },
      receivedAt: '2026-01-01T00:00:00Z',
    })
    const cli = {
      node: process.execPath,
      entry: fileURLToPath(new URL('../packages/cli/dist/src/cli.js', import.meta.url)),
      home: root,
      profile: 'default',
    }
    const command = async (operation: string, value: unknown, context?: string) => {
      const args = [
        cli.entry,
        'channel',
        operation,
        '--profile',
        'default',
        '--input',
        JSON.stringify(value),
        ...(context ? ['--context', context] : []),
      ]
      const result = await promisify(execFile)(cli.node, args, {
        env: { ...process.env, CORDISX_HOME: root, CODEX_THREAD_ID: session },
        timeout: 10000,
      }).catch((error: Error & { stdout?: string }) => {
        throw new Error(error.stdout || error.message)
      })
      return JSON.parse(result.stdout)
    }
    const runtime = {
      inputsSince: async (_caller, _filter, cursor) => ({ cursor, messages: [] }),
      notifyOnce: vi.fn(async () => ({ deliveryId: 'fixture' })),
      deliverySnapshot: () => ({ state: 'sent' }),
    }
    const access = {
      generation: 'fixture',
      runtime,
      accounts: () => [{ ref, state: 'ready' }],
      drain: async () => {},
    } as unknown as ChannelConversationAccess
    let active = false, turn = 0, adminContext = ''
    const bridge = vi.fn(async (_app: string, _operation: string, request: { operationId: string; prompt: string }) => {
      turn++
      const turnId = 'turn-' + turn
      active = true
      const context = /--context '([a-f0-9]{48})'/u.exec(request.prompt)?.[1]
      expect(context).toBeDefined()
      native.observedDispatch(request.operationId, session, turnId)
      expect(request.prompt).toContain('group-access-set')
      const read = await command('group-access', {}, context)
      if (turn === 1) {
        adminContext = context!
        expect(read).toMatchObject({ enabled: false, canEnable: true })
        await expect(command('group-access-set', { enabled: true, expectedRevision: read.revision }, '0'.repeat(48)))
          .rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
        await expect(
          command('group-access-set', { enabled: true, expectedRevision: read.revision, actor: 'ou_admin' }, context),
        )
          .rejects.toThrow('INVALID_REQUEST')
        expect(await command('group-access-set', { enabled: true, expectedRevision: read.revision }, context))
          .toMatchObject({ status: 'ok', enabled: true, revision: 2 })
      } else if (turn === 2) {
        expect(read).toMatchObject({ enabled: true, canEnable: false })
        await expect(command('group-access-set', { enabled: false, expectedRevision: read.revision }, context))
          .rejects.toThrow('CHANNEL_PERMISSION_DENIED')
      } else {
        expect(read).toMatchObject({ enabled: true, canRevoke: true })
        expect(await command('group-access-set', { enabled: false, expectedRevision: read.revision }, context))
          .toMatchObject({ status: 'ok', enabled: false, revision: 3 })
      }
      active = false
      return { status: 'started', sessionId: session, turnId }
    })
    const nativeRequest = async (method: string) =>
      method === 'thread/read'
        ? { thread: { id: session, name: 'Fixture', status: { type: active ? 'active' : 'idle' } } }
        : { data: [{ id: 'turn-' + turn, status: active ? 'inProgress' : 'completed' }] }
    const native = new ChannelNativeSessions({
      bridge: () => ({ call: bridge }) as unknown as AgentBridge,
      nativeRequest,
      cwd: root,
      cli,
    })
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
      generation: 'fixture',
      processStartedAt: (await processStartIdentity(process.pid))!,
      service: {} as PluginManagementService,
      channel: handler.channel,
    })
    const settle = async () => {
      await consumer.pump()
      await consumer.pump()
      await consumer.pump()
    }
    try {
      await consumer.policySet({
        enabled: true,
        autoReply: false,
        rules: [
          { id: 'account', ...ref, action: 'dispatch', effect: 'allow', userIds: ['ou_admin'] },
          { id: 'admin', ...ref, action: 'command', effect: 'allow', userIds: ['ou_admin'] },
        ],
      }, 0)
      await consumer.receive('old', message(event('om_old', 'ou_member'), 'old denied task'), true)
      await settle()
      expect(bridge).not.toHaveBeenCalled()
      await consumer.receive('admin', message(event('om_admin'), '给这个群开白，在这个群里都能和他说话'), true)
      await settle()
      expect(bridge).toHaveBeenCalledOnce()
      await expect(command('group-access', {}, adminContext)).rejects.toThrow('CHANNEL_CONTEXT_UNAVAILABLE')
      await expect(command('group-access-set', { enabled: true, expectedRevision: 2 })).rejects.toThrow(
        'CHANNEL_CONTEXT_UNAVAILABLE',
      )
      await consumer.receive('other', message(event('om_other', 'ou_member', 'oc_other'), 'unrelated'), true)
      await consumer.receive(
        'not-mentioned',
        message(event('om_unmentioned', 'ou_member'), 'ambient group chatter'),
        false,
      )
      await settle()
      expect(bridge).toHaveBeenCalledOnce()
      await consumer.receive('member', message(event('om_member', 'ou_member'), 'ordinary task'), true)
      await settle()
      expect(bridge).toHaveBeenCalledTimes(2)
      await consumer.receive('revoke', message(event('om_revoke'), '本群取消开白'), true)
      await settle()
      expect(bridge).toHaveBeenCalledTimes(3)
      await consumer.receive('after-revoke', message(event('om_after', 'ou_member'), 'denied again'), true)
      await settle()
      expect(bridge).toHaveBeenCalledTimes(3)
      expect(consumer.policy().policy.rules).toHaveLength(2)
    } finally {
      await server.close()
      tools.dispose()
      await consumer.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
