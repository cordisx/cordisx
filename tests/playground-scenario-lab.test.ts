import { describe, expect, it, vi } from 'vitest'
import {
  createPlaygroundScenarioLabRuntime,
  PLAYGROUND_SCENARIO_CATALOG,
  PlaygroundScenarioLabController,
  type PlaygroundScenarioLabRuntime,
} from '../packages/cli/src/playground/scenario-lab.js'
import type { BoundAgentLoopClientV4 } from '../packages/cli/src/agent-loop-contracts.js'

const immediate = async () => {}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function delayedRuntime(
  operation: 'create' | 'send',
  entered: () => void,
  release: Promise<void>,
  position: 'before' | 'after' = 'after',
): PlaygroundScenarioLabRuntime {
  const runtime = createPlaygroundScenarioLabRuntime()
  const delayed = async <Value>(execute: () => Promise<Value>): Promise<Value> => {
    entered()
    if (position === 'before') await release
    const result = await execute()
    if (position === 'after') await release
    return result
  }
  const client: BoundAgentLoopClientV4 = Object.freeze({
    ...runtime.client,
    createOrBind: command =>
      operation === 'create'
        ? delayed(() => runtime.client.createOrBind(command))
        : runtime.client.createOrBind(command),
    send: command =>
      operation === 'send'
        ? delayed(() => runtime.client.send(command))
        : runtime.client.send(command),
  })
  return Object.freeze({ ...runtime, client })
}

