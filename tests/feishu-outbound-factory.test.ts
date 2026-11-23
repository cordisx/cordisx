import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'
import { feishuDefinitionsForConfig } from '../packages/cli/src/launcher/feishu-adapter.js'

const { sdkFactory } = vi.hoisted(() => ({ sdkFactory: vi.fn() }))
vi.mock('@larksuiteoapi/node-sdk', async original => ({
  ...await original<typeof import('@larksuiteoapi/node-sdk')>(),
  createLarkChannel: sdkFactory,
}))

describe('configured Feishu factory outbound authority', () => {
  it.each(['conversation', 'topic'] as const)(
    'forwards prepared authority through factory and runtime to SDK %s',
    async semantics => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'feishu-outbound-factory-'))
      const account = { adapterId: 'feishu', accountId: 'synthetic-factory', tenantId: 'synthetic' }
      const target = {
        ...account,
        conversationId: 'oc_target',
        kind: 'group' as const,
        threadId: semantics === 'topic' ? 'om_root' : 'oc_target',
        semantics,
      }
      const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      const media = {
        type: 'image' as const,
        format: 'png' as const,
        handle: 'media:factory',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
      const resolve = vi.fn(async () => bytes)
      const upload = vi.fn(async (_request: unknown) => ({ image_key: 'factory-image' }))
      const dispatch = vi.fn(async (_request: unknown) => ({ code: 0, data: { message_id: 'om_factory_sent' } }))
      const legacySend = vi.fn()
      const disconnect = vi.fn(async () => {})
      const channel = {
        connect: vi.fn(async () => {}),
        disconnect,
        on: () => () => {},
        send: legacySend,
        rawClient: { im: { v1: { image: { create: upload }, message: { create: dispatch, reply: dispatch } } } },
      }
      sdkFactory.mockReturnValue(channel)
      const connected = vi.fn()
      const definitions = feishuDefinitionsForConfig({
        contract: 'cordisx.channel-service-config/v1',
        schemaVersion: 1,
        connections: [{
          ref: account,
          adapterKind: 'feishu',
          enabled: true,
          transport: { mode: 'websocket' },
          secretRef: 'host-secret:env/FEISHU_FACTORY_TEST_SECRET',
        }],
      }, {
        source: 'synthetic-factory',
        configurationRevision: 1,
        secretResolver: { environment: { FEISHU_FACTORY_TEST_SECRET: 'synthetic-only' } },
        outboundMediaAuthority: { resolve },
        channelConnected: connected,
      })
      const runtime = await ChannelRuntime.open({
        storePath: path.join(directory, 'runtime.json'),
        permissions: { authorize: async () => 'allow' },
        outboundMediaDescriptor: async () => media,
      })
      const caller = { source: 'synthetic-host', pluginId: 'host', generation: 'factory' }
      try {
        expect(definitions).toHaveLength(1)
        await runtime.activate(definitions[0]!, caller)
        expect(sdkFactory).toHaveBeenLastCalledWith(
          expect.objectContaining({ appId: account.accountId, appSecret: 'synthetic-only', transport: 'websocket' }),
        )
        expect(connected).toHaveBeenCalledWith(account, channel)
        const handle = await runtime.sendOutbound({
          contract: 'cordisx.channel-message-send/v1',
          schemaVersion: 1,
          target,
          kind: 'reply',
          idempotencyKey: 'factory-image',
          content: { type: 'image', handle: media.handle },
          fallback: { mode: 'reject' },
        }, caller)
        await runtime.drainOutbound(account)
        expect(resolve).toHaveBeenCalledExactlyOnceWith(media.handle, target, media.size)
        expect(upload).toHaveBeenCalledExactlyOnceWith({ data: { image_type: 'message', image: bytes } })
        expect(dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          ...(semantics === 'topic' ? { path: { message_id: 'om_root' } } : { params: { receive_id_type: 'chat_id' } }),
          data: expect.objectContaining({
            msg_type: 'image',
            content: JSON.stringify({ image_key: 'factory-image' }),
            ...(semantics === 'topic' ? { reply_in_thread: true } : { receive_id: 'oc_target' }),
          }),
        }))
        expect(await handle.receipt()).toMatchObject({
          status: 'sent',
          externalMessageId: 'om_factory_sent',
          effectiveType: 'image',
          downgraded: false,
        })
        expect(legacySend).not.toHaveBeenCalled()
      } finally {
        await runtime.dispose()
        await rm(directory, { recursive: true, force: true })
      }
      expect(connected).toHaveBeenLastCalledWith(account, undefined)
      expect(disconnect).toHaveBeenCalledTimes(1)
    },
  )
})
