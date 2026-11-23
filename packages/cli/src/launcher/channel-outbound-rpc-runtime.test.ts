import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime } from '@cordisx/channel-runtime'
import { type ChannelConversationAccess, ChannelConversationTools } from './channel-conversation-tools.js'
import { ChannelOutboundRpc } from './channel-outbound-rpc.js'

it('sends prepared bytes once and replays durable receipts after handle expiry without accepting content conflicts', async () => {
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
  const send = vi.fn(async (delivery: { media?: { handle: string } }) => {
    expect(await outbound.authority.resolve(delivery.media!.handle, target, 5)).toEqual(
      Uint8Array.from(Buffer.from('hello')),
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
      start: async () => ({ outboundTypes: ['file'], supportsOutboundMedia: true, send, stop: async () => {} }),
    }, { source: 'adapter', pluginId: 'adapter', generation: 'one' })
    const bytes = Buffer.from('hello')
    const started = await tools.call('media-prepare', {
      action: 'begin',
      account,
      target: { id: 'oc_target', kind: 'group' },
      operationId: 'prepare',
      type: 'file',
      format: 'binary',
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
      content: { type: 'file', handle: sealed.media.handle },
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
})
