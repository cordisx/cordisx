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
  lifecycleEvents: CordisXAgentLoopLifecycleEvent[] = []

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
  async lifecycle(_task: unknown, afterSequence: number) {
    const events = this.lifecycleEvents.filter(event => event.sequence > afterSequence)
    return { nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, events }
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
    expect(sentPage.value?.events.map(event => event.type)).toEqual(['message'])
    const startedPage = await iterator.next()
    expect(startedPage.value?.events).toMatchObject([{ type: 'lifecycle', lifecycle: { phase: 'turn.started' } }])

    host.lifecycleEvents = [
      { sequence: 1, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:opaque-task-1', type: 'approval.required', approval: { approvalId: 'approval-1', kind: 'command', state: 'pending' } },
      { sequence: 2, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:opaque-task-1', type: 'approval.resolved', approval: { approvalId: 'approval-1', kind: 'command', state: 'resolved', outcome: 'approved' } },
      { sequence: 3, session: { providerId: 'alpha', remoteSessionId: 'session-1' }, turnId: 'turn:opaque-task-1', type: 'turn.completed', output: [{ type: 'text', text: 'Hi from AgentLoop' }] },
    ]
    await vi.advanceTimersByTimeAsync(250)
    const approvalPending = await iterator.next()
    const approvalResolved = await iterator.next()
    const assistant = await iterator.next()
    const completed = await iterator.next()
    expect(approvalPending.value?.events).toMatchObject([{ type: 'approval', approval: { state: 'pending' } }])
    expect(approvalResolved.value?.events).toMatchObject([{ type: 'approval', approval: { state: 'resolved', outcome: 'approved' } }])
    expect(assistant.value?.events).toMatchObject([{ type: 'message', message: { role: 'assistant', content: [{ kind: 'text', text: 'Hi from AgentLoop' }] } }])
    expect(completed.value?.events).toMatchObject([{ type: 'lifecycle', lifecycle: { phase: 'turn.completed' } }])
    client.dispose()
    expect((await iterator.next()).value?.events).toMatchObject([{ type: 'lifecycle', lifecycle: { phase: 'binding.closed' } }])
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
    broker.dispose()
  })

  it('creates isolated tasks for two Rooms using the same owner and AgentDefinition', async () => {
    const host = new FakeHost()
    const broker = new CordisXAgentLoopBroker(host)
    const client = broker.bind({ ownerKey: 'chatroom-plugin', active: () => true, authorize: allowed() })
    const command = createCommand([definition('shared-room-assistant')])
    const first = await client.createOrBind(command)
    const second = await client.createOrBind({ ...command, commandId: 'create-room-2' })
    if (first.status !== 'accepted' || second.status !== 'accepted') throw new Error('Room bindings were not accepted')
    expect(first.binding.binding.bindingId).not.toBe(second.binding.binding.bindingId)
    expect(first.binding.task).not.toBe(second.binding.task)
    expect(host.created).toHaveLength(2)

    const firstSubscription = await client.subscribe(first.binding, -1)
    const secondSubscription = await client.subscribe(second.binding, -1)
    if (firstSubscription.status !== 'accepted' || secondSubscription.status !== 'accepted') throw new Error('Room subscriptions were not accepted')
    const firstEvents = firstSubscription.handle.pages[Symbol.asyncIterator]()
    const secondEvents = secondSubscription.handle.pages[Symbol.asyncIterator]()
    await firstEvents.next()
    await secondEvents.next()

    await client.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'send-room-1', type: 'send', binding: first.binding, content: [{ kind: 'text', text: 'Room one' }],
    })
    expect((await firstEvents.next()).value?.events).toMatchObject([{ type: 'message', message: { content: [{ text: 'Room one' }] } }])
    await firstEvents.next()
    const pendingSecondRoom = secondEvents.next()
    const crossed = await Promise.race([
      pendingSecondRoom.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 25)),
    ])
    expect(crossed).toBe(false)

    await client.send({
      $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V1, contract: 'cordisx.agent-loop-command/v1', schemaVersion: 1,
      commandId: 'send-room-2', type: 'send', binding: second.binding, content: [{ kind: 'text', text: 'Room two' }],
    })
    expect((await pendingSecondRoom).value?.events).toMatchObject([{ type: 'message', message: { content: [{ text: 'Room two' }] } }])
    expect(host.sent).toEqual([
      [{ kind: 'text', text: 'Room one' }],
      [{ kind: 'text', text: 'Room two' }],
    ])
    client.dispose()
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
