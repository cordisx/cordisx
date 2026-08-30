import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1,
  type AgentDefinition as CordisXAgentDefinition,
  type AgentLoopCommand as CordisXAgentLoopCommand,
} from '../packages/cli/src/agent-loop-contracts.js'
import {
  CordisXAgentLoopBroker,
  resolveAgentDefinition,
  type CordisXAgentLoopHost,
  type CordisXResolvedAgentDefinition,
} from '../packages/cli/src/renderer/agent-loop.js'
import type { CordisXAgentLoopLifecycleEvent } from '../packages/cli/src/renderer/provider-binding.js'

const inherit: CordisXAgentDefinition['inherit'] = {
  promptSections: 'merge', rules: 'merge', skills: 'merge', tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge',
}

function definition(
  agentId: string,
  input: Partial<Omit<CordisXAgentDefinition, '$schema' | 'contract' | 'schemaVersion' | 'identity' | 'inherit'>> & { inherit?: CordisXAgentDefinition['inherit'] } = {},
): CordisXAgentDefinition {
  return {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1',
    schemaVersion: 1,
    identity: { agentId, revision: 'r1' },
    inherit,
    ...input,
  }
}

function createCommand(definitions: readonly [CordisXAgentDefinition, ...CordisXAgentDefinition[]]): Extract<CordisXAgentLoopCommand, { type: 'create-or-bind' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1,
    contract: 'cordisx.agent-loop-command/v1',
    schemaVersion: 1,
    commandId: 'create-1',
    type: 'create-or-bind',
    definition: definitions.at(-1)!.identity,
    definitions,
    target: { mode: 'create' },
  }
}

class FakeHost implements CordisXAgentLoopHost {
  readonly created: CordisXResolvedAgentDefinition[] = []
  readonly sent: unknown[] = []
  readonly lifecycleByTask = new Map<string, CordisXAgentLoopLifecycleEvent[]>()
  readonly lifecycleReads: [task: string, afterSequence: number][] = []
  lifecycleEvents: CordisXAgentLoopLifecycleEvent[] = []
  lifecycleGate: Promise<void> | undefined
  lifecycleInFlight = 0
  maxLifecycleInFlight = 0

  async prepare() { return { ok: true as const, value: { model: { providerId: 'alpha', modelId: 'model-1' }, cwd: '/workspace' } } }
  async create(value: CordisXResolvedAgentDefinition) {
    this.created.push(value)
    const sequence = this.created.length
    return { ok: true as const, value: { task: `opaque-task-${sequence}`, session: { providerId: 'alpha', remoteSessionId: `session-${sequence}` } } }
  }
  async bind(task: string) { return { ok: true as const, value: { task, session: { providerId: 'alpha', remoteSessionId: 'session-1' } } } }
  async send(task: { readonly task: string }, content: unknown) {
    this.sent.push(content)
    return { ok: true as const, value: { messageId: `message:${task.task}`, turn: `turn:${task.task}` } }
  }
  async lifecycle(task: { readonly task: string }, afterSequence: number) {
    this.lifecycleInFlight += 1
    this.maxLifecycleInFlight = Math.max(this.maxLifecycleInFlight, this.lifecycleInFlight)
    try {
      await this.lifecycleGate
      this.lifecycleReads.push([task.task, afterSequence])
      const events = (this.lifecycleByTask.get(task.task) ?? this.lifecycleEvents).filter(event => event.sequence > afterSequence)
      return { nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, events }
    } finally {
      this.lifecycleInFlight -= 1
    }
  }
}

