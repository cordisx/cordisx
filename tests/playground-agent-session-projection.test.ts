import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentSetup } from '@cordisx/protocol/agents/v1'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'
import { PlaygroundAgentSessionStore } from '../packages/cli/src/playground/agent-session-store.js'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { DeterministicAgentSessionTransport } from '../packages/cli/src/renderer/deterministic-agent-session-transport.js'
import { projectPlaygroundAgentSessions } from '../packages/cli/src/renderer/playground-agent-session-projection.js'
import { HostAgentTaskDetailsNavigator } from '../packages/cli/src/renderer/host-ui/AgentTaskDetailsNavigator.js'
import { PlaygroundScenarioLabController } from '../packages/cli/src/playground/scenario-lab.js'
import {
  mergePlaygroundSimulatorTaskSnapshots,
  navigateTaskDetails,
  readPlaygroundSimulatorTaskSnapshots,
  simulatorTaskIdFromPath,
} from '../packages/cli/src/playground/client/task-details-navigation.js'

const owner = { pluginId: 'file:///fixtures/chatroom.ts:chatroom', generation: 1 } as const
const setup: AgentSetup = {
  definition: { agentId: 'chatroom.generalist', revision: 'session-projection-1' },
  definitions: [{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
    identity: { agentId: 'chatroom.generalist', revision: 'session-projection-1' },
    name: 'Chatroom Generalist',
    inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
    promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'Answer the Room.' }],
  }],
}

const reviewerSetup: AgentSetup = {
  definition: { agentId: 'chatroom.reviewer', revision: 'session-projection-1' },
  definitions: [{
    $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-definition.v1.schema.json',
    contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
    identity: { agentId: 'chatroom.reviewer', revision: 'session-projection-1' },
    name: 'Chatroom Reviewer',
    inherit: { promptSections: 'none', rules: 'none', skills: 'none', tools: 'none', mcpServers: 'none', runtimeDefaults: 'none' },
    promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: 'Review the Room.' }],
  }],
}

const message = (id: string, text: string, correlationId: string): UserMessage => ({
  id, role: 'user', content: [{ type: 'text', text }],
  source: {
    kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation,
    correlation: { namespace: 'chatroom.room-run', id: correlationId },
  },
})

const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 20))

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

