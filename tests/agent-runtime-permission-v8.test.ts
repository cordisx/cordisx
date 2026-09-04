import { describe, expect, it } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V8 } from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV8 } from '../packages/cli/src/permission-model-v4.js'
import { AgentRouteSessionScopeAuthority, type AgentActiveRoute } from '../packages/cli/src/renderer/agent-route-session-scope.js'

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
})
