import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Client, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk'
import { serveChannelCli } from '../packages/cli/src/cli/channel-cli-session.js'
import { callChannelCli } from '../packages/cli/src/cli/channel-cli-transport.js'
import { matchesChannelCliScope } from '../packages/cli/src/cli/channel-cli-scope.js'

const scope = {
  adapter: 'feishu' as const,
  account: 'app',
  tenant: 'tenant',
  conversation: 'chat',
  actor: 'actor',
  match: 'unique marker',
}
function message(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    messageId: 'inbound',
    chatId: 'chat',
    chatType: 'p2p',
    senderId: 'actor',
    content: 'unique marker',
    rawContentType: 'text',
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
    raw: { sender: { sender_type: 'user', tenant_key: 'tenant' } },
    ...overrides,
  }
}
function waitFor<T>(work: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('test deadline')), ms).unref()),
  ])
}

describe('Host scoped channel CLI', () => {
  it('admits only the exact new direct message including the real tenant', () => {
    const since = Date.now() - 50
    expect(matchesChannelCliScope(scope, message(), since)).toBe(true)
    for (
      const override of [
        { chatId: 'other' },
        { senderId: 'other' },
        { chatType: 'group' as const },
        { content: 'other' },
        { rawContentType: 'post' },
        { createTime: since - 1 },
        { raw: { sender: { sender_type: 'user', tenant_key: 'other' } } },
        { raw: { sender: { sender_type: 'app', tenant_key: 'tenant' } } },
        { raw: undefined },
      ]
    ) expect(matchesChannelCliScope(scope, message(override), since)).toBe(false)
  })

  it('uses a private live binding, rejects unmatched events before storage, sends once and reads back', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cxcli-'))
    const directory = path.join(parent, 'session')
    let onMessage: ((value: NormalizedMessage) => Promise<void>) | undefined
    let sends = 0
    let stopped = false
    const fakeSdk = {
      botIdentity: { name: 'test bot' },
      on: (kind: string, fn: (value: NormalizedMessage) => Promise<void>) => {
        if (kind === 'message') onMessage = fn
        return () => {
          onMessage = undefined
        }
      },
      connect: async () => undefined,
      disconnect: async () => {
        stopped = true
      },
      send: async (target: string, input: { text: string }) => {
        expect(target).toBe('chat')
        expect(input.text).toBe('reply')
        sends++
        return { messageId: 'outbound' }
      },
    } as unknown as LarkChannel
    const api = {
      im: {
        v1: {
          message: {
            get: async ({ path: p }: { path: { message_id: string } }) => ({
              code: 0,
              data: {
                items: [{
                  message_id: p.message_id,
                  chat_id: 'chat',
                  sender: { id: p.message_id === 'inbound' ? 'actor' : 'app', tenant_key: 'tenant' },
                  body: { content: JSON.stringify({ text: p.message_id === 'inbound' ? 'unique marker' : 'reply' }) },
                  deleted: false,
                }],
              },
            }),
          },
        },
      },
    } as unknown as Client
    let ready!: (value: string) => void
    const readyPromise = new Promise<string>(resolve => {
      ready = resolve
    })
    const serving = serveChannelCli({
      directory,
      durationSeconds: 30,
      scope,
      secret: 'test-only',
      internalChannelFactory: () => fakeSdk,
      internalClientFactory: () => api,
      stdout: line => {
        const event = JSON.parse(line) as { event: string; bindingPath: string }
        if (event.event === 'connection-ready') ready(event.bindingPath)
      },
    })
    const binding = await waitFor(readyPromise)
    try {
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(binding)).mode & 0o777).toBe(0o600)
      let listening!: () => void
      const listeningPromise = new Promise<void>(resolve => {
        listening = resolve
      })
      const lines: Array<Record<string, unknown>> = []
      const listen = callChannelCli(binding, { action: 'listen' }, line => {
        const item = JSON.parse(line) as Record<string, unknown>
        lines.push(item)
        if (item.event === 'listening') listening()
      }, 5_000)
      await waitFor(listeningPromise)
      await onMessage?.(message({ chatId: 'wrong-chat' }))
      await onMessage?.(message({ raw: { sender: { sender_type: 'user', tenant_key: 'wrong' } } }))
      await onMessage?.(message({ content: 'wrong text' }))
      const pre = JSON.parse(await readFile(path.join(directory, 'channel-store.json'), 'utf8')) as { inbox: object }
      expect(Object.keys(pre.inbox)).toHaveLength(0)
      await onMessage?.(message())
      await waitFor(listen)
      expect(lines.map(item => item.event)).toEqual(['listening', 'message'])
      const receipts: Array<Record<string, unknown>> = []
      const send = () =>
        callChannelCli(
          binding,
          { action: 'send', operationId: 'op', text: 'reply' },
          line => receipts.push(JSON.parse(line) as Record<string, unknown>),
          5_000,
        )
      await send()
      await send()
      expect(sends).toBe(1)
      expect(receipts[0]).toEqual(receipts[1])
      expect(receipts[0]).toMatchObject({ event: 'send-receipt', externalMessageId: 'outbound', attempts: 1 })
      await expect(callChannelCli(binding, { action: 'send', operationId: 'other', text: 'reply' }, () => {}, 5_000))
        .rejects.toThrow()
      let readback: Record<string, unknown> = {}
      await callChannelCli(binding, { action: 'readback' }, line => {
        readback = JSON.parse(line) as Record<string, unknown>
      }, 5_000)
      expect(readback).toMatchObject({
        event: 'readback',
        inboundMatches: true,
        outboundMatches: true,
        independentApi: true,
      })
      await callChannelCli(binding, { action: 'stop' }, () => {}, 5_000)
      await waitFor(serving)
      expect(stopped).toBe(true)
      await expect(stat(directory)).rejects.toThrow()
    } finally {
      await callChannelCli(binding, { action: 'stop' }, () => {}, 1_000).catch(() => undefined)
      await waitFor(serving).catch(() => undefined)
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('reports and propagates runtime cleanup failure while removing its binding', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'cxcli-fail-'))
    const directory = path.join(parent, 'session')
    const fakeSdk = {
      on: () => () => undefined,
      connect: async () => undefined,
      disconnect: async () => {
        throw new Error('fixture cleanup failure')
      },
      send: async () => ({ messageId: 'unused' }),
    } as unknown as LarkChannel
    let ready!: (value: string) => void
    const readyPromise = new Promise<string>(resolve => {
      ready = resolve
    })
    const events: Array<Record<string, unknown>> = []
    const serving = serveChannelCli({
      directory,
      durationSeconds: 30,
      scope,
      secret: 'test-only',
      internalChannelFactory: () => fakeSdk,
      internalClientFactory: () => ({} as Client),
      stdout: line => {
        const value = JSON.parse(line) as Record<string, unknown>
        events.push(value)
        if (value.event === 'connection-ready') ready(String(value.bindingPath))
      },
    })
    void serving.catch(() => undefined)
    const binding = await waitFor(readyPromise)
    try {
      await callChannelCli(binding, { action: 'stop' }, () => {}, 5_000)
      await expect(waitFor(serving)).rejects.toThrow('channel cleanup failed')
      expect(events).toContainEqual({ event: 'cleanup-failed', failures: [{ stage: 'runtime', name: 'Error' }] })
      await expect(stat(directory)).rejects.toThrow()
    } finally {
      await callChannelCli(binding, { action: 'stop' }, () => {}, 1_000).catch(() => undefined)
      await waitFor(serving).catch(() => undefined)
      await rm(parent, { recursive: true, force: true })
    }
  })
})
