import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { JsonChannelStore } from '../packages/channel-runtime/src/store.js'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'

it('preserves media and sent receipts across reopen and rejects malformed media', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-media-'))
  const file = path.join(directory, 'store.json')
  try {
    const store = await JsonChannelStore.open(file)
    const record = {
      deliveryId: 'delivery:synthetic',
      accountKey: 'synthetic',
      generation: 1,
      caller: { source: 'synthetic', pluginId: 'synthetic', generation: '1' },
      target: {
        adapterId: 'lark',
        accountId: 'synthetic',
        tenantId: 'synthetic',
        conversationId: 'chat',
        kind: 'group' as const,
        threadId: 'thread',
        semantics: 'topic' as const,
      },
      kind: 'reply' as const,
      text: '',
      createdAt: '2026-11-22T00:00:00Z',
      updatedAt: '2026-11-22T00:00:00Z',
      status: 'sent' as const,
      attempts: 1,
      externalMessageId: 'synthetic-receipt',
      media: {
        type: 'image' as const,
        handle: 'media:synthetic',
        format: 'png' as const,
        size: 8,
        sha256: 'a'.repeat(64),
      },
    }
    await store.transaction(state => {
      state.outbox[record.deliveryId] = record
    })
    expect((await JsonChannelStore.open(file)).snapshot().outbox[record.deliveryId]).toEqual(record)
    const state = JSON.parse(await readFile(file, 'utf8'))
    state.outbox[record.deliveryId].media.handle = 'https://example.invalid/image.png'
    await writeFile(file, JSON.stringify(state))
    await expect(JsonChannelStore.open(file)).rejects.toThrow('Invalid outbound media')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('deduplicates the media descriptor, preserves receipts, and fences unsupported adapters', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-media-'))
  const runtime = await ChannelRuntime.open({
    storePath: path.join(directory, 'store.json'),
    permissions: { authorize: async () => 'allow' },
  })
  const caller = { source: 'synthetic', pluginId: 'synthetic', generation: '1' }
  const target = {
    adapterId: 'lark',
    accountId: 'synthetic',
    tenantId: 'synthetic',
    conversationId: 'chat',
    kind: 'group' as const,
    threadId: 'thread',
    semantics: 'topic' as const,
  }
  const notification = {
    target,
    kind: 'reply' as const,
    text: '',
    media: {
      type: 'image' as const,
      handle: 'media:synthetic',
      format: 'png' as const,
      size: 8,
      sha256: 'a'.repeat(64),
    },
  }
  let sends = 0
  try {
    const definition = {
      descriptor: {
        ref: target,
        kind: 'lark' as const,
        implementationStatus: 'experimental' as const,
        configurationRevision: 1,
        secretState: 'ready' as const,
      },
      start: async () => ({
        supportsOutboundMedia: true,
        send: async () => {
          sends += 1
          return { externalMessageId: 'synthetic-receipt' }
        },
        stop: async () => {},
      }),
    }
    const handle = await runtime.activate(definition, caller)
    await runtime.notifyOnce(notification, caller, 'delivery:synthetic')
    await runtime.notifyOnce(notification, caller, 'delivery:synthetic')
    await expect(
      runtime.notifyOnce(
        { ...notification, media: { ...notification.media, sha256: 'b'.repeat(64) } },
        caller,
        'delivery:synthetic',
      ),
    ).rejects.toThrow('Operation conflict')
    await handle.drainOutbound(10)
    await runtime.notifyOnce(notification, caller, 'delivery:synthetic')
    await handle.drainOutbound(10)
    expect(sends).toBe(1)
    const unsupported = await runtime.activate({
      ...definition,
      start: async () => ({
        send: async () => {
          sends += 1
          return { externalMessageId: 'bad' }
        },
        stop: async () => {},
      }),
    }, caller)
    await runtime.notifyOnce(notification, caller, 'delivery:unsupported')
    await unsupported.drainOutbound(10)
    expect(sends).toBe(1)
    const state = JSON.parse(await readFile(path.join(directory, 'store.json'), 'utf8'))
    expect(state.outbox['delivery:synthetic'].externalMessageId).toBe('synthetic-receipt')
    expect(state.outbox['delivery:unsupported'].status).toBe('dead-letter')
  } finally {
    await runtime.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
