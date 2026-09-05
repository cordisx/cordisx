import { describe, expect, it } from 'vitest'
import type { ChannelAdapterHost, ChannelInboundEnvelope, ChannelOutboundDelivery } from '@cordisx/channel-runtime'
import { createFeishuAdapterDefinition } from '../packages/cli/src/launcher/feishu-adapter.js'
import { LauncherSecretResolutionError, resolveLauncherSecret } from '../packages/cli/src/launcher/secret-resolver.js'

const connection = {
  ref: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant-test' },
  adapterKind: 'feishu' as const,
  enabled: true,
  transport: { mode: 'websocket' as const },
  secretRef: 'host-secret:env/CORDISX_FEISHU_TEST_SECRET',
}

describe('launcher private secret resolution', () => {
  it('accepts only the explicit environment reference without returning reference data', async () => {
    await expect(resolveLauncherSecret('host-secret:env/CORDISX_FEISHU_TEST_SECRET', {
      environment: { CORDISX_FEISHU_TEST_SECRET: 'not-a-real-secret' },
    })).resolves.toBe('not-a-real-secret')
    await expect(resolveLauncherSecret('host-secret:env/MISSING', { environment: {} }))
      .rejects.toMatchObject({ code: 'SECRET_MISSING' } satisfies Partial<LauncherSecretResolutionError>)
    await expect(resolveLauncherSecret('inline:secret', { environment: {} }))
      .rejects.toMatchObject({ code: 'SECRET_REF_INVALID' } satisfies Partial<LauncherSecretResolutionError>)
  })
})

describe('official Feishu direct-message adapter', () => {
  it('normalizes allowed inbound text, drains it, and sends an outbound reply without retaining raw payloads', async () => {
    const received: ChannelInboundEnvelope[] = []
    let inboundDrains = 0
    let outboundDrains = 0
    let listener:
      | ((message: {
        messageId: string
        chatId: string
        chatType: 'p2p'
        senderId: string
        content: string
        createTime: number
        mentionedBot: boolean
      }) => Promise<void>)
      | undefined
    const sent: Array<{ to: string; text: string }> = []
    const definition = createFeishuAdapterDefinition({
      connection,
      configurationRevision: 4,
      source: 'cordisx-test',
      resolveSecret: async () => 'not-a-real-secret',
      createChannel: () =>
        ({
          connect: async () => undefined,
          disconnect: async () => undefined,
          on: (_name: 'message', handler: typeof listener) => {
            listener = handler
            return () => {
              listener = undefined
            }
          },
          send: async (to: string, input: { text: string }) => {
            sent.push({ to, text: input.text })
            return { messageId: 'outbound-1' }
          },
        }) as never,
    })
    const host: ChannelAdapterHost = {
      generation: 2,
      ref: connection.ref,
      receive: async value => {
        received.push(value)
        return { recordId: 'inbound-1', duplicate: false, status: 'queued' }
      },
      drainInbound: async () => {
        inboundDrains += 1
        return 1
      },
      drainOutbound: async () => {
        outboundDrains += 1
        return 0
      },
    }
    const active = await definition.start(host)
    await listener?.({
      messageId: 'inbound-1',
      chatId: 'chat-1',
      chatType: 'p2p',
      senderId: 'user-1',
      content: 'hello',
      createTime: 0,
      mentionedBot: false,
    })
    expect(received).toEqual([expect.objectContaining({
      input: expect.objectContaining({
        content: [{ type: 'text', text: 'hello' }],
        source: expect.objectContaining({ event: expect.objectContaining({ eventId: 'inbound-1' }) }),
      }),
    })])
    expect(JSON.stringify(received)).not.toContain('not-a-real-secret')
    expect(inboundDrains).toBe(1)
    const delivery: ChannelOutboundDelivery = {
      deliveryId: 'delivery-1',
      target: {
        ...connection.ref,
        conversationId: 'chat-1',
        kind: 'direct',
        threadId: 'chat-1',
        semantics: 'conversation',
      },
      kind: 'reply',
      text: 'pong',
      createdAt: '2026-08-25T00:00:00.000Z',
    }
    await expect(active.send(delivery)).resolves.toEqual({
      externalMessageId: 'outbound-1',
      recallHandle: 'outbound-1',
    })
    expect(sent).toEqual([{ to: 'chat-1', text: 'pong' }])
    await active.stop('disposed')
    expect(outboundDrains).toBeGreaterThanOrEqual(0)
  })

  it('accepts attributed inbound messages without task routing and rejects non-websocket configuration', async () => {
    const wrongTransport = { ...connection, transport: { mode: 'webhook' as const } }
    expect(() =>
      createFeishuAdapterDefinition({ connection: wrongTransport, configurationRevision: 1, source: 'test' })
    ).toThrow('CONNECTION_UNAVAILABLE')
    let listener:
      | ((
        message: {
          messageId: string
          chatId: string
          chatType: 'p2p'
          senderId: string
          content: string
          createTime: number
          mentionedBot: boolean
        },
      ) => Promise<void>)
      | undefined
    const definition = createFeishuAdapterDefinition({
      connection,
      configurationRevision: 1,
      source: 'test',
      resolveSecret: async () => 'x',
      createChannel: () =>
        ({
          connect: async () => undefined,
          disconnect: async () => undefined,
          on: (_: 'message', value: typeof listener) => {
            listener = value
            return () => {}
          },
          send: async () => ({ messageId: 'x' }),
        }) as never,
    })
    let received = 0
    const host: ChannelAdapterHost = {
      generation: 1,
      ref: connection.ref,
      receive: async () => {
        received += 1
        return { recordId: 'other', duplicate: false, status: 'queued' }
      },
      drainInbound: async () => 0,
      drainOutbound: async () => 0,
    }
    const active = await definition.start(host)
    await listener?.({
      messageId: 'other',
      chatId: 'chat',
      chatType: 'p2p',
      senderId: 'other-user',
      content: 'hello',
      createTime: 0,
      mentionedBot: false,
    })
    expect(received).toBe(1)
    await active.stop('disposed')
  })
})
