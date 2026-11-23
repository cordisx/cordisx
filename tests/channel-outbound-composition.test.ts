import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChannelEventRef,
  ChannelPermissionRequest,
  ChannelPluginIdentity,
  ChannelThreadRef,
} from '../packages/channel-runtime/src/types.js'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import {
  type ChannelConversationAccess,
  ChannelConversationTools,
} from '../packages/cli/src/launcher/channel-conversation-tools.js'
import { ChannelOutboundRpc } from '../packages/cli/src/launcher/channel-outbound-rpc.js'
import { createFeishuAdapterDefinition } from '../packages/cli/src/launcher/feishu-adapter.js'

const account = { adapterId: 'feishu', accountId: 'synthetic', tenantId: 'synthetic' }
const session = '01a10000-0000-7000-8000-000000000001'
const source: ChannelEventRef = {
  ...account,
  conversationId: 'oc_source',
  kind: 'group',
  threadId: 'om_source_root',
  semantics: 'topic',
  eventId: 'om_source_child',
  messageId: 'om_source_child',
  actor: { ...account, userId: 'ou_actor' },
}
const metadata = { 'x-codex-turn-metadata': { thread_id: session, turn_id: 'turn' } }
const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(
  options: { raw?: boolean; uploadError?: boolean; dispatchError?: boolean; denySource?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'outbound-composition-'))
  const storePath = path.join(directory, 'outbox.json')
  const outbound = new ChannelOutboundRpc()
  const descriptor = vi.fn(async (caller: ChannelPluginIdentity, handle: string, target: ChannelThreadRef) =>
    outbound.store.descriptor(caller.generation, handle, target)
  )
  let runtimeDenied = false
  const authorize = vi.fn(async (request: ChannelPermissionRequest) =>
    runtimeDenied && request.capability === 'channel.messages.send' ? 'deny' as const : 'allow' as const
  )
  const runtime = await ChannelRuntime.open({
    storePath,
    permissions: { authorize },
    outboundMediaDescriptor: descriptor,
  })
  const image = vi.fn(async (_request: unknown) => {
    if (options.uploadError) throw new Error('SYNTHETIC_UPLOAD_FAILED')
    return { image_key: 'synthetic-image-key' }
  })
  const file = vi.fn(async (_request: unknown) => ({ file_key: 'synthetic-file-key' }))
  const dispatch = vi.fn(async (_request: unknown) => {
    if (options.dispatchError) throw new Error('SYNTHETIC_DISPATCH_FAILED')
    return { code: 0, data: { message_id: 'om_synthetic_receipt' } }
  })
  const legacySend = vi.fn(async (..._args: unknown[]) => ({ messageId: 'om_legacy_receipt' }))
  const definition = createFeishuAdapterDefinition({
    connection: { ref: account, adapterKind: 'feishu', enabled: true, transport: { mode: 'websocket' } },
    configurationRevision: 1,
    source: 'synthetic-composition',
    outboundMediaAuthority: outbound.authority,
    resolveSecret: async () => 'synthetic',
    createChannel: () =>
      ({
        connect: async () => {},
        disconnect: async () => {},
        on: () => () => {},
        send: legacySend,
        ...(options.raw === false ? {} : {
          rawClient: {
            im: {
              v1: { message: { create: dispatch, reply: dispatch }, image: { create: image }, file: { create: file } },
            },
          },
        }),
      }) as never,
  })
  await runtime.activate(definition, { source: 'synthetic-host', pluginId: 'host', generation: 'fixture' })
  const access = {
    generation: 'fixture',
    runtime,
    outbound,
    accounts: () => [{ ref: account, state: 'ready' }],
    drain: async () => {
      await runtime.drainOutbound(account)
    },
  } as unknown as ChannelConversationAccess
  const native = {
    contextObservations: () => undefined,
    hasPreparation: () => false,
    isPreparing: () => false,
    exists: async () => true,
    start: vi.fn(async () => ({ state: 'running' as const, sessionId: session, turnId: 'turn' })),
    completion: async () => ({ state: 'running' as const }),
    reconcile: async () => ({ state: 'reconciliation-required' as const }),
  }
  const consumer = await ChannelConversationConsumer.open({
    appId: 'codex',
    profileId: 'fixture',
    file: path.join(directory, 'consumer.json'),
    access: () => access,
    native: () => native,
  })
  await consumer.policySet({
    enabled: true,
    rules: [
      ...(options.denySource
        ? [{
          id: 'deny-source',
          action: 'dispatch' as const,
          effect: 'deny' as const,
          conversationId: source.conversationId,
        }]
        : []),
    ],
  }, 0)
  await consumer.bind({
    channel: {
      ...account,
      conversationId: source.conversationId,
      kind: source.kind,
      threadId: source.threadId,
      semantics: source.semantics,
    },
    mode: 'deliver',
  }, session)
  await consumer.receive('inbox:source', {
    contract: 'cordisx.channel-user-input/v1',
    schemaVersion: 1,
    role: 'user',
    content: [{ type: 'text', text: 'send a response' }],
    source: { kind: 'channel', event: source },
    receivedAt: new Date().toISOString(),
  }, true)
  await consumer.pump()
  await consumer.pump()
  expect(consumer.agentAccess.source(session, 'turn')).toEqual(options.denySource ? undefined : source)
  const targetPolicy = vi.spyOn(consumer, 'sendAllowed')
  const tools = new ChannelConversationTools(() => access, consumer)
  cleanups.push(async () => {
    tools.dispose()
    await consumer.dispose()
    await runtime.dispose()
    outbound.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  const outbox = async () =>
    (JSON.parse(await readFile(storePath, 'utf8')) as {
      outbox: Record<
        string,
        { status: string; target: ChannelThreadRef; content: { type: string }; effectiveType: string; text: string }
      >
    }).outbox
  return {
    runtime,
    native,
    consumer,
    tools,
    outbound,
    descriptor,
    authorize,
    image,
    file,
    dispatch,
    legacySend,
    targetPolicy,
    outbox,
    denyRuntime: () => {
      runtimeDenied = true
    },
  }
}

const destination = (mode: 'conversation' | 'thread') => ({
  id: 'oc_target',
  kind: 'group',
  replyMode: mode,
  ...(mode === 'thread' ? { replyTo: 'om_target_root' } : {}),
})

async function prepare(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: 'conversation' | 'thread',
  media: { type: 'image' | 'audio' | 'file' | 'video'; mediaType: string; bytes: Buffer; name?: string } = {
    type: 'image',
    mediaType: 'image/png',
    bytes,
  },
) {
  const begin = await f.tools.call('media-prepare', {
    action: 'begin',
    account,
    target: destination(mode),
    operationId: 'prepare-image',
    type: media.type,
    mediaType: media.mediaType,
    ...(media.name === undefined ? {} : { name: media.name }),
    size: media.bytes.length,
    sha256: createHash('sha256').update(media.bytes).digest('hex'),
  }, metadata) as { status: string; uploadId: string }
  expect(begin).toMatchObject({ status: 'ok' })
  expect(
    await f.tools.call('media-prepare', {
      action: 'chunk',
      uploadId: begin.uploadId,
      offset: 0,
      bytesBase64: media.bytes.toString('base64'),
    }, metadata),
  ).toMatchObject({ status: 'ok' })
  const committed = await f.tools.call('media-prepare', { action: 'commit', uploadId: begin.uploadId }, metadata) as {
    status: string
    media: { handle: string }
  }
  expect(committed).toMatchObject({ status: 'ok' })
  return { uploadId: begin.uploadId, handle: committed.media.handle }
}

describe('production outbound composition with a mocked Feishu SDK', () => {
  it.each(['audio', 'file', 'video'] as const)(
    'sends minimum valid signed %s bytes through preparation and SDK upload',
    async type => {
      const f = await fixture()
      const signed = type === 'audio'
        ? Buffer.alloc(47)
        : type === 'video'
        ? Buffer.alloc(20)
        : Buffer.from('%PDF-1.7\n')
      if (type === 'audio') {
        signed.write('OggS')
        signed[5] = 2
        signed[26] = 1
        signed[27] = 19
        signed.write('OpusHead', 28)
      } else if (type === 'video') {
        signed.writeUInt32BE(20, 0)
        signed.write('ftyp', 4)
        signed.write('isom', 8)
        signed.write('isom', 16)
      }
      const media = {
        type,
        bytes: signed,
        mediaType: type === 'audio' ? 'audio/ogg' : type === 'video' ? 'video/mp4' : 'application/pdf',
        ...(type === 'audio' ? {} : { name: type === 'video' ? 'clip.mp4' : 'report.pdf' }),
      }
      const prepared = await prepare(f, 'thread', media)
      expect(
        await f.tools.call('send', {
          account,
          target: destination('thread'),
          operationId: `send-${type}`,
          payload: { type, handle: prepared.handle },
        }, metadata),
      ).toMatchObject({ status: 'ok', deliveryState: 'sent', receipt: { externalMessageId: 'om_synthetic_receipt' } })
      expect(f.file).toHaveBeenCalledExactlyOnceWith({
        data: {
          file_type: type === 'audio' ? 'opus' : type === 'video' ? 'mp4' : 'pdf',
          file_name: type === 'audio' ? 'audio.opus' : media.name,
          file: signed,
        },
      })
      expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        path: { message_id: 'om_target_root' },
        data: expect.objectContaining({
          msg_type: type === 'video' ? 'media' : type,
          reply_in_thread: true,
          content: JSON.stringify({ file_key: 'synthetic-file-key' }),
        }),
      }))
      expect(Object.values(await f.outbox())[0]).toMatchObject({
        status: 'sent',
        effectiveType: type,
        media: { size: signed.length, sha256: createHash('sha256').update(signed).digest('hex') },
      })
      expect(f.image).not.toHaveBeenCalled()
      expect(f.legacySend).not.toHaveBeenCalled()
    },
  )

  it.each(['richtext', 'card'] as const)(
    'renders typed %s through tools and actual runtime without upload',
    async type => {
      const f = await fixture()
      const payload = type === 'richtext'
        ? { type, blocks: [{ text: 'literal **text**', style: 'plain' }] }
        : { type, title: 'Title', body: 'literal **body**' }
      expect(
        await f.tools.call('send', {
          account,
          target: destination('conversation'),
          operationId: `send-${type}`,
          payload,
        }, metadata),
      )
        .toMatchObject({ status: 'ok', deliveryState: 'sent', receipt: { externalMessageId: 'om_synthetic_receipt' } })
      const rendered = type === 'richtext'
        ? { en_us: { title: '', content: [[{ tag: 'text', text: 'literal **text**' }]] } }
        : {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: 'Title' } },
          elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'literal **body**' } }],
        }
      expect(f.dispatch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        params: { receive_id_type: 'chat_id' },
        data: expect.objectContaining({
          receive_id: 'oc_target',
          msg_type: type === 'richtext' ? 'post' : 'interactive',
          content: JSON.stringify(rendered),
        }),
      }))
      expect(Object.values(await f.outbox())[0]).toMatchObject({
        status: 'sent',
        effectiveType: type,
        content: payload,
      })
      expect(f.descriptor).not.toHaveBeenCalled()
      expect(f.image).not.toHaveBeenCalled()
      expect(f.file).not.toHaveBeenCalled()
      expect(f.legacySend).not.toHaveBeenCalled()
    },
  )

  it('denies the real inbound source before creating an authorized native turn', async () => {
    const f = await fixture({ denySource: true })
    expect(f.native.start).not.toHaveBeenCalled()
    expect(f.consumer.status(session).jobs).toEqual([])
    expect(
      await f.tools.call('media-prepare', {
        action: 'begin',
        account,
        target: destination('thread'),
        operationId: 'untrusted-source',
        type: 'image',
        mediaType: 'image/png',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }, { 'cordisx/channelContext': 'forged' }),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_CONTEXT_UNAVAILABLE' })
    expect(await f.outbox()).toEqual({})
    expect(f.image).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
  it.each(['conversation', 'thread'] as const)(
    'prepares, uploads, dispatches and retains sent receipt in %s',
    async mode => {
      const f = await fixture(), prepared = await prepare(f, mode)
      const request = {
        account,
        target: destination(mode),
        operationId: 'send-image',
        payload: { type: 'image', handle: prepared.handle },
        fallback: { mode: 'reject' },
      }
      expect(await f.tools.call('send', request, metadata)).toMatchObject({ status: 'ok', deliveryState: 'sent' })
      expect(f.targetPolicy).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'oc_target', actor: source.actor }),
      )
      expect(f.descriptor).toHaveBeenCalledTimes(1)
      expect(f.image).toHaveBeenCalledWith({ data: { image_type: 'message', image: bytes } })
      expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({
        ...(mode === 'thread'
          ? { path: { message_id: 'om_target_root' } }
          : { params: { receive_id_type: 'chat_id' } }),
        data: expect.objectContaining({
          msg_type: 'image',
          content: JSON.stringify({ image_key: 'synthetic-image-key' }),
          ...(mode === 'thread' ? { reply_in_thread: true } : { receive_id: 'oc_target' }),
        }),
      }))
      const records = Object.values(await f.outbox())
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        status: 'sent',
        target: {
          conversationId: 'oc_target',
          threadId: mode === 'thread' ? 'om_target_root' : 'oc_target',
          semantics: mode === 'thread' ? 'topic' : 'conversation',
        },
        content: { type: 'image', handle: prepared.handle },
        effectiveType: 'image',
      })
      expect(await f.tools.call('receipt', { account, operationId: 'send-image' }, metadata))
        .toMatchObject({ deliveryState: 'sent', receipt: { externalMessageId: 'om_synthetic_receipt' } })
      await f.tools.call('send', request, metadata)
      expect(f.image).toHaveBeenCalledTimes(1)
      expect(f.dispatch).toHaveBeenCalledTimes(1)
      expect(f.legacySend).not.toHaveBeenCalled()
    },
  )

  it('rechecks target policy before prepare and send effects', async () => {
    const f = await fixture(), prepared = await prepare(f, 'thread')
    await f.consumer.policySet({
      enabled: true,
      rules: [{
        id: 'deny',
        action: 'send',
        effect: 'deny',
        conversationId: 'oc_target',
      }],
    }, f.consumer.policy().revision)
    expect.soft(
      await f.tools.call('media-prepare', {
        action: 'begin',
        account,
        target: destination('thread'),
        operationId: 'denied-prepare',
        type: 'image',
        mediaType: 'image/png',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }, metadata),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_POLICY_DENIED' })
    expect.soft(
      await f.tools.call('send', {
        account,
        target: destination('thread'),
        operationId: 'denied-send',
        payload: { type: 'image', handle: prepared.handle },
      }, metadata),
    ).toMatchObject({ status: 'rejected', code: 'CHANNEL_POLICY_DENIED' })
    for (
      const input of [{
        action: 'chunk',
        uploadId: prepared.uploadId,
        offset: 0,
        bytesBase64: bytes.toString('base64'),
      }, { action: 'commit', uploadId: prepared.uploadId }]
    ) {
      expect.soft(await f.tools.call('media-prepare', input, metadata)).toMatchObject({
        status: 'rejected',
        code: 'CHANNEL_POLICY_DENIED',
      })
    }
    expect(
      await f.tools.call('send', {
        account,
        target: destination('thread'),
        operationId: 'denied-send',
        payload: { type: 'image', handle: prepared.handle },
      }, metadata),
    )
      .toMatchObject({ status: 'rejected', code: 'CHANNEL_POLICY_DENIED' })
    expect(await f.outbox()).toEqual({})
    expect(f.descriptor).not.toHaveBeenCalled()
    expect(f.image).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it.each(['uploadError', 'dispatchError'] as const)('does not downgrade or report sent after %s', async error => {
    const f = await fixture({ [error]: true }), prepared = await prepare(f, 'thread')
    expect(
      await f.tools.call('send', {
        account,
        target: destination('thread'),
        operationId: 'failed-image',
        payload: { type: 'image', handle: prepared.handle },
        fallback: { mode: 'text', text: 'Must not send after an error' },
      }, metadata),
    )
      .not.toMatchObject({ deliveryState: 'sent' })
    expect(Object.values(await f.outbox())[0]).toMatchObject({ effectiveType: 'image', content: { type: 'image' } })
    expect(Object.values(await f.outbox())[0]?.status).not.toBe('sent')
    expect(f.legacySend).not.toHaveBeenCalled()
    expect(f.file).not.toHaveBeenCalled()
    if (error === 'uploadError') expect(f.dispatch).not.toHaveBeenCalled()
    else expect(f.dispatch).toHaveBeenCalledTimes(1)
  })

  it('rejects a prepared handle on another topic before outbox or SDK effects', async () => {
    const f = await fixture(), prepared = await prepare(f, 'thread')
    expect(
      await f.tools.call('send', {
        account,
        target: { ...destination('thread'), replyTo: 'om_other_root' },
        operationId: 'wrong-topic',
        payload: { type: 'image', handle: prepared.handle },
      }, metadata),
    ).toMatchObject({ status: 'rejected', code: 'MEDIA_SOURCE_DENIED' })
    expect(await f.outbox()).toEqual({})
    expect(f.descriptor).not.toHaveBeenCalled()
    expect(f.image).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('retains runtime send permission checks after tools policy and preparation pass', async () => {
    const f = await fixture(), prepared = await prepare(f, 'conversation')
    f.denyRuntime()
    expect(
      await f.tools.call('send', {
        account,
        target: destination('conversation'),
        operationId: 'runtime-denied',
        payload: { type: 'image', handle: prepared.handle },
        fallback: { mode: 'text', text: 'No policy fallback' },
      }, metadata),
    ).not.toMatchObject({ deliveryState: 'sent' })
    expect(f.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'channel.messages.send',
        source: expect.objectContaining({ conversationId: 'oc_target' }),
      }),
    )
    expect(await f.outbox()).toEqual({})
    expect(f.descriptor).not.toHaveBeenCalled()
    expect(f.image).not.toHaveBeenCalled()
    expect(f.legacySend).not.toHaveBeenCalled()
  })

  it('allows only explicitly requested capability fallback, never guessed tools fallback', async () => {
    const f = await fixture({ raw: false })
    expect(
      await f.tools.call('send', {
        account,
        target: destination('conversation'),
        operationId: 'unsupported',
        payload: { type: 'card', title: 'Title', body: 'Body' },
        fallback: { mode: 'reject' },
      }, metadata),
    )
      .not.toMatchObject({ deliveryState: 'sent' })
    expect(await f.outbox()).toEqual({})
    expect(
      await f.tools.call('send', {
        account,
        target: destination('conversation'),
        operationId: 'explicit-fallback',
        payload: { type: 'card', title: 'Title', body: 'Body' },
        fallback: { mode: 'text', text: 'Explicit fallback' },
      }, metadata),
    )
      .toMatchObject({ status: 'ok', deliveryState: 'sent', receipt: { externalMessageId: 'om_legacy_receipt' } })
    expect(Object.values(await f.outbox())[0]).toMatchObject({
      status: 'sent',
      requestedType: 'card',
      effectiveType: 'text',
      text: 'Explicit fallback',
      content: { type: 'card' },
      fallback: { mode: 'text', text: 'Explicit fallback' },
    })
    expect(f.legacySend).toHaveBeenCalledTimes(1)
    expect(f.legacySend).toHaveBeenCalledWith('oc_target', { text: 'Explicit fallback' }, {})
    expect(f.image).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })
})
