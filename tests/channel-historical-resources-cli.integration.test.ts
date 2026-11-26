import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ChannelEventRef } from '@cordisx/channel-runtime'
import { ensureHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runConfiguredChannelCommand } from '../packages/cli/src/cli/channel-configured-command.js'
import { configuredChannelManagementToolHandler } from '../packages/cli/src/cli/channel-consumer-composition.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'
import type { ChannelConversationAccess } from '../packages/cli/src/launcher/channel-conversation-access.js'
import { CHANNEL_CONVERSATION_POLICY_INITIAL } from '../packages/cli/src/launcher/channel-conversation-policy.js'
import { ChannelHistoricalResources } from '../packages/cli/src/launcher/channel-historical-resources.js'
import { channelMessageRead } from '../packages/cli/src/launcher/channel-message-read.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'

describe('configured CLI historical resource consumption', () => {
  it('uses the real configured endpoint/parser/dispatcher to prepare and decode scoped media bytes', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'channel-resource-cli-'))
    const configPath = path.join(home, 'config.json')
    const account = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
    const source: ChannelEventRef = {
      ...account,
      conversationId: 'oc_fixture',
      kind: 'group',
      threadId: 'om_media',
      semantics: 'reply-chain',
      eventId: 'incoming',
      messageId: 'om_incoming',
      actor: { ...account, userId: 'ou_fixture' },
    }
    const context = 'a'.repeat(48)
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cBZkAAAAASUVORK5CYII=',
      'base64',
    )
    const download = vi.fn(async () => ({ getReadableStream: () => Readable.from([bytes]) }))
    const get = vi.fn(async ({ path: request }: { path: { message_id: string } }) => ({
      code: 0,
      data: {
        items: [{
          chat_id: source.conversationId,
          message_id: request.message_id,
          ...(request.message_id === source.messageId ? { parent_id: 'om_media' } : {}),
          msg_type: request.message_id === 'om_media' ? 'image' : 'text',
          body: { content: request.message_id === 'om_media' ? '{"image_key":"verified_key"}' : '{"text":"source"}' },
        }],
      },
    }))
    const sdk = { rawClient: { im: { v1: { message: { get }, messageResource: { get: download } } } } } as never
    const resources = new ChannelHistoricalResources()
    const access = {
      generation: 'fixture-generation',
      accounts: () => [{ ref: account, state: 'ready' }],
      readMessage: (event, messageId) => channelMessageRead(event, messageId, sdk),
      historicalResource: (event, messageId, index, prepare, caller, authorize, range, signal) =>
        resources.read(event, messageId, index, prepare, caller, sdk, authorize, range, signal),
    } as ChannelConversationAccess
    const consumer = {
      taskSettings: { isBound: () => true },
      agentAccess: {
        hasPreparation: () => false,
        preparation: () => false,
        caller: (metadata: Record<string, unknown>) =>
          metadata['cordisx/channelContext'] === context
            && metadata['openai/threadId'] === 'fixture-session'
            ? { source, threadId: 'fixture-session', turnId: 'fixture-turn' }
            : undefined,
      },
      commandAllowed: () => true,
      policy: () => ({
        policy: {
          ...CHANNEL_CONVERSATION_POLICY_INITIAL,
          enabled: true,
          rules: [{
            id: 'explicit-resource',
            action: 'command',
            effect: 'allow',
            commands: ['resource-read'],
            userIds: ['ou_fixture'],
          }],
        },
      }),
    } as never
    const tools = new ChannelConversationTools(() => access, consumer)
    const handler = configuredChannelManagementToolHandler(tools)
    await ensureHomeConfig(configPath)
    const identity = await processStartIdentity(process.pid)
    const server = await startPluginManagementRpcServer({
      homeDir: home,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'fixture-launch',
      processStartedAt: identity!,
      service: {} as never,
      channel: handler.channel!,
    })
    const input = { account, conversationId: source.conversationId, kind: source.kind, messageId: 'om_media', index: 0 }
    const command = async (operation: string, request: unknown) => {
      const output: string[] = []
      await runConfiguredChannelCommand([
        operation,
        '--profile',
        'default',
        '--context',
        context,
        '--input',
        JSON.stringify(request),
      ], line => output.push(line))
      return JSON.parse(output[0]!)
    }
    vi.stubEnv('CORDISX_HOME', home)
    vi.stubEnv('CODEX_THREAD_ID', 'fixture-session')
    try {
      expect(await command('resource-status', input)).toMatchObject({ resource: { state: 'not-prepared' } })
      expect(download).not.toHaveBeenCalled()
      const prepared = await command('resource-refetch', input)
      expect(prepared).toMatchObject({
        resource: { state: 'ready', attachment: { mediaType: 'image/png', size: bytes.length } },
      })
      const chunks: Buffer[] = []
      let offset = 0
      while (offset < bytes.length) {
        const result = await command('resource-read', { ...input, offset, length: 16 })
        const chunk = Buffer.from(result.chunk.base64, 'base64')
        chunks.push(chunk)
        expect(result.chunk.nextOffset).toBe(offset + chunk.length)
        expect(result.chunk.hasMore).toBe(result.chunk.nextOffset < bytes.length)
        expect(JSON.stringify(result)).not.toContain(home)
        expect(JSON.stringify(result)).not.toContain('verified_key')
        offset = result.chunk.nextOffset
      }
      expect(Buffer.concat(chunks)).toEqual(bytes)
      expect(download).toHaveBeenCalledTimes(1)
      await expect(command('resource-read', { ...input, fileKey: 'unverified', offset: 0, length: 16 }))
        .rejects.toThrow('CHANNEL_OPERATION_REJECTED')
      expect(download).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
      tools.dispose()
      await server.close()
      await resources.dispose()
      await rm(home, { recursive: true, force: true })
    }
  })
})
