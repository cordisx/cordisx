import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { AgentLoopCommand, AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4,
} from '../packages/cli/src/agent-loop-contracts.js'
import { CordisXAgentLoopBrokerV4, type AgentLoopV4Transport } from '../packages/cli/src/renderer/agent-loop-v4.js'
import {
  PlaygroundMockAgentLoopHost,
  PlaygroundMockAgentLoopV4Transport,
  type PlaygroundMockCliExecutor,
} from '../packages/cli/src/renderer/playground-mock-agent-loop.js'

function base(commandId: string) {
  return { $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V4, contract: 'cordisx.agent-loop-command/v4' as const, schemaVersion: 4 as const, commandId }
}

const definition = {
  $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  contract: 'cordisx.agent-definition/v1' as const,
  schemaVersion: 1 as const,
  identity: { agentId: 'agent-1', revision: 'revision-1' },
  inherit: { promptSections: 'none' as const, rules: 'none' as const, skills: 'none' as const, tools: 'none' as const, mcpServers: 'none' as const, runtimeDefaults: 'none' as const },
}

describe('AgentLoop v4 renderer adapter', () => {
  const options = () => ({
    ownerKey: 'plugin-owner', active: () => true,
    authorize: async (request: { capability: string }) => ({ capability: request.capability as never, state: 'allowed' as const, code: 'allowed' as const }),
    authorizeV4: async (request: { capability: string }) => ({ capability: request.capability as never, state: 'allowed' as const, code: 'allowed' as const }),
  })

  it('executes create/send/approval/introduction/cancel with exact public causation', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const transport = new PlaygroundMockAgentLoopV4Transport(host)
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'plugin-owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const create: Extract<AgentLoopCommand, { type: 'create-or-bind' }> = {
      ...base('create-1'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' },
    }
    const created = await client.createOrBind(create)
    expect(created).toMatchObject({ status: 'accepted', binding: { schemaVersion: 4, task: expect.stringContaining('debug:agent-loop/mock/v1:task:') }, delivery: { disposition: 'executed' } })
    if (created.status !== 'accepted') throw new Error('create failed')
    const send: Extract<AgentLoopCommand, { type: 'send' }> = { ...base('send-1'), type: 'send', binding: created.binding, content: [{ kind: 'text', text: '[approval]' }] }
    const sent = await client.send(send)
    expect(sent).toMatchObject({ status: 'accepted', delivery: { disposition: 'executed' } })
    if (sent.status !== 'accepted') throw new Error('send failed')
    const approval: Extract<AgentLoopCommand, { type: 'approval-decision' }> = { ...base('approval-operation-1'), type: 'approval-decision', binding: created.binding, turn: sent.turn, approvalId: `simulated-approval-${sent.turn}`, decision: 'approved' }
    expect(await client.decideApproval(approval)).toMatchObject({ status: 'accepted', decision: 'approved', causation: { operationId: 'approval-operation-1' } })
    const introduction: Extract<AgentLoopCommand, { type: 'request-member-self-introduction' }> = {
      ...base('introduction-operation-1'), type: 'request-member-self-introduction', binding: created.binding,
      participantId: 'agent-1', memberId: 'agent-1', runId: 'run-1', intent: { kind: 'member-self-introduction', audience: 'room', output: 'assistant-message' },
    }
    const requested = await client.requestMemberSelfIntroduction(introduction)
    expect(requested).toMatchObject({ status: 'accepted', causation: { operationId: 'introduction-operation-1' }, participantId: 'agent-1', runId: 'run-1' })
    if (requested.status !== 'accepted') throw new Error('introduction failed')
    const cancel: Extract<AgentLoopCommand, { type: 'cancel-member-self-introduction' }> = {
      ...base('cancel-operation-1'), type: 'cancel-member-self-introduction', binding: created.binding,
      participantId: 'agent-1', memberId: 'agent-1', runId: 'run-1', requestOperationId: 'introduction-operation-1',
    }
    expect(await client.cancelMemberSelfIntroduction(cancel)).toMatchObject({ status: 'accepted', turn: requested.turn, messageId: requested.messageId, causation: { operationId: 'cancel-operation-1' } })
    client.dispose()

    const restoredTransport = Object.create(transport) as AgentLoopV4Transport
    restoredTransport.readAgentLoopV4Lifecycle = async () => ({
      status: 'accepted', nextAfterSequence: 1, events: [{
        eventId: 'restored-event-1', sequence: 1, turnId: requested.turn, type: 'turn.completed',
        output: [{ type: 'text', text: 'Restored introduction.' }],
        introduction: { operationId: 'introduction-operation-1', messageId: requested.messageId, participantId: 'agent-1', memberId: 'agent-1', runId: 'run-1' },
      }],
    })
    const restoredBroker = new CordisXAgentLoopBrokerV4(restoredTransport, host, 'playground', 'composition-1')
    const restoredClient = restoredBroker.bind({
      ownerKey: 'plugin-owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const subscribed = await restoredClient.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('restored subscription unavailable')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'message', causation: { operationId: 'introduction-operation-1' },
        message: expect.objectContaining({ messageId: requested.messageId, purpose: 'member-self-introduction', content: [{ kind: 'text', text: 'Restored introduction.' }] }),
      }),
    ]))
    subscribed.handle.unsubscribe()
    restoredClient.dispose()
  })

  it('rejects a forged generation and isolates the same operation id by owner', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const transport = new PlaygroundMockAgentLoopV4Transport(host)
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const options = (ownerKey: string) => ({
      ownerKey, active: () => true,
      authorize: async (request: Parameters<Parameters<typeof broker.bind>[0]['authorize']>[0]) => ({ capability: request.capability, state: 'allowed' as const, code: 'allowed' as const }),
      authorizeV4: async (request: Parameters<NonNullable<Parameters<typeof broker.bind>[0]['authorizeV4']>>[0]) => ({ capability: request.capability, state: 'allowed' as const, code: 'allowed' as const }),
    })
    const first = await broker.bind(options('owner-a')).createOrBind({ ...base('shared-op'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
    const secondDefinition = { ...definition, identity: { agentId: 'agent-2', revision: 'revision-1' } }
    const conflicting = await broker.bind(options('owner-a')).createOrBind({ ...base('shared-op'), type: 'create-or-bind', definition: secondDefinition.identity, definitions: [secondDefinition], target: { mode: 'create' } })
    const second = await broker.bind(options('owner-b')).createOrBind({ ...base('shared-op'), type: 'create-or-bind', definition: secondDefinition.identity, definitions: [secondDefinition], target: { mode: 'create' } })
    expect(first.status).toBe('accepted')
    expect(conflicting).toMatchObject({ status: 'unavailable', code: 'operation-conflict' })
    expect(second.status).toBe('accepted')
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('create failed')
    expect(second.binding.task).not.toBe(first.binding.task)
    const forged: AgentLoopTaskBinding = { ...first.binding, binding: { ...first.binding.binding, generation: 99 } }
    expect(await broker.bind(options('owner-a')).send({ ...base('forged-send'), type: 'send', binding: forged, content: [{ kind: 'text', text: 'forged' }] })).not.toMatchObject({ status: 'accepted' })
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
      transport.createAgentLoopV4 = async input => ({ ...(await source.createAgentLoopV4(input) as object), detailsUrl })
      const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', `details-${index}`)
      const result = await broker.bind(options()).createOrBind({ ...base(`invalid-details-${index}`), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
      expect(result).toMatchObject({ status: 'unavailable', code: 'details-unavailable' })
      broker.dispose()
    }

    const host = new PlaygroundMockAgentLoopHost()
    const source = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(source) as AgentLoopV4Transport
    transport.createAgentLoopV4 = async input => ({ ...(await source.createAgentLoopV4(input) as object), delivery: 'unknown' })
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'invalid-delivery')
    expect(await broker.bind(options()).createOrBind({ ...base('invalid-delivery'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } }))
      .toMatchObject({ status: 'unavailable', code: 'reconciliation-required' })
    broker.dispose()
  })

  it('emits retryable introduction failure and permits a new operation to retry the exact member run', async () => {
    let attempts = 0
    let hostState: string | undefined
    let transportState: string | undefined
    const hostPersistence = { read: () => hostState, write: (value: string) => { hostState = value } }
    const transportPersistence = { read: () => transportState, write: (value: string) => { transportState = value } }
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
    const broker = new CordisXAgentLoopBrokerV4(new PlaygroundMockAgentLoopV4Transport(host, transportPersistence), host, 'playground', 'retry-introduction')
    const client = broker.bind(options())
    const created = await client.createOrBind({ ...base('create-retry-introduction'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
    if (created.status !== 'accepted') throw new Error('create failed')
    const request = (commandId: string) => ({ ...base(commandId), type: 'request-member-self-introduction' as const, binding: created.binding, participantId: 'participant-1', memberId: 'member-1', runId: 'run-1', intent: { kind: 'member-self-introduction' as const, audience: 'room' as const, output: 'assistant-message' as const } })
    expect(await client.requestMemberSelfIntroduction(request('intro-fails'))).toMatchObject({ status: 'accepted' })
    await new Promise(resolve => setTimeout(resolve, 10))
    client.dispose()
    broker.dispose()

    const restoredHost = new PlaygroundMockAgentLoopHost(executor, hostPersistence)
    const restoredBroker = new CordisXAgentLoopBrokerV4(new PlaygroundMockAgentLoopV4Transport(restoredHost, transportPersistence), restoredHost, 'playground', 'retry-introduction-reloaded')
    const restoredClient = restoredBroker.bind(options())
    const rebound = await restoredClient.createOrBind({ ...base('bind-after-introduction-failure'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'bind', task: created.binding.task } })
    if (rebound.status !== 'accepted') throw new Error('bind after reload failed')
    const failedSubscription = await restoredClient.subscribe(rebound.binding, 0)
    if (failedSubscription.status !== 'accepted') throw new Error('failed introduction subscription failed')
    const failedPage = await failedSubscription.handle.pages[Symbol.asyncIterator]().next()
    expect(failedPage.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lifecycle', causation: { operationId: 'intro-fails' }, lifecycle: { phase: 'turn.started' } }),
      expect.objectContaining({ type: 'lifecycle', causation: { operationId: 'intro-fails' }, lifecycle: { phase: 'turn.failed', failure: { code: 'SIMULATED_CLI_FAILURE', retryable: true } } }),
    ]))
    failedSubscription.handle.unsubscribe()
    expect(await restoredClient.cancelMemberSelfIntroduction({
      ...base('cancel-failed-introduction'), type: 'cancel-member-self-introduction', binding: rebound.binding,
      participantId: 'participant-1', memberId: 'member-1', runId: 'run-1', requestOperationId: 'intro-fails',
    })).toMatchObject({ status: 'conflict', code: 'introduction-conflict' })
    expect(await restoredClient.requestMemberSelfIntroduction({ ...request('intro-retries'), binding: rebound.binding })).toMatchObject({ status: 'accepted' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(attempts).toBe(2)
    const subscribed = await restoredClient.subscribe(rebound.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lifecycle', causation: { operationId: 'intro-fails' }, lifecycle: { phase: 'turn.failed', failure: { code: 'SIMULATED_CLI_FAILURE', retryable: true } } }),
      expect.objectContaining({ type: 'message', causation: { operationId: 'intro-retries' }, message: expect.objectContaining({ purpose: 'member-self-introduction' }) }),
    ]))
    expect(page.value?.events.some(event => event.type === 'lifecycle' && event.lifecycle.phase === 'turn.cancelled')).toBe(false)
    subscribed.handle.unsubscribe()
    restoredClient.dispose()
    restoredBroker.dispose()
  })

  it('emits an exact cancelled lifecycle without a late assistant completion and replays cancel idempotently', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const transport = new PlaygroundMockAgentLoopV4Transport(host)
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const created = await client.createOrBind({ ...base('create-cancel'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
    if (created.status !== 'accepted') throw new Error('create failed')
    const request = { ...base('intro-cancel'), type: 'request-member-self-introduction' as const, binding: created.binding, participantId: 'participant-1', memberId: 'member-1', runId: 'run-1', intent: { kind: 'member-self-introduction' as const, audience: 'room' as const, output: 'assistant-message' as const } }
    const requested = await client.requestMemberSelfIntroduction(request)
    if (requested.status !== 'accepted') throw new Error('introduction failed')
    const cancel = { ...base('cancel-intro'), type: 'cancel-member-self-introduction' as const, binding: created.binding, participantId: 'participant-1', memberId: 'member-1', runId: 'run-1', requestOperationId: request.commandId }
    expect(await client.cancelMemberSelfIntroduction(cancel)).toMatchObject({ status: 'accepted', delivery: { disposition: 'executed' } })
    expect(await client.cancelMemberSelfIntroduction(cancel)).toMatchObject({ status: 'accepted', delivery: { disposition: 'replayed' } })
    expect(await client.cancelMemberSelfIntroduction({ ...cancel, commandId: 'cancel-intro-again' })).toMatchObject({ status: 'conflict', code: 'introduction-cancelled' })
    await new Promise(resolve => setTimeout(resolve, 10))
    const subscribed = await client.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.value?.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'lifecycle', causation: { operationId: 'cancel-intro' }, lifecycle: { phase: 'turn.cancelled' },
    })]))
    expect(page.value?.events.some(event => event.type === 'message' && event.turn === requested.turn)).toBe(false)
    subscribed.handle.unsubscribe()

    const lateTransport = Object.create(transport) as AgentLoopV4Transport
    lateTransport.readAgentLoopV4Lifecycle = async () => ({
      status: 'accepted', nextAfterSequence: 1, events: [{
        eventId: 'late-cancelled-output', sequence: 1, turnId: requested.turn, type: 'turn.completed',
        output: [{ type: 'text', text: 'This late provider output must stay hidden.' }],
        cancellation: { operationId: 'cancel-intro' },
      }],
    })
    const lateBroker = new CordisXAgentLoopBrokerV4(lateTransport, host, 'playground', 'composition-1')
    const lateClient = lateBroker.bind({
      ownerKey: 'owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const lateSubscription = await lateClient.subscribe(created.binding, 0)
    if (lateSubscription.status !== 'accepted') throw new Error('late subscription failed')
    const latePage = await lateSubscription.handle.pages[Symbol.asyncIterator]().next()
    expect(latePage.value?.events).toEqual([expect.objectContaining({
      type: 'lifecycle', causation: { operationId: 'cancel-intro' }, lifecycle: { phase: 'turn.cancelled' },
    })])
    lateSubscription.handle.unsubscribe()
    lateClient.dispose()
    lateBroker.dispose()
  })

  it('generates definition-sensitive natural introductions and records only redacted semantic association fields', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const broker = new CordisXAgentLoopBrokerV4(new PlaygroundMockAgentLoopV4Transport(host), host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const make = (agentId: string, name: string, text: string) => ({ ...definition, identity: { agentId, revision: 'revision-1' }, name, promptSections: [{ sectionId: 'intro', kind: 'introduction' as const, text }] })
    const messages: string[] = []
    for (const [index, configured] of [make('lead', 'Lead', 'Coordinate the work carefully.'), make('reviewer', 'Reviewer', 'Challenge assumptions and review quality.')].entries()) {
      const created = await client.createOrBind({ ...base(`create-natural-${index}`), type: 'create-or-bind', definition: configured.identity, definitions: [configured], target: { mode: 'create' } })
      if (created.status !== 'accepted') throw new Error('create failed')
      const request = { ...base(`intro-natural-${index}`), type: 'request-member-self-introduction' as const, binding: created.binding, participantId: `participant-${index}`, memberId: `member-${index}`, runId: `run-${index}`, intent: { kind: 'member-self-introduction' as const, audience: 'room' as const, output: 'assistant-message' as const } }
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
    const semantic = host.snapshot().tasks.flatMap(task => task.events).filter(event => event.type === 'semantic.message' && event.purpose === 'member-self-introduction')
    expect(semantic).toHaveLength(2)
    expect(semantic[0]).toMatchObject({ operationId: 'intro-natural-0', purpose: 'member-self-introduction', participantId: 'participant-0', memberId: 'member-0', runId: 'run-0' })
    expect(JSON.stringify(semantic)).not.toMatch(/binding|token|promptSections/iu)
    const traces = host.snapshot().tasks
    expect(traces.every(trace => trace.execution?.operation === 'introduce-member')).toBe(true)
    expect(traces.every(trace => trace.execution?.argv.includes('introduce-member') === true)).toBe(true)
    expect(traces.every(trace => trace.events.some(event => event.type === 'execution.started') && trace.events.some(event => event.type === 'execution.completed'))).toBe(true)
  })

  it('does not advance an active subscription past lifecycle events emitted before durable causation commits', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const baseTransport = new PlaygroundMockAgentLoopV4Transport(host)
    const transport = Object.create(baseTransport) as AgentLoopV4Transport
    transport.requestAgentLoopIntroductionV4 = async input => {
      const turn = `racing-turn:${input.operationId}`
      host.appendV4Lifecycle(input.task, { turnId: turn, type: 'turn.completed', output: [{ type: 'text', text: 'I help the team review changes.' }] })
      await new Promise(resolve => setTimeout(resolve, 150))
      return { status: 'accepted', turn, messageId: `racing-message:${input.operationId}`, delivery: 'executed' }
    }
    const broker = new CordisXAgentLoopBrokerV4(transport, host, 'playground', 'composition-1')
    const client = broker.bind({
      ownerKey: 'owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
    })
    const created = await client.createOrBind({ ...base('create-race'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
    if (created.status !== 'accepted') throw new Error('create failed')
    const subscribed = await client.subscribe(created.binding, 0)
    if (subscribed.status !== 'accepted') throw new Error('subscribe failed')
    const iterator = subscribed.handle.pages[Symbol.asyncIterator]()
    const request = { ...base('intro-race'), type: 'request-member-self-introduction' as const, binding: created.binding, participantId: 'participant-1', memberId: 'member-1', runId: 'run-1', intent: { kind: 'member-self-introduction' as const, audience: 'room' as const, output: 'assistant-message' as const } }
    const pending = client.requestMemberSelfIntroduction(request)
    const firstPage = iterator.next()
    const early = await Promise.race([firstPage.then(() => 'event'), new Promise<'quiet'>(resolve => setTimeout(() => resolve('quiet'), 75))])
    expect(early).toBe('quiet')
    expect(await pending).toMatchObject({ status: 'accepted', causation: { operationId: 'intro-race' } })
    const page = await firstPage
    expect(page.value?.events).toEqual(expect.arrayContaining([expect.objectContaining({
      type: 'message', causation: { operationId: 'intro-race' }, message: expect.objectContaining({ purpose: 'member-self-introduction' }),
    })]))
    subscribed.handle.unsubscribe()
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
      return [() => { activeRegistrations -= 1; disposedRegistrations += 1 }]
    }
    const bind = () => broker.bind({
      ownerKey: 'owner', active: () => true,
      authorize: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      authorizeV4: async request => ({ capability: request.capability, state: 'allowed', code: 'allowed' }),
      registerPrompt,
    })
    const first = bind()
    const created = await first.createOrBind({ ...base('create-prompts'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'create' } })
    if (created.status !== 'accepted') throw new Error('create failed')
    const second = bind()
    const rebound = await second.createOrBind({ ...base('bind-prompts'), type: 'create-or-bind', definition: definition.identity, definitions: [definition], target: { mode: 'bind', task: created.binding.task } })
    if (rebound.status !== 'accepted') throw new Error('bind failed')
    expect(activeRegistrations).toBe(1)
    first.dispose()
    expect(activeRegistrations).toBe(1)
    expect(disposedRegistrations).toBe(0)
    expect(await second.send({ ...base('send-provider-replaced'), type: 'send', binding: rebound.binding, content: [{ kind: 'text', text: 'hello' }] })).toMatchObject({ status: 'unavailable', code: 'provider-replaced' })
    broker.dispose()
    expect(activeRegistrations).toBe(0)
    expect(disposedRegistrations).toBe(1)
    second.dispose()
    expect(disposedRegistrations).toBe(1)
    expect(await readFile(new URL('../packages/cli/src/renderer/runtime.ts', import.meta.url), 'utf8')).toContain('agentLoopBrokerV4.dispose()')
  })
})
