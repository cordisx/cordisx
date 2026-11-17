import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'
import { ChannelLiveThreshold } from '../packages/cli/src/launcher/channel-live-threshold.js'

describe('Channel live threshold', () => {
  it('does not cascade a continued job on its initial above-threshold sample', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-threshold-continuation-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'store.json'))
      await store.mutate(state => {
        state.continuationDefaults = { revision: 1, policy: { enabled: true, thresholdRatio: 0.5 } }
        state.bindings.a = {
          id: 'a',
          sessionId: 'target',
          hostId: 'local',
          profileId: 'p',
          channel: { adapterId: 'test', accountId: 'a', tenantId: 't', conversationId: 'c', kind: 'group' },
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
          sessionId: 'target',
          turnId: 'turn',
          liveContinuationTarget: 'target',
        }
      })
      let now = 100
      let generation = 1
      const observations = new ContextObservations(() => now)
      let epoch = observations.open('target', 1)
      const cross = vi.fn(async () => {}), monitor = new ChannelLiveThreshold(store, observations, cross)
      monitor.sync()
      const sample = (sequence: number, usedTokens: number) => ({
        sessionId: 'target',
        sessionGeneration: generation,
        turnId: 'turn',
        usedTokens,
        budget: { status: 'resolved' as const, tokens: 100 },
        observedAt: now,
        expiresAt: now + 100,
        sequence,
        ...epoch,
      })
      observations.observe(sample(1, 50))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).not.toHaveBeenCalled()
      epoch = observations.invalidate('target', 'config')!
      observations.observe(sample(2, 50))
      await new Promise(resolve => setImmediate(resolve))
      now = 201
      observations.observe(sample(3, 50))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).not.toHaveBeenCalled()
      generation = 2
      epoch = observations.open('target', generation)
      observations.observe(sample(4, 50))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).not.toHaveBeenCalled()
      observations.observe(sample(5, 49))
      observations.observe(sample(6, 50))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).toHaveBeenCalledExactlyOnceWith({ source: 'target', sourceTurn: 'turn', sourceJob: 'j' })
      monitor.dispose()
      observations.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('evaluates a fresh above-threshold initial sample and a new configuration epoch', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-threshold-initial-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'store.json'))
      await store.mutate(state => {
        state.continuationDefaults = { revision: 1, policy: { enabled: true, thresholdRatio: 0.5 } }
        state.bindings.a = {
          id: 'a',
          sessionId: 's',
          hostId: 'local',
          profileId: 'p',
          channel: { adapterId: 'test', accountId: 'a', tenantId: 't', conversationId: 'c', kind: 'group' },
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
          sessionId: 's',
          turnId: 'turn',
        }
      })
      const observations = new ContextObservations(() => 100), epoch = observations.open('s', 1)
      const cross = vi.fn(async () => {}), monitor = new ChannelLiveThreshold(store, observations, cross)
      monitor.sync()
      const sample = (sequence: number, epochs: typeof epoch) => ({
        sessionId: 's',
        sessionGeneration: 1,
        turnId: 'turn',
        usedTokens: 50,
        budget: { status: 'resolved' as const, tokens: 100 },
        observedAt: 100,
        expiresAt: 200,
        sequence,
        ...epochs,
      })
      observations.observe(sample(1, epoch))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).toHaveBeenCalledTimes(1)
      const updated = observations.invalidate('s', 'config')!
      observations.observe(sample(2, updated))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).toHaveBeenCalledTimes(2)
      monitor.dispose()
      observations.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('continues observing a running binding after 128 idle bindings', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cx-threshold-many-'))
    try {
      const store = await ChannelConversationStore.open(path.join(dir, 'store.json'))
      await store.mutate(state => {
        state.continuationDefaults = { revision: 1, policy: { enabled: true, thresholdRatio: 0.5 } }
        for (let i = 0; i <= 128; i++) {
          const id = `binding-${i}`
          state.bindings[id] = {
            id,
            sessionId: `session-${i}`,
            hostId: 'local',
            profileId: 'p',
            channel: { adapterId: 'test', accountId: 'a', tenantId: 't', conversationId: id, kind: 'group' },
            createdAt: '2026-01-01',
            fromSequence: 1,
            mode: 'deliver',
            autoReply: false,
            state: 'active',
          }
        }
        state.jobs.j = {
          id: 'j',
          recordId: 'r',
          bindingId: 'binding-128',
          autoCreate: false,
          state: 'running',
          sessionId: 'session-128',
          turnId: 'turn',
        }
      })
      const observations = new ContextObservations(() => 100)
      for (let i = 0; i <= 128; i++) observations.open(`session-${i}`, 1)
      const cross = vi.fn(async () => {}), monitor = new ChannelLiveThreshold(store, observations, cross)
      monitor.sync()
      const epoch = observations.open('session-128', 1)
      const sample = (sequence: number, usedTokens: number, turnId: string) => ({
        sessionId: 'session-128',
        sessionGeneration: 1,
        turnId,
        usedTokens,
        budget: { status: 'resolved' as const, tokens: 100 },
        observedAt: 100,
        expiresAt: 200,
        sequence,
        ...epoch,
      })
      observations.observe(sample(1, 49, 'previous-turn'))
      observations.observe(sample(2, 50, 'turn'))
      await new Promise(resolve => setImmediate(resolve))
      expect(cross).toHaveBeenCalledExactlyOnceWith({ source: 'session-128', sourceTurn: 'turn', sourceJob: 'j' })
      monitor.dispose()
      observations.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

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
