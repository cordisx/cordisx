import { describe, expect, it, vi } from 'vitest'
import { ChannelLiveTurnControl } from '../packages/cli/src/launcher/channel-live-turn-control.js'

describe('Channel exact native turn control', () => {
  it('interrupts only the requested turn and requires its terminal interrupted readback', async () => {
    const statuses = ['inProgress', 'inProgress', 'interrupted']
    const nativeRequest = vi.fn(async (method: string, input: Record<string, unknown>) => {
      if (method === 'turn/interrupt') return {}
      return { data: [{ id: input.threadId === 'source' ? 'turn' : 'wrong', status: statuses.shift() }] }
    })
    const control = new ChannelLiveTurnControl({ nativeRequest }, async () => {}, 3)
    expect(await control.interruptExact('source', 'turn')).toBe('interrupted')
    expect(nativeRequest.mock.calls.filter(call => call[0] === 'turn/interrupt')).toEqual([
      ['turn/interrupt', { threadId: 'source', turnId: 'turn' }],
    ])
  })
  it('does not issue an interrupt to an unknown turn, and never retries an uncertain write', async () => {
    const unknown = vi.fn(async () => ({ data: [{ id: 'other', status: 'inProgress' }] }))
    expect(
      await new ChannelLiveTurnControl({ nativeRequest: unknown }, async () => {}, 1)
        .interruptExact('source', 'turn'),
    ).toBe('uncertain')
    expect(unknown).toHaveBeenCalledTimes(1)
    const lost = vi.fn(async (method: string) => {
      if (method === 'turn/interrupt') throw new Error('connection lost')
      return { data: [{ id: 'turn', status: 'inProgress' }] }
    })
    expect(
      await new ChannelLiveTurnControl({ nativeRequest: lost }, async () => {}, 1)
        .interruptExact('source', 'turn'),
    ).toBe('uncertain')
    expect(lost.mock.calls.filter(call => call[0] === 'turn/interrupt')).toHaveLength(1)
  })
  it('distinguishes a naturally completed turn from an accepted interruption', async () => {
    const nativeRequest = vi.fn(async () => ({ data: [{ id: 'turn', status: 'completed' }] }))
    expect(
      await new ChannelLiveTurnControl({ nativeRequest }, async () => {}, 1)
        .interruptExact('source', 'turn'),
    ).toBe('already-completed')
    expect(nativeRequest).toHaveBeenCalledTimes(1)
  })
})
