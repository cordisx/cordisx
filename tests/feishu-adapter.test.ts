import { describe, expect, it, vi } from 'vitest'
import { normalize, type NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type { ChannelAdapterHost, ChannelInboundEnvelope, ChannelOutboundDelivery } from '@cordisx/channel-runtime'
import { validateInput } from '../packages/channel-runtime/src/runtime-validation.js'
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
  it.each([true, false])('preserves main, quoted and topic Markdown sends with raw SDK=%s', async raw => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_created' } }))
    const reply = vi.fn(async () => ({ code: 0, data: { message_id: 'om_replied' } }))
    const send = vi.fn(async () => ({ messageId: 'om_sent' }))
    const definition = createFeishuAdapterDefinition({
      connection,
      configurationRevision: 1,
      source: 'test',
      resolveSecret: async () => 'fixture-only',
      createChannel: () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          on: () => () => {},
          send,
          ...(raw ? { rawClient: { im: { v1: { message: { create, reply } } } } } : {}),
        }) as never,
    })
    const active = await definition.start({
      generation: 1,
      ref: connection.ref,
      receive: async () => ({ recordId: 'unused', duplicate: false, status: 'queued' }),
      drainInbound: async () => 0,
      drainOutbound: async () => 0,
    })
    try {
      for (const semantics of ['conversation', 'reply-chain', 'topic'] as const) {
        await active.send({
          deliveryId: 'delivery:' + semantics,
          target: {
            ...connection.ref,
            conversationId: 'oc_group',
            kind: 'group',
            threadId: semantics === 'conversation' ? 'oc_group' : 'om_source',
            semantics,
          },
          kind: 'reply',
          text: '**requested**',
          createdAt: '2026-11-15T00:00:00Z',
        })
      }
      if (raw) {
        expect(create).toHaveBeenCalledTimes(1)
        expect(create.mock.calls[0]?.[0]).toMatchObject({
          data: {
            receive_id: 'oc_group',
            msg_type: 'post',
            content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: '**requested**' }]] } }),
            uuid: expect.stringMatching(/^[a-f0-9]{32}$/),
          },
        })
        expect(reply.mock.calls.map(([input]) => input)).toEqual([
          expect.objectContaining({
            path: { message_id: 'om_source' },
            data: expect.objectContaining({ reply_in_thread: false, msg_type: 'post' }),
          }),
          expect.objectContaining({
            path: { message_id: 'om_source' },
            data: expect.objectContaining({ reply_in_thread: true, msg_type: 'post' }),
          }),
        ])
        expect(send).not.toHaveBeenCalled()
      } else {
        expect(send.mock.calls.map(([, input]) => input)).toEqual([
          { text: '**requested**' },
          { text: '**requested**' },
          { text: '**requested**' },
        ])
        expect(send.mock.calls.map(([, , options]) => options)).toEqual([
          {},
          { replyTo: 'om_source', replyInThread: false },
          { replyTo: 'om_source', replyInThread: true },
        ])
      }
    } finally {
      await active.stop('disposed')
    }
  })
  it('sends bounded question cards with the stable delivery UUID and never fabricates a text fallback', async () => {
    const create = vi.fn(async () => ({ code: 0, data: { message_id: 'om_card' } }))
    const send = vi.fn(async () => ({ messageId: 'om_text' }))
    const build = (raw: boolean) =>
      createFeishuAdapterDefinition({
        connection,
        configurationRevision: 1,
        source: 'test',
        resolveSecret: async () => 'fixture-only',
        createChannel: () =>
          ({
            connect: async () => {},
            disconnect: async () => {},
            on: () => () => {},
            send,
            ...(raw ? { rawClient: { im: { v1: { message: { create } } } } } : {}),
          }) as never,
      })
    const host = {
      generation: 1,
      ref: connection.ref,
      receive: async () => ({ recordId: 'unused', duplicate: false, status: 'queued' as const }),
      drainInbound: async () => 0,
      drainOutbound: async () => 0,
    }
    const delivery = {
      deliveryId: 'delivery:question',
      target: {
        ...connection.ref,
        conversationId: 'oc_group',
        kind: 'group' as const,
        threadId: 'oc_group',
        semantics: 'conversation' as const,
      },
      kind: 'reply' as const,
      text: 'Question',
      createdAt: '2026-11-15T00:00:00Z',
      questionCard: { token: 'a'.repeat(64), question: 'Question', options: ['Yes'] },
    }
    const active = await build(true).start(host)
    try {
      await active.send(delivery)
      await active.send(delivery)
      const calls = create.mock.calls.map(([input]) => input)
      expect(calls[0].data).toMatchObject({ msg_type: 'interactive', receive_id: 'oc_group' })
      expect(calls[0].data.uuid).toBe(calls[1].data.uuid)
      expect(JSON.parse(calls[0].data.content).elements[1].actions[0].value).toEqual({
        channelQuestion: 'a'.repeat(64),
        option: 0,
      })
      expect(send).not.toHaveBeenCalled()
    } finally {
      await active.stop('disposed')
    }
    const noRaw = await build(false).start(host)
    try {
      await expect(noRaw.send(delivery)).rejects.toThrow()
      expect(send).not.toHaveBeenCalled()
    } finally {
      await noRaw.stop('disposed')
    }
  })
  it('accepts SDK empty thread IDs as conversations and preserves real reply chains for receive selectors', async () => {
    let listener: ((message: NormalizedMessage) => Promise<void>) | undefined
    let selectors: readonly string[] | undefined
    const received: ChannelInboundEnvelope[] = []
    const definition = createFeishuAdapterDefinition({
      connection,
      configurationRevision: 1,
      source: 'test',
      resolveSecret: async () => 'not-a-real-secret',
      readConnection: () => ({ ...connection, selectors }) as never,
      createChannel: () =>
        ({
          connect: async () => {},
          disconnect: async () => {},
          on: (_name: 'message', handler: typeof listener) => {
            if (_name !== 'message') return () => {}
            listener = handler
            return () => {
              listener = undefined
            }
          },
          send: async () => ({ messageId: 'unused' }),
        }) as never,
    })
    const active = await definition.start({
      generation: 1,
      ref: connection.ref,
      receive: async envelope => {
        validateInput(connection.ref, envelope)
        received.push(envelope)
        return { recordId: 'validated', duplicate: false, status: 'queued' }
      },
      drainInbound: async () => 0,
      drainOutbound: async () => 0,
    })
    try {
      const message = await normalize({
        sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user', tenant_key: 'tenant-test' },
        message: {
          message_id: 'om_test',
          chat_id: 'oc_test',
          chat_type: 'group',
          create_time: '1',
          message_type: 'text',
          content: JSON.stringify({ text: 'SDK normalized message' }),
          root_id: '',
          thread_id: '',
        },
      } as never, { includeRaw: false })
      expect(message.rootId).toBe('')
      expect(message.threadId).toBe('')
      await listener!(message)
      await listener!({ ...message, rootId: '  ', threadId: '\t' })
      expect(received.map(value => value.input.source.event)).toEqual([
        expect.objectContaining({ threadId: 'oc_test', semantics: 'conversation' }),
        expect.objectContaining({ threadId: 'oc_test', semantics: 'conversation' }),
      ])
      selectors = ['replies']
      await listener!(message)
      expect(received).toHaveLength(2)
      await listener!({ ...message, rootId: 'om_reply', threadId: '' })
      expect(received[2]!.input.source.event).toMatchObject({ threadId: 'om_reply', semantics: 'reply-chain' })
      await listener!({ ...message, rootId: 'om_topic', threadId: 'omt_topic' })
      expect(received[3]!.input.source.event).toMatchObject({ threadId: 'om_topic', semantics: 'topic' })
      expect(JSON.stringify(received)).not.toContain('not-a-real-secret')
    } finally {
      await active.stop('disposed')
    }
  })

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
            if (_name !== 'message') return () => {}
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
            if (_ !== 'message') return () => {}
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
