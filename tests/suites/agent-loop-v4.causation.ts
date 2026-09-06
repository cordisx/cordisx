import type { AgentLoopCommand, AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4'
import { expect, it } from 'vitest'
import { type AgentLoopV4Transport, CordisXAgentLoopBrokerV4 } from '../../packages/cli/src/renderer/agent-loop-v4.js'
import {
  PlaygroundMockAgentLoopHost,
  PlaygroundMockAgentLoopV4Transport,
} from '../../packages/cli/src/renderer/playground-mock-agent-loop.js'
import { base, definition, options } from './agent-loop-v4.fixtures.js'

export function registerCausationTests() {
  it('executes create/send/approval/introduction/cancel with exact public causation', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const transport = new PlaygroundMockAgentLoopV4Transport(host)
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'plugin-owner',
      active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const create: Extract<AgentLoopCommand, { type: 'create-or-bind' }> = {
      ...base('create-1'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    }
    const created = await client.createOrBind(create)
    expect(created).toMatchObject({
      status: 'accepted',
      binding: { schemaVersion: 4, task: expect.stringContaining('debug:agent-loop/mock/v1:task:') },
      delivery: { disposition: 'executed' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    expect(broker.definitionPresentation(definition.identity)).toEqual({
      identity: definition.identity,
      name: 'Agent One',
      introduction: 'Coordinates this exact room.',
    })
    expect(created.binding.binding.bindingId).toMatch(/^[A-Za-z0-9._~-]{1,512}$/u)
    const send: Extract<AgentLoopCommand, { type: 'send' }> = {
      ...base('send-1'),
      type: 'send',
      binding: created.binding,
      content: [{ kind: 'text', text: '[approval]' }],
    }
    const sent = await client.send(send)
    expect(sent).toMatchObject({ status: 'accepted', delivery: { disposition: 'executed' } })
    if (sent.status !== 'accepted') throw new Error('send failed')
    const approval: Extract<AgentLoopCommand, { type: 'approval-decision' }> = {
      ...base('approval-operation-1'),
      type: 'approval-decision',
      binding: created.binding,
      turn: sent.turn,
      approvalId: `simulated-approval-${sent.turn}`,
      decision: 'approved',
    }
    expect(await client.decideApproval(approval)).toMatchObject({
      status: 'accepted',
      decision: 'approved',
      causation: { operationId: 'approval-operation-1' },
    })
    const introduction: Extract<AgentLoopCommand, { type: 'request-member-self-introduction' }> = {
      ...base('introduction:operation:1'),
      type: 'request-member-self-introduction',
      binding: created.binding,
      participantId: 'agent-1',
      memberId: 'agent-1',
      runId: 'run-1',
      intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
    }
    const requested = await client.requestMemberSelfIntroduction(introduction)
    expect(requested).toMatchObject({
      status: 'accepted',
      causation: { operationId: 'introduction:operation:1' },
      participantId: 'agent-1',
      runId: 'run-1',
    })
    if (requested.status !== 'accepted') throw new Error('introduction failed')
    expect(requested.turn).toMatch(/^[A-Za-z0-9._~-]{1,512}$/u)
    expect(requested.messageId).toMatch(/^[A-Za-z0-9._~-]{1,512}$/u)
    const cancel: Extract<AgentLoopCommand, { type: 'cancel-member-self-introduction' }> = {
      ...base('cancel-operation-1'),
      type: 'cancel-member-self-introduction',
      binding: created.binding,
      participantId: 'agent-1',
      memberId: 'agent-1',
      runId: 'run-1',
      requestOperationId: 'introduction:operation:1',
    }
    expect(await client.cancelMemberSelfIntroduction(cancel)).toMatchObject({
      status: 'accepted',
      turn: requested.turn,
      messageId: requested.messageId,
      causation: { operationId: 'cancel-operation-1' },
    })
    client.dispose()

    const restoredTransport = Object.create(transport) as AgentLoopV4Transport
    restoredTransport.readAgentLoopV4Lifecycle = async () => ({
      status: 'accepted',
      nextAfterSequence: 2,
      events: [{
        eventId: 'restored-event-1',
        sequence: 1,
        turnId: requested.turn,
        type: 'turn.completed',
        output: [{ type: 'text', text: 'Restored introduction.' }],
        introduction: {
          operationId: 'introduction:operation:1',
          messageId: requested.messageId,
          participantId: 'agent-1',
          memberId: 'agent-1',
          runId: 'run-1',
        },
      }, {
        eventId: 'restored-event-2',
        sequence: 2,
        turnId: 'provider:turn:2',
        type: 'turn.completed',
        output: [{ type: 'text', text: 'Restored conversation.' }],
      }],
    })
    const restoredBroker = new CordisXAgentLoopBrokerV4(restoredTransport, host, 'playground', 'composition-1')
    const restoredClient = restoredBroker.bind({
      ownerKey: 'plugin-owner',
      active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const subscribed = await restoredClient.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('restored subscription unavailable')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        causation: { operationId: 'introduction:operation:1' },
        message: expect.objectContaining({
          messageId: requested.messageId,
          purpose: 'member-self-introduction',
          content: [{ kind: 'text', text: 'Restored introduction.' }],
        }),
      }),
    ]))
    const conversation = page.value?.events.find(event =>
      event.type === 'message' && event.message.purpose === 'conversation'
    )
    expect(conversation?.message.messageId).toMatch(/^[A-Za-z0-9._~-]{1,512}$/u)
    expect(conversation?.message.messageId).not.toContain(':')
    subscribed.handle.unsubscribe()
    restoredClient.dispose()
  })

  it('fails closed on legacy Simulator persistence before an explicit rebind', async () => {
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
    const host = new PlaygroundMockAgentLoopHost(undefined, hostPersistence)
    const broker = new CordisXAgentLoopBrokerV4(
      new PlaygroundMockAgentLoopV4Transport(host, transportPersistence),
      host,
      'playground',
      'legacy-persistence',
    )
    const client = broker.bind(options())
    const created = await client.createOrBind({
      ...base('create-before-reload'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted' || hostState === undefined || transportState === undefined) {
      throw new Error('create did not persist')
    }
    client.dispose()
    broker.dispose()

    const legacyTransport = JSON.parse(transportState) as { version: number; bindings: { bindingId: string }[] }
    legacyTransport.version = 1
    legacyTransport.bindings[0]!.bindingId = 'simulated-binding:legacy-task'
    transportState = JSON.stringify(legacyTransport)

    const restoredHost = new PlaygroundMockAgentLoopHost(undefined, hostPersistence)
    const restoredBroker = new CordisXAgentLoopBrokerV4(
      new PlaygroundMockAgentLoopV4Transport(restoredHost, transportPersistence),
      restoredHost,
      'playground',
      'legacy-persistence-reloaded',
    )
    const restoredClient = restoredBroker.bind(options())
    const rebound = await restoredClient.createOrBind({
      ...base('bind-after-legacy-state'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'bind', task: created.binding.task },
    })
    expect(rebound).toMatchObject({ status: 'accepted', binding: { binding: { generation: 1 } } })
    if (rebound.status !== 'accepted') throw new Error('rebind failed')
    expect(rebound.binding.binding.bindingId).toMatch(/^[A-Za-z0-9._~-]{1,512}$/u)
    expect(rebound.binding.binding.bindingId).not.toContain(':')
    restoredClient.dispose()
    restoredBroker.dispose()

    const legacyHost = JSON.parse(hostState) as { version: number }
    legacyHost.version = 1
    hostState = JSON.stringify(legacyHost)
    expect(new PlaygroundMockAgentLoopHost(undefined, hostPersistence).snapshot().tasks).toEqual([])
  })

  it('rejects a forged generation and isolates the same operation id by owner', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const transport = new PlaygroundMockAgentLoopV4Transport(host)
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const options = (ownerKey: string) => ({
      ownerKey,
      active: () => true,
      authorize: async (request: Parameters<Parameters<typeof broker.bind>[0]['authorize']>[0]) => ({
        capability: request.capability,
        state: 'allowed' as const,
        code: 'allowed' as const,
      }),
      authorizeV4: async (request: Parameters<NonNullable<Parameters<typeof broker.bind>[0]['authorizeV4']>>[0]) => ({
        capability: request.capability,
        state: 'allowed' as const,
        code: 'allowed' as const,
      }),
    })
    const first = await broker.bind(options('owner-a')).createOrBind({
      ...base('shared-op'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    const secondDefinition = { ...definition, identity: { agentId: 'agent-2', revision: 'revision-1' } }
    const conflicting = await broker.bind(options('owner-a')).createOrBind({
      ...base('shared-op'),
      type: 'create-or-bind',
      definition: secondDefinition.identity,
      definitions: [secondDefinition],
      target: { mode: 'create' },
    })
    const second = await broker.bind(options('owner-b')).createOrBind({
      ...base('shared-op'),
      type: 'create-or-bind',
      definition: secondDefinition.identity,
      definitions: [secondDefinition],
      target: { mode: 'create' },
    })
    expect(first.status).toBe('accepted')
    expect(conflicting).toMatchObject({ status: 'unavailable', code: 'operation-conflict' })
    expect(second.status).toBe('accepted')
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('create failed')
    expect(second.binding.task).not.toBe(first.binding.task)
    const forged: AgentLoopTaskBinding = { ...first.binding, binding: { ...first.binding.binding, generation: 99 } }
    expect(
      await broker.bind(options('owner-a')).send({
        ...base('forged-send'),
        type: 'send',
        binding: forged,
        content: [{ kind: 'text', text: 'forged' }],
      }),
    ).not.toMatchObject({ status: 'accepted' })
  })

  it('resolves legacy TaskBinding through the exact owner and generation without treating task as SessionId', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const source = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(source) as AgentLoopV4Transport
    const observed: unknown[] = []
    transport.resolveAgentLoopV4Session = async input => {
      observed.push(structuredClone(input))
      return input.binding.generation === 1
        ? { status: 'resolved', sessionId: 'remote-session-exact' }
        : { status: 'unavailable', code: 'binding-closed' }
    }
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'legacy-acquire')
    const created = await broker.bind(options()).createOrBind({
      ...base('create-for-legacy-acquire'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')
    expect(await broker.resolveLegacySession(options(), created.binding)).toEqual({
      status: 'resolved',
      sessionId: 'remote-session-exact',
    })
    expect(observed).toEqual([expect.objectContaining({
      task: created.binding.task,
      binding: created.binding.binding,
      definition: created.binding.definition,
      scope: expect.objectContaining({ ownerKey: 'plugin-owner' }),
    })])
    expect(
      await broker.resolveLegacySession(options(), {
        ...created.binding,
        binding: { ...created.binding.binding, generation: 2 },
      }),
    ).toEqual({ status: 'unavailable', code: 'binding-closed' })
    expect(await broker.resolveLegacySession({ ...options(), active: () => false }, created.binding))
      .toEqual({ status: 'unavailable', code: 'plugin-generation-replaced' })
    broker.dispose()
  })

  it('isolates lifecycle correlation when owners reuse the same opaque task and turn handles', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const source = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(source) as AgentLoopV4Transport
    transport.createAgentLoopV4 = async input => {
      const result = await source.createAgentLoopV4(input) as {
        locator: { task: string; binding: { bindingId: string; generation: number } }
      }
      return { ...result, locator: { task: 'shared-task', binding: { bindingId: 'shared-binding', generation: 1 } } }
    }
    transport.requestAgentLoopIntroductionV4 = async input => ({
      status: 'accepted',
      turn: 'shared-turn',
      messageId: `message-${input.scope.ownerKey}`,
      delivery: 'executed',
    })
    transport.readAgentLoopV4Lifecycle = async () => ({
      status: 'accepted',
      nextAfterSequence: 1,
      events: [{
        eventId: 'shared-event',
        sequence: 1,
        turnId: 'shared-turn',
        type: 'turn.completed',
        output: [{ type: 'text', text: 'owner-scoped reply' }],
      }],
    })
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'owner-correlation')
    const bind = (ownerKey: string) => broker.bind({ ...options(), ownerKey })
    const ownerA = bind('owner-a')
    const ownerB = bind('owner-b')
    const create = (commandId: string) => ({
      ...base(commandId),
      type: 'create-or-bind' as const,
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' as const },
    })
    const createdA = await ownerA.createOrBind(create('create-owner-a'))
    const createdB = await ownerB.createOrBind(create('create-owner-b'))
    if (createdA.status !== 'accepted' || createdB.status !== 'accepted') throw new Error('create failed')
    expect(
      await ownerA.requestMemberSelfIntroduction({
        ...base('intro-owner-a'),
        type: 'request-member-self-introduction',
        binding: createdA.binding,
        participantId: 'participant-a',
        memberId: 'member-a',
        runId: 'run-a',
        intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
      }),
    ).toMatchObject({ status: 'accepted', messageId: 'message-owner-a' })
    const subscribed = await ownerB.subscribe(createdB.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    const message = page.value?.events.find(event => event.type === 'message')
    expect(message).toMatchObject({ type: 'message', message: { purpose: 'conversation' } })
    expect(message).not.toMatchObject({
      causation: { operationId: 'intro-owner-a' },
      message: { messageId: 'message-owner-a' },
    })
    subscribed.handle.unsubscribe()
    ownerA.dispose()
    ownerB.dispose()
    broker.dispose()
  })

  it('fails closed on noncanonical task details URLs and unknown delivery dispositions', async () => {
    const invalidUrls = [
      { url: 'javascript:alert(1)', target: 'host' },
      { url: 'https://EXAMPLE.com/', target: 'external' },
      { url: 'https://example.com:443/', target: 'external' },
      { url: 'https://example.com/?query=1', target: 'external' },
      { url: 'https://example.com/%75ser', target: 'external' },
    ]
    for (const [index, detailsUrl] of invalidUrls.entries()) {
      const host = new PlaygroundMockAgentLoopHost()
      const source = new PlaygroundMockAgentLoopV4Transport(host)
      const transport = Object.create(source) as AgentLoopV4Transport
      transport.createAgentLoopV4 = async input => ({
        ...(await source.createAgentLoopV4(input) as object),
        detailsUrl,
      })
      const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', `details-${index}`)
      const result = await broker.bind(options()).createOrBind({
        ...base(`invalid-details-${index}`),
        type: 'create-or-bind',
        definition: definition.identity,
        definitions: [definition],
        target: { mode: 'create' },
      })
      expect(result).toMatchObject({ status: 'unavailable', code: 'details-unavailable' })
      broker.dispose()
    }

    const host = new PlaygroundMockAgentLoopHost()
    const source = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(source) as AgentLoopV4Transport
    transport.createAgentLoopV4 = async input => ({
      ...(await source.createAgentLoopV4(input) as object),
      delivery: 'unknown',
    })
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'invalid-delivery')
    expect(
      await broker.bind(options()).createOrBind({
        ...base('invalid-delivery'),
        type: 'create-or-bind',
        definition: definition.identity,
        definitions: [definition],
        target: { mode: 'create' },
      }),
    )
      .toMatchObject({ status: 'unavailable', code: 'reconciliation-required' })
    broker.dispose()
  })

  it('fails closed on overlong AgentLoop handles returned by a transport', async () => {
    const overlong = 'x'.repeat(513)
    for (const field of ['task', 'binding'] as const) {
      const host = new PlaygroundMockAgentLoopHost()
      const source = new PlaygroundMockAgentLoopV4Transport(host)
      const transport = Object.create(source) as AgentLoopV4Transport
      transport.createAgentLoopV4 = async input => {
        const result = await source.createAgentLoopV4(input) as {
          locator: { task: string; binding: { bindingId: string; generation: number } }
        }
        return field === 'task'
          ? { ...result, locator: { ...result.locator, task: overlong } }
          : { ...result, locator: { ...result.locator, binding: { ...result.locator.binding, bindingId: overlong } } }
      }
      const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', `overlong-create-${field}`)
      expect(
        await broker.bind(options()).createOrBind({
          ...base(`overlong-create-${field}`),
          type: 'create-or-bind',
          definition: definition.identity,
          definitions: [definition],
          target: { mode: 'create' },
        }),
      )
        .toMatchObject({ status: 'unavailable', code: 'reconciliation-required' })
      broker.dispose()
    }

    const host = new PlaygroundMockAgentLoopHost()
    const source = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(source) as AgentLoopV4Transport
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'overlong-results')
    const client = broker.bind(options())
    const created = await client.createOrBind({
      ...base('create-overlong-results'),
      type: 'create-or-bind',
      definition: definition.identity,
      definitions: [definition],
      target: { mode: 'create' },
    })
    if (created.status !== 'accepted') throw new Error('create failed')

    transport.sendAgentLoopV4 = async () => ({
      status: 'accepted',
      turn: overlong,
      messageId: overlong,
      delivery: 'executed',
    })
    expect(
      await client.send({
        ...base('send-overlong-results'),
        type: 'send',
        binding: created.binding,
        content: [{ kind: 'text', text: 'hello' }],
      }),
    )
      .toMatchObject({ status: 'unavailable', code: 'reconciliation-required' })
    transport.requestAgentLoopIntroductionV4 = async () => ({
      status: 'accepted',
      turn: overlong,
      messageId: overlong,
      delivery: 'executed',
    })
    expect(
      await client.requestMemberSelfIntroduction({
        ...base('intro-overlong-results'),
        type: 'request-member-self-introduction',
        binding: created.binding,
        participantId: 'participant-1',
        memberId: 'member-1',
        runId: 'run-1',
        intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
      }),
    ).toMatchObject({ status: 'unavailable', code: 'reconciliation-required' })

    transport.requestAgentLoopIntroductionV4 = input => source.requestAgentLoopIntroductionV4(input)
    const introduction = {
      ...base('intro-before-overlong-cancel'),
      type: 'request-member-self-introduction' as const,
      binding: created.binding,
      participantId: 'participant:1',
      memberId: 'member:1',
      runId: 'run:1',
      intent: {
        kind: 'member-self-introduction' as const,
        audience: 'room' as const,
        output: 'assistant-message' as const,
      },
    }
    const requested = await client.requestMemberSelfIntroduction(introduction)
    if (requested.status !== 'accepted') throw new Error('introduction failed')
    transport.cancelAgentLoopIntroductionV4 = async () => ({
      status: 'accepted',
      turn: overlong,
      messageId: overlong,
      delivery: 'executed',
    })
    expect(
      await client.cancelMemberSelfIntroduction({
        ...base('cancel-overlong-results'),
        type: 'cancel-member-self-introduction',
        binding: created.binding,
        participantId: 'participant:1',
        memberId: 'member:1',
        runId: 'run:1',
        requestOperationId: introduction.commandId,
      }),
    ).toMatchObject({ status: 'unavailable', code: 'reconciliation-required' })

    transport.readAgentLoopV4Lifecycle = async () => ({
      status: 'accepted',
      nextAfterSequence: 8,
      events: [
        { eventId: overlong, sequence: 1, turnId: 'turn-valid', type: 'turn.started' },
        { eventId: 'event-overlong-turn', sequence: 2, turnId: overlong, type: 'turn.started' },
        {
          eventId: 'event-valid',
          sequence: 3,
          turnId: 'turn-valid',
          type: 'approval.required',
          approval: { approvalId: overlong, kind: 'command' },
        },
        {
          eventId: 'event-invalid-introduction',
          sequence: 4,
          turnId: requested.turn,
          type: 'turn.completed',
          output: [{ type: 'text', text: 'must not be downgraded' }],
          introduction: {
            operationId: overlong,
            messageId: requested.messageId,
            participantId: 'participant-1',
            memberId: 'member-1',
            runId: 'run-1',
          },
        },
        {
          eventId: 'event-invalid-cancellation',
          sequence: 5,
          turnId: 'turn-valid',
          type: 'turn.cancelled',
          cancellation: { operationId: overlong },
        },
        {
          eventId: 'event-invalid-causation',
          sequence: 6,
          turnId: 'turn-valid',
          type: 'approval.resolved',
          causation: { operationId: overlong },
          approval: { approvalId: 'approval-valid', kind: 'command', outcome: 'approved' },
        },
        {
          eventId: 'event-valid-introduction',
          sequence: 7,
          turnId: requested.turn,
          type: 'turn.completed',
          output: [{ type: 'text', text: 'valid introduction' }],
          introduction: {
            operationId: introduction.commandId,
            messageId: requested.messageId,
            participantId: 'participant:1',
            memberId: 'member:1',
            runId: 'run:1',
          },
        },
        { eventId: 'event-final', sequence: 8, turnId: 'turn-valid', type: 'turn.started' },
      ],
    })
    const subscribed = await client.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: 'event-final', turn: 'turn-valid' }),
      expect.objectContaining({
        type: 'message',
        causation: { operationId: introduction.commandId },
        message: expect.objectContaining({ messageId: requested.messageId, purpose: 'member-self-introduction' }),
      }),
    ]))
    expect(
      page.value?.events.some(event =>
        ['event-invalid-introduction', 'event-invalid-cancellation', 'event-invalid-causation'].includes(event.eventId)
      ),
    ).toBe(false)
    subscribed.handle.unsubscribe()
    client.dispose()
    broker.dispose()
  })
}