describe('Playground Agent/Session native task projection', () => {
  it('projects Room facts into one recent task and its exact Simulator detail without a second ledger', async () => {
    const runtime = new CordisXAgentSessionRuntime({
      driver: new DeterministicAgentSessionTransport(), authorize: async () => true,
    })
    const created = await runtime.create(owner, { sessionId: 'cx-session.room-one.run-one', setup })
    if (created.status !== 'accepted') throw new Error('Agent/Session fixture create failed')
    expect(projectPlaygroundAgentSessions(runtime.playgroundProjection())?.tasks).toMatchObject([{
      taskRef: 'cx-session.room-one.run-one', status: 'created', events: [],
    }])
    await created.handle.agent.followup(message('cx-message.room-one.1', 'hi [tool] [approval]', 'room-one/run-one'))
    await settle()

    const authority = projectPlaygroundAgentSessions(runtime.playgroundProjection())
    const authorityOnlyStorage = new MemoryStorage()
    expect(mergePlaygroundSimulatorTaskSnapshots(authorityOnlyStorage, undefined, authority)?.tasks).toHaveLength(1)
    expect(readPlaygroundSimulatorTaskSnapshots(authorityOnlyStorage)).toBeUndefined()
    expect([...Array(authorityOnlyStorage.length).keys()].map(index => authorityOnlyStorage.getItem(authorityOnlyStorage.key(index)!)).join('\n'))
      .not.toContain('cx-session.room-one.run-one')
    const storage = new MemoryStorage()
    const {
      sessionId: _sessionId,
      sessionGeneration: _sessionGeneration,
      agentGeneration: _agentGeneration,
      agentDetail: _agentDetail,
      ...legacyBase
    } = structuredClone(authority!.tasks[0]!)
    const legacyTask = {
      ...legacyBase,
      taskRef: 'debug:agent-loop/mock/v1:legacy', origin: 'simulator' as const,
      debugTaskId: 'Legacy AgentLoop fixture',
      detailsUrl: { url: 'app://-/playground/simulator/tasks/debug%3Aagent-loop%2Fmock%2Fv1%3Alegacy', target: 'host' as const },
      events: [],
    }
    const recent = mergePlaygroundSimulatorTaskSnapshots(storage, {
      namespace: authority!.namespace, label: authority!.label, tasks: [legacyTask],
    }, authority)
    expect(recent?.tasks).toHaveLength(2)
    const sessionTask = recent?.tasks.find(task => task.taskRef === 'cx-session.room-one.run-one')
    expect(sessionTask).toMatchObject({
      taskRef: 'cx-session.room-one.run-one',
      origin: 'agent-session',
      sessionId: 'cx-session.room-one.run-one',
      sessionGeneration: 1,
      agentGeneration: 1,
      agentLabel: 'Chatroom Generalist',
      status: 'completed',
      detailsUrl: { url: 'app://-/playground/simulator/tasks/cx-session.room-one.run-one', target: 'host' },
      agentDetail: { kind: 'host', ref: 'deterministic-agent-session:cx-session.room-one.run-one' },
    })
    const events = sessionTask?.events ?? []
    expect(events.find(event => event.sessionEvent?.type === 'user/message')).toMatchObject({
      messageId: 'cx-message.room-one.1',
      sessionEvent: { data: { source: { correlation: { namespace: 'chatroom.room-run', id: 'room-one/run-one' } } } },
    })
    expect(events.find(event => event.sessionEvent?.type === 'assistant/message')).toMatchObject({
      type: 'semantic.message', detail: 'Playground Agent/Session fixture approval: unavailable',
    })
    expect(events.find(event => event.sessionEvent?.type === 'tool/call')).toMatchObject({ type: 'execution.started' })
    expect(events.find(event => event.sessionEvent?.type === 'tool/result')).toMatchObject({ type: 'semantic.message' })
    expect(events.find(event => event.sessionEvent?.type === 'approval/asked')).toMatchObject({ type: 'approval.required' })
    expect(events.find(event => event.sessionEvent?.type === 'approval/decided')).toMatchObject({ type: 'semantic.message' })
    const detailController = new PlaygroundScenarioLabController(sessionTask!)
    const trace = detailController.getSnapshot().trace
    expect(trace.find(event => (event.payload as { event?: { sessionEvent?: { type?: string } } }).event?.sessionEvent?.type === 'user/message'))
      .toMatchObject({ direction: 'chatroom-to-agent-host', summary: 'hi [tool] [approval]' })
    expect(trace.find(event => (event.payload as { event?: { sessionEvent?: { type?: string } } }).event?.sessionEvent?.type === 'assistant/message'))
      .toMatchObject({ direction: 'agent-host-to-chatroom', summary: 'Playground Agent/Session fixture approval: unavailable' })
    detailController.dispose()

    const locations: string[] = []
    const view = {
      history: {
        state: null,
        pushState: (_data: unknown, _unused: string, url?: string | URL | null) => { locations.push(String(url)) },
      },
      dispatchEvent: () => true,
    }
    expect(navigateTaskDetails(view as never, sessionTask!.detailsUrl)).toBe(true)
    expect(locations).toEqual(['/playground/simulator/tasks/cx-session.room-one.run-one'])
    expect(simulatorTaskIdFromPath(locations[0]!)).toBe('cx-session.room-one.run-one')
    const agentDetailLocations: string[] = []
    const agentDetailNavigator = new HostAgentTaskDetailsNavigator({
      navigateHost: url => { agentDetailLocations.push(url) },
      navigateExternal: () => { throw new Error('Agent/Session details must stay Host-owned') },
    })
    await agentDetailNavigator.navigateAgentDetail(sessionTask!.agentDetail!, sessionTask!.sessionId!)
    expect(agentDetailLocations).toEqual(['app://-/playground/simulator/tasks/cx-session.room-one.run-one'])
    expect(readPlaygroundSimulatorTaskSnapshots(storage)?.tasks.map(task => task.taskRef))
      .toEqual(['debug:agent-loop/mock/v1:legacy'])
    await runtime.dispose()
  })

  it('recovers replay into the same task, keeps distinct Sessions, and never duplicates resumed entries', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cordisx-agent-session-projection-'))
    try {
      const firstStore = new PlaygroundAgentSessionStore(home)
      const first = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport(), authorize: async () => true, persistence: firstStore,
      })
      const one = await first.create(owner, { sessionId: 'cx-session.room-one', setup })
      const two = await first.create(owner, { sessionId: 'cx-session.room-two', setup: reviewerSetup })
      if (one.status !== 'accepted' || two.status !== 'accepted') throw new Error('Distinct Session create failed')
      await Promise.all([
        one.handle.agent.followup(message('cx-message.one', 'one', 'room-one/run-one')),
        two.handle.agent.followup(message('cx-message.two', 'two', 'room-two/run-two')),
      ])
      await settle()
      expect(projectPlaygroundAgentSessions(first.playgroundProjection())?.tasks.map(task => task.taskRef))
        .toEqual(['cx-session.room-one', 'cx-session.room-two'])
      await first.dispose()

      const secondStore = new PlaygroundAgentSessionStore(home)
      const recovered = await secondStore.load()
      const second = new CordisXAgentSessionRuntime({
        driver: new DeterministicAgentSessionTransport(recovered), authorize: async () => true,
        persistence: secondStore, initialSessions: recovered,
      })
      const replay = projectPlaygroundAgentSessions(second.playgroundProjection())
      expect(replay?.tasks).toHaveLength(2)
      expect(replay?.tasks.map(task => [task.taskRef, task.agentLabel])).toEqual([
        ['cx-session.room-one', 'Chatroom Generalist'],
        ['cx-session.room-two', 'Chatroom Reviewer'],
      ])
      expect(second.definitionPresentation(setup.definition)).toMatchObject({ name: 'Chatroom Generalist', introduction: 'Answer the Room.' })
      expect(second.definitionPresentation(reviewerSetup.definition)).toMatchObject({ name: 'Chatroom Reviewer', introduction: 'Review the Room.' })
      expect(replay?.tasks.find(task => task.taskRef === 'cx-session.room-one')?.events
        .find(event => event.sessionEvent?.type === 'assistant/message')).toMatchObject({
        sessionEvent: { data: { message: { id: 'deterministic-assistant.cx-session.room-one.1' } } },
      })
      const resumed = await second.resume(owner, { sessionId: 'cx-session.room-one' })
      expect(resumed).toMatchObject({ status: 'accepted', sessionId: 'cx-session.room-one', disposition: 'resumed' })
      const afterResume = projectPlaygroundAgentSessions(second.playgroundProjection())
      expect(afterResume?.tasks.map(task => task.taskRef)).toEqual(['cx-session.room-one', 'cx-session.room-two'])
      expect(new Set(afterResume?.tasks.map(task => task.taskRef)).size).toBe(2)
      expect(afterResume?.tasks.find(task => task.taskRef === 'cx-session.room-one')).toMatchObject({
        agentLabel: 'Chatroom Generalist',
        agentDetail: { kind: 'host', ref: 'deterministic-agent-session:cx-session.room-one' },
      })
      await second.dispose()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