describe('Playground Scenario Lab Phase 1', () => {
  it('runs four same-binding sends once in deterministic order and resets to an owner-isolated empty state', async () => {
    const controller = new PlaygroundScenarioLabController(immediate)
    await controller.run()
    const completed = controller.getSnapshot()
    expect(completed).toMatchObject({
      owner: 'host-playground-scenario-lab',
      phase: 'completed',
      cursor: 2,
      stepCount: 2,
    })
    expect(completed.tasks).toHaveLength(1)
    expect(completed.conversation.selection).toMatchObject({ kind: 'room', roomId: 'scenario-continuous-sends' })
    expect(completed.conversation.entries).toHaveLength(8)
    expect(completed.conversation.entries.slice(0, 4).map(entry => entry.kind === 'message' ? entry.authorId : ''))
      .toEqual([
        'scenario-human',
        'scenario-human',
        'scenario-human',
        'scenario-human',
      ])
    expect(completed.conversation.entries.slice(4).map(entry => entry.kind === 'message' ? entry.authorId : ''))
      .toEqual([
        'scenario-agent-a',
        'scenario-agent-a',
        'scenario-agent-a',
        'scenario-agent-a',
      ])
    expect(
      completed.conversation.entries.filter(entry => entry.kind === 'message' && entry.authorId === 'scenario-human')
        .every(entry => entry.kind === 'message' && entry.reactions?.[0]?.state === 'completed'),
    ).toBe(true)
    expect(completed.tasks[0]?.events.filter(event => event.type === 'input.accepted')).toHaveLength(4)
    expect(
      completed.activities.filter(activity => activity.message.startsWith('send a/')).map(activity => activity.message),
    ).toEqual([
      'send a/1: executed',
      'send a/2: executed',
      'send a/3: executed',
      'send a/4: executed',
    ])

    controller.reset()
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'idle',
      cursor: 0,
      activities: [],
      tasks: [],
      conversation: { entries: [], selection: { kind: 'room' } },
    })
    await controller.run()
    expect(controller.getSnapshot().activities.filter(activity => activity.message === 'create a: executed'))
      .toHaveLength(1)
    controller.dispose()
  })

  it('creates three exact independent bindings and sends distinct operations concurrently', async () => {
    const controller = new PlaygroundScenarioLabController(immediate)
    controller.select('multi-binding')
    await controller.run()
    const snapshot = controller.getSnapshot()
    expect(snapshot.phase).toBe('completed')
    expect(snapshot.tasks.map(task => task.identity.agentId)).toEqual([
      'playground.scenario.a',
      'playground.scenario.b',
      'playground.scenario.c',
    ])
    expect(snapshot.tasks.map(task => task.input)).toEqual([
      'Independent input for Agent A.',
      'Independent input for Agent B.',
      'Independent input for Agent C.',
    ])
    expect(snapshot.conversation.selection).toMatchObject({
      kind: 'room',
      activeRuns: [
        { participantId: 'scenario-agent-a', memberId: 'scenario-member-a', runId: 'scenario-run-a' },
        { participantId: 'scenario-agent-b', memberId: 'scenario-member-b', runId: 'scenario-run-b' },
        { participantId: 'scenario-agent-c', memberId: 'scenario-member-c', runId: 'scenario-run-c' },
      ],
    })
    expect(
      snapshot.conversation.entries.filter(entry => entry.kind === 'message').map(entry =>
        entry.kind === 'message' ? entry.authorId : ''
      ),
    ).toEqual([
      'scenario-human',
      'scenario-human',
      'scenario-human',
      'scenario-agent-a',
      'scenario-agent-b',
      'scenario-agent-c',
    ])
    expect(snapshot.activities.filter(activity => activity.message.startsWith('send '))).toHaveLength(3)
    controller.dispose()
  })

  it('uses human messages as exact grouping boundaries for the same Agent', async () => {
    const controller = new PlaygroundScenarioLabController(immediate)
    controller.select('human-interruption')
    await controller.run()
    expect(
      controller.getSnapshot().conversation.entries.map(entry =>
        entry.kind === 'message' ? entry.authorId : entry.kind
      ),
    ).toEqual([
      'scenario-human',
      'scenario-agent-a',
      'scenario-human',
      'scenario-agent-a',
    ])
    controller.dispose()
  })

  it('pauses between deterministic steps and resumes one exact step with Next', async () => {
    let releaseDelay: (() => void) | undefined
    const controller = new PlaygroundScenarioLabController(() =>
      new Promise(resolve => {
        releaseDelay = resolve
      })
    )
    const running = controller.run()
    await vi.waitFor(() => expect(controller.getSnapshot().cursor).toBe(1))
    controller.pause()
    releaseDelay?.()
    await running
    expect(controller.getSnapshot()).toMatchObject({ phase: 'paused', cursor: 1, stepCount: 2 })

    await controller.next()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'completed', cursor: 2 })
    expect(controller.getSnapshot().tasks[0]?.events.filter(event => event.type === 'input.accepted')).toHaveLength(4)
    controller.dispose()
  })

  it('exposes typed failure then a fresh retry and formal v4 approval decisions', async () => {
    const controller = new PlaygroundScenarioLabController(immediate)
    controller.select('failure-retry')
    await controller.next()
    await controller.next()
    expect(controller.getSnapshot().tasks[0]?.status).toBe('error')
    expect(controller.getSnapshot().conversation.entries.at(-1)).toMatchObject({
      kind: 'message',
      authorId: 'scenario-agent-a',
      deliveryState: 'delivered',
      runState: 'failed',
    })
    await controller.next()
    expect(controller.getSnapshot().tasks[0]).toMatchObject({
      status: 'completed',
      input: 'Retry with a fresh logical operation.',
    })
    expect(controller.getSnapshot().conversation.entries.at(-1)).toMatchObject({
      kind: 'message',
      authorId: 'scenario-agent-a',
      runState: 'idle',
    })

    controller.select('approval-decision')
    await controller.run()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'completed', cursor: 3, stepCount: 3 })
    expect(
      controller.getSnapshot().activities.filter(activity => activity.message.startsWith('approval a/')).map(activity =>
        activity.message
      ),
    ).toEqual([
      'approval a/1: approved/executed',
      'approval a/2: denied/executed',
      'approval a/3: cancelled/executed',
    ])
    expect(
      controller.getSnapshot().conversation.entries.filter(entry => entry.kind === 'approval').map(entry =>
        entry.kind === 'approval' ? entry.state : ''
      ),
    ).toEqual([
      'approved',
      'denied',
      'cancelled',
    ])
    expect(PLAYGROUND_SCENARIO_CATALOG.find(item => item.id === 'approval-decision')?.availability).toMatchObject({
      state: 'available',
    })
    expect(
      controller.getSnapshot().activities.every(activity =>
        activity.kind === 'operation' || activity.kind === 'result'
      ),
    ).toBe(true)
    controller.dispose()
  })

  it('preserves long multiline code and links through the text-only public command path', async () => {
    const controller = new PlaygroundScenarioLabController(immediate)
    controller.select('plain-text-stress')
    await controller.run()
    const input = controller.getSnapshot().tasks[0]?.input ?? ''
    expect(input.length).toBeGreaterThan(500)
    expect(input).toContain('```ts')
    expect(input).toContain('https://example.com/scenario?mode=deterministic')
    expect(
      controller.getSnapshot().conversation.entries.some(entry =>
        entry.kind === 'message'
        && entry.authorId === 'scenario-human'
        && entry.body.join('\n').includes('```ts')
      ),
    ).toBe(true)
    controller.dispose()
  })

  it('fences a create completion that arrives after reset from the replacement state', async () => {
    const gate = deferred()
    const entered = deferred()
    let runtimes = 0
    const controller = new PlaygroundScenarioLabController(immediate, () => {
      runtimes += 1
      return runtimes === 1
        ? delayedRuntime('create', entered.resolve, gate.promise)
        : createPlaygroundScenarioLabRuntime()
    })
    const running = controller.run()
    await entered.promise
    controller.reset()
    gate.resolve()
    await running
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', cursor: 0, activities: [], tasks: [] })
    controller.dispose()
  })

  it('fences a send completion that arrives after reset from the replacement state', async () => {
    const gate = deferred()
    const entered = deferred()
    let runtimes = 0
    const controller = new PlaygroundScenarioLabController(immediate, () => {
      runtimes += 1
      return runtimes === 1
        ? delayedRuntime('send', entered.resolve, gate.promise)
        : createPlaygroundScenarioLabRuntime()
    })
    await controller.next()
    const sending = controller.next()
    await entered.promise
    controller.reset()
    gate.resolve()
    await sending
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', cursor: 0, activities: [], tasks: [] })
    controller.dispose()
  })

  it('fences an old run after selecting a replacement scenario', async () => {
    const gate = deferred()
    const entered = deferred()
    let runtimes = 0
    const controller = new PlaygroundScenarioLabController(immediate, () => {
      runtimes += 1
      return runtimes === 1
        ? delayedRuntime('create', entered.resolve, gate.promise)
        : createPlaygroundScenarioLabRuntime()
    })
    const running = controller.run()
    await entered.promise
    controller.select('multi-binding')
    gate.resolve()
    await running
    expect(controller.getSnapshot()).toMatchObject({
      selectedScenarioId: 'multi-binding',
      phase: 'idle',
      cursor: 0,
      activities: [],
      tasks: [],
    })
    controller.dispose()
  })

  it('does not publish a late completion after disposal', async () => {
    const gate = deferred()
    const entered = deferred()
    const controller = new PlaygroundScenarioLabController(
      immediate,
      () => delayedRuntime('create', entered.resolve, gate.promise, 'before'),
    )
    let publications = 0
    controller.subscribe(() => {
      publications += 1
    })
    const running = controller.run()
    await entered.promise
    const beforeDispose = publications
    controller.dispose()
    gate.resolve()
    await running
    expect(publications).toBe(beforeDispose)
    expect(controller.getSnapshot()).toMatchObject({ cursor: 0, tasks: [] })
  })

  it('keeps the entry developer-only and outside product navigation and Recent tasks', async () => {
    const [{ readFile }, path] = await Promise.all([import('node:fs/promises'), import('node:path')])
    const [app, component, controllerSource, backend] = await Promise.all([
      readFile(path.resolve('packages/cli/src/playground/client/App.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/client/components/ScenarioLabPage.tsx'), 'utf8'),
      readFile(path.resolve('packages/cli/src/playground/scenario-lab.ts'), 'utf8'),
      readFile(path.resolve('packages/cli/src/renderer/playground-mock-agent-loop.ts'), 'utf8'),
    ])
    expect(app).toContain("id: 'scenario-lab'")
    expect(app.indexOf("id: 'scenario-lab'")).toBeGreaterThan(app.indexOf("id: 'developer-heading'"))
    expect(app.indexOf("id: 'scenario-lab'")).toBeLessThan(app.indexOf("id: 'runtime-separator'"))
    expect(app).not.toContain('<SidebarItem id="scenario-lab"')
    expect(component).toContain('data-playground-scenario-workbench')
    expect(component).toContain('data-source-task-id')
    expect(component).toContain('className="pg-event-timeline"')
    expect(component).toContain('className="pg-event-composer"')
    expect(component).toContain('data-event-details-drawer="true"')
    expect(component).toContain('Raw event details')
    expect(component).toContain("en ? 'Permission decision' : '权限决定'")
    expect(component).not.toContain('<AgentConversationRenderer')
    expect(controllerSource).not.toMatch(/registerCollection|registerSource|recentTasks|ChatroomRoomRegistry/u)
    expect(backend).not.toMatch(/\b(lead|reviewer|recipient-selection|room-timeline)\b/iu)
  })
})
