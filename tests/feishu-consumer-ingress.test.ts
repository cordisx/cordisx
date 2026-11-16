import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { type EventMap, normalize } from '@larksuiteoapi/node-sdk'
import { ChannelRuntime } from '../packages/channel-runtime/src/index.js'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { createFeishuAdapterDefinition } from '../packages/cli/src/launcher/feishu-adapter.js'

describe('Feishu durable ingress composition', () => {
  it('uses the real core receipt for staged mention metadata even when catch-up wins the commit race', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'feishu-ingress-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'test' }
    const runtime = await ChannelRuntime.open({
      storePath: path.join(root, 'transport.json'),
      permissions: { authorize: async () => 'allow' },
    })
    const caller = { source: 'fixture', pluginId: 'fixture', generation: 'one' }
    const native = {
      exists: async () => true,
      start: vi.fn(async () => ({
        state: 'running' as const,
        sessionId: '01a10000-0000-7000-8000-000000000001',
        turnId: 'one',
      })),
      completion: async () => ({ state: 'running' as const }),
      reconcile: async () => ({ state: 'reconciliation-required' as const }),
    }
    const access = {
      generation: 'fixture',
      runtime,
      accounts: () => [{ ref, state: 'ready' }],
      conversations: async () => ({ complete: true, conversations: [] }),
      drain: async () => {},
    } satisfies ChannelConversationAccess
    const file = path.join(root, 'consumer.json')
    const consumer = await ChannelConversationConsumer.open({
      profileId: 'fixture',
      file,
      access: () => access,
      native: () => native,
    })
    const handlers: Partial<EventMap> = {}
    const ids: string[] = []
    const definition = createFeishuAdapterDefinition({
      connection: { ref, adapterKind: 'feishu', enabled: true, transport: { mode: 'websocket' }, secretRef: 'fixture' },
      configurationRevision: 1,
      source: 'fixture',
      resolveSecret: async () => 'fixture',
      createChannel: () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          send: async () => ({ messageId: 'unused' }),
          on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
            Object.assign(handlers, { [name]: handler })
            return () => {
              delete handlers[name]
            }
          },
        }) as never,
      onNormalizedInput: async (recordId, input, mentioned, persisted, addressing) => {
        ids.push(recordId)
        if (persisted) await consumer.pump() // Catch-up sees the core receipt before this callback commits.
        await consumer.receive(recordId, input, mentioned, persisted, addressing)
      },
    })
    try {
      await consumer.policySet({ enabled: true, groupReception: 'all' }, 0)
      await runtime.activate(definition, caller)
      const raw = {
        sender: { sender_id: { open_id: 'alice' }, sender_type: 'user', tenant_key: 'test' },
        message: {
          message_id: 'om_race',
          chat_id: 'oc_race',
          chat_type: 'group',
          create_time: String(Date.now()),
          message_type: 'text',
          content: JSON.stringify({ text: 'mention race' }),
          root_id: '',
          thread_id: '',
          mentions: [{ key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob Smith' }],
        },
      }
      const message = { ...await normalize(raw as never, { includeRaw: false }), mentionedBot: true }
      await handlers.message!(message)
      await consumer.pump()
      const persisted = await runtime.inputsSince(caller, [{ account: ref }], 'channel-input:0:empty')
      expect(ids).toEqual([persisted.messages[0]!.recordId, persisted.messages[0]!.recordId])
      const store = await ChannelConversationStore.open(file)
      const inputs = Object.values(store.snapshot().inputs)
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        persisted: true,
        mentionedBot: true,
        accepted: true,
        routed: true,
        addressing: { mentions: [{ key: '@_user_2', userId: 'ou_bob', name: 'Bob Smith' }] },
      })
      expect(persisted.messages[0]!.input.source.event).not.toHaveProperty('mentions')
      expect(native.start).toHaveBeenCalledTimes(1)
      await store.close()
      await runtime.dispose()
      expect(Object.keys(handlers)).toEqual([])
    } finally {
      await consumer.dispose()
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
