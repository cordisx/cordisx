import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/contracts.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import {
  CordisXAgentContextService,
  CordisXAgentTurnControlService,
} from '../packages/cli/src/renderer/agent-context-service.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/ownership.js'

function fakeBroker(authorize = vi.fn(async (..._args: any[]) => ({ ok: true }))) {
  const listeners = new Set<() => void>()
  let policy = 'allow'
  return {
    authorize,
    snapshots: () => [{
      identity: { id: 'reader', source: 'file:///reader' },
      capability: 'agent.events.read',
      policy,
      scope: { sessionIds: ['s'] },
      fingerprint: 'f',
    }],
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    revoke: () => {
      policy = 'deny'
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

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
    const fiber = root.plugin(CordisXAgentContextService, {
      broker: fakeBroker(authorize) as never,
      bridge,
      live: () => true,
    })
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
      broker: fakeBroker() as never,
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

  it('closes a late open when the owning plugin fiber is disposed', async () => {
    const root = new Context()
    let completeOpen!: (result: { status: 'open'; handle: string; cursor: number }) => void
    const bridge = {
      read: vi.fn(async () => ({ status: 'unavailable' as const, code: 'stale' as const })),
      open: vi.fn(() =>
        new Promise<{ status: 'open'; handle: string; cursor: number }>(resolve => {
          completeOpen = resolve
        })
      ),
      next: vi.fn(),
      close: vi.fn(async () => {}),
    }
    const service = root.plugin(CordisXAgentContextService, {
      broker: fakeBroker() as never,
      bridge,
      live: () => true,
    })
    await service
    let caller!: Context
    const plugin = root.plugin({
      inject: ['agentContext'],
      apply(ctx) {
        caller = ctx.extend({
          [CORDISX_PLUGIN_ID]: 'reader',
          [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
          [CORDISX_PLUGIN_GENERATION]: 'g1',
        })
      },
    })
    await plugin
    const observer = vi.fn(), pending = caller.agentContext.watch({ sessionId: 's', thresholdRatio: .9 }, observer)
    await vi.waitFor(() => expect(bridge.open).toHaveBeenCalledOnce())
    await plugin.dispose()
    completeOpen({ status: 'open', handle: 'late', cursor: 0 })
    expect(await pending).toEqual({ status: 'unavailable', code: 'generation-replaced' })
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ handle: 'late' })
    expect(observer).not.toHaveBeenCalled()
    await service.dispose()
  })

  it('requires Host ownership proof and fences an exact turn target to the plugin lifetime', async () => {
    const root = new Context(), live = { value: true }
    const bridge = {
      acquire: vi.fn(async () => ({ status: 'available' as const, handle: 'opaque' })),
      cancel: vi.fn(async () => ({ status: 'accepted' as const, outcome: 'cancelled' as const })),
    }
    const authorizeOwner = vi.fn(async (input: { sessionId: string }) =>
      input.sessionId === 'owned' ? 'host-proof' : undefined
    )
    const service = root.plugin(CordisXAgentTurnControlService, { bridge, authorizeOwner, live: () => live.value })
    await service
    let caller!: Context
    const plugin = root.plugin({
      inject: ['agentTurnControl'],
      apply(ctx) {
        caller = ctx.extend({
          [CORDISX_PLUGIN_ID]: 'reader',
          [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
          [CORDISX_PLUGIN_GENERATION]: 'g1',
        })
      },
    })
    await plugin
    expect(await caller.agentTurnControl.acquire({ sessionId: 'other', turnId: 'turn-1' })).toEqual({
      status: 'unavailable',
      code: 'denied',
    })
    expect(bridge.acquire).not.toHaveBeenCalled()
    const result = await caller.agentTurnControl.acquire({ sessionId: 'owned', turnId: 'turn-1' })
    expect(result.status).toBe('available')
    if (result.status !== 'available') throw new Error('acquire failed')
    expect(bridge.acquire).toHaveBeenCalledWith({
      sessionId: 'owned',
      turnId: 'turn-1',
      ownerAuthorization: 'host-proof',
    })
    expect(await result.target.cancel()).toEqual({ status: 'accepted', outcome: 'cancelled' })
    expect(bridge.cancel).toHaveBeenCalledWith({ handle: 'opaque' })
    await plugin.dispose()
    expect(await result.target.cancel()).toEqual({ status: 'unavailable', code: 'stale' })
    expect(bridge.cancel).toHaveBeenCalledOnce()
    live.value = false
    await service.dispose()
  })

  it('captures the exact session and turn before asynchronous ownership authorization', async () => {
    const root = new Context()
    let grant!: (proof: string) => void
    const bridge = {
      acquire: vi.fn(async () => ({ status: 'available' as const, handle: 'h' })),
      cancel: vi.fn(async () => ({ status: 'accepted' as const, outcome: 'cancelled' as const })),
    }
    const service = root.plugin(CordisXAgentTurnControlService, {
      bridge,
      live: () => true,
      authorizeOwner: () =>
        new Promise<string>(resolve => {
          grant = resolve
        }),
    })
    await service
    const caller = root.extend({
      [CORDISX_PLUGIN_ID]: 'reader',
      [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    const request = { sessionId: 'owned', turnId: 'first' }
    const pending = caller.agentTurnControl.acquire(request)
    request.sessionId = 'other'
    request.turnId = 'second'
    grant('proof')
    const result = await pending
    expect(bridge.acquire).toHaveBeenCalledWith({ sessionId: 'owned', turnId: 'first', ownerAuthorization: 'proof' })
    expect(result).toMatchObject({ status: 'available', target: { sessionId: 'owned', turnId: 'first' } })
    await service.dispose()
  })

  it('does not deliver a context sample from another session', async () => {
    const root = new Context()
    const bridge = {
      read: vi.fn(async () => ({ status: 'available' as const, sample: { sessionId: 'other' } })),
      open: vi.fn(async () => ({ status: 'open' as const, handle: 'h', cursor: 0 })),
      next: vi.fn(async () => ({
        status: 'events' as const,
        cursor: 1,
        events: [{ thresholdRatio: .9, sample: { sessionId: 'other' } }],
      })),
      close: vi.fn(async () => {}),
    }
    const service = root.plugin(CordisXAgentContextService, {
      broker: fakeBroker() as never,
      bridge: bridge as never,
      live: () => true,
    })
    await service
    const caller = root.extend({
      [CORDISX_PLUGIN_ID]: 'reader',
      [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    expect(await caller.agentContext.read('owned')).toEqual({ status: 'unavailable', code: 'unavailable' })
    const observer = vi.fn(),
      result = await caller.agentContext.watch({ sessionId: 'owned', thresholdRatio: .9 }, observer)
    if (result.status !== 'subscribed') throw new Error('watch failed')
    expect(await result.subscription.closed).toEqual({ code: 'unavailable' })
    expect(observer).not.toHaveBeenCalled()
    expect(bridge.close).toHaveBeenCalledOnce()
    await service.dispose()
  })

  it('closes a quiet watch immediately when the exact read permission is revoked', async () => {
    const root = new Context(), broker = fakeBroker()
    const bridge = {
      read: vi.fn(),
      open: vi.fn(async () => ({ status: 'open' as const, handle: 'h', cursor: 0 })),
      next: vi.fn(() => new Promise<never>(() => {})),
      close: vi.fn(async () => {}),
    }
    const service = root.plugin(CordisXAgentContextService, { broker: broker as never, bridge, live: () => true })
    await service
    const caller = root.extend({
      [CORDISX_PLUGIN_ID]: 'reader',
      [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    const observer = vi.fn(), result = await caller.agentContext.watch({ sessionId: 's', thresholdRatio: .9 }, observer)
    if (result.status !== 'subscribed') throw new Error('watch failed')
    broker.revoke()
    expect(await result.subscription.closed).toEqual({ code: 'denied' })
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ handle: 'h' })
    expect(observer).not.toHaveBeenCalled()
    expect(broker.listeners.size).toBe(0)
    await service.dispose()
  })

  it('tracks real broker policy changes without treating authorization audit updates as revocation', async () => {
    const root = new Context(), identity = { id: 'reader', source: 'file:///reader' }
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), {
      request: vi.fn(async () => 'allow' as const),
    })
    broker.register(
      identity,
      normalizePluginManifest({
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        schemaVersion: 1,
        id: identity.id,
        capabilities: [{
          name: 'agent.events.read',
          required: false,
          reason: { key: 'read', fallback: 'Read events' },
          scope: { sessionIds: ['s'] },
        }],
      }, identity.id),
      { pluginId: 'reader', moduleGeneration: 'g1' },
    )
    broker.setPolicy(identity, 'agent.events.read', 'allow')
    const bridge = {
      read: vi.fn(),
      open: vi.fn(async () => ({ status: 'open' as const, handle: 'h', cursor: 0 })),
      next: vi.fn(() => new Promise<never>(() => {})),
      close: vi.fn(async () => {}),
    }
    const service = root.plugin(CordisXAgentContextService, { broker, bridge, live: () => true })
    await service
    const caller = root.extend({
      [CORDISX_PLUGIN_ID]: identity.id,
      [CORDISX_PLUGIN_SOURCE]: identity.source,
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    const result = await caller.agentContext.watch({ sessionId: 's', thresholdRatio: .9 }, vi.fn())
    if (result.status !== 'subscribed') throw new Error('watch failed')
    await broker.authorize(identity, 'agent.events.read', { agentSessionId: 's' })
    expect(bridge.close).not.toHaveBeenCalled()
    broker.setPolicy(identity, 'agent.events.read', 'deny')
    expect(await result.subscription.closed).toEqual({ code: 'denied' })
    expect(bridge.close).toHaveBeenCalledOnce()
    await service.dispose()
    broker.dispose()
  })

  it('withholds an in-flight read or open after permission is revoked', async () => {
    const root = new Context(), broker = fakeBroker()
    let finishRead!: (value: any) => void, finishOpen!: (value: any) => void
    const bridge = {
      read: vi.fn(() =>
        new Promise<any>(resolve => {
          finishRead = resolve
        })
      ),
      open: vi.fn(() =>
        new Promise<any>(resolve => {
          finishOpen = resolve
        })
      ),
      next: vi.fn(),
      close: vi.fn(async () => {}),
    }
    const service = root.plugin(CordisXAgentContextService, { broker: broker as never, bridge, live: () => true })
    await service
    const caller = root.extend({
      [CORDISX_PLUGIN_ID]: 'reader',
      [CORDISX_PLUGIN_SOURCE]: 'file:///reader',
      [CORDISX_PLUGIN_GENERATION]: 'g1',
    })
    const read = caller.agentContext.read('s'),
      watch = caller.agentContext.watch({ sessionId: 's', thresholdRatio: .9 }, vi.fn())
    await vi.waitFor(() => {
      expect(bridge.read).toHaveBeenCalledOnce()
      expect(bridge.open).toHaveBeenCalledOnce()
    })
    broker.revoke()
    finishRead({ status: 'available', sample: { sessionId: 's' } })
    finishOpen({ status: 'open', handle: 'late', cursor: 0 })
    expect(await read).toEqual({ status: 'unavailable', code: 'denied' })
    expect(await watch).toEqual({ status: 'unavailable', code: 'denied' })
    expect(bridge.close).toHaveBeenCalledExactlyOnceWith({ handle: 'late' })
    expect(broker.listeners.size).toBe(0)
    await service.dispose()
  })
})
