import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type EventMap, normalize } from '@larksuiteoapi/node-sdk'
import { createLocalChannelService } from '../packages/cli/src/launcher/channel-service.js'
import { createConfiguredChannelConsumer } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { bundledPluginEntry } from '../packages/cli/src/launcher/bundled-plugin.js'

const { sdkFactory } = vi.hoisted(() => ({ sdkFactory: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<typeof import('@larksuiteoapi/node-sdk')>(),
  createLarkChannel: sdkFactory,
}))

describe('production Channel command composition with SDK transport fixtures', () => {
  it('carries native mention identity and live member lookup through the configured launcher and sends command topics once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-command-composition-'))
    const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'fixture' }
    const handlers: Partial<EventMap> = {}
    const members = vi.fn(async () => ({
      code: 0,
      data: { items: [{ member_id_type: 'open_id', member_id: 'ou_bob', name: 'Bob Smith' }], has_more: false },
    }))
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_result' } }))
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_main' } }))
    const disconnect = vi.fn(async () => {})
    sdkFactory.mockReturnValue({
      connect: async () => {},
      disconnect,
      on: (name: keyof EventMap, handler: EventMap[keyof EventMap]) => {
        Object.assign(handlers, { [name]: handler })
        return () => {
          delete handlers[name]
        }
      },
      send: vi.fn(),
      rawClient: { im: { v1: { chatMembers: { get: members }, message: { reply, create } } } },
    })
    const entry = bundledPluginEntry('channel')
    const service = createLocalChannelService({
      artifactDirectory: path.dirname(entry),
      dataDir: path.join(root, 'transport'),
      source: 'fixture:channel',
      environment: { CHANNEL_COMMAND_FIXTURE: 'fixture-only' },
    })
    let owner: Awaited<ReturnType<typeof createConfiguredChannelConsumer>> | undefined
    try {
      await service.start({
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref,
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/CHANNEL_COMMAND_FIXTURE',
        }],
      })
      const native = { exists: vi.fn(async () => true), start: vi.fn(), completion: vi.fn(), reconcile: vi.fn() }
      owner = await createConfiguredChannelConsumer({
        service,
        homeDir: root,
        appId: 'codex',
        profileId: 'fixture',
        native: () => native as never,
        report: vi.fn(),
      })
      const consumer = owner.consumer!
      await consumer.policySet({
        enabled: true,
        replyMode: 'none',
        rules: [{ id: 'commands', action: 'command', effect: 'allow', userIds: ['ou_actor'] }],
      }, 0)
      const input = async (id: string, text: string, targetMention: boolean) => {
        const message = await normalize({
          sender: { sender_id: { open_id: 'ou_actor' }, sender_type: 'user', tenant_key: 'fixture' },
          message: {
            message_id: id,
            chat_id: 'oc_group',
            chat_type: 'group',
            create_time: String(Date.now()),
            message_type: 'text',
            content: JSON.stringify({ text }),
            mentions: [
              { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bot' },
              ...(targetMention ? [{ key: '@_user_2', id: { open_id: 'ou_bob' }, name: 'Bob Smith' }] : []),
            ],
          },
        } as never, { includeRaw: false, botIdentity: { openId: 'ou_bot', name: 'Bot' } })
        await handlers.message!(message)
        await consumer.pump()
        await consumer.pump()
      }
      await input('om_deny', '@_user_1 /deny-user @_user_2', true)
      expect(consumer.policy().policy.rules.filter(rule => rule.action === 'dispatch')).toMatchObject([{
        userIds: ['ou_bob'],
        effect: 'deny',
      }])
      expect(members).not.toHaveBeenCalled()
      await input('om_reset', '@_user_1 /reset-user Bob Smith', false)
      expect(consumer.policy().policy.rules.filter(rule => rule.action === 'dispatch')).toEqual([])
      expect(members).toHaveBeenCalledWith({
        path: { chat_id: 'oc_group' },
        params: { member_id_type: 'open_id', page_size: 100 },
      })
      expect(reply).toHaveBeenCalledTimes(2)
      expect(reply.mock.calls.map(([request]) => request)).toEqual([
        expect.objectContaining({
          path: { message_id: 'om_deny' },
          data: expect.objectContaining({ reply_in_thread: true }),
        }),
        expect.objectContaining({
          path: { message_id: 'om_reset' },
          data: expect.objectContaining({ reply_in_thread: true }),
        }),
      ])
      expect(create).not.toHaveBeenCalled()
      expect(native.start).not.toHaveBeenCalled()
      await owner.dispose()
      owner = undefined
      expect(Object.keys(handlers)).toEqual([])
      expect(disconnect).toHaveBeenCalledTimes(1)
    } finally {
      await owner?.dispose()
      await service.dispose()
      await rm(root, { recursive: true, force: true })
      sdkFactory.mockReset()
    }
  })
})
