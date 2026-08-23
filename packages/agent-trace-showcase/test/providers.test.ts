import { describe, expect, it } from 'vitest'
import {
  FixtureTraceShowcaseStore,
  SHOWCASE_PLUGIN,
  UnavailableTraceShowcaseStore,
} from '../src/providers.js'
import { createTraceShowcaseStore } from '../src/index.js'

describe('Agent Trace fixture provider', () => {
  it('owns every fake row, pages earlier history, and preserves exact session attribution', async () => {
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const initial = store.getSnapshot()
    expect(initial).toMatchObject({
      sessionId: 'session-a', hasEarlier: true,
      status: {
        mode: 'fixture',
        completeness: 'complete',
        contractVersion: 'cordisx.agent-events/v1',
        coreHead: '2ec9ca15234e778853104d1667c7d1c4bffff1d9',
      },
    })
    expect(initial.events.every(event => event.sessionId === 'session-a')).toBe(true)
    expect(initial.range).toMatchObject({ loaded: 16, totalAvailable: 24, renderedLimit: 500 })
    await store.loadEarlier()
    expect(store.getSnapshot()).toMatchObject({ hasEarlier: false, range: { loaded: 24 } })
    store.dispose()
  })

  it('records explicit allow ordering, source identity, cancellation, and clear without deleting history', async () => {
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a', permissionPolicy: 'allow' })
    const requestId = await store.requestDemo({ kind: 'inject', content: 'fixture payload' })
    const chain = store.getSnapshot().events.filter(event => event.requestId === requestId)
    expect(chain.map(event => event.phase)).toEqual(['requested', 'permission', 'queued'])
    expect(chain[0]).toMatchObject({
      type: 'message.delivery', semanticType: 'agent.inject', plugin: SHOWCASE_PLUGIN,
      payload: { target: 'next-step', wakeup: false, content: 'fixture payload' },
    })
    expect(chain[1]?.permission).toMatchObject({
      capability: 'agent.messages.append', policy: 'allow', outcome: 'allowed',
    })
    expect(await store.cancelQueued(requestId)).toBe(true)
    expect(store.getSnapshot().events.filter(event => event.requestId === requestId).at(-1)?.phase).toBe('cancelled')

    await store.requestDemo({ kind: 'followup' })
    await store.requestDemo({ kind: 'system-prompt-section' })
    const before = store.getSnapshot().events.length
    expect(await store.clearQueued()).toBeGreaterThanOrEqual(2)
    expect(store.getSnapshot().events.length).toBeGreaterThan(before)
    expect(store.getSnapshot().events.some(event => event.phase === 'queued')).toBe(true)
    store.dispose()
  })

  it.each([
    ['ask', ['requested', 'permission'], 'ask-pending'],
    ['deny', ['requested', 'permission', 'failed'], 'denied'],
  ] as const)('projects %s permission honestly without a queued success', async (policy, phases, outcome) => {
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a', permissionPolicy: policy })
    const requestId = await store.requestDemo({ kind: 'steer' })
    const chain = store.getSnapshot().events.filter(event => event.requestId === requestId)
    expect(chain.map(event => event.phase)).toEqual(phases)
    expect(chain.find(event => event.phase === 'permission')?.permission?.outcome).toBe(outcome)
    expect(chain.some(event => event.phase === 'queued')).toBe(false)
    store.dispose()
  })

  it.each([
    ['followup', 'agent.messages.append', { target: 'next-turn', wakeup: true }],
    ['steer', 'agent.messages.append', { target: 'next-step', wakeup: true }],
    ['inject', 'agent.messages.append', { target: 'next-step', wakeup: false }],
    ['pre-step', 'agent.messages.append', { mode: 'append-only', sourcePreserved: true }],
    ['system-prompt-section', 'agent.prompt.section', { section: 'showcase.demo' }],
    ['system-prompt-context', 'agent.prompt.context', { context: 'showcase.demo' }],
  ] as const)('projects %s semantics through the merged capability vocabulary', async (kind, capability, semantics) => {
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const requestId = await store.requestDemo({ kind })
    const chain = store.getSnapshot().events.filter(event => event.requestId === requestId)
    expect(chain.map(event => event.phase)).toEqual(['requested', 'permission', 'queued'])
    expect(chain[0]?.payload).toMatchObject(semantics)
    expect(chain[1]?.permission?.capability).toBe(capability)
    expect(chain.every(event => event.plugin === SHOWCASE_PLUGIN)).toBe(true)
    store.dispose()
  })

  it('isolates session A/B stores and exposes an honest unavailable provider', async () => {
    const a = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const b = new FixtureTraceShowcaseStore({ sessionId: 'session-b' })
    await a.requestDemo({ kind: 'followup' })
    expect(a.getSnapshot().range.totalAvailable).toBe(27)
    expect(b.getSnapshot().range.totalAvailable).toBe(24)
    expect(b.getSnapshot().events.every(event => event.sessionId === 'session-b')).toBe(true)
    a.dispose()
    b.dispose()

    const unavailable = new UnavailableTraceShowcaseStore('session-a')
    expect(unavailable.getSnapshot()).toMatchObject({
      sessionId: 'session-a', events: [], status: {
        mode: 'unavailable',
        completeness: 'unavailable',
        coreHead: '2ec9ca15234e778853104d1667c7d1c4bffff1d9',
      },
    })
    await expect(unavailable.requestDemo({ kind: 'inject' })).rejects.toThrow(/unavailable/)

    expect(createTraceShowcaseStore({ mode: 'fixture' }).getSnapshot().status.mode).toBe('unavailable')
  })
})
