import { describe, expect, it, vi } from 'vitest'
import { channelGroupGuidanceReply } from '../packages/cli/src/launcher/channel-group-guidance-reply.js'
import { parseChannelConversationPolicy } from '../packages/cli/src/launcher/channel-conversation-policy.js'

const ref = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant' }
const message = {
  contract: 'cordisx.channel-user-input/v1',
  schemaVersion: 1,
  role: 'user',
  content: [{ type: 'text', text: 'help me' }],
  source: {
    kind: 'channel',
    event: {
      ...ref,
      conversationId: 'oc_group',
      kind: 'group',
      threadId: 'oc_group',
      semantics: 'conversation',
      eventId: 'om_1',
      messageId: 'om_1',
      actor: { ...ref, userId: 'ou_user' },
    },
  },
  receivedAt: new Date().toISOString(),
}
const policy = (rules: object[]) => parseChannelConversationPolicy({ enabled: true, rules })
const denied = { id: 'deny', action: 'dispatch', effect: 'deny', userIds: ['ou_user'] }

describe('denied group request guidance', () => {
  it('sends one bounded reply only when addressed and denied task access', async () => {
    let available = true
    const reserve = vi.fn(async () => {
      if (!available) return false
      available = false
      return true
    })
    const notifyOnce = vi.fn(async () => ({ deliveryId: 'd' })), drain = vi.fn(async () => {})
    let currentPolicy = policy([denied])
    const input = {
      message: message as never,
      recordId: 'inbox:1',
      mentionedBot: true,
      consumer: {
        policy: () => ({ revision: 1, policy: currentPolicy }),
        profileLogicalOwner: () => ({ store: { snapshot: () => ({ policy: currentPolicy, inputs: {} }) } }),
      } as never,
      access: () => ({ generation: 'g', runtime: { notifyOnce }, drain }) as never,
      guidance: { reserve } as never,
    }
    await channelGroupGuidanceReply(input)
    await channelGroupGuidanceReply(input)
    expect(notifyOnce).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledOnce()
    expect(notifyOnce.mock.calls[0]?.[0].text).toContain('没有任务投递权限')
    expect(notifyOnce.mock.calls[0]?.[2]).toMatch(/^delivery:[a-f0-9]{64}$/u)
    currentPolicy = policy([])
    available = true
    await channelGroupGuidanceReply(input)
    expect(notifyOnce).toHaveBeenCalledOnce()
    await channelGroupGuidanceReply({ ...input, mentionedBot: false })
    expect(notifyOnce).toHaveBeenCalledOnce()
  })

  it('does not send after a policy revision changes while reserving', async () => {
    let revision = 0, release!: () => void
    const reserve = () =>
      new Promise<boolean>(resolve => {
        release = () => resolve(true)
      })
    const notifyOnce = vi.fn(), currentPolicy = policy([denied])
    const work = channelGroupGuidanceReply({
      message: message as never,
      recordId: 'inbox:1',
      mentionedBot: true,
      consumer: {
        policy: () => ({ revision, policy: currentPolicy }),
        profileLogicalOwner: () => ({ store: { snapshot: () => ({ policy: currentPolicy, inputs: {} }) } }),
      } as never,
      access: () => ({ generation: 'g', runtime: { notifyOnce }, drain: async () => {} }) as never,
      guidance: { reserve } as never,
    })
    revision++
    release()
    await work
    expect(notifyOnce).not.toHaveBeenCalled()
  })
  it('does not tell a whitelisted member that their new mentioned task is denied', async () => {
    const currentPolicy = policy([{ id: 'account', action: 'dispatch', effect: 'allow', userIds: ['ou_admin'] }])
    const notifyOnce = vi.fn(), reserve = vi.fn()
    await channelGroupGuidanceReply({
      message: message as never,
      recordId: 'inbox:1',
      mentionedBot: true,
      consumer: {
        policy: () => ({ revision: 1, policy: currentPolicy }),
        profileLogicalOwner: () => ({
          store: {
            snapshot: () => ({
              policy: currentPolicy,
              groupTaskAccess: [{ ...ref, conversationId: 'oc_group', fromSequence: 2 }],
              inputs: { input: { input: message, mentionedBot: true, sequence: 2 } },
            }),
          },
        }),
      } as never,
      access: () => ({ generation: 'g', runtime: { notifyOnce }, drain: async () => {} }) as never,
      guidance: { reserve } as never,
    })
    expect(reserve).not.toHaveBeenCalled()
    expect(notifyOnce).not.toHaveBeenCalled()
  })
})
