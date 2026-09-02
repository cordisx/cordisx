import { describe, expect, it } from 'vitest'
import type { CordisXPluginManifestV5 } from '../packages/cli/src/permission-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV5 } from '../packages/cli/src/permission-model-v4.js'
import { MemoryPermissionPolicyStore, PermissionBroker, type PermissionPrompt } from '../packages/cli/src/renderer/platform.js'

const identity = { source: 'file:///plugins/chatroom.mjs', id: 'org.cordisx.chatroom' } as const
const connection = { connectionId: 'development-host-transport', generation: 1 } as const
const route = {
  kind: 'host-route' as const, active: true as const,
  owner: { source: identity.source, pluginId: identity.id }, routeId: 'room-session-detail',
  routeInstanceId: 'main:route-1', path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
  params: { sessionId: 'room-a-run-a' },
}
const manifest: CordisXPluginManifestV5 = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5, schemaVersion: 5, id: identity.id, services: [],
  capabilities: [
    { name: 'agents.create', required: true, scope: {} },
    { name: 'sessions.subscribe', required: false, scope: { sessionIds: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } } },
  ],
}
const prompt: PermissionPrompt = { request: async () => 'deny' }

describe('Agent Session permission-v4 Host authority', () => {
  it('normalizes unbound declarations for exact per-Session prompting', () => {
    expect(normalizePluginManifestV5({
      ...manifest,
      capabilities: [{ name: 'sessions.subscribe', required: false, scope: {} }],
    }, identity.id, { assertScope: () => {} }).capabilities)
      .toEqual([{ name: 'sessions.subscribe', required: false, scope: { sessionIds: undefined } }])
  })

  it('prompts for an exact Host-reserved SessionId and persists an allow decision', async () => {
    const requested: string[] = []
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), {
      request: async input => {
        requested.push(`${input.declaration.name}:${input.requested.agentSessionId}`)
        return 'allow'
      },
    })
    broker.register(identity, manifest)
    broker.replaceAgentRuntimeConnection(connection)
    const input = {
      identity, capability: 'agents.create' as const, sessionId: 'host-reserved-session',
      scopeSource: { kind: 'host-create' as const, reservedSessionId: 'host-reserved-session' }, connection,
    }
    expect((await broker.authorizeAgentRuntime(input)).authorized).toBe(true)
    expect((await broker.authorizeAgentRuntime(input)).authorized).toBe(true)
    expect(requested).toEqual(['agents.create:host-reserved-session'])
  })

  it('admits one unbound Session capability only through its Host-issued exact scope', async () => {
    const requested: string[] = []
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), {
      request: async input => { requested.push(String(input.requested.agentSessionId)); return 'allow-once' },
    })
    broker.register(identity, {
      ...manifest,
      capabilities: [{ name: 'sessions.subscribe', required: false, scope: {} }],
    })
    broker.replaceAgentRuntimeConnection(connection)
    expect((await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-exact', exactSessionId: 'room-a-run-a' }, connection,
    })).authorized).toBe(true)
    expect(await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-exact', exactSessionId: 'different-session' }, connection,
    })).toEqual({ authorized: false })
    expect(requested).toEqual(['room-a-run-a'])
  })

  it('allows only seeded exact create and active same-plugin route leases', async () => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt)
    const seed = broker.createDevelopmentAgentRuntimePolicySeedAuthority()
    await broker.seedAgentRuntimePolicies(seed, identity, [
      { capability: 'agents.create', sessionIds: ['room-a-run-a'], policy: 'allow-persistent' },
      { capability: 'sessions.subscribe', sessionIds: ['room-a-run-a'], policy: 'allow-persistent' },
    ])
    broker.register(identity, manifest)
    broker.replaceAgentRuntimeConnection(connection)
    broker.replaceAgentRuntimeRouteScope(route)
    const created = await broker.authorizeAgentRuntime({
      identity, capability: 'agents.create', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-create', reservedSessionId: 'room-a-run-a' }, connection,
    })
    expect(created.authorized).toBe(true)
    expect(created.lease).toBeDefined()
    const subscribed = await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-route', routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: route.params }, connection,
    })
    expect(subscribed.authorized).toBe(true)
    expect(broker.isAgentRuntimeLeaseActive(identity, subscribed.lease!.leaseId)).toBe(true)
    await expect(broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'other',
      scopeSource: { kind: 'host-route', routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: { sessionId: 'other' } }, connection,
    })).resolves.toEqual({ authorized: false })
  })

  it('fences a route lease exactly once on route replacement and rejects its stale handle', async () => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt)
    broker.register(identity, manifest)
    broker.replaceAgentRuntimeConnection(connection)
    broker.replaceAgentRuntimeRouteScope(route)
    const seed = broker.createDevelopmentAgentRuntimePolicySeedAuthority()
    await broker.seedAgentRuntimePolicies(seed, identity, [
      { capability: 'sessions.subscribe', sessionIds: ['room-a-run-a'], policy: 'allow-persistent' },
    ])
    const decision = await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-route', routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: route.params }, connection,
    })
    const fences: string[] = []
    broker.subscribeAgentRuntimePermissionFences(fence => fences.push(`${fence.sessionId}:${fence.code}`))
    broker.replaceAgentRuntimeRouteScope({ ...route, routeInstanceId: 'main:route-2', params: { sessionId: 'room-a-run-b' } })
    broker.revokeAgentRuntimeRoute('main:route-1')
    expect(fences).toEqual(['room-a-run-a:route-replaced'])
    expect(broker.isAgentRuntimeLeaseActive(identity, decision.lease!.leaseId)).toBe(false)
  })
})
