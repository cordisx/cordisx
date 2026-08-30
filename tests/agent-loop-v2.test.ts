import { describe, expect, it } from 'vitest'
import type {
  AgentDefinition,
  AgentLoopCommand,
  AgentLoopTaskBinding,
} from '@cordisx/protocol/agent-loop/v2'
import {
  CORDISX_AGENT_DEFINITION_SCHEMA_V1,
  CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2,
} from '../packages/cli/src/agent-loop-contracts.js'
import { CordisXAgentLoopBrokerV2, canonicalAgentLoopTaskDetailsUrl } from '../packages/cli/src/renderer/agent-loop-v2.js'
import { PlaygroundMockAgentLoopHost } from '../packages/cli/src/renderer/playground-mock-agent-loop.js'

const inherit: AgentDefinition['inherit'] = {
  promptSections: 'append', rules: 'append', skills: 'append', tools: 'merge', mcpServers: 'merge', runtimeDefaults: 'merge',
}

function definition(agentId: string): AgentDefinition {
  return {
    $schema: CORDISX_AGENT_DEFINITION_SCHEMA_V1,
    contract: 'cordisx.agent-definition/v1', schemaVersion: 1,
    identity: { agentId, revision: 'r1' }, inherit,
    promptSections: [{ sectionId: 'introduction', kind: 'introduction', text: `${agentId} prompt` }],
    skills: ['summarize'],
  }
}

function create(commandId: string, target: AgentDefinition): Extract<AgentLoopCommand, { type: 'create-or-bind' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2,
    contract: 'cordisx.agent-loop-command/v2', schemaVersion: 2,
    commandId, type: 'create-or-bind', definition: target.identity,
    definitions: [target], target: { mode: 'create' },
  }
}

function send(commandId: string, binding: AgentLoopTaskBinding, text: string): Extract<AgentLoopCommand, { type: 'send' }> {
  return {
    $schema: CORDISX_AGENT_LOOP_COMMAND_SCHEMA_V2,
    contract: 'cordisx.agent-loop-command/v2', schemaVersion: 2,
    commandId, type: 'send', binding, content: [{ kind: 'text', text }],
  }
}

const allowed = async (request: { capability: 'tasks.create' | 'tasks.content.read' | 'turns.submit' }) => ({
  capability: request.capability, state: 'allowed' as const, code: 'allowed' as const,
})

describe('durable AgentLoop v2 broker', () => {
  it('executes and replays exact create/send operations while preserving details, ids, and event causation', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const broker = new CordisXAgentLoopBrokerV2(host, () => new Date('2026-08-31T00:00:00.000Z'))
    const client = broker.bind({ ownerKey: 'chatroom', active: () => true, authorize: allowed })
    const lead = definition('lead')
    const createLead = create('create-lead', lead)
    const [created, createRetry] = await Promise.all([client.createOrBind(createLead), client.createOrBind(createLead)])
    expect(created.status).toBe('accepted')
    expect(createRetry.status).toBe('accepted')
    if (created.status !== 'accepted' || createRetry.status !== 'accepted') throw new Error('create unavailable')
    expect(created.delivery.disposition).toBe('executed')
    expect(createRetry.delivery.disposition).toBe('replayed')
    expect(createRetry.binding).toEqual(created.binding)
    expect(createRetry.detailsUrl).toEqual(created.detailsUrl)
    expect(host.snapshot().tasks).toHaveLength(1)

    const sendLead = send('send-lead', created.binding, 'hello')
    const sent = await client.send(sendLead)
    const sendRetry = await client.send(sendLead)
    expect(sent.status).toBe('accepted')
    expect(sendRetry.status).toBe('accepted')
    if (sent.status !== 'accepted' || sendRetry.status !== 'accepted') throw new Error('send unavailable')
    expect(sendRetry).toMatchObject({ messageId: sent.messageId, turn: sent.turn, delivery: { disposition: 'replayed' } })
    expect(host.snapshot().tasks[0]?.events.filter(event => event.type === 'input.accepted')).toHaveLength(1)

    const subscribed = await client.subscribe(created.binding, -1)
    expect(subscribed.status).toBe('accepted')
    if (subscribed.status !== 'accepted') throw new Error('subscribe unavailable')
    const page = await subscribed.handle.pages[Symbol.asyncIterator]().next()
    expect(page.done).toBe(false)
    expect(page.value?.events.some(event => event.causation?.operationId === 'create-lead')).toBe(true)
    subscribed.handle.unsubscribe()
  })

  it('rejects structural operation reuse before side effects and isolates the same id by owner', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const broker = new CordisXAgentLoopBrokerV2(host)
    const first = broker.bind({ ownerKey: 'one', active: () => true, authorize: allowed })
    const second = broker.bind({ ownerKey: 'two', active: () => true, authorize: allowed })
    const lead = definition('lead')
    const reviewer = definition('reviewer')
    expect((await first.createOrBind(create('same-id', lead))).status).toBe('accepted')
    const conflict = await first.createOrBind(create('same-id', reviewer))
    expect(conflict).toMatchObject({ status: 'unavailable', code: 'operation-conflict' })
    expect((await second.createOrBind(create('same-id', reviewer))).status).toBe('accepted')
    expect(host.snapshot().tasks).toHaveLength(2)
  })

  it('reconciles an exact create operation after client dispose with one logical task and a new generation', async () => {
    const host = new PlaygroundMockAgentLoopHost()
    const broker = new CordisXAgentLoopBrokerV2(host)
    const lead = definition('lead')
    const command = create('durable-create', lead)
    const first = broker.bind({ ownerKey: 'chatroom', active: () => true, authorize: allowed })
    const created = await first.createOrBind(command)
    if (created.status !== 'accepted') throw new Error('create unavailable')
    first.dispose()
    const second = broker.bind({ ownerKey: 'chatroom', active: () => true, authorize: allowed })
    const reconciled = await second.createOrBind(command)
    expect(reconciled.status).toBe('accepted')
    if (reconciled.status !== 'accepted') throw new Error('reconcile unavailable')
    expect(reconciled.delivery.disposition).toBe('reconciled')
    expect(reconciled.binding.task).toBe(created.binding.task)
    expect(reconciled.binding.binding.generation).toBe(created.binding.binding.generation + 1)
    expect(reconciled.detailsUrl).toEqual(created.detailsUrl)
    expect(host.snapshot().tasks).toHaveLength(1)
    second.dispose()
    expect(host.snapshot().tasks[0]?.active).toBe(false)
  })

  it('validates canonical Host and external task URLs', () => {
    expect(canonicalAgentLoopTaskDetailsUrl({ url: 'app://-/playground/simulator/tasks/1', target: 'host' })).toBeDefined()
    expect(canonicalAgentLoopTaskDetailsUrl({ url: 'codex:task/1', target: 'external' })).toBeDefined()
    expect(canonicalAgentLoopTaskDetailsUrl({ url: 'http://example.com', target: 'external' } as never)).toBeUndefined()
    expect(canonicalAgentLoopTaskDetailsUrl({ url: 'app://-/task', target: 'external' } as never)).toBeUndefined()
    expect(canonicalAgentLoopTaskDetailsUrl({ url: 'https://user:pass@example.com/task', target: 'external' })).toBeUndefined()
  })
})
