import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  CordisXAgentContextService,
  CordisXAgentTurnControlService,
} from '../packages/cli/src/renderer/agent-context-service.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

describe('Agent context public service', () => {
  it('brokers the exact session and closes the private subscription on unsubscribe', async () => {
    const root = new Context(),
      authorize = vi.fn(async (_caller, _capability, scope) => ({ ok: scope.agentSessionId === 'session-1' }))
    let deliver!: (page: any) => void
    const next = vi.fn(() =>
      new Promise<any>(resolve => {
        deliver = resolve
      })
    )
    const bridge = {
      read: vi.fn(async () => ({ status: 'unavailable' as const, code: 'stale' as const })),
      open: vi.fn(async () => ({ status: 'open' as const, handle: 'private', cursor: 0 })),
      next,
      close: vi.fn(async () => {}),
    }
    const fiber = root.plugin(CordisXAgentContextService, { broker: { authorize } as never, bridge, live: () => true })
    await fiber
    const ctx = root.extend({
      [CORDISX_PLUGIN_ID]: 'reader',
      [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    expect(await ctx.agentContext.read('other')).toEqual({ status: 'unavailable', code: 'denied' })
    expect(bridge.read).not.toHaveBeenCalled()
    const observer = vi.fn(),
      result = await ctx.agentContext.watch({ sessionId: 'session-1', thresholdRatio: .9 }, observer)
    expect(result.status).toBe('subscribed')
    if (result.status !== 'subscribed') throw new Error('watch failed')
    const event = {
      contract: 'cordisx.agent-context-threshold/v1',
      thresholdRatio: .9,
      reason: 'crossed',
      sample: { sessionId: 'session-1' },
    }
    deliver({ status: 'events', cursor: 1, events: [event] })
    await vi.waitFor(() => expect(observer).toHaveBeenCalledOnce())
    await result.subscription.unsubscribe()
    expect(await result.subscription.closed).toEqual({ code: 'unsubscribed' })
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ handle: 'private' })
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      'agent.events.read',
      { agentSessionId: 'session-1' },
      undefined,
    )
    await fiber.dispose()
  })
  it('rejects unsafe thresholds and never upgrades a read grant into turn control', async () => {
    const root = new Context()
    const contextFiber = root.plugin(CordisXAgentContextService, {
      broker: { authorize: vi.fn(async () => ({ ok: true })) } as never,
      live: () => true,
    })
    const controlFiber = root.plugin(CordisXAgentTurnControlService)
    await contextFiber
    await controlFiber
    const ctx = root.extend({
      [CORDISX_PLUGIN_ID]: 'reader',
      [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    expect(await ctx.agentContext.watch({ sessionId: 's', thresholdRatio: .96 }, () => {})).toEqual({
      status: 'unavailable',
      code: 'invalid-request',
    })
    expect(await ctx.agentContext.read('s')).toEqual({ status: 'unavailable', code: 'unsupported' })
    expect(await ctx.agentTurnControl.acquire({ sessionId: 's', turnId: 't' })).toEqual({
      status: 'unavailable',
      code: 'unsupported',
    })
    await contextFiber.dispose()
    await controlFiber.dispose()
  })
})
