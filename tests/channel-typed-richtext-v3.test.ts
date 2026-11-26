import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime, UncertainChannelSendError } from '../packages/channel-runtime/src/runtime.js'
import type { ChannelPluginIdentity, ChannelThreadRef } from '../packages/channel-runtime/src/types.js'

const target = {
  adapterId: 'feishu',
  accountId: 'bot',
  tenantId: 'tenant',
  conversationId: 'oc_chat',
  kind: 'group' as const,
  threadId: 'oc_chat',
  semantics: 'conversation' as const,
}
const caller = { source: 'test', pluginId: 'consumer', generation: 'one' }
const image = (handle: string) => ({
  type: 'image' as const,
  handle,
  format: 'png' as const,
  size: 8,
  sha256: 'a'.repeat(64),
})
const content = {
  type: 'richtext' as const,
  blocks: [{
    type: 'paragraph' as const,
    nodes: [{ type: 'image' as const, handle: 'media:first' }, { type: 'image' as const, handle: 'media:second' }],
  }],
}
const request = {
  contract: 'cordisx.channel-message-send/v3' as const,
  schemaVersion: 3 as const,
  target,
  kind: 'reply' as const,
  idempotencyKey: 'typed-richtext',
  content,
  fallback: { mode: 'reject' as const },
}

async function fixture(support = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'typed-richtext-v3-'))
  const descriptor = vi.fn(async (identity: ChannelPluginIdentity, handle: string, actualTarget: ChannelThreadRef) => {
    expect(identity).toEqual(caller)
    expect(actualTarget).toEqual(target)
    return image(handle)
  })
  const runtime = await ChannelRuntime.open({
    storePath: path.join(directory, 'runtime.json'),
    permissions: { authorize: async () => 'allow' },
    outboundMediaDescriptor: descriptor,
  })
  const send = vi.fn(async (_delivery: unknown) => ({ externalMessageId: 'om_sent' }))
  await runtime.activate({
    descriptor: {
      ref: target,
      kind: 'feishu',
      implementationStatus: 'experimental',
      configurationRevision: 1,
      secretState: 'ready',
    },
    start: async () => ({
      outboundTypes: ['text', 'richtext'],
      richtext: { paragraphs: true, mentions: true },
      richtextV3: support,
      supportsOutboundMedia: true,
      send,
      stop: async () => {},
    }),
  }, { source: 'adapter', pluginId: 'adapter', generation: 'one' })
  return {
    runtime,
    send,
    descriptor,
    dispose: async () => {
      await runtime.dispose()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

it('fingerprints all nodes and descriptors and replays a sent receipt without reusing expired authority', async () => {
  const test = await fixture()
  try {
    const handle = await test.runtime.sendTypedV3(request, caller)
    expect(test.descriptor).toHaveBeenCalledTimes(2)
    await test.runtime.drainOutbound(target)
    expect(test.send).toHaveBeenCalledTimes(1)
    expect(test.send.mock.calls[0]?.[0]).toMatchObject({
      outboundVersion: 3,
      content,
      preparedImages: [image('media:first'), image('media:second')],
    })
    test.descriptor.mockImplementation(async () => {
      throw new Error('expired')
    })
    await test.runtime.sendTypedV3(request, caller)
    await test.runtime.drainOutbound(target)
    expect(test.send).toHaveBeenCalledTimes(1)
    expect(await handle.receipt()).toMatchObject({ status: 'sent' })
    await expect(
      test.runtime.sendTypedV3({
        ...request,
        content: {
          type: 'richtext',
          blocks: [{
            type: 'paragraph',
            nodes: [{ type: 'image', handle: 'media:first' }, { type: 'image', handle: 'media:changed' }],
          }],
        },
      }, caller),
    ).rejects.toThrow('Operation conflict')
  } finally {
    await test.dispose()
  }
})

it('rejects a later unauthorized image before enqueue and rechecks revocation before dispatch', async () => {
  const test = await fixture()
  try {
    test.descriptor.mockImplementation(async (_identity, handle) => {
      if (handle === 'media:second') throw new Error('denied')
      return image(handle)
    })
    await expect(test.runtime.sendTypedV3(request, caller)).rejects.toThrow('denied')
    expect(test.send).not.toHaveBeenCalled()
    test.descriptor.mockImplementation(async (_identity, handle) => image(handle))
    const handle = await test.runtime.sendTypedV3(request, caller)
    test.descriptor.mockImplementation(async () => {
      throw new Error('revoked')
    })
    await test.runtime.drainOutbound(target)
    expect(test.send).not.toHaveBeenCalled()
    expect(await handle.receipt()).toMatchObject({ status: 'failed' })
  } finally {
    await test.dispose()
  }
})

it('never uploads unused fallback images and never replays an uncertain send', async () => {
  const fallback = await fixture(false)
  try {
    const handle = await fallback.runtime.sendTypedV3({
      ...request,
      fallback: { mode: 'text', text: 'explicit fallback' },
    }, caller)
    expect(fallback.descriptor).not.toHaveBeenCalled()
    await fallback.runtime.drainOutbound(target)
    expect(fallback.send.mock.calls[0]?.[0]).toMatchObject({ content: { type: 'text', text: 'explicit fallback' } })
    expect(await handle.receipt()).toMatchObject({ status: 'sent', downgraded: true })
  } finally {
    await fallback.dispose()
  }
  const uncertain = await fixture()
  try {
    uncertain.send.mockImplementation(async () => {
      throw new UncertainChannelSendError('NETWORK_TIMEOUT')
    })
    const handle = await uncertain.runtime.sendTypedV3(request, caller)
    await uncertain.runtime.drainOutbound(target)
    await uncertain.runtime.sendTypedV3(request, caller)
    await uncertain.runtime.drainOutbound(target)
    expect(uncertain.send).toHaveBeenCalledTimes(1)
    expect(await handle.receipt()).toMatchObject({ status: 'unknown' })
  } finally {
    await uncertain.dispose()
  }
})

it('rejects successor content on both frozen runtime send facades', async () => {
  const test = await fixture()
  try {
    await expect(
      test.runtime.sendTyped(
        { ...request, contract: 'cordisx.channel-message-send/v1', schemaVersion: 1 } as never,
        caller,
      ),
    ).rejects.toThrow()
    await expect(
      test.runtime.sendTypedV2(
        { ...request, contract: 'cordisx.channel-message-send/v2', schemaVersion: 2 } as never,
        caller,
      ),
    ).rejects.toThrow()
    expect(test.send).not.toHaveBeenCalled()
  } finally {
    await test.dispose()
  }
})
