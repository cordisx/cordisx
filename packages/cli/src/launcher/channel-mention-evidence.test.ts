import { describe, expect, it } from 'vitest'
import { ChannelMentionEvidence } from './channel-mention-evidence.js'
import type { ChannelThreadRef } from '@cordisx/channel-runtime'

const target: ChannelThreadRef = {
  adapterId: 'feishu',
  accountId: 'app',
  tenantId: 'tenant',
  conversationId: 'oc_group',
  kind: 'group',
  threadId: 'oc_group',
  semantics: 'conversation',
  eventId: 'event',
}
describe('generation-local accepted sender evidence', () => {
  it('verifies only an observed exact user in the same account and conversation', async () => {
    const evidence = new ChannelMentionEvidence(target)
    await expect(evidence.verify(target, ['ou_user'])).rejects.toThrow('CHANNEL_MENTION_UNVERIFIED')
    evidence.observe(target, 'ou_user')
    await expect(evidence.verify(target, ['ou_user'])).resolves.toBeUndefined()
    for (
      const mutation of [{ adapterId: 'lark' }, { accountId: 'other' }, { tenantId: 'other' }, {
        conversationId: 'oc_other',
      }, { kind: 'direct' as const }]
    ) {
      await expect(evidence.verify({ ...target, ...mutation }, ['ou_user'])).rejects.toThrow(
        'CHANNEL_MENTION_UNVERIFIED',
      )
    }
    await expect(evidence.verify(target, ['ou_user', 'ou_forged'])).rejects.toThrow('CHANNEL_MENTION_UNVERIFIED')
    evidence.dispose()
    await expect(evidence.verify(target, ['ou_user'])).rejects.toThrow('CHANNEL_MENTION_UNVERIFIED')
    const replacement = new ChannelMentionEvidence(target)
    await expect(replacement.verify(target, ['ou_user'])).rejects.toThrow('CHANNEL_MENTION_UNVERIFIED')
  })
  it('does not accept names, broadcast IDs or another tenant observation', async () => {
    const evidence = new ChannelMentionEvidence(target)
    for (const userId of ['Name', 'all', 'ou_bad\n']) evidence.observe(target, userId)
    evidence.observe({ ...target, tenantId: 'other' }, 'ou_user')
    for (const userId of ['Name', 'all', 'ou_user']) {
      await expect(evidence.verify(target, [userId])).rejects.toThrow('CHANNEL_MENTION_UNVERIFIED')
    }
  })
  it('expires sender evidence without claiming current group membership', async () => {
    let now = 1000
    const evidence = new ChannelMentionEvidence(target, () => now)
    evidence.observe(target, 'ou_user')
    now += 299_999
    await expect(evidence.verify(target, ['ou_user'])).resolves.toBeUndefined()
    now += 1
    await expect(evidence.verify(target, ['ou_user'])).rejects.toThrow('CHANNEL_MENTION_UNVERIFIED')
  })
})
