import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelContinuationManager } from '../packages/cli/src/launcher/channel-continuation-manager.js'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'

describe('Channel live continuation integration', () => {
  it('prepares, fences the exact source, catches up and resumes one business turn', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-live-integration-'))
    try {
      const store = await ChannelConversationStore.open(path.join(directory, 'store.json'))
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
        state.inputs.r = {
          recordId: 'r',
          input: {
            source: {
              event: {
                adapterId: 'feishu',
                accountId: 'a',
                tenantId: 't',
                conversationId: 'c',
                kind: 'group',
                eventId: 'e',
              },
            },
            content: [],
          } as never,
          mentionedBot: false,
          sequence: 1,
          persisted: true,
          accepted: true,
          routed: true,
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
      let token = '', interrupted = false, preparationCompleted = false, historyReads = 0
      const configuration = {
        providerId: 'openai',
        model: 'model',
        cwd: '/tmp',
        serviceTier: null,
        approvalsReviewer: 'user',
        sandbox: { type: 'dangerFullAccess' },
        permissionProfile: null,
        execution: { approval: 'never', workMode: 'default', effort: 'high', execution: 'full-access' },
      }
      const business = vi.fn(async () => ({ state: 'running', sessionId: 'target', turnId: 'business' }))
      const native = {
        contextObservations: () => observations,
        continuationConfiguration: async () => configuration,
        continuationHistory: async () => ({
          entries: historyReads++ === 0
            ? [{ role: 'user', text: 'goal' }, { role: 'command', text: 'working' }]
            : [{ role: 'user', text: 'goal' }, { role: 'command', text: 'finished' }, {
              role: 'assistant',
              text: 'new progress',
            }],
          clippedCharacters: 0,
          truncated: false,
        }),
        startContinuation: vi.fn(async (_id, _brief, prep, _source, options) => {
          expect(prep.sandbox).toEqual({ type: 'readOnly', networkAccess: false })
          token = options.token
          return { state: 'running', sessionId: 'target', turnId: 'prepare' }
        }),
        liveTurnControl: () => ({
          turnState: async (session: string) =>
            session === 'source' ? 'active' : preparationCompleted ? 'completed' : 'active',
          interruptExact: async (session: string, turn: string) => {
            expect([session, turn]).toEqual(['source', 'turn'])
            interrupted = true
            return 'interrupted'
          },
        }),
        startLiveBusiness: business,
      }
      const manager = new ChannelContinuationManager(store, () => native as never)
      manager.attachContext()
      const epoch = observations.open('source', 1)
      for (const [sequence, usedTokens] of [[1, 39_999], [2, 40_000]] as const) {
        observations.observe({
          sessionId: 'source',
          sessionGeneration: 1,
          turnId: 'turn',
          usedTokens,
          budget: { status: 'resolved', tokens: 80_000 },
          observedAt: 100,
          expiresAt: 200,
          sequence,
          ...epoch,
        })
      }
      for (let attempt = 0; attempt < 50 && !token; attempt++) await new Promise(resolve => setTimeout(resolve, 2))
      for (let attempt = 0; attempt < 50 && store.snapshot().liveTakeovers.source?.state !== 'ready'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2))
      }
      expect(interrupted).toBe(false)
      expect(await manager.history('target', { limit: 8 })).toMatchObject({ source: 'source' })
      expect(await manager.liveReady('target', 'prepare', token)).toEqual({ status: 'accepted' })
      expect(interrupted).toBe(true)
      expect(store.snapshot().bindings.a?.sessionId).toBe('target')
      expect(business).not.toHaveBeenCalled()
      preparationCompleted = true
      await manager.pumpLive()
      expect(business).toHaveBeenCalledTimes(1)
      expect(business.mock.calls[0]![0]).toMatchObject({
        target: 'target',
        configuration,
        delta: '[{"role":"command","text":"finished"},{"role":"assistant","text":"new progress"}]',
      })
      expect(store.snapshot().jobs.j).toMatchObject({ sessionId: 'target', turnId: 'business', state: 'running' })
      expect(await manager.history('target', { limit: 8 })).toMatchObject({ source: 'source' })
      await manager.pumpLive()
      expect(business).toHaveBeenCalledTimes(1)
      manager.dispose()
      observations.dispose()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
