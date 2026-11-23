import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelConversationConsumer } from '../packages/cli/src/launcher/channel-conversation-consumer.js'
import { ChannelLiveTurnControl } from '../packages/cli/src/launcher/channel-live-turn-control.js'

it.each(['completed', 'failed', 'interrupted'])(
  'the actual Channel consumer updates the original message after native %s is read back',
  async status => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-stopped-consumer-'))
    const event = {
      adapterId: 'feishu',
      accountId: 'synthetic',
      tenantId: 'synthetic',
      conversationId: 'chat',
      kind: 'group' as const,
      threadId: 'chat',
      semantics: 'conversation' as const,
      eventId: 'message',
      messageId: 'message',
      actor: { adapterId: 'feishu', accountId: 'synthetic', tenantId: 'synthetic', userId: 'user' },
    }
    const message = {
      contract: 'cordisx.channel-user-input/v1' as const,
      schemaVersion: 1 as const,
      role: 'user' as const,
      source: { kind: 'channel' as const, event },
      content: [{ type: 'text' as const, text: 'synthetic' }],
      receivedAt: new Date().toISOString(),
    }
    const calls: string[] = []
    const access = {
      generation: 'synthetic',
      accounts: () => [{ ref: event, state: 'ready' }],
      conversations: async () => ({ complete: true, conversations: [] }),
      runtime: {
        inputsSince: async (_caller: unknown, _filter: unknown, cursor: string) => ({ cursor, messages: [] }),
        observeOutbound: () => () => {},
      },
      feedbackReact: async (_event: unknown, emoji: string) => {
        calls.push('add:' + emoji)
        return { reactionId: emoji, emojiType: emoji }
      },
      feedbackRemove: async (_event: unknown, id: string) => {
        calls.push('remove:' + id)
        return { reactionId: id, removed: true }
      },
    }
    let terminal = false
    const native = {
      start: async () => ({ state: 'running' as const, sessionId: 'session', turnId: 'turn' }),
      exists: async () => true,
      completion: async () => ({
        state: terminal ? status === 'completed' ? 'completed' as const : 'failed' as const : 'running' as const,
      }),
      reconcile: async () => ({ state: 'running' as const, sessionId: 'session', turnId: 'turn' }),
      liveTurnControl: () =>
        new ChannelLiveTurnControl({
          nativeRequest: async (method, params) => {
            expect(method).toBe('thread/turns/list')
            expect(params.threadId).toBe('session')
            return { data: [{ id: 'turn', status: terminal ? status : 'inProgress' }] }
          },
        }),
    }
    let consumer: Awaited<ReturnType<typeof ChannelConversationConsumer.open>> | undefined
    try {
      await writeFile(
        path.join(root, 'channel-feedback.json'),
        JSON.stringify({
          reaction: { stoppedEnabled: true, stoppedEmojiType: 'DONE' },
          wait: { enabled: false },
        }),
      )
      consumer = await ChannelConversationConsumer.open({
        file: path.join(root, 'consumer.json'),
        profileId: 'test',
        access: () => access as never,
        native: () => native as never,
      })
      await consumer.policySet({ ...consumer.policy().policy, enabled: true, groupReception: 'all' }, 0)
      await consumer.receive('record', message, true)
      await consumer.pump()
      await vi.waitFor(() => expect(calls).toContain('remove:Get'))
      expect(calls).not.toContain('add:DONE')
      terminal = true
      await consumer.pump()
      await vi.waitFor(() => expect(calls).toContain('remove:OnIt'))
      expect(calls).toEqual(['add:Get', 'add:OnIt', 'remove:Get', 'add:DONE', 'remove:OnIt'])
    } finally {
      await consumer?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
