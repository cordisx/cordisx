import { describe, expect, it } from 'vitest'
import {
  deriveOverview,
  filterTraceEvents,
  groupTraceEvents,
  orderTraceEvents,
} from '../src/model.js'
import { FixtureTraceShowcaseStore } from '../src/providers.js'

describe('Agent Trace Timeline model', () => {
  it('filters across lanes, provenance, source, type, phase, and text', () => {
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const events = store.getSnapshot().events
    expect(filterTraceEvents(events, {
      search: 'Steer requested', lane: 'injection', truth: 'cordisx', source: 'agent-trace-showcase',
      type: 'message.delivery', phase: 'requested',
    })).toEqual([
      expect.objectContaining({
        type: 'message.delivery', semanticType: 'agent.steer', phase: 'requested', lane: 'injection',
      }),
    ])
    expect(filterTraceEvents(events, {
      search: 'no-match', lane: 'all', truth: 'all', source: 'all', type: 'all', phase: 'all',
    })).toEqual([])
    store.dispose()
  })

  it('orders, groups by turn/step, and derives bounded four-lane overview spans', () => {
    const store = new FixtureTraceShowcaseStore({ sessionId: 'session-a' })
    const events = store.getSnapshot().events
    const ordered = orderTraceEvents([...events].reverse(), 'sequence')
    expect(ordered.map(event => event.seq)).toEqual([...ordered.map(event => event.seq)].sort((a, b) => a - b))
    const groups = groupTraceEvents(ordered)
    expect(groups.map(group => group.turnNumber)).toEqual([7, 8])
    expect(groups[0]?.steps.map(step => step.stepNumber)).toEqual([1, 2])
    expect(groups[1]?.steps.map(step => step.stepNumber)).toEqual([1, 2])
    for (const mode of ['sequence', 'time'] as const) {
      const spans = deriveOverview(ordered, mode)
      expect(spans).toHaveLength(ordered.length)
      expect(spans.every(span => span.left >= 0 && span.left <= 100 && span.width > 0)).toBe(true)
      expect(new Set(spans.map(span => span.event.lane))).toEqual(new Set(['input', 'model', 'tools', 'injection']))
    }
    store.dispose()
  })
})
