import { describe, expect, it, vi } from 'vitest'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../packages/cli/src/usage-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  type CordisXPluginManifestV5,
} from '../packages/cli/src/permission-contracts.js'

const identity = { id: 'development', source: 'file:///cordisx-local-dev/project/development.js' }
const session = { providerId: 'codex', remoteSessionId: 'task-1' }
function manifest(points = ['sidebar.navigation.items', 'main']) {
  return normalizeUsageManifestV11({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
    schemaVersion: 11,
    id: identity.id,
    services: [],
    capabilities: [
      { name: 'ui.extension-points.render', required: true, scope: { extensionPoints: points } },
      { name: 'usage.read', required: true, scope: { profile: 'current' } },
      { name: 'tasks.control', required: true, scope: { sessions: [session] } },
    ],
  }, identity.id)
}
function fixture() {
  const store = new MemoryPermissionPolicyStore()
  const request = vi.fn(async () => 'deny' as const)
  const requestV2 = vi.fn(async () => undefined)
  const broker = new PermissionBroker(
    store,
    { request },
    () => new Date(),
    50,
    'profile',
    'runtime',
    undefined,
    undefined,
    { request: requestV2, requestV3: requestV2, requestV4: requestV2, requestUsageV6: requestV2 },
  )
  const mount = (generation: string, development = true, value = manifest()) =>
    broker.register(
      identity,
      value,
      { pluginId: identity.id, moduleGeneration: generation },
      undefined,
      undefined,
      development,
    )
  return { broker, store, request, requestV2, mount }
}
describe('one generation-bound local development permission default', () => {
  it('admits declared points before service activation and allows high-risk calls without prompts or persistent grants', async () => {
    const { broker, store, request, requestV2, mount } = fixture()
    const remove = mount('first')
    expect(broker.requiredDenied(identity)).toEqual([])
    for (const point of ['sidebar.navigation.items', 'main']) {
      expect(broker.domAccess(identity, point)).toMatchObject({
        authorized: true,
        authorizationOrigin: 'local-development',
      })
      expect(await broker.requestDomAccess(identity, point)).toMatchObject({ authorized: true })
    }
    // Every call remains scope-checked, including high-risk capabilities that cannot persist allow.
    expect(await broker.authorize(identity, 'tasks.control', { session })).toMatchObject({ ok: true })
    expect(await broker.authorize(identity, 'tasks.control', { session })).toMatchObject({ ok: true })
    expect(await broker.authorizeUsage(identity)).toBe(true)
    expect(
      broker.snapshots().every(item => item.policy === 'allow' && item.authorizationOrigin === 'local-development'),
    ).toBe(true)
    expect(request).not.toHaveBeenCalled()
    expect(requestV2).not.toHaveBeenCalled()
    expect(store.read()).toEqual([])
    expect(store.readV2()).toEqual([])
    expect(store.readV3()).toEqual([])
    expect(store.readV4()).toEqual([])
    remove()
    broker.dispose()
  })
  it('rebinds new scopes on HMR and does not carry authority to an installed replacement with the same identity', async () => {
    const { broker, mount, requestV2 } = fixture()
    const remove = mount('first')
    const old = broker.usageFence(identity, 'first')
    remove()
    expect(old()).toBe(false)
    expect(broker.domAccess(identity, 'main').authorized).toBe(false)
    const next = mount('second', true, manifest(['manager.content']))
    expect(broker.domAccess(identity, 'manager.content').authorized).toBe(true)
    expect(broker.domAccess(identity, 'main').authorized).toBe(false)
    next()
    mount('installed', false)
    expect(broker.requiredDenied(identity)).toEqual(['tasks.control'])
    expect(broker.domAccess(identity, 'main').authorized).toBe(false)
    expect(await broker.authorizeUsage(identity)).toBe(false)
    expect(requestV2).toHaveBeenCalledTimes(1)
    broker.dispose()
  })
  it('retains exact scopes, explicit denial, and identities without verified provenance', async () => {
    const { broker, mount, requestV2 } = fixture()
    mount('first')
    expect(await broker.authorize(identity, 'tasks.control', { session: { ...session, remoteSessionId: 'other' } }))
      .toMatchObject({ ok: false, error: { code: 'permission-scope-denied' } })
    expect(await broker.authorize(identity, 'models.read', { providerId: 'codex' }))
      .toMatchObject({ ok: false, error: { code: 'permission-undeclared' } })
    expect(broker.domAccess(identity, 'undeclared.point').authorized).toBe(false)
    await broker.setPolicy(identity, 'tasks.control', 'deny')
    expect(await broker.authorize(identity, 'tasks.control', { session })).toMatchObject({ ok: false })
    expect(broker.requiredDenied(identity)).toEqual(['tasks.control'])
    const other = { ...identity, source: 'file:///another-plugin.js' }
    broker.register(other, manifest(), { pluginId: identity.id, moduleGeneration: 'other' })
    expect(broker.domAccess(other, 'main').authorized).toBe(false)
    expect(requestV2).not.toHaveBeenCalled()
    broker.dispose()
  })
  it('grants Host DOM only within the declared roots and operations, with revocable generation leases', async () => {
    const { broker, store } = fixture()
    const value = normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
      schemaVersion: 5,
      id: identity.id,
      services: [],
      capabilities: [{
        name: 'ui.host-dom.modify',
        required: true,
        rationale: {
          title: { key: 'title', fallback: 'Modify a test root' },
          description: { key: 'description', fallback: 'Modify a test root' },
          feature: { key: 'feature', fallback: 'Development test' },
          deniedBehavior: { key: 'denied', fallback: 'Disabled' },
        },
        security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
        scope: { rootIds: ['root'], operations: ['set-text'] },
      }],
    }, identity.id) as CordisXPluginManifestV5
    const remove = broker.register(
      identity,
      value,
      { pluginId: identity.id, moduleGeneration: 'dom' },
      undefined,
      undefined,
      true,
    )
    expect(broker.requiredDenied(identity)).toEqual([])
    const grant = await broker.authorizeHostDom(identity, 'ui.host-dom.modify', 'root', ['set-text'])
    expect(grant).toMatchObject({ authorized: true, authorizationOrigin: 'local-development' })
    expect(await broker.authorizeHostDom(identity, 'ui.host-dom.modify', 'other', ['set-text']))
      .toMatchObject({ authorized: false })
    expect(broker.isHostDomLeaseActive(identity, grant.lease!.leaseId)).toBe(true)
    remove()
    expect(broker.isHostDomLeaseActive(identity, grant.lease!.leaseId)).toBe(false)
    expect(store.readV4()).toEqual([])
    broker.dispose()
  })
  it('automatically authorizes exact Agent leases without persisting development as user consent', async () => {
    const { broker, store, request } = fixture()
    const connection = { connectionId: 'connection', generation: 1 }
    const value: CordisXPluginManifestV5 = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
      schemaVersion: 5,
      id: identity.id,
      services: [],
      capabilities: [{ name: 'sessions.get', required: true, scope: {} }],
    }
    const remove = broker.register(
      identity,
      value,
      { pluginId: identity.id, moduleGeneration: 'agent' },
      undefined,
      undefined,
      true,
    )
    broker.replaceAgentRuntimeConnection(connection)
    const grant = await broker.authorizeAgentRuntime({
      identity,
      capability: 'sessions.get',
      sessionId: 'session',
      scopeSource: { kind: 'host-exact', exactSessionId: 'session' },
      connection,
    })
    expect(grant.authorized).toBe(true)
    expect(store.readV4()).toEqual([])
    expect(request).not.toHaveBeenCalled()
    remove()
    expect(broker.isAgentRuntimeLeaseActive(identity, grant.lease!.leaseId)).toBe(false)
    broker.dispose()
  })
})
