import { describe, expect, it } from 'vitest'
import { AgentRouteSessionScopeAuthority, type AgentActiveRoute } from '../packages/cli/src/renderer/agent-route-session-scope.js'

const owner = { pluginId: 'file:///plugins/chatroom.mjs:org.cordisx.chatroom', generation: 7 } as const
const declaration = {
  name: 'sessions.subscribe' as const,
  required: false,
  scope: { sessionIds: { kind: 'host-route-param' as const, routeId: 'room-session-detail', param: 'sessionId' } },
}

function harness(input: { active?: AgentActiveRoute; allow?: boolean } = {}) {
  let active = input.active
  const plans: { readonly scope: { readonly sessionIds: readonly string[] } }[] = []
  const authority = new AgentRouteSessionScopeAuthority({
    activeRoute: () => active,
    routes: plugin => plugin === owner.pluginId ? [{ id: 'room-session-detail', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId' }] : [],
    decide: async plan => {
      plans.push(plan)
      return Object.freeze({ authorized: input.allow !== false && plan.scope.sessionIds.length === 1 })
    },
    connectionGeneration: () => 1,
  })
  return { authority, plans, setActive: (next: AgentActiveRoute | undefined) => { active = next } }
}

describe('Host route-bound Agent Session authorization', () => {
  it('allows only the exact SessionId from the active same-plugin route and emits an exact v4 plan', async () => {
    const { authority, plans } = harness({ active: { owner: owner.pluginId, routeId: 'room-session-detail', instanceId: 'route-1', params: { sessionId: 'session-1' } } })
    authority.install(owner.pluginId, [declaration])
    authority.validateInstalledRoutes(owner.pluginId)
    await expect(authority.authorize(owner, 'sessions.subscribe', 'session-1')).resolves.toBe(true)
    expect(plans).toMatchObject([{ scope: { sessionIds: ['session-1'] } }])
    await expect(authority.authorize(owner, 'sessions.subscribe', 'session-2')).resolves.toBe(false)
  })

  it('requires create to use the active route SessionId before the Session exists', async () => {
    const { authority, plans } = harness({ active: { owner: owner.pluginId, routeId: 'room-session-detail', instanceId: 'route-1', params: { sessionId: 'session-to-create' } } })
    authority.install(owner.pluginId, [{
      name: 'agents.create', required: false,
      scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } },
    }])
    authority.validateInstalledRoutes(owner.pluginId)
    await expect(authority.authorize(owner, 'agents.create', 'session-to-create')).resolves.toBe(true)
    await expect(authority.authorize(owner, 'agents.create', 'other-session')).resolves.toBe(false)
    await expect(authority.authorize(owner, 'agents.create')).resolves.toBe(false)
    expect(plans).toMatchObject([{ scope: { sessionIds: ['session-to-create'] } }])
  })

  it('rejects empty, wildcard, cross-owner, inactive, unresolved, and required dynamic declarations', async () => {
    const { authority, setActive } = harness({ active: { owner: 'https://other.test:chatroom', routeId: 'room-session-detail', instanceId: 'route-1', params: { sessionId: 'session-1' } } })
    authority.install(owner.pluginId, [declaration])
    authority.validateInstalledRoutes(owner.pluginId)
    await expect(authority.authorize(owner, 'sessions.subscribe', 'session-1')).resolves.toBe(false)
    setActive(undefined)
    await expect(authority.authorize(owner, 'sessions.subscribe', 'session-1')).resolves.toBe(false)
    expect(() => authority.install(owner.pluginId, [{ ...declaration, required: true }])).toThrow('invalid dynamic')
    expect(() => authority.install(owner.pluginId, [{ ...declaration, scope: { sessionIds: [] } }])).toThrow('Session read')
    expect(() => authority.install(owner.pluginId, [{ ...declaration, scope: { sessionIds: ['*'] } }])).toThrow('Session read')
    const unresolved = new AgentRouteSessionScopeAuthority({
      activeRoute: () => undefined, routes: () => [], decide: async () => Object.freeze({ authorized: true }), connectionGeneration: () => 1,
    })
    unresolved.install(owner.pluginId, [declaration])
    expect(() => unresolved.validateInstalledRoutes(owner.pluginId)).toThrow('owned route')
  })

  it('settles the route lease only once when navigation or permission revocation fences it', async () => {
    const { authority, setActive } = harness({ active: { owner: owner.pluginId, routeId: 'room-session-detail', instanceId: 'route-1', params: { sessionId: 'session-1' } } })
    authority.install(owner.pluginId, [declaration])
    authority.validateInstalledRoutes(owner.pluginId)
    expect(await authority.authorize(owner, 'sessions.subscribe', 'session-1')).toBe(true)
    const fences: string[] = []
    authority.subscribe((_owner, sessionId, code) => fences.push(`${sessionId}:${code}`))
    setActive({ owner: owner.pluginId, routeId: 'room-session-detail', instanceId: 'route-2', params: { sessionId: 'session-2' } })
    authority.reconcileRoutes()
    authority.revoke(owner.pluginId)
    expect(fences).toEqual(['session-1:route-replaced'])
  })
})
