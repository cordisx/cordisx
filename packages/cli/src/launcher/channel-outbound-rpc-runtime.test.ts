import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime } from '@cordisx/channel-runtime'
import { type ChannelConversationAccess, ChannelConversationTools } from './channel-conversation-tools.js'
import { ChannelOutboundRpc } from './channel-outbound-rpc.js'

it.each(['file', 'richtext'] as const)(
  'sends prepared %s bytes once and replays durable receipts after handle expiry without accepting content conflicts',
  async mode => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'outbound-rpc-runtime-'))
    const outbound = new ChannelOutboundRpc()
    const account = { adapterId: 'feishu', accountId: 'test', tenantId: 'tenant' }
    const target = {
      ...account,
      conversationId: 'oc_target',
      kind: 'group' as const,
      threadId: 'oc_target',
      semantics: 'conversation' as const,
    }
    const runtime = await ChannelRuntime.open({
      storePath: path.join(directory, 'store.json'),
      permissions: { authorize: async () => 'allow' },
      outboundMediaDescriptor: async (caller, handle, target) =>
        outbound.store.descriptor(caller.generation, handle, target),
      resolveOutboundMedia: outbound.authority.resolve,
    })
    const bytes = mode === 'file' ? Buffer.from('hello') : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    const send = vi.fn(async (delivery: import('@cordisx/channel-runtime').ChannelOutboundDelivery) => {
      const handle = delivery.media?.handle ?? delivery.preparedImages?.[0]?.handle
      expect(await outbound.authority.resolve(handle!, target, bytes.length)).toEqual(
        Uint8Array.from(bytes),
      )
      return { externalMessageId: 'om_sent' }
    })
    const access = {
      generation: 'generation',
      runtime,
      outbound,
      accounts: () => [{ ref: account, state: 'ready' }],
      drain: async () => {
        await runtime.drainOutbound(account)
      },
    } as unknown as ChannelConversationAccess
    const tools = new ChannelConversationTools(() => access)
    try {
      await runtime.activate({
        descriptor: {
          ref: account,
          kind: 'feishu',
          implementationStatus: 'experimental',
          configurationRevision: 1,
          secretState: 'ready',
        },
        start: async () => ({
          outboundTypes: ['file', 'richtext'],
          richtext: { paragraphs: true, mentions: true },
          richtextV3: true,
          supportsOutboundMedia: true,
          send,
          stop: async () => {},
        }),
      }, { source: 'adapter', pluginId: 'adapter', generation: 'one' })
      const started = await tools.call('media-prepare', {
        action: 'begin',
        account,
        target: { id: 'oc_target', kind: 'group' },
        operationId: 'prepare',
        type: mode === 'file' ? 'file' : 'image',
        format: mode === 'file' ? 'binary' : 'png',
        filename: 'sample.bin',
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }) as { uploadId: string }
      expect(started).toMatchObject({ status: 'ok' })
      await tools.call('media-prepare', {
        action: 'chunk',
        uploadId: started.uploadId,
        offset: 0,
        bytesBase64: bytes.toString('base64'),
      })
      const sealed = await tools.call('media-prepare', { action: 'commit', uploadId: started.uploadId }) as {
        media: { handle: string }
      }
      const request = {
        account,
        target: { id: 'oc_target', kind: 'group' },
        operationId: 'send',
        content: mode === 'file' ? { type: 'file', handle: sealed.media.handle } : {
          type: 'richtext',
          blocks: [
            {
              type: 'paragraph',
              nodes: [{ type: 'link', text: 'Docs', url: 'https://example.org' }, {
                type: 'image',
                handle: sealed.media.handle,
              }],
            },
            { type: 'inline-code', text: 'literal code' },
            { type: 'code', text: 'return 42', language: 'GO' },
          ],
        },
        fallback: { mode: 'reject' },
      }
      expect(await tools.call('send', request)).toMatchObject({ status: 'ok', receipt: { state: 'sent' } })
      outbound.store.dispose()
      expect(await tools.call('receipt', { account, operationId: 'send' })).toMatchObject({
        status: 'ok',
        receipt: { state: 'sent' },
      })
      expect(await tools.call('send', request)).toMatchObject({ status: 'ok', receipt: { state: 'sent' } })
      expect(send).toHaveBeenCalledTimes(1)
      expect(await tools.call('send', { ...request, operationId: 'new' })).toMatchObject({ status: 'rejected' })
      for (
        const patch of [
          { content: { type: 'file', handle: 'media:changed' } },
          { fallback: { mode: 'text', text: 'changed fallback' } },
          { target: { id: 'oc_other', kind: 'group' } },
        ]
      ) {
        expect(await tools.call('send', { ...request, ...patch })).toMatchObject({
          status: 'partial',
          deliveryState: 'unknown',
        })
      }
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      tools.dispose()
      outbound.dispose()
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
