import { describe, expect, it } from 'vitest'
import type { AgentCancelCause, AgentOptions } from '@cordisx/protocol/agents/v1'
import type { UserMessage } from '@cordisx/protocol/sessions/v1'
import { CordisXAgentSessionRuntime, type CordisXPrivateAgentDriver } from '../packages/cli/src/renderer/agent-session-runtime.js'

class Driver implements CordisXPrivateAgentDriver {
  private readonly replacement = new Set<() => void>()
  readonly submitted: string[] = []
  async create(): Promise<{ readonly status: 'accepted' }> { return { status: 'accepted' } }
  async resume(): Promise<{ readonly status: 'accepted' }> { return { status: 'accepted' } }
  async submit(input: { readonly message: UserMessage }): Promise<'accepted'> { this.submitted.push(input.message.id); return 'accepted' }
  async discard(): Promise<'accepted'> { return 'accepted' }
  async cancel(_input: { readonly cause: AgentCancelCause; readonly keepInbox: boolean }): Promise<'accepted'> { return 'accepted' }
  onReplacement(listener: () => void): () => void { this.replacement.add(listener); return () => this.replacement.delete(listener) }
  replace(): void { for (const listener of this.replacement) listener() }
  dispose(): void { this.replacement.clear() }
}

const owner = { pluginId: 'registry:test', generation: 1 } as const
const message = (id: string): UserMessage => ({
  id, role: 'user', content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'plugin', pluginId: owner.pluginId, generation: owner.generation },
})

describe('Agent/Session Host authority v1', () => {
  it('creates an owner handle, admits a MessageId once, and replays one Session truth', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true, now: () => 10 })
    const created = await runtime.create(owner, { sessionId: 'session-1', mutationId: 'create-1', options: {} satisfies AgentOptions })
    expect(created).toMatchObject({ status: 'accepted', disposition: 'created', sessionId: 'session-1' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    expect(await created.handle.agent.followup(message('message-1'))).toMatchObject({ status: 'accepted', messageId: 'message-1' })
    expect(await created.handle.agent.followup(message('message-1'))).toMatchObject({ status: 'accepted', messageId: 'message-1' })
    expect(driver.submitted).toEqual(['message-1'])

    const snapshot = await created.handle.agent.session.snapshot()
    expect(snapshot).toMatchObject({ status: 'available', snapshot: { snapshotSeq: 1 } })
    const read = await created.handle.agent.session.read({ afterSeq: -1, snapshotSeq: 1, limit: 10 })
    expect(read).toMatchObject({ status: 'available', page: { events: [{ type: 'agent/inbox/spliced' }, { type: 'user/message' }] } })
  })

  it('installs the live fence before replay and closes on connection replacement', async () => {
    const driver = new Driver()
    const runtime = new CordisXAgentSessionRuntime({ driver, authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-2' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await created.handle.agent.followup(message('message-2'))
    const pages: string[] = []
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, page => { pages.push(`${page.phase}:${page.events.map(event => event.seq).join(',')}`) })
    expect(subscribed.status).toBe('subscribed')
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    expect(pages).toEqual(['replay:0,1'])
    driver.replace()
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'connection-replaced' })
    expect(await subscribed.subscription.unsubscribe()).toMatchObject({ status: 'closed', code: 'connection-replaced' })
    expect(await created.handle.agent.whenIdle()).toEqual({ status: 'unavailable', code: 'agent-replaced' })
  })

  it('uses first-terminal route fencing and never starts an observer after closure', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-closed' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const pages: string[] = []
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, page => { pages.push(page.phase) })
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    runtime.fenceSession('session-closed', 'route-replaced')
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'route-replaced' })
    expect(await subscribed.subscription.unsubscribe()).toMatchObject({ status: 'closed', code: 'route-replaced' })
    expect(pages).toEqual([])
  })

  it('fails a throwing observer closed rather than leaking a rejected subscription', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-observer-failure' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, () => { throw new Error('observer failed') })
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    await created.handle.agent.followup(message('message-observer-failure'))
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'observer-failed' })
  })

  it('fences an old owner handle and its Session subscription after permission revocation', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-revoked' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    const subscribed = await created.handle.agent.session.subscribe({ afterSeq: -1 }, () => {})
    if (subscribed.status !== 'subscribed') throw new Error('subscription unavailable')
    runtime.fenceOwner(owner.pluginId, 'permission-revoked')
    expect(await subscribed.subscription.closed).toMatchObject({ status: 'closed', code: 'permission-revoked' })
    expect(await created.handle.agent.followup(message('after-revoke'))).toMatchObject({ status: 'unavailable', code: 'agent-replaced' })
    expect(await created.handle.dispose()).toMatchObject({ status: 'unavailable', code: 'agent-replaced' })
  })

  it('records asked and exactly one decided approval fact in the same Session', async () => {
    const runtime = new CordisXAgentSessionRuntime({ driver: new Driver(), authorize: async () => true })
    const created = await runtime.create(owner, { sessionId: 'session-3' })
    if (created.status !== 'accepted') throw new Error('agent unavailable')
    await runtime.registerAnswerer(owner, created.handle.agent, async () => 'allowed-once')
    const decision = await runtime.requestApproval(owner, { agent: created.handle.agent, toolName: 'shell' })
    expect(decision.outcome).toBe('allowed-once')
    const page = await created.handle.agent.session.read({ afterSeq: -1, limit: 10 })
    expect(page).toMatchObject({ status: 'available', page: { events: [{ type: 'approval/asked' }, { type: 'approval/decided' }] } })
  })
})
