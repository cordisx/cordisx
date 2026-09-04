import { describe, expect, it } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V8, type CordisXPluginManifestV8 } from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV8 } from '../packages/cli/src/permission-model-v4.js'
import { AgentRouteSessionScopeAuthority, type AgentActiveRoute } from '../packages/cli/src/renderer/agent-route-session-scope.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'

const owner = { pluginId: 'file:///plugins/chatroom.mjs:org.cordisx.chatroom', generation: 8 } as const
const requester = { agentId: 'cx-session.reviewer', sessionId: 'cx-session.reviewer', agentGeneration: 2, definition: { agentId: 'reviewer', revision: 'r1' } } as const
const authority = { agentId: 'cx-session.lead', sessionId: 'cx-session.lead', agentGeneration: 3, definition: { agentId: 'lead', revision: 'r2' } } as const
const scope = { authorityRequester: { kind: 'approval-authority-requester-route' as const, requester: { kind: 'host-route-param' as const, routeId: 'room-session-detail', param: 'sessionId' as const } } }

describe('plugin-manifest/v8 correlated approval authority', () => {
  it('accepts only the bounded answer declaration and keeps v6-style widening invalid', () => {
    const manifest = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V8, schemaVersion: 8, id: 'org.cordisx.chatroom', services: [],
      capabilities: [{ name: 'approvals.answer', required: false, scope }],
    }
    expect(normalizePluginManifestV8(manifest, manifest.id, { assertScope: () => {} })).toEqual(manifest)
    expect(() => normalizePluginManifestV8({ ...manifest, capabilities: [{ name: 'approvals.answer', required: false, scope: {} }] }, manifest.id, { assertScope: () => {} })).toThrow()
  })

  it('mints a Lead authority lease only from the exact active Reviewer route and fences route replacement', async () => {
    let active: AgentActiveRoute | undefined = { owner, routeId: 'room-session-detail', instanceId: 'reviewer-route', params: { sessionId: requester.sessionId } }
    const authorityScope = new AgentRouteSessionScopeAuthority({
      activeRoute: () => active,
      routes: candidate => candidate.pluginId === owner.pluginId && candidate.generation === owner.generation
        ? [{ id: 'room-session-detail', path: '/main/chatroom/:roomId/session/:sessionId', schemaVersion: 2 }] : [],
      decide: async () => ({ authorized: true }), connectionGeneration: () => 1,
    })
    authorityScope.install(owner, [{ manifestVersion: 8, name: 'approvals.answer', required: false, scope }])
    authorityScope.validateInstalledRoutes(owner)
    const lease = await authorityScope.mintApprovalAuthorityLease(owner, { routingId: 'route-1', registrationId: 'registration-1', requester, authority })
    expect(lease).toMatchObject({ correlation: { route: { sessionId: requester.sessionId }, requester, authority } })
    if (lease === undefined) throw new Error('authority lease unavailable')
    expect(authorityScope.approvalAuthorityLeaseActive(owner, lease, requester, authority)).toBe(true)
    expect(authorityScope.approvalAuthorityLeaseActive(owner, lease, requester, { ...authority, agentGeneration: 4 })).toBe(false)
    active = { owner, routeId: 'room-session-detail', instanceId: 'reviewer-route-next', params: { sessionId: requester.sessionId } }
    expect(authorityScope.approvalAuthorityLeaseActive(owner, lease, requester, authority)).toBe(false)
  })

  it('authorizes a v8 authority lease only through the current exact requester route', async () => {
    const identity = { source: 'file:///plugins/chatroom.mjs', id: 'org.cordisx.chatroom' } as const
    const connection = { connectionId: 'development-host-transport', generation: 1 } as const
    const agentOwner = { pluginId: `${identity.source}:${identity.id}`, generation: 8 } as const
    const reviewerRoute = {
      kind: 'host-route' as const, active: true as const,
      owner: { source: identity.source, pluginId: identity.id }, routeId: 'room-session-detail',
      routeInstanceId: 'main:reviewer-route', path: '/main/chatroom/:roomId/session/:sessionId',
      params: { sessionId: requester.sessionId },
    }
    const manifest: CordisXPluginManifestV8 = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V8, schemaVersion: 8, id: identity.id, services: [],
      capabilities: [{ name: 'approvals.answer', required: false, scope }],
    }
    const store = new MemoryPermissionPolicyStore()
    const broker = new PermissionBroker(store, { request: async () => 'deny' })
    broker.register(identity, manifest)
    broker.replaceAgentRuntimeConnection(connection)
    broker.replaceAgentRuntimeRouteScope(reviewerRoute)
    const developmentAuthority = broker.createDevelopmentAgentRuntimeAuthorizationAuthority()
    let active: AgentActiveRoute = {
      owner: agentOwner, routeId: reviewerRoute.routeId, instanceId: reviewerRoute.routeInstanceId, params: reviewerRoute.params,
    }
    const scopeAuthority = new AgentRouteSessionScopeAuthority({
      activeRoute: () => active,
      routes: candidate => candidate.pluginId === agentOwner.pluginId && candidate.generation === agentOwner.generation
        ? [{ id: reviewerRoute.routeId, path: reviewerRoute.path, schemaVersion: 2 }]
        : [],
      decide: async plan => {
        const decision = await broker.authorizeDevelopmentAgentRuntime(developmentAuthority, {
          identity, capability: plan.capability, sessionId: plan.scope.sessionIds[0], scopeSource: plan.scopeSource, connection,
        })
        return { authorized: decision.authorized, ...(decision.lease === undefined ? {} : { leaseId: decision.lease.leaseId }) }
      },
      isLeaseActive: (_candidate, leaseId) => broker.isAgentRuntimeLeaseActive(identity, leaseId),
      connectionGeneration: () => connection.generation,
    })
    scopeAuthority.install(agentOwner, [{ manifestVersion: 8, name: 'approvals.answer', required: false, scope }])
    scopeAuthority.validateInstalledRoutes(agentOwner)

    const lease = await scopeAuthority.mintApprovalAuthorityLease(agentOwner, {
      routingId: 'routing-1', registrationId: 'registration-1', requester, authority,
    })
    expect(lease).toBeDefined()
    if (lease === undefined) throw new Error('authority lease unavailable')
    expect(scopeAuthority.approvalAuthorityLeaseActive(agentOwner, lease, requester, authority)).toBe(true)
    expect(store.readV4()).toEqual([expect.objectContaining({
      key: expect.objectContaining({ capability: 'approvals.answer', scope: { sessionIds: [authority.sessionId] } }),
      policy: 'allow-persistent',
    })])

    await expect(broker.authorizeDevelopmentAgentRuntime(developmentAuthority, {
      identity, capability: 'approvals.answer', sessionId: authority.sessionId,
      scopeSource: { kind: 'host-exact', exactSessionId: authority.sessionId }, connection,
    })).resolves.toEqual({ authorized: false })
    await expect(broker.authorizeDevelopmentAgentRuntime(developmentAuthority, {
      identity, capability: 'approvals.answer', sessionId: requester.sessionId,
      scopeSource: {
        kind: 'host-route', routeInstanceId: reviewerRoute.routeInstanceId, routeId: reviewerRoute.routeId,
        path: reviewerRoute.path, params: reviewerRoute.params,
      }, connection,
    })).resolves.toEqual({ authorized: false })

    const nextRoute = { ...reviewerRoute, routeInstanceId: 'main:next-reviewer-route' }
    active = { owner: agentOwner, routeId: nextRoute.routeId, instanceId: nextRoute.routeInstanceId, params: nextRoute.params }
    broker.replaceAgentRuntimeRouteScope(nextRoute)
    expect(scopeAuthority.approvalAuthorityLeaseActive(agentOwner, lease, requester, authority)).toBe(false)
  })
})
