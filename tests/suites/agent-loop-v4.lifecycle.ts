import { expect, it } from 'vitest'
import { type AgentLoopV4Transport, CordisXAgentLoopBrokerV4 } from '../../packages/cli/src/renderer/agent-loop-v4.js'
import {
  PlaygroundMockAgentLoopHost,
  PlaygroundMockAgentLoopV4Transport,
  type PlaygroundMockCliExecutor,
} from '../../packages/cli/src/renderer/playground-mock-agent-loop.js'
import { base, definition, options } from './agent-loop-v4.fixtures.js'
import { readOwnedSourceGraph } from '../source-module-graph.js'

export function registerLifecycleTests() {
  it('emits retryable introduction failure and permits a new operation to retry the exact member run', async () => {
    let attempts = 0
    let hostState: string | undefined
    let transportState: string | undefined
    const hostPersistence = {
      read: () => hostState,
      write: (value: string) => {
        hostState = value
      },
    }
    const transportPersistence = {
      read: () => transportState,
      write: (value: string) => {
        transportState = value
      },
    }
    const executor: PlaygroundMockCliExecutor = {
      execute: async invocation => {
        if (invocation.operation !== 'introduce-member') return { status: 'ok', stdout: 'Completed successfully.' }
        attempts += 1
        return attempts === 1
          ? { status: 'error', error: { code: 'SIMULATED_CLI_FAILURE', message: 'Retryable introduction failure.' } }
          : { status: 'ok', stdout: 'I’m ready to help the room move forward.' }
      },
    }
    const host = new PlaygroundMockAgentLoopHost(executor, hostPersistence)
    const broker = new CordisXAgentLoopBrokerV4(
      new PlaygroundMockAgentLoopV4Transport(host, transportPersistence),
      host,
      'playground',
      'retry-introduction',
    )
    const client = broker.bind(options())
    const created = await client.createOrBind({
      ...base('create-retry-introduction'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    const request = (commandId: string) => ({
      ...base(commandId),
      type: 'request-member-self-introduction' as const,
      binding: created.binding,
      participantId: 'participant-1',
      memberId: 'member-1',
      runId: 'run-1',
      intent: {
        kind: 'member-self-introduction' as const,
        audience: 'room' as const,
        output: 'assistant-message' as const,
      },
    })
    expect(await client.requestMemberSelfIntroduction(request('intro-fails'))).toMatchObject({ status: 'accepted' })
    await new Promise(resolve => setTimeout(resolve, 10))
    client.dispose()
    broker.dispose()

    const restoredHost = new PlaygroundMockAgentLoopHost(executor, hostPersistence)
    const restoredBroker = new CordisXAgentLoopBrokerV4(
      new PlaygroundMockAgentLoopV4Transport(restoredHost, transportPersistence),
      restoredHost,
      'playground',
      'retry-introduction-reloaded',
    )
    const restoredClient = restoredBroker.bind(options())
    const rebound = await restoredClient.createOrBind({
      ...base('bind-after-introduction-failure'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'bind', task: created.binding.task },
    })
    if (rebound.status !== 'accepted') throw new Error('bind after reload failed')
    const failedSubscription = await restoredClient.subscribe(rebound.binding, 0)
    if (failedSubscription.status !== 'accepted') throw new Error('failed introduction subscription failed')
    const failedPage = await failedSubscription.handle.pages[Symbol.asyncIterator]().next()
    expect(failedPage.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'lifecycle',
        causation: { operationId: 'intro-fails' },
        lifecycle: { phase: 'turn.started' },
      }),
      expect.objectContaining({
        type: 'lifecycle',
        causation: { operationId: 'intro-fails' },
        lifecycle: { phase: 'turn.failed', failure: { code: 'SIMULATED_CLI_FAILURE', retryable: true } },
      }),
    ]))
    failedSubscription.handle.unsubscribe()
    expect(
      await restoredClient.cancelMemberSelfIntroduction({
        ...base('cancel-failed-introduction'),
        type: 'cancel-member-self-introduction',
        binding: rebound.binding,
        participantId: 'participant-1',
        memberId: 'member-1',
        runId: 'run-1',
        requestOperationId: 'intro-fails',
      }),
    ).toMatchObject({ status: 'conflict', code: 'introduction-conflict' })
    expect(
      await restoredClient.requestMemberSelfIntroduction({ ...request('intro-retries'), binding: rebound.binding }),
    ).toMatchObject({ status: 'accepted' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempts).toBe(2)
    const subscribed = await restoredClient.subscribe(rebound.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'lifecycle',
        causation: { operationId: 'intro-fails' },
        lifecycle: { phase: 'turn.failed', failure: { code: 'SIMULATED_CLI_FAILURE', retryable: true } },
      }),
      expect.objectContaining({
        type: 'message',
        causation: { operationId: 'intro-retries' },
        message: expect.objectContaining({ purpose: 'member-self-introduction' }),
      }),
    ]))
    expect(page.value?.events.some(event => event.type === 'lifecycle' && event.lifecycle.phase === 'turn.cancelled'))
      .toBe(false)
    subscribed.handle.unsubscribe()
    restoredClient.dispose()
    restoredBroker.dispose()
  })

  it('emits an exact cancelled lifecycle without a late assistant completion and replays cancel idempotently', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const transport = new PlaygroundMockAgentLoopV4Transport(host)
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'owner',
      active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const created = await client.createOrBind({
      ...base('create-cancel'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    const request = {
      ...base('intro-cancel'),
      type: 'request-member-self-introduction' as const,
      binding: created.binding,
      participantId: 'participant-1',
      memberId: 'member-1',
      runId: 'run-1',
      intent: {
        kind: 'member-self-introduction' as const,
        audience: 'room' as const,
        output: 'assistant-message' as const,
      },
    }
    const requested = await client.requestMemberSelfIntroduction(request)
    if (requested.status !== 'accepted') throw new Error('introduction failed')
    const cancel = {
      ...base('cancel-intro'),
      type: 'cancel-member-self-introduction' as const,
      binding: created.binding,
      participantId: 'participant-1',
      memberId: 'member-1',
      runId: 'run-1',
      requestOperationId: request.commandId,
    }
    expect(await client.cancelMemberSelfIntroduction(cancel)).toMatchObject({
      status: 'accepted',
      delivery: { disposition: 'executed' },
    })
    expect(await client.cancelMemberSelfIntroduction(cancel)).toMatchObject({
      status: 'accepted',
      delivery: { disposition: 'replayed' },
    })
    expect(await client.cancelMemberSelfIntroduction({ ...cancel, commandId: 'cancel-intro-again' })).toMatchObject({
      status: 'conflict',
      code: 'introduction-cancelled',
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const subscribed = await client.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'lifecycle',
      causation: { operationId: 'cancel-intro' },
      lifecycle: { phase: 'turn.cancelled' },
    })]))
    expect(page.value?.events.some(event => event.type === 'message' && event.turn === requested.turn)).toBe(false)
    subscribed.handle.unsubscribe()

    const lateTransport = Object.create(transport) as AgentLoopV4Transport
    lateTransport.readAgentLoopV4Lifecycle = async () => ({
      status: 'accepted',
      nextAfterSequence: 1,
      events: [{
        eventId: 'late-cancelled-output',
        sequence: 1,
        turnId: requested.turn,
        type: 'turn.completed',
        output: [{ type: 'text', text: 'This late provider output must stay hidden.' }],
        cancellation: { operationId: 'cancel-intro' },
      }],
    })
    const lateBroker = new CordisXAgentLoopBrokerV4(lateTransport, host, 'playground', 'composition-1')
    const lateClient = lateBroker.bind({
      ownerKey: 'owner',
      active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const lateSubscription = await lateClient.subscribe(created.binding, 0)
    if (lateSubscription.status !== 'accepted') throw new Error('late subscription failed')
    const latePage = await lateSubscription.handle.pages[Symbol.asyncIterator]().next()
    expect(latePage.value?.events).toEqual([expect.objectContaining({
      type: 'lifecycle',
      causation: { operationId: 'cancel-intro' },
      lifecycle: { phase: 'turn.cancelled' },
    })])
    lateSubscription.handle.unsubscribe()
    lateClient.dispose()
    lateBroker.dispose()
  })

  it('generates definition-sensitive natural introductions and records only redacted semantic association fields', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const broker = new CordisXAgentLoopBrokerV4(
      new PlaygroundMockAgentLoopV4Transport(host),
      host,
      'playground',
      'composition-1',
    )
    const client = broker.bind({
      ownerKey: 'owner',
      active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const make = (agentId: string, name: string, text: string) => ({
      ...definition,
      identity: { agentId, revision: 'revision-1' },
      name,
      promptSections: [{ sectionId: 'intro', kind: 'introduction' as const, text }],
    })
    const messages: string[] = []
    for (
      const [index, configured] of [
        make('lead', 'Lead', 'Coordinate the work carefully.'),
        make('reviewer', 'Reviewer', 'Challenge assumptions and review quality.'),
      ].entries()
    ) {
      const created = await client.createOrBind({
        ...base(`create-natural-${index}`),
        type: 'create-or-bind',
        definition: configured.identity,
        definitions: [configured],
        target: { mode: 'create' },
      })
      if (created.status !== 'accepted') throw new Error('create failed')
      const request = {
        ...base(`intro-natural-${index}`),
        type: 'request-member-self-introduction' as const,
        binding: created.binding,
        participantId: `participant-${index}`,
        memberId: `member-${index}`,
        runId: `run-${index}`,
        intent: {
          kind: 'member-self-introduction' as const,
          audience: 'room' as const,
          output: 'assistant-message' as const,
        },
      }
      const requested = await client.requestMemberSelfIntroduction(request)
      expect(requested.status).toBe('accepted')
      if (requested.status !== 'accepted') throw new Error('introduction failed')
      await new Promise(resolve => setTimeout(resolve, 10))
      const subscribed = await client.subscribe(created.binding, 0)
      if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
      const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
      const message = page.value?.events.find(event => event.type === 'message')
      if (message?.type !== 'message' || message.message.content[0]?.kind !== 'text') throw new Error('message missing')
      expect(message.message.messageId).toBe(requested.messageId)
      messages.push(message.message.content[0].text)
      subscribed.handle.unsubscribe()
    }
    expect(messages[0]).not.toBe(messages[1])
    expect(messages.join('\n')).not.toMatch(/Mock|Simulator/iu)
    expect(messages).not.toContain('Coordinate the work carefully.')
    expect(messages).not.toContain('Challenge assumptions and review quality.')
    const semantic = host.snapshot().tasks.flatMap(task => task.events).filter(event =>
      event.type === 'semantic.message' && event.purpose === 'member-self-introduction'
    )
    expect(semantic).toHaveLength(2)
    expect(semantic[0]).toMatchObject({
      operationId: 'intro-natural-0',
      purpose: 'member-self-introduction',
      participantId: 'participant-0',
      memberId: 'member-0',
      runId: 'run-0',
    })
    expect(JSON.stringify(semantic)).not.toMatch(/binding|token|promptSections/iu)
    const traces = host.snapshot().tasks
    expect(traces.every(trace => trace.execution?.operation === 'introduce-member')).toBe(true)
    expect(traces.every(trace => trace.execution?.argv.includes('introduce-member') === true)).toBe(true)
    expect(
      traces.every(trace =>
        trace.events.some(event => event.type === 'execution.started')
        && trace.events.some(event => event.type === 'execution.completed')
      ),
    ).toBe(true)
  })

  it('does not advance an active subscription past lifecycle events emitted before durable causation commits', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const baseTransport = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(baseTransport) as AgentLoopV4Transport
    transport.requestAgentLoopIntroductionV4 = async input => {
      const turn = `racing-turn:${input.operationId}`
      host.appendV4Lifecycle(input.task, {
        turnId: turn,
        type: 'turn.completed',
        output: [{ type: 'text', text: 'I help the team review changes.' }],
      })
      await new Promise(resolve => setTimeout(resolve, 150))
      return { status: 'accepted', turn, messageId: `racing-message:${input.operationId}`, delivery: 'executed' }
    }
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'owner',
      active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const created = await client.createOrBind({
      ...base('create-race'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    const subscribed = await client.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const iterator = subscribed.handle.pages[Symbol.asyncIterator]()
    const request = {
      ...base('intro-race'),
      type: 'request-member-self-introduction' as const,
      binding: created.binding,
      participantId: 'participant-1',
      memberId: 'member-1',
      runId: 'run-1',
      intent: {
        kind: 'member-self-introduction' as const,
        audience: 'room' as const,
        output: 'assistant-message' as const,
      },
    }
    const pending = client.requestMemberSelfIntroduction(request)
    const firstPage = iterator.next()
    const early = await Promise.race([
      firstPage.then(() => 'event'),
      new Promise<'quiet'>(resolve => setTimeout(() => resolve('quiet'), 75)),
    ])
    expect(early).toBe('quiet')
    expect(await pending).toMatchObject({ status: 'accepted', causation: { operationId: 'intro-race' } })
    const page = await firstPage
    expect(page.value?.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'message',
      causation: { operationId: 'intro-race' },
      message: expect.objectContaining({ purpose: 'member-self-introduction' }),
    })]))
    subscribed.handle.unsubscribe()
  })

  it('fences late create and subscribe results after the owning client disposes', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const source = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(source) as AgentLoopV4Transport
    let releaseCreate!: () => void
    let markCreateStarted!: () => void
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve
    })
    const createStarted = new Promise<void>(resolve => {
      markCreateStarted = resolve
    })
    transport.createAgentLoopV4 = async input => {
      markCreateStarted()
      await createGate
      return await source.createAgentLoopV4(input)
    }
    let promptRegistrations = 0
    let promptDisposals = 0
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'dispose-fence')
    const lateClient = broker.bind({
      ...options(),
      registerPrompt: () => {
        promptRegistrations += 1
        return [() => {
          promptDisposals += 1
        }]
      },
    })
    const lateCreate = lateClient.createOrBind({
      ...base('late-create'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    await createStarted
    lateClient.dispose()
    releaseCreate()
    expect(await lateCreate).toMatchObject({ status: 'unavailable', code: 'provider-replaced' })
    expect({ promptRegistrations, promptDisposals }).toEqual({ promptRegistrations: 0, promptDisposals: 0 })

    transport.createAgentLoopV4 = input => source.createAgentLoopV4(input)
    const owner = broker.bind(options())
    const created = await owner.createOrBind({
      ...base('create-before-late-subscribe'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    let releaseLifecycle!: () => void
    let markLifecycleStarted!: () => void
    const lifecycleGate = new Promise<void>(resolve => {
      releaseLifecycle = resolve
    })
    const lifecycleStarted = new Promise<void>(resolve => {
      markLifecycleStarted = resolve
    })
    transport.readAgentLoopV4Lifecycle = async input => {
      markLifecycleStarted()
      await lifecycleGate
      return await source.readAgentLoopV4Lifecycle(input)
    }
    const subscriber = broker.bind(options())
    const lateSubscribe = subscriber.subscribe(created.binding, 0)
    await lifecycleStarted
    subscriber.dispose()
    releaseLifecycle()
    expect(await lateSubscribe).toMatchObject({ status: 'unavailable', authorization: { code: 'host-unavailable' } })
    owner.dispose()
    broker.dispose()
  })

  it('releases only the owning client prompt registrations and drains survivors on broker disposal', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const baseTransport = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(baseTransport) as AgentLoopV4Transport
    transport.sendAgentLoopV4 = async () => ({ status: 'unavailable', code: 'provider-replaced' })
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'profile', 'composition')
    let activeRegistrations = 0
    let disposedRegistrations = 0
    const registerPrompt = () => {
      if (activeRegistrations !== 0) throw new Error('duplicate global prompt registration')
      activeRegistrations += 1
      return [() => {
        activeRegistrations -= 1
        disposedRegistrations += 1
      }]
    }
    const bind = () =>
      broker.bind({
        ownerKey: 'owner',
        active: () => true,
        authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
        authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
        registerPrompt,
      })
    const first = bind()
    const created = await first.createOrBind({
      ...base('create-prompts'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    const second = bind()
    const rebound = await second.createOrBind({
      ...base('bind-prompts'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'bind', task: created.binding.task },
    })
    if (rebound.status !== 'accepted') throw new Error('bind failed')
    expect(activeRegistrations).toBe(1)
    first.dispose()
    expect(activeRegistrations).toBe(1)
    expect(disposedRegistrations).toBe(0)
    expect(
      await second.send({
        ...base('send-provider-replaced'),
        type: 'send',
        binding: rebound.binding,
        content: [{ kind: 'text', text: 'hello' }],
      }),
    ).toMatchObject({ status: 'unavailable', code: 'provider-replaced' })
    broker.dispose()
    expect(activeRegistrations).toBe(0)
    expect(disposedRegistrations).toBe(1)
    second.dispose()
    expect(disposedRegistrations).toBe(1)
    const runtime = await readOwnedSourceGraph(new URL('../../packages/cli/src/renderer/runtime.ts', import.meta.url))
    expect(runtime.executableSource).toMatch(/agentLoopBrokerV4\(\)!\.dispose\(\)/u)
  })
}
