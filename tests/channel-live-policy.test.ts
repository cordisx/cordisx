import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { livePolicyOperation } from '../packages/cli/src/launcher/channel-live-policy.js'
import { continuationDefaultsOperation } from '../packages/cli/src/launcher/channel-continuation-defaults.js'

describe('Channel live continuation policy', () => {
  it('inherits sparse defaults while keeping old window-based policy separate', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-live-policy-'))
    try {
      const file = path.join(dir, 'state.json'), store = await ChannelConversationStore.open(file)
      await store.mutate(state => {
        for (const sessionId of ['new', 'legacy']) {
          state.bindings[sessionId] = {
            id: sessionId,
            sessionId,
            hostId: 'local',
            profileId: 'p',
            channel: { adapterId: 'feishu', accountId: 'a', tenantId: 't', conversationId: sessionId, kind: 'group' },
            createdAt: '2026-01-01',
            fromSequence: 1,
            mode: 'deliver',
            autoReply: false,
            state: 'active',
          }
        }
        state.continuations.legacy = { policy: { enabled: true, threshold: 0.8, reserveTokens: 1, maxAgeMs: 1000 } }
      })
      await continuationDefaultsOperation(store, 'continuation-defaults-set', {
        expectedRevision: 0,
        policy: { enabled: true, thresholdRatio: 0.9 },
      })
      expect(await livePolicyOperation(store, 'continuation-live-policy', { sessionId: 'legacy' }))
        .toMatchObject({ legacy: true, policy: { enabled: false, thresholdRatio: 0.9 } })
      expect(
        await livePolicyOperation(store, 'continuation-live-policy-set', {
          sessionId: 'new',
          expectedRevision: 0,
          overrides: { thresholdRatio: 0.001 },
        }),
      ).toMatchObject({ policy: { enabled: true, thresholdRatio: 0.001 }, overrideRevision: 1 })
      await expect(livePolicyOperation(store, 'continuation-live-policy-set', {
        sessionId: 'new',
        expectedRevision: 0,
        overrides: {},
      })).rejects.toThrow('REVISION_CONFLICT')
      await expect(livePolicyOperation(store, 'continuation-live-policy-set', {
        sessionId: 'new',
        expectedRevision: 1,
        overrides: { thresholdRatio: 0.96 },
      })).rejects.toThrow('INVALID_CONTINUATION_POLICY')
      await livePolicyOperation(store, 'continuation-live-policy-set', {
        sessionId: 'legacy',
        expectedRevision: 0,
        overrides: {},
      })
      const reopened = await ChannelConversationStore.open(file)
      expect(await livePolicyOperation(reopened, 'continuation-live-policy', { sessionId: 'legacy' }))
        .toMatchObject({ legacy: false, policy: { enabled: true, thresholdRatio: 0.9 } })
      expect(reopened.snapshot().continuations.legacy?.policy?.threshold).toBe(0.8)
      await expect(livePolicyOperation(reopened, 'continuation-live-policy', { sessionId: 'missing' }))
        .rejects.toThrow('CHANNEL_TARGET_NOT_BOUND')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