function allowed() {
  return async (request: { capability: 'tasks.create' | 'tasks.content.read' | 'turns.submit' }) => ({ capability: request.capability, state: 'allowed' as const, code: 'allowed' as const })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Host-bound AgentLoop', () => {
  it('resolves ordered parents with merge before applying the child field policies', () => {
    const first = definition('base-a', {
      promptSections: [{ sectionId: 'intro', kind: 'introduction', text: 'Intro A' }],
      rules: ['rule-a'],
      tools: { include: ['read'] },
      runtimeDefaults: { adapterId: 'codex', effort: 'low' },
    })
    const second = definition('base-b', {
      promptSections: [
        { sectionId: 'intro', kind: 'introduction', text: 'Intro B' },
        { sectionId: 'personality', kind: 'personality', text: 'Precise' },
      ],
      rules: ['rule-b'],
      tools: { include: ['write'] },
      runtimeDefaults: { model: { providerId: 'alpha', modelId: 'model-1' } },
    })
    const leaf = definition('leaf', {
      extends: [first.identity, second.identity],
      inherit: { ...inherit, promptSections: 'append', rules: 'prepend', tools: 'replace' },
      promptSections: [{ sectionId: 'memory', kind: 'memory', text: 'Remember this' }],
      rules: ['rule-leaf'],
      tools: { include: ['shell'] },
    })
    const resolved = resolveAgentDefinition(createCommand([first, second, leaf]))
    expect(resolved.promptSections?.map(item => [item.sectionId, item.text])).toEqual([
      ['intro', 'Intro B'], ['personality', 'Precise'], ['memory', 'Remember this'],
    ])
    expect(resolved.rules).toEqual(['rule-leaf', 'rule-a', 'rule-b'])
    expect(resolved.tools).toEqual({ include: ['shell'] })
    expect(resolved.runtimeDefaults).toEqual({ adapterId: 'codex', effort: 'low', model: { providerId: 'alpha', modelId: 'model-1' } })
  })

  it('rejects unreachable catalog entries and duplicate append identities', () => {
    const base = definition('base', { promptSections: [{ sectionId: 'intro', kind: 'introduction', text: 'base' }] })
    const unused = definition('unused')
    const leaf = definition('leaf', { extends: [base.identity] })
    expect(() => resolveAgentDefinition(createCommand([base, unused, leaf]))).toThrow('unreachable')
    const duplicate = definition('duplicate', {
      extends: [base.identity], inherit: { ...inherit, promptSections: 'append' },
      promptSections: [{ sectionId: 'intro', kind: 'introduction', text: 'local' }],
    })
    expect(() => resolveAgentDefinition(createCommand([base, duplicate]))).toThrow('duplicate effective identities')
  })

  it('creates one owner-scoped identity, wakes it with text, and proactively streams assistant, approval, and lifecycle events', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    const broker = new CordisXAgentLoopBroker(host, () => new Date('2026-08-30T00:00:00.000Z'))
    const prompts: string[] = []
    const client = broker.bind({
      ownerKey: 'chatroom-plugin', active: () => true, authorize: allowed(),
      registerPrompt: (_sessionId, resolved) => {
        prompts.push(...(resolved.promptSections ?? []).map(item => item.text))
        return []
      },
    })
    const agent = definition('assistant', {
      promptSections: [
        { sectionId: 'intro', kind: 'introduction', text: 'Internal assistant' },
        { sectionId: 'personality', kind: 'personality', text: 'Concise' },
        { sectionId: 'memory', kind: 'memory', text: 'Room-neutral memory' },
      ],
    })
    const command = createCommand([agent])
    const first = await client.createOrBind(command)
    expect(first.status).toBe('accepted')
    if (first.status !== 'accepted') throw new Error('binding was not accepted')
    expect(host.created).toHaveLength(1)
    expect(prompts).toEqual(['Internal assistant', 'Concise', 'Room-neutral memory'])

    const subscription = await client.subscribe(first.binding, -1)
    if (subscription.status !== 'accepted') throw new Error('subscription was not accepted')
    const iterator = subscription.handle.pages[Symbol.asyncIterator]()
    const replay = await iterator.next()
    expect(replay.value?.events).toMatchObject([{ type: 'lifecycle', lifecycle: { phase: 'binding.created' } }])

    const send = await client.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'send-1', type: 'send', binding: first.binding, content: [{ kind: 'text', text: 'Hello' }],
    })
    expect(send.status).toBe('accepted')
    expect(host.sent).toEqual([[{ kind: 'text', text: 'Hello' }]])
    const sentPage = await iterator.next()
    expect(sentPage.value?.events).toMatchObject([
      { type: 'message' },
      { type: 'lifecycle', lifecycle: { phase: 'turn.started' } },
    ])

    host.lifecycleEvents = [
      { sequence: 1, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:opaque-task-1', type: 'approval.required', approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' } },
      { sequence: 2, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:opaque-task-1', type: 'approval.resolved', approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'approved' } },
      { sequence: 3, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:opaque-task-1', type: 'turn.completed', output: [{ type: 'text', text: 'Hi from AgentLoop' }] },
    ]
    await vi.advanceTimersByTimeAsync(250)
    const lifecycle = await iterator.next()
    expect(lifecycle.value?.events).toMatchObject([
      { type: 'approval', approval: { state: 'pending' } },
      { type: 'approval', approval: { state: 'resolved', outcome: 'approved' } },
      { type: 'message', message: { role: 'assistant', content: [{ kind: 'text', text: 'Hi from AgentLoop' }] } },
      { type: 'lifecycle', lifecycle: { phase: 'turn.completed' } },
    ])
    client.dispose()
    expect((await iterator.next()).value?.events).toMatchObject([{ type: 'lifecycle', lifecycle: { phase: 'binding.closed' } }])
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    broker.dispose()
  })

  it('concurrently manages multiple definitions, task bindings, subscriptions, and per-binding cursors', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    const broker = new CordisXAgentLoopBroker(host)
    const client = broker.bind({ ownerKey: 'chatroom-plugin', active: () => true, authorize: allowed() })
    const analystCommand = createCommand([definition('analyst')])
    const reviewerCommand = { ...createCommand([definition('reviewer')]), commandId: 'create-reviewer' }
    const [first, firstRetry, second] = await Promise.all([
      client.createOrBind(analystCommand),
      client.createOrBind(analystCommand),
      client.createOrBind(reviewerCommand),
    ])
    if (first.status !== 'accepted' || firstRetry.status !== 'accepted' || second.status !== 'accepted') throw new Error('Agent bindings were not accepted')
    expect(firstRetry.binding).toEqual(first.binding)
    expect(first.binding.binding.bindingId).not.toBe(second.binding.binding.bindingId)
    expect(first.binding.task).not.toBe(second.binding.task)
    expect(first.binding.definition).toEqual({ agentId: 'analyst', revision: 'r1' })
    expect(second.binding.definition).toEqual({ agentId: 'reviewer', revision: 'r1' })
    expect(host.created).toHaveLength(2)

    const rebound = await client.createOrBind({
      ...analystCommand,
      commandId: 'bind-analyst-task',
      target: { mode: 'bind', task: first.binding.task },
    })
    expect(rebound).toMatchObject({ status: 'accepted', binding: first.binding })

    const [firstSubscription, secondSubscription] = await Promise.all([
      client.subscribe(first.binding, -1),
      client.subscribe(second.binding, -1),
    ])
    if (firstSubscription.status !== 'accepted' || secondSubscription.status !== 'accepted') throw new Error('Agent subscriptions were not accepted')
    const firstEvents = firstSubscription.handle.pages[Symbol.asyncIterator]()
    const secondEvents = secondSubscription.handle.pages[Symbol.asyncIterator]()
    const [firstReplay, secondReplay] = await Promise.all([firstEvents.next(), secondEvents.next()])
    expect(firstReplay.value?.subscription.binding).toEqual(first.binding.binding)
    expect(secondReplay.value?.subscription.binding).toEqual(second.binding.binding)
    expect(firstReplay.value?.events.every(event => JSON.stringify(event.binding) === JSON.stringify(first.binding.binding))).toBe(true)
    expect(secondReplay.value?.events.every(event => JSON.stringify(event.binding) === JSON.stringify(second.binding.binding))).toBe(true)

    const analystSend = {
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1' as const, schemaVersion: 1 as const,
      commandId: 'send-analyst', type: 'send' as const, binding: first.binding, content: [{ kind: 'text' as const, text: 'Analyze' }] as const,
    }
    const [firstSent, firstSentRetry] = await Promise.all([
      client.send(analystSend),
      client.send(analystSend),
      client.send({
        $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
        commandId: 'send-reviewer', type: 'send', binding: second.binding, content: [{ kind: 'text', text: 'Review' }],
      }),
    ])
    expect(firstSentRetry).toEqual(firstSent)
    const collision = await client.send({ ...analystSend, binding: second.binding, content: [{ kind: 'text', text: 'Different binding and payload' }] })
    expect(collision).toMatchObject({ status: 'unavailable', authorization: { code: 'unsupported' } })
    const [firstSentPage, secondSentPage] = await Promise.all([firstEvents.next(), secondEvents.next()])
    expect(firstSentPage.value).toMatchObject({ subscription: { binding: first.binding.binding }, events: [
      { binding: first.binding.binding, type: 'message', message: { content: [{ text: 'Analyze' }] } },
      { binding: first.binding.binding, type: 'lifecycle', lifecycle: { phase: 'turn.started' } },
    ] })
    expect(secondSentPage.value).toMatchObject({ subscription: { binding: second.binding.binding }, events: [
      { binding: second.binding.binding, type: 'message', message: { content: [{ text: 'Review' }] } },
      { binding: second.binding.binding, type: 'lifecycle', lifecycle: { phase: 'turn.started' } },
    ] })
    expect(host.sent).toEqual([
      [{ kind: 'text', text: 'Analyze' }],
      [{ kind: 'text', text: 'Review' }],
    ])

    host.lifecycleByTask.set(first.binding.task, [{
      sequence: 1, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:analyst', type: 'approval.required',
      approval: { approvalId: 'approval-analyst', kind: 'command', state: 'pending' },
    }])
    host.lifecycleByTask.set(second.binding.task, [{
      sequence: 1, session: { providerId: 'alpha', remoteSessionId: 'session-2' }, turnId: 'turn:reviewer', type: 'turn.completed',
      output: [{ type: 'text', text: 'Reviewer reply' }],
    }])
    await vi.advanceTimersByTimeAsync(250)
    const analystApproval = await firstEvents.next()
    const reviewerLifecycle = await secondEvents.next()
    expect(analystApproval.value).toMatchObject({ events: [{ binding: first.binding.binding, type: 'approval', approval: { approvalId: 'approval-analyst', state: 'pending' } }] })
    expect(reviewerLifecycle.value).toMatchObject({ events: [
      { binding: second.binding.binding, type: 'message', message: { role: 'assistant', content: [{ text: 'Reviewer reply' }] } },
      { binding: second.binding.binding, type: 'lifecycle', lifecycle: { phase: 'turn.completed' } },
    ] })

    host.lifecycleByTask.set(first.binding.task, [
      ...host.lifecycleByTask.get(first.binding.task)!,
      { sequence: 2, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:analyst', type: 'approval.resolved', approval: { approvalId: 'approval-analyst', kind: 'command', state: 'resolved', outcome: 'approved' } },
    ])
    host.lifecycleByTask.set(second.binding.task, [
      ...host.lifecycleByTask.get(second.binding.task)!,
      { sequence: 2, session: { providerId: 'alpha', remoteSessionId: 'session-2' }, turnId: 'turn:reviewer-2', type: 'turn.failed', failure: { code: 'REVIEW_FAILED', retryable: true } },
    ])
    await vi.advanceTimersByTimeAsync(250)
    expect((await firstEvents.next()).value).toMatchObject({ events: [{ binding: first.binding.binding, type: 'approval', approval: { state: 'resolved', outcome: 'approved' } }] })
    expect((await secondEvents.next()).value).toMatchObject({ events: [{ binding: second.binding.binding, type: 'lifecycle', lifecycle: { phase: 'turn.failed' } }] })
    expect(host.lifecycleReads).toContainEqual([first.binding.task, 1])
    expect(host.lifecycleReads).toContainEqual([second.binding.task, 1])

    const stale = await client.subscribe({
      ...first.binding,
      binding: { ...first.binding.binding, generation: first.binding.binding.generation + 1 },
    }, -1)
    expect(stale).toMatchObject({ status: 'unavailable', authorization: { code: 'task-unavailable' } })
    client.dispose()
    expect((await firstEvents.next()).value).toMatchObject({ events: [{ binding: first.binding.binding, type: 'lifecycle', lifecycle: { phase: 'binding.closed' } }] })
    expect((await secondEvents.next()).value).toMatchObject({ events: [{ binding: second.binding.binding, type: 'lifecycle', lifecycle: { phase: 'binding.closed' } }] })
    broker.dispose()
  })

  it('bounds slow-subscriber buffering with pull pages and cleans pending consumers', async () => {
    vi.useFakeTimers()
    const host = new FakeHost()
    let releaseLifecycle!: () => void
    host.lifecycleGate = new Promise(resolve => { releaseLifecycle = resolve })
    const broker = new CordisXAgentLoopBroker(host)
    const client = broker.bind({ ownerKey: 'chatroom-plugin', active: () => true, authorize: allowed() })
    const created = await client.createOrBind(createCommand([definition('fanout-member')]))
    if (created.status !== 'accepted') throw new Error('Agent binding was not accepted')
    const subscription = await client.subscribe(created.binding, -1)
    if (subscription.status !== 'accepted') throw new Error('Agent subscription was not accepted')
    const events = subscription.handle.pages[Symbol.asyncIterator]()
    expect((await events.next()).value?.events).toHaveLength(1)

    await Promise.all(Array.from({ length: 40 }, (_, index) => client.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: `fanout-${index}`, type: 'send', binding: created.binding, content: [{ kind: 'text', text: `Message ${index}` }],
    })))
    expect(host.maxLifecycleInFlight).toBe(1)
    const first = await events.next()
    const second = await events.next()
    expect(first.value).toMatchObject({ phase: 'live', afterSequence: 0, nextAfterSequence: 64, hasMore: true })
    expect(first.value?.events).toHaveLength(64)
    expect(second.value).toMatchObject({ phase: 'live', afterSequence: 64, nextAfterSequence: 80, hasMore: false })
    expect(second.value?.events).toHaveLength(16)
    expect([...first.value!.events, ...second.value!.events].every(event => event.binding.bindingId === created.binding.binding.bindingId)).toBe(true)

    const pending = events.next()
    subscription.handle.unsubscribe()
    expect(await pending).toEqual({ value: undefined, done: true })
    client.dispose()
    releaseLifecycle()
    await Promise.resolve()
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
    broker.dispose()
  })

  it('returns explicit unsupported for image-ref when no controlled resolver exists', async () => {
    const host = new FakeHost()
    host.send = async () => ({ ok: false as const, error: { code: 'adapter-unavailable' as const, message: 'No controlled image-ref resolver' } })
    const broker = new CordisXAgentLoopBroker(host)
    const client = broker.bind({ ownerKey: 'chatroom-plugin', active: () => true, authorize: allowed() })
    const created = await client.createOrBind(createCommand([definition('assistant')]))
    if (created.status !== 'accepted') throw new Error('binding was not accepted')
    const result = await client.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'send-image', type: 'send', binding: created.binding,
      content: [{ kind: 'image-ref', ref: 'image:controlled-1', mediaType: 'image/png' }],
    })
    expect(result).toMatchObject({ status: 'unavailable', authorization: { state: 'unavailable', code: 'unsupported' } })
    broker.dispose()
  })

  it('preserves existing denied outcomes and fences bindings to their owning client', async () => {
    const host = new FakeHost()
    const broker = new CordisXAgentLoopBroker(host)
    const denied = broker.bind({
      ownerKey: 'denied-plugin', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'denied', code: 'user-denied' }),
    })
    const deniedResult = await denied.createOrBind(createCommand([definition('assistant')]))
    expect(deniedResult).toMatchObject({ status: 'denied', authorization: { code: 'user-denied' } })
    expect(host.created).toHaveLength(0)

    const owner = broker.bind({ ownerKey: 'owner-plugin', active: () => true, authorize: allowed() })
    const outsider = broker.bind({ ownerKey: 'other-plugin', active: () => true, authorize: allowed() })
    const created = await owner.createOrBind(createCommand([definition('owner-assistant')]))
    if (created.status !== 'accepted') throw new Error('binding was not accepted')
    const result = await outsider.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'cross-owner-send', type: 'send', binding: created.binding, content: [{ kind: 'text', text: 'not authorized' }],
    })
    expect(result).toMatchObject({ status: 'unavailable', authorization: { code: 'task-unavailable' } })
    expect(host.sent).toHaveLength(0)
    broker.dispose()
  })
})
