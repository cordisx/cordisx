import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { CordisXPluginManifestV5, CordisXPluginManifestV6, CordisXPluginManifestV7, CordisXPluginManifestV8 } from '../packages/cli/src/permission-contracts.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV5 } from '../packages/cli/src/permission-model-v4.js'
import { BrowserPermissionPrompt, MemoryPermissionPolicyStore, PermissionBroker, type PermissionPrompt } from '../packages/cli/src/renderer/platform.js'

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
      .toEqual([{ name: 'sessions.subscribe', required: false, scope: {} }])
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

  it('uses the Host development authority to persist an exact lease without a dialog', async () => {
    const store = new MemoryPermissionPolicyStore()
    const request = vi.fn<PermissionPrompt['request']>(async () => 'deny')
    const broker = new PermissionBroker(store, { request })
    broker.register(identity, {
      ...manifest,
      capabilities: [{ name: 'sessions.get', required: true, scope: {} }],
    })
    broker.replaceAgentRuntimeConnection(connection)
    const authority = broker.createDevelopmentAgentRuntimeAuthorizationAuthority()
    const decision = await broker.authorizeDevelopmentAgentRuntime(authority, {
      identity, capability: 'sessions.get', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-exact', exactSessionId: 'room-a-run-a' }, connection,
    })

    expect(request).not.toHaveBeenCalled()
    expect(decision.authorized).toBe(true)
    expect(decision.lease?.sessionId).toBe('room-a-run-a')
    expect(broker.isAgentRuntimeLeaseActive(identity, decision.lease!.leaseId)).toBe(true)
    expect(store.readV4()).toEqual([
      expect.objectContaining({
        schemaVersion: 4,
        key: expect.objectContaining({
          identity: { source: identity.source, pluginId: identity.id },
          capability: 'sessions.get',
          scope: { sessionIds: ['room-a-run-a'] },
        }),
        policy: 'allow-persistent',
      }),
    ])
  })

  it('admits explicit local-development Agent runtime authorization for every supported manifest predecessor through v8, and rejects unknown versions', async () => {
    const manifests: readonly (CordisXPluginManifestV5 | CordisXPluginManifestV6 | CordisXPluginManifestV7 | CordisXPluginManifestV8)[] = [
      manifest,
      { ...manifest, $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6, schemaVersion: 6 },
      { ...manifest, $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V7, schemaVersion: 7 },
      { ...manifest, $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V8, schemaVersion: 8 },
    ]
    for (const candidate of manifests) {
      const store = new MemoryPermissionPolicyStore()
      const broker = new PermissionBroker(store, prompt)
      broker.register(identity, candidate)
      broker.replaceAgentRuntimeConnection(connection)
      const authority = broker.createDevelopmentAgentRuntimeAuthorizationAuthority()
      const result = await broker.authorizeDevelopmentAgentRuntime(authority, {
        identity, capability: 'agents.create', sessionId: `cx-session.manifest-v${candidate.schemaVersion}`,
        scopeSource: { kind: 'host-create', reservedSessionId: `cx-session.manifest-v${candidate.schemaVersion}` }, connection,
      })
      expect(result.authorized).toBe(true)
      expect(store.readV4()).toEqual([expect.objectContaining({
        key: expect.objectContaining({ capability: 'agents.create', scope: { sessionIds: [`cx-session.manifest-v${candidate.schemaVersion}`] } }),
        policy: 'allow-persistent',
      })])
    }

    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt)
    broker.register(identity, { ...manifest, $schema: 'https://example.invalid/plugin-manifest.v9.schema.json', schemaVersion: 9 } as never)
    broker.replaceAgentRuntimeConnection(connection)
    const authority = broker.createDevelopmentAgentRuntimeAuthorizationAuthority()
    await expect(broker.authorizeDevelopmentAgentRuntime(authority, {
      identity, capability: 'agents.create', sessionId: 'cx-session.unknown',
      scopeSource: { kind: 'host-create', reservedSessionId: 'cx-session.unknown' }, connection,
    })).resolves.toEqual({ authorized: false })
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

  it('adds a Host-authorized scenario route without replacing the visible Room lease', async () => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt)
    broker.register(identity, manifest)
    broker.replaceAgentRuntimeConnection(connection)
    broker.replaceAgentRuntimeRouteScope(route)
    const seed = broker.createDevelopmentAgentRuntimePolicySeedAuthority()
    await broker.seedAgentRuntimePolicies(seed, identity, [
      { capability: 'sessions.subscribe', sessionIds: ['room-a-run-a'], policy: 'allow-persistent' },
      { capability: 'sessions.subscribe', sessionIds: ['room-a-reviewer'], policy: 'allow-persistent' },
    ])
    const visible = await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-run-a',
      scopeSource: { kind: 'host-route', routeInstanceId: route.routeInstanceId, routeId: route.routeId, path: route.path, params: route.params }, connection,
    })
    const authority = broker.createPlaygroundScenarioAgentRuntimeRouteAuthority()
    const scenarioRoute = {
      ...route, routeInstanceId: 'playground-scenario:run-one', params: { sessionId: 'room-a-reviewer' },
    }
    const close = broker.activatePlaygroundScenarioAgentRuntimeRoute(authority, route.routeInstanceId, scenarioRoute)
    const reviewer = await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-reviewer',
      scopeSource: {
        kind: 'host-route', routeInstanceId: scenarioRoute.routeInstanceId,
        routeId: scenarioRoute.routeId, path: scenarioRoute.path, params: scenarioRoute.params,
      }, connection,
    })
    expect(visible.authorized).toBe(true)
    expect(reviewer.authorized).toBe(true)
    const fences: string[] = []
    broker.subscribeAgentRuntimePermissionFences(fence => fences.push(`${fence.sessionId}:${fence.code}`))
    close()
    close()
    expect(broker.isAgentRuntimeLeaseActive(identity, visible.lease!.leaseId)).toBe(true)
    expect(broker.isAgentRuntimeLeaseActive(identity, reviewer.lease!.leaseId)).toBe(false)
    expect(fences).toEqual(['room-a-reviewer:route-replaced'])
    expect(() => broker.activatePlaygroundScenarioAgentRuntimeRoute({}, route.routeInstanceId, scenarioRoute))
      .toThrow('authority is invalid')
  })

  it('mounts a captured Shell scenario route without consulting a transient foreground route', async () => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), prompt)
    broker.register(identity, manifest)
    broker.replaceAgentRuntimeConnection(connection)
    const seed = broker.createDevelopmentAgentRuntimePolicySeedAuthority()
    await broker.seedAgentRuntimePolicies(seed, identity, [
      { capability: 'sessions.subscribe', sessionIds: ['room-a-reviewer'], policy: 'allow-persistent' },
    ])
    const authority = broker.createPlaygroundScenarioAgentRuntimeRouteAuthority()
    const scenarioRoute = {
      ...route, routeInstanceId: 'playground-scenario:captured-run', params: { sessionId: 'room-a-reviewer' },
    }

    const close = broker.activateCapturedPlaygroundScenarioAgentRuntimeRoute(authority, scenarioRoute)
    const reviewer = await broker.authorizeAgentRuntime({
      identity, capability: 'sessions.subscribe', sessionId: 'room-a-reviewer',
      scopeSource: {
        kind: 'host-route', routeInstanceId: scenarioRoute.routeInstanceId,
        routeId: scenarioRoute.routeId, path: scenarioRoute.path, params: scenarioRoute.params,
      }, connection,
    })

    expect(reviewer.authorized).toBe(true)
    close()
    expect(broker.isAgentRuntimeLeaseActive(identity, reviewer.lease!.leaseId)).toBe(false)
  })

  it('closes active and queued prompts when the plugin generation is replaced', async () => {
    const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true })
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), new BrowserPermissionPrompt(dom.window.document))
    const unregister = broker.register(identity, {
      ...manifest,
      capabilities: [{ name: 'sessions.get', required: true, scope: {} }],
    }, { pluginId: identity.id, moduleGeneration: 'generation-1' })
    broker.replaceAgentRuntimeConnection(connection)
    const authorize = (sessionId: string) => broker.authorizeAgentRuntime({
      identity, capability: 'sessions.get' as const, sessionId,
      scopeSource: { kind: 'host-exact' as const, exactSessionId: sessionId }, connection,
    })
    const first = authorize('room-a-run-a')
    const queued = authorize('room-a-run-b')
    await Promise.resolve()
    await Promise.resolve()
    expect(dom.window.document.querySelectorAll('[data-permission-prompt]')).toHaveLength(1)

    unregister()

    await expect(first).resolves.toEqual({ authorized: false })
    await expect(queued).resolves.toEqual({ authorized: false })
    expect(dom.window.document.querySelectorAll('[data-permission-prompt]')).toHaveLength(0)
    dom.window.close()
  })
})
