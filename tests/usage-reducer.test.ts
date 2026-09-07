import { describe, expect, it } from 'vitest'
import { reduceUsageRecords, type UsageTokenVector } from '../packages/cli/src/launcher/usage-reducer.js'

function meta(id = 'owner', extras: Record<string, unknown> = {}) {
  return { type: 'session_meta', payload: { id, ...extras } }
}
function usage(input: number, output = 0, extras: Partial<UsageTokenVector> = {}): UsageTokenVector {
  return {
    input_tokens: input,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
    ...extras,
  }
}
function token(total: UsageTokenVector, last: UsageTokenVector, ordinal?: number) {
  return {
    type: 'event_msg',
    ordinal,
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } },
  }
}
function baseline() {
  return reduceUsageRecords(undefined, [meta(), token(usage(100), usage(100), 1)], { baseline: true }).state
}
const next = (records: readonly unknown[]) => reduceUsageRecords(baseline(), records, { baseline: false })

describe('metadata-only usage reducer', () => {
  it('never credits initial or explicitly requested baseline scans', () => {
    const records = [meta(), token(usage(100), usage(100), 1), token(usage(140), usage(40), 2)]
    expect(reduceUsageRecords(undefined, records, { baseline: false }).increment.inputTokens).toBe(0)
    expect(reduceUsageRecords(baseline(), records.slice(2), { baseline: true }).increment.inputTokens).toBe(0)
    expect(next(records.slice(2)).increment.inputTokens).toBe(40)
  })
  it('adds input/output once and never adds cached/reasoning subsets again', () => {
    const result = next([
      token(
        usage(900, 200, { cached_input_tokens: 500, reasoning_output_tokens: 100 }),
        usage(800, 200, { cached_input_tokens: 500, reasoning_output_tokens: 100 }),
        2,
      ),
    ])
    expect(result.increment).toEqual({ inputTokens: 800, outputTokens: 200 })
  })
  it('deduplicates repeated totals, ordinals, replayed chunks, and null rate-limit info', () => {
    const event = token(usage(140), usage(40), 2)
    const result = next([event, event, token(usage(140), usage(40), 3), {
      type: 'event_msg',
      ordinal: 4,
      payload: { type: 'token_count', info: null },
    }])
    expect(result.increment.inputTokens).toBe(40)
    expect(reduceUsageRecords(result.state, [event], { baseline: false }).increment.inputTokens).toBe(0)
    expect(result.state.lastTotal?.total_tokens).toBe(140)
  })
  it('compaction does not reset cumulative accounting or source identity', () => {
    const result = next([
      { type: 'compacted', payload: { message: 'must not be returned' } },
      token(usage(130), usage(30), 3),
    ])
    expect(result.increment.inputTokens).toBe(30)
    expect(result.state.ownerId).toBe('owner')
    expect(result.state.counterEpoch).toBe(0)
    expect(JSON.stringify(result)).not.toContain('must not be returned')
  })
  it('rejects synthetic context-window totals and rebaselines before resuming', () => {
    const result = next([
      token(usage(0, 0, { total_tokens: 128000 }), usage(0, 0, { total_tokens: 127900 }), 2),
      token(usage(150), usage(50), 3),
      token(usage(180), usage(30), 4),
    ])
    expect(result.increment.inputTokens).toBe(30)
    expect(result.diagnostics).toContainEqual({ code: 'invalid-counter', count: 1 })
  })
  it('counter reset and missing intervals create no compensation but permit later valid increments', () => {
    const reset = next([token(usage(20), usage(20), 2), token(usage(50), usage(30), 3)])
    expect(reset.increment.inputTokens).toBe(30)
    expect(reset.state.counterEpoch).toBe(1)
    const gap = next([token(usage(400), usage(100), 2), token(usage(450), usage(50), 3)])
    expect(gap.increment.inputTokens).toBe(50)
    expect(gap.diagnostics).toContainEqual({ code: 'counter-gap', count: 1 })
  })
  it('uses first child metadata, ignores inherited parent metadata, and continuously filters fork ordinals', () => {
    const child = reduceUsageRecords(undefined, [
      meta('child', { forked_from_id: 'parent', subagent_history_start_ordinal: 50 }),
      meta('parent'),
      token(usage(100000), usage(100000), 20),
      token(usage(100), usage(100), 51),
    ], { baseline: true })
    expect(child.state.ownerId).toBe('child')
    expect(child.state.lastTotal?.total_tokens).toBe(100)
    const result = reduceUsageRecords(child.state, [
      token(usage(200000), usage(100000), 40),
      token(usage(150), usage(50), 52),
      token(usage(250), usage(100)),
    ], { baseline: false })
    expect(result.increment.inputTokens).toBe(50)
    expect(result.state.lastTotal?.total_tokens).toBe(150)
  })
  it('never bills unknown forks, missing owners, or an invalid first owner', () => {
    for (
      const records of [
        [meta('child', { forked_from_id: 'parent' })],
        [],
        [meta('../unsafe'), meta('parent')],
      ]
    ) {
      const initial = reduceUsageRecords(undefined, records, { baseline: true })
      const result = reduceUsageRecords(initial.state, [
        token(usage(100), usage(100), 1),
        token(usage(200), usage(100), 2),
      ], { baseline: false })
      expect(result.increment.inputTokens).toBe(0)
    }
  })
  it('parses complete JSONL strings but emits no message bodies, raw fields or paths', () => {
    const result = next([
      JSON.stringify({ type: 'response_item', payload: { content: 'secret conversation', path: '/private/path' } }),
      JSON.stringify(token({ ...usage(125), private_secret: 'secret' } as UsageTokenVector, usage(25), 2)),
    ])
    expect(result.increment.inputTokens).toBe(25)
    expect(JSON.stringify(result)).not.toMatch(/secret|private|content/)
  })
  it('malformed complete records and unsafe counters break continuity without throwing', () => {
    const broken = [
      '{broken json',
      token(usage(-1), usage(1), 2),
      token(usage(120, 0, { cached_input_tokens: 121 }), usage(20), 2),
      token(usage(Number.MAX_SAFE_INTEGER + 1), usage(20), 2),
    ]
    for (const bad of broken) {
      const result = next([bad, token(usage(150), usage(50), 3), token(usage(170), usage(20), 4)])
      expect(result.increment.inputTokens).toBe(20)
    }
  })
  it('does not mutate saved state and behaves identically across restart serialization', () => {
    const previous = baseline()
    const before = structuredClone(previous)
    const first = reduceUsageRecords(previous, [token(usage(140), usage(40), 2)], { baseline: false })
    expect(previous).toEqual(before)
    const restarted = reduceUsageRecords(JSON.parse(JSON.stringify(first.state)), [token(usage(180), usage(40), 3)], {
      baseline: false,
    })
    expect(restarted.increment.inputTokens).toBe(40)
  })
  it('fails closed for damaged checkpoints and never adopts a parent after a broken first record', () => {
    expect(() => reduceUsageRecords({ ...baseline(), counterEpoch: -1 }, [], { baseline: false })).toThrow(
      'Invalid usage source checkpoint',
    )
    expect(() => reduceUsageRecords({ ...baseline(), lastTotal: usage(-1) }, [], { baseline: false })).toThrow()
    const brokenHeader = reduceUsageRecords(undefined, ['{bad owning header', meta('parent')], { baseline: true })
    expect(brokenHeader.state.ownerId).toBeNull()
    expect(
      reduceUsageRecords(brokenHeader.state, [token(usage(100), usage(100), 1), token(usage(200), usage(100), 2)], {
        baseline: false,
      }).increment.inputTokens,
    ).toBe(0)
  })
})
