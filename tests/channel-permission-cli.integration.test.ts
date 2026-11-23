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

describe('personal access and group recovery through the compiled production CLI', () => {
  it('opens only one member behind account allowlists, denies/resets them, and recovers a blocked group by an authorized request', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-access-cli-'))
    const configPath = path.join(root, 'config.json')
    await ensureHomeConfig(configPath)
    const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
    const session = '01a10000-0000-7000-8000-000000000001'
    const event = (id: string, sender = 'ou_admin', conversationId = 'oc_group', kind = 'group'): ChannelEventRef => ({
      ...ref,
      conversationId,
      kind,
      threadId: conversationId,
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
      const result = await promisify(execFile)(cli.node, [
        cli.entry,
        'channel',
        operation,
        '--profile',
        'default',
        '--input',
        JSON.stringify(value),
        ...(context ? ['--context', context] : []),
      ], {
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
    let action: 'allow' | 'deny' | 'reset' | 'task' | 'block' | 'restore' = 'allow'
    const bridge = vi.fn(async (_app: string, _operation: string, request: { operationId: string; prompt: string }) => {
      turn++
      const turnId = 'turn-' + turn
      active = true
      const context = /--context '([a-f0-9]{48})'/u.exec(request.prompt)![1]!
      native.observedDispatch(request.operationId, session, turnId)
      expect(request.prompt).toContain('user-access-set')
      expect(request.prompt).toContain('group-block-set')
      if (action === 'task') {
        await expect(command('user-access-set', { user: 'ou_admin', effect: 'allow', expectedRevision: 2 }, context))
          .rejects.toThrow('CHANNEL_PERMISSION_REQUEST_REQUIRED')
      } else if (action === 'block' || action === 'restore') {
        const read = await command('group-block', {}, context)
        expect(read).toMatchObject({ blocked: action === 'restore', canRestore: true })
        expect(
          await command('group-block-set', { blocked: action === 'block', expectedRevision: read.revision }, context),
        )
          .toMatchObject({ blocked: action === 'block' })
      } else {
        adminContext = context
        const read = await command('user-access', { user: 'ou_member' }, context)
        await expect(
          command('user-access-set', {
            user: 'ou_member',
            effect: action,
            expectedRevision: read.revision,
            conversationId: 'oc_other',
          }, context),
        )
          .rejects.toThrow('INVALID_REQUEST')
        expect(
          await command(
            'user-access-set',
            { user: 'ou_member', effect: action, expectedRevision: read.revision },
            context,
          ),
        )
          .toMatchObject({
            effect: action,
            dispatchAllowed: action === 'allow',
            grantForFutureMentions: action === 'allow',
          })
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
    let sequence = 0
    const receive = async (text: string, sender = 'ou_admin', group = 'oc_group', mentioned = true, kind = 'group') => {
      await consumer.receive(
        'record-' + ++sequence,
        message(event('om_' + sequence, sender, group, kind), text),
        mentioned,
      )
      await settle()
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
      await receive('old task', 'ou_member')
      expect(bridge).not.toHaveBeenCalled()
      await receive('给 ou_member 授权')
      expect(bridge).toHaveBeenCalledOnce()
      await expect(command('user-access', { user: 'ou_member' }, adminContext)).rejects.toThrow(
        'CHANNEL_CONTEXT_UNAVAILABLE',
      )
      action = 'task'
      await receive('other member', 'ou_other')
      await receive('other group', 'ou_member', 'oc_other')
      await receive('private task', 'ou_member', 'oc_private', false, 'direct')
      await receive('not mentioned', 'ou_member', 'oc_group', false)
      expect(bridge).toHaveBeenCalledOnce()
      await receive('new task', 'ou_member')
      expect(bridge).toHaveBeenCalledTimes(2)
      action = 'deny'
      await receive('禁止 ou_member 发起任务')
      expect(bridge).toHaveBeenCalledTimes(3)
      await receive('denied task', 'ou_member')
      expect(bridge).toHaveBeenCalledTimes(3)
      action = 'reset'
      await receive('恢复 ou_member 权限')
      await receive('account still blocks', 'ou_member')
      expect(bridge).toHaveBeenCalledTimes(4)
      action = 'block'
      await receive('禁止本群任务')
      expect(bridge).toHaveBeenCalledTimes(5)
      await receive('ordinary blocked administrator task')
      await receive('恢复本群任务', 'ou_member')
      await receive('他说恢复本群任务')
      await receive('恢复本群任务', 'ou_admin', 'oc_group', false)
      expect(bridge).toHaveBeenCalledTimes(5)
      action = 'restore'
      await receive('恢复本群任务')
      expect(bridge).toHaveBeenCalledTimes(6)
      expect(consumer.profileLogicalOwner().store.snapshot().policy.rules).toHaveLength(2)
      // Existing authenticated management command is also usable when ordinary task admission is denied.
      await receive('/messages-off')
      await receive('/messages-on')
      expect(bridge).toHaveBeenCalledTimes(6)
      expect(consumer.profileLogicalOwner().store.snapshot().policy.rules).toHaveLength(2)
    } finally {
      await server.close()
      tools.dispose()
      await consumer.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
