import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelConversationStore } from '../packages/cli/src/launcher/channel-conversation-store.js'
import { ChannelLiveTakeover, mayFinishChannelJob } from '../packages/cli/src/launcher/channel-live-takeover.js'

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-takeover-')), file = path.join(directory, 'store.json')
  const store = await ChannelConversationStore.open(file)
  await store.mutate(state => {
    state.continuationDefaults = { revision: 1, policy: { enabled: true, thresholdRatio: 0.5 } }
    for (const [id, status] of [['a', 'active'], ['b', 'archived']] as const) {
      state.bindings[id] = {
        id,
        sessionId: 'source',
        hostId: 'local',
        profileId: 'p',
        channel: { adapterId: 'feishu', accountId: 'a', tenantId: 't', conversationId: id, kind: 'group' },
        createdAt: '2026-01-01',
        fromSequence: 1,
        mode: 'deliver',
        autoReply: false,
        state: status,
      }
    }
    state.jobs.active = {
      id: 'active',
      recordId: 'r',
      bindingId: 'a',
      autoCreate: false,
      state: 'running',
      sessionId: 'source',
      turnId: 'turn',
    }
    state.jobs.queued = {
      id: 'queued',
      recordId: 'r2',
      bindingId: 'a',
      autoCreate: false,
      state: 'queued',
      sessionId: 'source',
    }
    state.taskSettings.source = { revision: 1, settings: {}, application: 'applied' }
  })
  let token = ''
  const native = {
    prepare: vi.fn(async (input: { token: string }) => {
      token = input.token
      return { sessionId: 'target', turnId: 'prepare' }
    }),
    turnState: vi.fn(async (): Promise<'active' | 'completed' | 'failed' | 'unknown'> => 'active'),
    interruptExact: vi.fn(async (): Promise<'interrupted' | 'already-completed' | 'uncertain'> => 'interrupted'),
    catchup: vi.fn(async () => ({ delta: 'latest bounded source activity' })),
  }
  const takeover = new ChannelLiveTakeover(store, native)
  return { directory, file, store, takeover, native, token: () => token }
}

describe('live takeover fencing', () => {
  it('waits for the exact target and atomically migrates bindings, queued jobs, and settings', async () => {
    const f = await fixture()
    try {
      const oldJob = f.store.snapshot().jobs.active!
      expect(await f.takeover.begin({ source: 'source', sourceTurn: 'turn', sourceJob: 'active' })).toBe(true)
      expect(mayFinishChannelJob(f.store.snapshot(), oldJob)).toBe(true)
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'other', token: f.token() }))
        .toBe(false)
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: 'wrong' }))
        .toBe(false)
      expect(f.native.interruptExact).not.toHaveBeenCalled()
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: f.token() }))
        .toBe(true)
      expect(f.native.interruptExact).toHaveBeenCalledExactlyOnceWith('source', 'turn')
      expect(f.native.catchup).toHaveBeenCalledExactlyOnceWith('source', 'turn')
      const state = f.store.snapshot()
      expect(Object.values(state.bindings).map(binding => binding.sessionId)).toEqual(['target', 'target'])
      expect(state.jobs.queued?.sessionId).toBe('target')
      expect(state.jobs.active).toMatchObject({
        sessionId: 'target',
        state: 'reconciliation-required',
        code: 'CONTINUATION_BUSINESS_TURN_PENDING',
      })
      expect(state.jobs.active?.turnId).toBeUndefined()
      expect(state.liveTakeovers.source?.catchup).toBe('latest bounded source activity')
      expect(state.taskSettings.target).toEqual(state.taskSettings.source)
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: f.token() }))
        .toBe(false)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
  it('fences a changed binding and never interrupts on stale target readiness', async () => {
    const f = await fixture()
    try {
      await f.takeover.begin({ source: 'source', sourceTurn: 'turn', sourceJob: 'active' })
      await f.store.mutate(state => {
        state.bindings.a!.state = 'archived'
      })
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: f.token() }))
        .toBe(false)
      expect(f.native.interruptExact).not.toHaveBeenCalled()
      expect(f.store.snapshot().bindings.b?.sessionId).toBe('source')
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
  it('leaves an uncertain interrupt fenced across restart and never repeats it', async () => {
    const f = await fixture()
    try {
      f.native.interruptExact.mockRejectedValueOnce(new Error('transport lost'))
      await f.takeover.begin({ source: 'source', sourceTurn: 'turn', sourceJob: 'active' })
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: f.token() }))
        .toBe(false)
      const reopened = await ChannelConversationStore.open(f.file)
      expect(reopened.snapshot().liveTakeovers.source?.state).toBe('unknown')
      expect(
        await new ChannelLiveTakeover(reopened, f.native).ready({
          source: 'source',
          target: 'target',
          targetTurn: 'prepare',
          token: f.token(),
        }),
      ).toBe(false)
      expect(f.native.interruptExact).toHaveBeenCalledTimes(1)
      expect(reopened.snapshot().bindings.a?.sessionId).toBe('source')
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
  it('lets an already completed source finish without launching duplicate business', async () => {
    const f = await fixture()
    try {
      await f.takeover.begin({ source: 'source', sourceTurn: 'turn', sourceJob: 'active' })
      f.native.turnState.mockResolvedValueOnce('completed')
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: f.token() }))
        .toBe(false)
      expect(f.native.interruptExact).not.toHaveBeenCalled()
      expect(f.native.catchup).toHaveBeenCalledExactlyOnceWith('source', 'turn')
      expect(f.store.snapshot().liveTakeovers.source?.state).toBe('abandoned')
      expect(mayFinishChannelJob(f.store.snapshot(), f.store.snapshot().jobs.active!)).toBe(true)
      expect(f.store.snapshot().bindings.a?.sessionId).toBe('source')
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
  it('releases the source if an exact interrupt reports it already completed', async () => {
    const f = await fixture()
    try {
      await f.takeover.begin({ source: 'source', sourceTurn: 'turn', sourceJob: 'active' })
      f.native.interruptExact.mockResolvedValueOnce('already-completed')
      expect(await f.takeover.ready({ source: 'source', target: 'target', targetTurn: 'prepare', token: f.token() }))
        .toBe(false)
      expect(f.store.snapshot().liveTakeovers.source?.state).toBe('abandoned')
      expect(mayFinishChannelJob(f.store.snapshot(), f.store.snapshot().jobs.active!)).toBe(true)
    } finally {
      await rm(f.directory, { recursive: true, force: true })
    }
  })
})
