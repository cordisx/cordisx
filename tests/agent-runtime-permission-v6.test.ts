import { describe, expect, it, vi } from 'vitest'
import type { CordisXPluginManifestV6 } from '../packages/cli/src/permission-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V6 } from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV6 } from '../packages/cli/src/permission-model-v4.js'
import { MemoryPermissionPolicyStore, PermissionBroker, type PermissionPrompt } from '../packages/cli/src/renderer/platform.js'

const identity = { source: 'file:///plugins/chatroom.mjs', id: 'org.cordisx.chatroom' } as const
const connection = { connectionId: 'desktop-current-transport', generation: 3 } as const
const dynamic = { kind: 'host-route-param' as const, routeId: 'room-session-detail', param: 'sessionId' as const }
const manifest: CordisXPluginManifestV6 = {
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  schemaVersion: 6,
  id: identity.id,
  services: [],
  capabilities: [
    { name: 'approvals.request', required: false, scope: { sessionIds: dynamic } },
    { name: 'approvals.answer', required: false, scope: { sessionIds: dynamic } },
  ],
}

describe('plugin-manifest/v6 exact Session approval authority', () => {
  it('accepts exactly the complete twelve-name Agent runtime capability set', () => {
    const names = [
      'agents.create', 'agents.resume', 'agents.get', 'agents.message.submit', 'agents.message.cancel', 'agents.cancel',
      'agents.live.subscribe', 'sessions.get', 'sessions.read', 'sessions.subscribe', 'approvals.request', 'approvals.answer',
    ] as const
    const normalized = normalizePluginManifestV6({
      ...manifest,
      capabilities: names.map(name => ({ name, required: false, scope: { sessionIds: [`cx-session.${name}`] } })),
    }, identity.id, { assertScope: () => {} })
    expect(normalized.capabilities.map(item => item.name)).toEqual(names)
    expect(() => normalizePluginManifestV6({
      ...manifest,
      capabilities: [{ name: 'approvals.admin', required: false, scope: { sessionIds: ['cx-session.one'] } }],
    }, identity.id, { assertScope: () => {} })).toThrow()
  })

  it('normalizes the complete v6 approval declarations and rejects widened scopes', () => {
    expect(normalizePluginManifestV6(manifest, identity.id, { assertScope: () => {} })).toEqual(manifest)
    const invalid = [
      { name: 'approvals.request', required: true, scope: { sessionIds: dynamic } },
      { name: 'approvals.request', required: false, scope: {} },
      { name: 'approvals.request', required: false, scope: { sessionIds: [] } },
      { name: 'approvals.request', required: false, scope: { sessionIds: [''] } },
      { name: 'approvals.request', required: false, scope: { sessionIds: ['*'] } },
      { name: 'approvals.request', required: false, scope: { sessionIds: ['cx-session.*'] } },
      { name: 'approvals.request', required: false, scope: { sessionIds: ['session-one', 'session-one'] } },
      { name: 'approvals.request', required: false, scope: { sessionIds: { ...dynamic, param: 'roomId' } } },
    ]
    for (const declaration of invalid) {
      expect(() => normalizePluginManifestV6({ ...manifest, capabilities: [declaration] }, identity.id, { assertScope: () => {} })).toThrow()
    }
    expect(() => normalizePluginManifestV6({
      ...manifest,
      capabilities: [manifest.capabilities[0], manifest.capabilities[0]],
    }, identity.id, { assertScope: () => {} })).toThrow('duplicate capability')
    expect(() => normalizePluginManifestV6({
      ...manifest,
      capabilities: [{ name: 'turns.introduce', required: false, scope: {} }],
    }, identity.id, { assertScope: () => {} })).toThrow('not supported by manifest v6')
  })

  it('materializes only the active same-owner route SessionId into the existing ledger and lease', async () => {
    const request = vi.fn<PermissionPrompt['request']>(async () => 'allow-once')
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request })
    broker.register(identity, manifest, { pluginId: identity.id, moduleGeneration: 'generation-three' })
    broker.replaceAgentRuntimeConnection(connection)
    const route = {
      kind: 'host-route' as const,
      active: true as const,
      owner: { source: identity.source, pluginId: identity.id },
      routeId: 'room-session-detail',
      routeInstanceId: 'main:room-one:session-reviewer',
      path: '/main/chatroom/:roomId/session/:sessionId',
      params: { sessionId: 'cx-session.reviewer' },
    }
    broker.replaceAgentRuntimeRouteScope(route)
    const accepted = await broker.authorizeAgentRuntime({
      identity,
      capability: 'approvals.request',
      sessionId: 'cx-session.reviewer',
      scopeSource: { kind: 'host-route', routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: route.params },
      connection,
    })
    expect(accepted.authorized).toBe(true)
    expect(accepted.lease?.sessionId).toBe('cx-session.reviewer')
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ requested: { agentSessionId: 'cx-session.reviewer' } }))
    await expect(broker.authorizeAgentRuntime({
      identity,
      capability: 'approvals.request',
      sessionId: 'cx-session.lead',
      scopeSource: { kind: 'host-route', routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: { sessionId: 'cx-session.lead' } },
      connection,
    })).resolves.toEqual({ authorized: false })
    broker.replaceAgentRuntimeConnection({ ...connection, generation: 4 })
    expect(broker.isAgentRuntimeLeaseActive(identity, accepted.lease!.leaseId)).toBe(false)
  })

  it('revokes exact approval leases on policy and plugin-generation replacement', async () => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: async () => 'allow-once' })
    const unregister = broker.register(identity, manifest, { pluginId: identity.id, moduleGeneration: 'generation-three' })
    broker.replaceAgentRuntimeConnection(connection)
    const route = {
      kind: 'host-route' as const, active: true as const,
      owner: { source: identity.source, pluginId: identity.id }, routeId: 'room-session-detail',
      routeInstanceId: 'main:room-one:session-reviewer', path: '/main/chatroom/:roomId/session/:sessionId',
      params: { sessionId: 'cx-session.reviewer' },
    }
    broker.replaceAgentRuntimeRouteScope(route)
    const authorize = async () => await broker.authorizeAgentRuntime({
      identity, capability: 'approvals.request' as const, sessionId: 'cx-session.reviewer',
      scopeSource: { kind: 'host-route' as const, routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: route.params },
      connection,
    })
    const first = await authorize()
    expect(first.authorized).toBe(true)
    const seed = broker.createDevelopmentAgentRuntimePolicySeedAuthority()
    await broker.seedAgentRuntimePolicies(seed, identity, [{
      capability: 'approvals.request', sessionIds: ['cx-session.reviewer'], policy: 'deny-persistent',
    }])
    expect(broker.isAgentRuntimeLeaseActive(identity, first.lease!.leaseId)).toBe(false)
    await broker.seedAgentRuntimePolicies(seed, identity, [{
      capability: 'approvals.request', sessionIds: ['cx-session.reviewer'], policy: 'allow-persistent',
    }])
    const second = await authorize()
    expect(second.authorized).toBe(true)
    unregister()
    expect(broker.isAgentRuntimeLeaseActive(identity, second.lease!.leaseId)).toBe(false)
    broker.register(identity, manifest, { pluginId: identity.id, moduleGeneration: 'generation-four' })
    await expect(authorize()).resolves.toMatchObject({ authorized: true })
  })
})
