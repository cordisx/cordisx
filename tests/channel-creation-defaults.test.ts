import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ChatExecutionPreferences } from '../packages/cli/src/launcher/chat-execution-preferences.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelCreationDefaults } from '../packages/cli/src/launcher/channel-creation-defaults.js'
import { ChannelNativeSessions } from '../packages/cli/src/launcher/channel-native-sessions.js'
import { type AgentBridge, createCodexBridgeHandler } from '../packages/cli/src/launcher/agent-bridge.js'
import { createChannelActionsBridgeHandler } from '../packages/cli/src/launcher/channel-actions-rpc.js'
import type { ChannelUserInput } from '@cordisx/channel-runtime'

const message: ChannelUserInput = {
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  receivedAt: '2026-11-17T00:00:00Z',
  content: [{ type: 'text', text: 'test' }],
  source: {
    kind: 'channel',
    event: {
      adapterId: 'feishu',
      accountId: 'test',
      tenantId: 'test',
      conversationId: 'oc_test',
      kind: 'group',
      threadId: 'oc_test',
      semantics: 'conversation',
      eventId: 'om_test',
    },
  },
}

describe('separate Channel creation defaults', () => {
  it('persists only explicit Channel fields, preserves legacy data and never writes general defaults', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-defaults-'))
    let store: ChannelConversationStore | undefined, preferences: ChatExecutionPreferences | undefined
    try {
      const file = path.join(root, 'channel.json'), configPath = path.join(root, 'config.json')
      await ensureHomeConfig(configPath)
      preferences = await ChatExecutionPreferences.open({
        file: path.join(root, 'chats.json'),
        configPath,
        appId: 'codex',
        profileId: 'default',
      })
      const general = await preferences.setDefaults({
        execution: 'read-only',
        approval: 'on-request',
        networkAccess: true,
      }, 0)
      store = await ChannelConversationStore.open(file)
      const legacy = { ...store.snapshot(), creationDefaults: undefined }
      await store.close()
      await writeFile(file, JSON.stringify(legacy))
      store = await ChannelConversationStore.open(file)
      const defaults = new ChannelCreationDefaults(store)
      expect(defaults.read()).toEqual({ revision: 0, settings: {} })
      await defaults.operation('channel-execution-defaults-set', {
        expectedRevision: 0,
        settings: { execution: 'inherit', approval: 'never', networkAccess: false },
      })
      expect(defaults.read()).toEqual({ revision: 1, settings: { approval: 'never', networkAccess: false } })
      expect(await preferences.defaults()).toEqual(general)
      await expect(defaults.operation('channel-execution-defaults-set', { expectedRevision: 0, settings: {} })).rejects
        .toThrow('REVISION_CONFLICT')
      await store.close()
      store = await ChannelConversationStore.open(file)
      expect(new ChannelCreationDefaults(store).read()).toEqual({
        revision: 1,
        settings: { approval: 'never', networkAccess: false },
      })
      await new ChannelCreationDefaults(store).operation('channel-execution-defaults-set', {
        expectedRevision: 1,
        settings: { approval: 'inherit' },
      })
      expect(new ChannelCreationDefaults(store).read().settings).toEqual({})
      expect(JSON.parse(await readFile(file, 'utf8')).bindings).toEqual(legacy.bindings)
    } finally {
      await store?.close()
      await preferences?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies general, Channel and scoped effort defaults to creation and the first turn without reapplying on resume', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-defaults-native-'))
    let preferences: ChatExecutionPreferences | undefined
    try {
      const configPath = path.join(root, 'config.json')
      await ensureHomeConfig(configPath)
      preferences = await ChatExecutionPreferences.open({
        file: path.join(root, 'chats.json'),
        configPath,
        appId: 'codex',
        profileId: 'default',
      })
      await preferences.setDefaults({
        execution: 'workspace-write',
        approval: 'on-request',
        workMode: 'plan',
        effort: 'low',
        networkAccess: true,
      }, 0)
      const calls: Array<{ method: string; params: Record<string, unknown> }> = []
      const nativeRequest = async (method: string, params: Readonly<Record<string, unknown>>) => {
        calls.push({ method, params })
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'chat',
              model: 'model',
              sandbox: { type: 'workspaceWrite', writableRoots: [root], networkAccess: false },
            },
          }
        }
        if (method === 'thread/resume' || method === 'thread/read') {
          return { thread: { id: 'chat', model: 'model', cwd: root, status: { type: 'idle' } } }
        }
        if (method === 'turn/start') return { turn: { id: 'turn' } }
        return {}
      }
      const handler = createCodexBridgeHandler({ nativeRequest, catalog: async () => [] }, root)
      const sessions = new ChannelNativeSessions({
        bridge: () => ({ call: (_app, operation, args, signal) => handler(operation, args, signal) }) as AgentBridge,
        nativeRequest,
        cwd: root,
        execution: preferences,
      })
      const overlay = {
        approval: 'never' as const,
        workMode: 'inherit' as const,
        effort: 'medium',
        networkAccess: false,
      }
      expect(
        await sessions.start('first', message, undefined, undefined, undefined, undefined, { effort: 'high' }, overlay),
      ).toMatchObject({ state: 'running' })
      expect(calls.find(call => call.method === 'thread/start')?.params).toMatchObject({
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        config: { model_reasoning_effort: 'high', 'sandbox_workspace_write.network_access': false },
      })
      expect(calls.find(call => call.method === 'turn/start')?.params).toMatchObject({
        effort: 'high',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', networkAccess: false },
        collaborationMode: { mode: 'plan', settings: { model: 'model', reasoning_effort: 'high' } },
      })
      const general = await preferences.prepare('thread/start', { cwd: root, model: 'model' })
      expect(general.params).toMatchObject({
        approvalPolicy: 'on-request',
        config: { model_reasoning_effort: 'low', 'sandbox_workspace_write.network_access': true },
      })
      await preferences.setDefaults({ execution: 'full-access', workMode: 'default' }, 1)
      calls.length = 0
      expect(
        await sessions.start('resumed', message, 'chat', undefined, undefined, undefined, { effort: 'high' }, overlay),
      ).toMatchObject({ state: 'running' })
      expect(calls.some(call => call.method === 'thread/start')).toBe(false)
      const resumed = calls.find(call => call.method === 'turn/start')?.params
      expect(resumed).not.toHaveProperty('sandboxPolicy')
      expect(resumed).not.toHaveProperty('collaborationMode')
      expect(resumed).not.toHaveProperty('approvalPolicy')
    } finally {
      await preferences?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('routes Channel overlay actions to the consumer even when the general Host action is present', async () => {
    const execution = vi.fn(async () => ({ status: 'ok', settings: { approval: 'never' } }))
    const channel = vi.fn(async () => ({ status: 'ok', revision: 1, settings: {} }))
    const handler = createChannelActionsBridgeHandler({
      token: 'fixture',
      api: {} as never,
      execution,
      consumer: { executionOperation: channel } as never,
    })
    expect(await handler.handle({ version: 1, token: 'fixture', action: 'channel-execution-defaults' })).toMatchObject({
      status: 'applied',
      execution: { revision: 1 },
    })
    expect(channel).toHaveBeenCalledExactlyOnceWith('channel-execution-defaults', {})
    expect(execution).not.toHaveBeenCalled()
    await handler.handle({ version: 1, token: 'fixture', action: 'execution-defaults' })
    expect(execution).toHaveBeenCalledExactlyOnceWith('execution-defaults', {})
  })
})
