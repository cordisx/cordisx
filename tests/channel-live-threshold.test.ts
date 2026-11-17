import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'
import { ChannelLiveThreshold } from '../packages/cli/src/launcher/channel-live-threshold.js'

describe('Channel live threshold', () => {
  it('starts only on a fresh below-to-above sample for the owned running turn', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-threshold-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'store.json'))
      await store.mutate(state => {
        state.continuationDefaults = { revision: 1, policy: { enabled: true, thresholdRatio: 0.5 } }
        state.bindings.a = {
          id: 'a',
          sessionId: 'source',
          hostId: 'local',
          profileId: 'p',
          channel: { adapterId: 'feishu', accountId: 'a', tenantId: 't', conversationId: 'c', kind: 'group' },
          createdAt: '2026-01-01',
          fromSequence: 1,
          mode: 'deliver',
          autoReply: false,
          state: 'active',
        }
        state.jobs.j = {
          id: 'j',
          recordId: 'r',
          bindingId: 'a',
          autoCreate: false,
          state: 'running',
          sessionId: 'source',
          turnId: 'turn',
        }
      })
      const observations = new ContextObservations(() => 100)
      const cross = vi.fn(async () => {}), monitor = new ChannelLiveThreshold(store, observations, cross)
      monitor.sync()
      const epoch = observations.open('source', 1)
      const sample = (sequence: number, usedTokens: number, turnId = 'turn') => ({
        sessionId: 'source',
        sessionGeneration: 1,
        turnId,
        usedTokens,
        budget: { status: 'resolved' as const, tokens: 80_000 },
        observedAt: 100,
        expiresAt: 200,
        sequence,
        ...epoch,
      })
      observations.observe(sample(1, 39_999))
      observations.observe(sample(2, 40_000, 'other'))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).not.toHaveBeenCalled()
      observations.observe(sample(3, 39_999, 'other'))
      observations.observe(sample(4, 40_000))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).toHaveBeenCalledExactlyOnceWith({ source: 'source', sourceTurn: 'turn', sourceJob: 'j' })
      await store.mutate(state => {
        state.continuationDefaults = { revision: 2, policy: { enabled: false, thresholdRatio: 0.5 } }
      })
      monitor.sync()
      observations.observe(sample(7, 39_999))
      observations.observe(sample(8, 40_000))
      await Promise.resolve()
      expect(cross).toHaveBeenCalledTimes(1)
      monitor.dispose()
      observations.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
