import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { SessionEvent, UserMessage } from '@cordisx/protocol/sessions/v1'
import { PlaygroundAgentSessionStore } from '../packages/cli/src/playground/agent-session-store.js'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { DeterministicAgentSessionTransport } from '../packages/cli/src/renderer/deterministic-agent-session-transport.js'

const owner = { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 } as const
const message = (id: string, text: string): UserMessage => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: {
    kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation,
    correlation: { namespace: 'chatroom.room-run', id: 'room-7/run-3' },
  },
})
const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 10))
const identitySetup: AgentSetup = {
  definition: { agentId: 'chatroom.lead', revision: 'durable-identity-1' },
  definitions: [{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
    identity: { agentId: 'chatroom.lead', revision: 'durable-identity-1' }, name: 'Lead',
    inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
    promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'Lead the Room.' }],
  }],
}

function turnStart(sessionId: string, seq: number, turn: number): SessionEvent<'turn/start'> {
  return {
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
    contract: 'cordisx.session-event/v1', schemaVersion: 1,
    sessionId, seq, time: 10 + seq, type: 'turn/start', data: { turn },
  }
}

describe('Playground durable Agent Session store', () => {
  it('recovers from the same explicit Playground home and rejects a replaced launcher generation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-agent-session-home-'))
    const home = path.join(root, 'home')
    const configPath = path.join(root, 'cordisx.config.json')
    await writeFile(configPath, JSON.stringify({ version: 1, providers: [], plugins: [] }))
    const request = (token: string, runtimeGeneration: string, requestId: string, input: Record<string, unknown>) => JSON.stringify({
      version: 1, token, runtimeGeneration, requestId, ...input,
    })
    const tokenFrom = (source: string): string => {
      const token = /playgroundAgentSessionStoreToken: "([a-f0-9]+)"/u.exec(source)?.[1]
      if (token === undefined) throw new Error('Playground Session store token is missing')
      return token
    }
    try {
      const first = await createPlaygroundSession(configPath, { homeDir: home })
      const firstComposition = await first.buildComposition('/runtime.ts')
      const firstToken = tokenFrom(firstComposition.source)
      const persisted = {
        id: 'cx-session.same-room-run', generation: 1,
        header: { id: 'cx-session.same-room-run', formatVersion: 1, createdAt: 10, isSeeded: false },
        events: [turnStart('cx-session.same-room-run', 0, 1)],
      }
      expect(await first.handleAgentSessionStoreRequest(request(firstToken, firstComposition.generation, 'create-1', {
        operation: 'create', session: persisted,
      }))).toMatchObject({ requestId: 'create-1', value: { status: 'accepted', nextSeq: 1 } })
      expect(await first.handleAgentSessionStoreRequest(request(firstToken, firstComposition.generation, 'setup-1', {
        operation: 'update-setup', sessionId: persisted.id, sessionGeneration: 1, setup: identitySetup,
      }))).toMatchObject({ requestId: 'setup-1', value: { status: 'accepted', nextSeq: 1 } })
      expect(await first.handleAgentSessionStoreRequest(request(firstToken, firstComposition.generation, 'setup-stale', {
        operation: 'update-setup', sessionId: persisted.id, sessionGeneration: 2, setup: identitySetup,
      }))).toMatchObject({ requestId: 'setup-stale', value: { status: 'unavailable', code: 'generation-conflict' } })
      await first.close()

      const second = await createPlaygroundSession(configPath, { homeDir: home })
      const secondComposition = await second.buildComposition('/runtime.ts')
      const secondToken = tokenFrom(secondComposition.source)
      expect(await second.handleAgentSessionStoreRequest(request(secondToken, secondComposition.generation, 'load-2', { operation: 'load' })))
        .toMatchObject({ requestId: 'load-2', value: { status: 'loaded', sessions: [{
          id: 'cx-session.same-room-run', generation: 1, events: [{ seq: 0 }],
          setup: { definition: identitySetup.definition, definitions: [{ name: 'Lead' }] },
        }] } })
      expect(await second.handleAgentSessionStoreRequest(request(firstToken, firstComposition.generation, 'stale-1', { operation: 'load' })))
        .toMatchObject({ requestId: 'stale-1', value: { status: 'unavailable', code: 'generation-conflict' } })
      await second.reset()
      const resetComposition = await second.buildComposition('/runtime.ts')
      const resetToken = tokenFrom(resetComposition.source)
      expect(await second.handleAgentSessionStoreRequest(request(resetToken, resetComposition.generation, 'load-reset', { operation: 'load' })))
        .toMatchObject({ requestId: 'load-reset', value: { status: 'loaded', sessions: [] } })
      await second.close()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 30_000)

  it('recovers exact SessionEvent replay, then appends fenced live facts after a Host restart', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-agent-sessions-'))
    try {
      const firstStore = new PlaygroundAgentSessionStore(home)
      const firstRuntime = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport(), authorize: async () => true, persistence: firstStore,
      })
      const created = await firstRuntime.create(owner, { sessionId: 'cx-session.room-7-run-3' })
      if (created.status !== 'accepted') throw new Error('Playground Session create failed')
      await created.handle.agent.followup(message('room-7-message-1', 'first durable reply'))
      await settle()
      const firstSnapshot = await created.handle.agent.session.snapshot()
      if (firstSnapshot.status !== 'available') throw new Error('Playground Session snapshot failed')
      const replayThrough = firstSnapshot.snapshot.snapshotSeq
      expect(replayThrough).toBeGreaterThan(2)
      await firstRuntime.dispose()

      const secondStore = new PlaygroundAgentSessionStore(home)
      const recovered = await secondStore.load()
      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toMatchObject({ id: 'cx-session.room-7-run-3', generation: 1 })
      expect(recovered[0]?.events.find(event => event.type === 'user/message')).toMatchObject({
        data: { source: { correlation: { namespace: 'chatroom.room-run', id: 'room-7/run-3' } } },
      })

      const secondRuntime = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport(recovered), authorize: async () => true,
        persistence: secondStore, initialSessions: recovered,
      })
      const session = await secondRuntime.session(owner, 'cx-session.room-7-run-3')
      if (session === undefined) throw new Error('Recovered Session is unavailable')
      const pages: Array<{ readonly phase: string; readonly replayThrough: number; readonly seqs: readonly number[] }> = []
      const subscribed = await session.subscribe({ afterSeq: -1 }, page => {
        pages.push({ phase: page.phase, replayThrough: page.replayThrough, seqs: page.events.map(event => event.seq) })
      })
      if (subscribed.status !== 'subscribed') throw new Error('Recovered Session subscription failed')
      expect(pages[0]).toMatchObject({ phase: 'replay', replayThrough, seqs: expect.arrayContaining([0, replayThrough]) })

      const resumed = await secondRuntime.resume(owner, { sessionId: 'cx-session.room-7-run-3' })
      if (resumed.status !== 'accepted') throw new Error('Recovered Agent resume failed')
      expect(resumed).toMatchObject({ sessionId: 'cx-session.room-7-run-3', sessionGeneration: 1, disposition: 'resumed' })
      await resumed.handle.agent.followup(message('room-7-message-2', 'second durable reply'))
      await settle()
      const secondSnapshot = await session.snapshot()
      expect(secondSnapshot).toMatchObject({ status: 'available', snapshot: { sessionId: 'cx-session.room-7-run-3', sessionGeneration: 1 } })
      const live = pages.filter(page => page.phase === 'live')
      expect(live.length).toBeGreaterThan(0)
      expect(live.every(page => page.replayThrough === replayThrough && page.seqs.every(seq => seq > replayThrough))).toBe(true)
      const final = await session.read({ afterSeq: replayThrough, limit: 100 })
      if (final.status !== 'available') throw new Error('Recovered Session live read failed')
      expect(final.page.events.find(event => event.type === 'assistant/message')).toMatchObject({
        data: { turn: 2, message: { id: 'deterministic-assistant.cx-session.room-7-run-3.2' } },
      })
      await subscribed.subscription.unsubscribe()
      await secondRuntime.dispose()

      const disk = await readFile(path.join(home, 'state/playground-agent-sessions/v1/ledger.json'), 'utf8')
      expect(disk).toContain('room-7-message-2')
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('loads a v1 SessionEvent-only ledger and upgrades identity through the same Session record on resume', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-agent-session-identity-upgrade-'))
    try {
      const store = new PlaygroundAgentSessionStore(home)
      await store.create({
        id: 'cx-session.legacy-without-identity', generation: 1,
        header: { id: 'cx-session.legacy-without-identity', formatVersion: 1, createdAt: 10, isSeeded: false },
        events: [],
      })
      const legacy = await store.load()
      expect(legacy[0]).not.toHaveProperty('setup')
      const runtime = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport(legacy), authorize: async () => true,
        persistence: store, initialSessions: legacy,
      })
      expect(runtime.definitionPresentation(identitySetup.definition)).toBeUndefined()
      expect(await runtime.resume(owner, { sessionId: 'cx-session.legacy-without-identity', setup: identitySetup }))
        .toMatchObject({ status: 'accepted', sessionId: 'cx-session.legacy-without-identity' })
      await runtime.dispose()

      const upgraded = await store.load()
      expect(upgraded[0]).toMatchObject({ setup: { definition: identitySetup.definition, definitions: [{ name: 'Lead' }] } })
      const recovered = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport(upgraded), authorize: async () => true, initialSessions: upgraded,
      })
      expect(recovered.definitionPresentation(identitySetup.definition)).toMatchObject({
        name: 'Lead', introduction: 'Lead the Room.',
      })
      await recovered.dispose()
    } finally { await rm(home, { recursive: true, force: true }) }
  })

  it('atomically fences divergent cursors, Session generations, and non-JSON structured-clone values', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-agent-session-fences-'))
    try {
      const store = new PlaygroundAgentSessionStore(home)
      await store.create({
        id: 'cx-session.fences', generation: 3,
        header: { id: 'cx-session.fences', formatVersion: 1, createdAt: 10, isSeeded: false }, events: [],
      })
      await store.append({ sessionId: 'cx-session.fences', sessionGeneration: 3, expectedSeq: 0, events: [turnStart('cx-session.fences', 0, 1)] })
      await expect(store.append({ sessionId: 'cx-session.fences', sessionGeneration: 3, expectedSeq: 0, events: [turnStart('cx-session.fences', 0, 1)] })).resolves.toBeUndefined()
      await expect(store.append({ sessionId: 'cx-session.fences', sessionGeneration: 4, expectedSeq: 1, events: [turnStart('cx-session.fences', 1, 2)] })).rejects.toThrow('generation-conflict')
      await expect(store.updateSetup({ sessionId: 'cx-session.fences', sessionGeneration: 4, setup: identitySetup }))
        .rejects.toThrow('generation-conflict')

      const concurrent = await Promise.allSettled([
        store.append({ sessionId: 'cx-session.fences', sessionGeneration: 3, expectedSeq: 1, events: [turnStart('cx-session.fences', 1, 2)] }),
        store.append({ sessionId: 'cx-session.fences', sessionGeneration: 3, expectedSeq: 1, events: [turnStart('cx-session.fences', 1, 9)] }),
      ])
      expect(concurrent.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect((await store.load())[0]?.events).toHaveLength(2)

      const invalid = turnStart('cx-session.fences', 2, 3) as SessionEvent & { data: { turn: number; extra: Date } }
      Object.assign(invalid.data, { extra: new Date() })
      await expect(store.append({ sessionId: 'cx-session.fences', sessionGeneration: 3, expectedSeq: 2, events: [invalid] }))
        .rejects.toThrow('plain JSON object')
      expect((await store.load())[0]).toMatchObject({ events: [{ seq: 0 }, { seq: 1 }] })
      expect((await store.load())[0]).not.toHaveProperty('setup')
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
