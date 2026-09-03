import { describe, expect, it } from 'vitest'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { DeterministicAgentSessionTransport } from '../packages/cli/src/renderer/deterministic-agent-session-transport.js'

const owner = { pluginId: 'file:///fixtures/chatroom.ts:org.cordisx.chatroom', generation: 1 } as const
const message = (id: string, text: string): UserMessage => ({
  id, role: 'user', content: [{ type: 'text', text }],
  source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation },
})
const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 0))

describe('Playground deterministic Agent/Session driver', () => {
  it('creates an exact caller Session, appends fixture assistant facts, and replays them through the same Session', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new DeterministicAgentSessionTransport(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'room-preview-session-1' })
    expect(created).toMatchObject({ status: 'accepted', sessionId: 'room-preview-session-1', sessionIdSource: 'caller' })
    if (created.status !== 'accepted') throw new Error('fixture driver unavailable')
    expect(await runtime.get(owner, 'room-preview-session-1')).toBeDefined()
    const live: string[] = []
    const agentLive = await created.handle.agent.subscribe(event => { live.push(`${event.type}:${'status' in event.data ? event.data.status : ''}`) })
    expect(agentLive.status).toBe('subscribed')
    expect(created.handle.agent.status).toEqual({ status: 'available', value: 'idle' })
    expect(await created.handle.agent.followup(message('m-1', 'hello fixture [tool]'))).toMatchObject({ status: 'accepted', messageId: 'm-1' })
    await settle()
    const snapshot = await created.handle.agent.session.snapshot()
    expect(snapshot).toMatchObject({ status: 'available', snapshot: { snapshotSeq: 12 } })
    const replay = await created.handle.agent.session.read({ afterSeq: -1, limit: 20 })
    if (replay.status !== 'available') throw new Error('fixture Session unavailable')
    expect(replay.page.events.map(event => event.type)).toEqual([
      'agent/inbox/spliced', 'user/message', 'agent/inbox/spliced', 'turn/start', 'step/start', 'tool/call', 'tool/result', 'assistant/chunk',
      'assistant/chunk', 'assistant/chunk', 'assistant/message', 'step/end', 'turn/end',
    ])
    expect(replay.page.events.find(event => event.type === 'tool/result')).toMatchObject({ data: { meta: { fixture: 'deterministic-agent-session', deterministic: true } } })
    expect(replay.page.events.find(event => event.type === 'assistant/message')).toMatchObject({ data: { message: { source: { provider: 'deterministic-agent-session' } } } })
    const assistant = replay.page.events.find(event => event.type === 'assistant/message')
    expect(assistant?.type === 'assistant/message' ? assistant.data.message.id : undefined)
      .toMatch(/^deterministic-assistant\.[A-Za-z0-9._~-]+$/u)
    expect(live).toEqual(['agent/status:running', 'agent/inbox/inserted:', 'agent/inbox/claimed:', 'agent/status:idle'])
    expect(await created.handle.dispose()).toMatchObject({ status: 'accepted' })
    const resumed = await runtime.resume(owner, { sessionId: 'room-preview-session-1' })
    expect(resumed).toMatchObject({ status: 'accepted', disposition: 'resumed' })
  })

  it('uses the Host approval seam, supports pending-message discard and emits one cancelled terminal', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new DeterministicAgentSessionTransport(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'room-preview-session-2' })
    if (created.status !== 'accepted') throw new Error('fixture driver unavailable')
    await runtime.registerAnswerer(owner, created.handle.agent, async () => 'allowed-once')
    expect(await created.handle.agent.followup(message('m-approval', '[approval]'))).toMatchObject({ status: 'accepted' })
    await settle()
    expect(await created.handle.agent.followup(message('m-pending', '[pending]'))).toMatchObject({ status: 'accepted' })
    expect(await created.handle.agent.discard('m-pending')).toMatchObject({ status: 'conflict', code: 'already-claimed', messageId: 'm-pending' })
    expect(await created.handle.agent.followup(message('m-cancel', '[pending]'))).toMatchObject({ status: 'accepted' })
    expect(await created.handle.agent.cancel({ kind: 'user' })).toMatchObject({ status: 'accepted' })
    const read = await created.handle.agent.session.read({ afterSeq: -1, limit: 40 })
    if (read.status !== 'available') throw new Error('fixture Session unavailable')
    expect(read.page.events.find(event => event.type === 'approval/decided')).toMatchObject({ data: { outcome: 'allowed-once' } })
    expect(read.page.events.find(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled')).toBeDefined()
    expect(read.page.events.find(event => event.type === 'turn/end' && event.data.reason.kind === 'interrupted')).toMatchObject({
      type: 'turn/end', data: { reason: { kind: 'interrupted' } },
    })
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, () => {})
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    expect(await subscribed.subscription.unsubscribe()).toMatchObject({ status: 'closed', code: 'unsubscribed' })
    expect(await subscribed.subscription.unsubscribe()).toMatchObject({ status: 'closed', code: 'unsubscribed' })
  })
})
