import { describe, expect, it, vi } from 'vitest'
import { ChannelFeedback, createFeedbackSdkAccess } from '../packages/cli/src/launcher/channel-feedback.js'
import { channelReactionInput } from '../packages/cli/src/launcher/channel-reaction-input.js'
import { channelCliHelp } from '../packages/cli/src/cli/channel-command-help.js'
import { ChannelConversationTools } from '../packages/cli/src/launcher/channel-conversation-tools.js'

const event = {
  adapterId: 'lark',
  accountId: 'synthetic',
  tenantId: 'synthetic',
  conversationId: 'chat',
  kind: 'group' as const,
  threadId: 'thread',
  semantics: 'topic' as const,
  eventId: 'source',
  messageId: 'source',
}
describe('feedback reaction owner', () => {
  it('discovers operations, retains IDs, removes only owned, and refuses uncertain responses', async () => {
    expect(channelCliHelp('reaction')).toContain('reactionId')
    expect(channelCliHelp()).toContain('reaction')
    const create = vi.fn(async () => ({ code: 0, data: { reaction_id: 'own' } }))
    const remove = vi.fn(async () => ({ code: 0 }))
    const channel = { rawClient: { im: { v1: { messageReaction: { create, delete: remove } } } } }
    const access = createFeedbackSdkAccess(() => channel, () => true)
    expect(await access.react(event, 'OnIt')).toEqual({ reactionId: 'own', emojiType: 'OnIt' })
    await expect(access.remove({ ...event, accountId: 'other' }, 'own')).rejects.toThrow('NOT_OWNED')
    await expect(access.remove(event, 'human')).rejects.toThrow('NOT_OWNED')
    await access.remove(event, 'own')
    expect(remove).toHaveBeenCalledTimes(1)
    create.mockResolvedValue({ code: 0, data: {} } as never)
    await expect(access.react(event, 'OnIt')).rejects.toThrow('UNKNOWN')
  })
  it('a blank agent discovers help and invokes the authorized reaction seam', async () => {
    expect(channelCliHelp('reaction')).toContain('action:"add"')
    const react = vi.fn(async () => ({ reactionId: 'owned', emojiType: 'OnIt' }))
    const tools = new ChannelConversationTools(
      () => ({ feedbackReact: react, feedbackRemove: async () => ({ removed: true }) }) as never,
      {
        agentAccess: {
          hasPreparation: () => false,
          preparation: () => false,
          caller: () => ({ source: event, threadId: 'synthetic' }),
        },
        commandAllowed: () => true,
      } as never,
    )
    try {
      expect(await tools.call('reaction', { action: 'add', emojiType: 'OnIt' }, {})).toMatchObject({
        status: 'ok',
        receipt: { reactionId: 'owned' },
      })
      expect(react).toHaveBeenCalledWith(event, 'OnIt')
    } finally {
      tools.dispose()
    }
  })
  it('requires actual completed jobs and an explicit completion mapping', async () => {
    const state: any = {
      policy: { enabled: true },
      inputs: { source: { input: { source: { event } }, feedback: { reaction: { reactionId: 'processing' } } } },
      jobs: { job: { recordId: 'source', state: 'running' } },
    }
    const react = vi.fn(async () => ({ reactionId: 'completed' })), remove = vi.fn(async () => ({ removed: true }))
    let completion: string | undefined
    const feedback = new ChannelFeedback({
      store: { snapshot: () => structuredClone(state), mutate: async (run: any) => run(state) },
      access: () => ({ feedbackReact: react, feedbackRemove: remove }),
      allows: () => true,
      settings: async () => ({ reaction: { enabled: true, completionEmojiType: completion } }),
    })
    try {
      for (const status of ['running', 'failed', 'cancelled', 'reconciliation-required']) {
        state.jobs.job.state = status
        await feedback.completed('source')
      }
      state.jobs.job.state = 'completed'
      await feedback.completed('source')
      expect(react).not.toHaveBeenCalled()
      completion = 'OK'
      await feedback.completed('source')
      await feedback.completed('source')
      expect(remove).toHaveBeenCalledWith(event, 'processing')
      expect(react).toHaveBeenCalledTimes(1)
      expect(react).toHaveBeenCalledWith(event, 'OK')
    } finally {
      feedback.dispose()
    }
  })
  it('attributes add/remove with context, stable dedup and self-loop rejection', () => {
    const known = {
      target: event,
      text: 'bot answer',
      original: { content: [{ type: 'text', text: 'original' }] } as never,
    }
    const reaction = {
      messageId: 'bot-message',
      operator: { openId: 'human' },
      emojiType: 'OK',
      action: 'added' as const,
      actionTime: 1000,
    }
    const input = channelReactionInput(reaction, known, 'bot')!
    expect(JSON.stringify(input)).toContain('original')
    expect(input.source.event.actor?.userId).toBe('human')
    expect(channelReactionInput(reaction, known, 'bot')).toEqual(input)
    expect(channelReactionInput({ ...reaction, action: 'removed' }, known, 'bot')!.source.event.eventId).not.toBe(
      input.source.event.eventId,
    )
    expect(channelReactionInput({ ...reaction, operator: { openId: 'bot' } }, known, 'bot')).toBeUndefined()
    expect(channelReactionInput(reaction, undefined, 'bot')).toBeUndefined()
  })
})
