import { describe, expect, it } from 'vitest'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
  canonicalExtensionPointSource,
} from '../packages/cli/src/renderer/extension-points.js'
import {
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  type CordisXExtensionPointPolicyRecordV1,
} from '../packages/cli/src/contracts.js'

describe('extension point runtime contract', () => {
  it('declares exactly thirteen retained host descriptors and diagnoses cross-family duplicates', () => {
    const registry = new ExtensionPointDescriptorRegistry()
    const remove = registry.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    expect(registry.descriptors()).toHaveLength(13)
    expect(registry.descriptors().filter(item => item.kind === 'surface')).toHaveLength(10)
    expect(registry.descriptors().filter(item => item.kind === 'outlet')).toHaveLength(3)
    expect(registry.descriptor('session.content')).toMatchObject({
      kind: 'outlet',
      title: { namespace: 'cordisx.manager.extension-points', key: 'outlet.session.content.title', fallback: 'Session content page' },
      icon: 'host:history',
    })
    expect(Object.isFrozen(registry.descriptor('session.content')?.title)).toBe(true)

    const removeDuplicate = registry.registerCatalog({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'app', kind: 'surface', title: { key: 'duplicate.title', fallback: 'Duplicate' },
        description: { key: 'duplicate.description', fallback: 'Duplicate point' }, icon: 'host:info',
      }],
    })
    expect(registry.descriptor('app')?.kind).toBe('outlet')
    expect(registry.diagnostics()).toEqual([
      expect.objectContaining({ code: 'duplicate-point-id', pointId: 'app' }),
    ])
    removeDuplicate()
    const removeInvalid = registry.registerCatalog({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'adapter.panel', kind: 'outlet', title: { key: 'adapter.title' },
        description: { key: 'adapter.description', fallback: 'Adapter panel' }, icon: 'plugin:panel',
      }],
    })
    expect(registry.descriptor('adapter.panel')).toBeUndefined()
    expect(registry.diagnostics()).toEqual([
      expect.objectContaining({ code: 'invalid-descriptor', pointId: 'adapter.panel' }),
    ])
    removeInvalid()
    remove()
    expect(registry.descriptors()).toEqual([])
    registry.dispose()
  })

  it('keys inherit/allow/deny by canonical source, plugin id, and point id', () => {
    const descriptors = new ExtensionPointDescriptorRegistry()
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const legacyIdentity = { source: 'file:///opt/cordisx/plugins/legacy.mjs', pluginId: 'legacy', pointId: 'app' }
    const stored: CordisXExtensionPointPolicyRecordV1 = {
      $schema: CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
      schemaVersion: 1,
      identity: legacyIdentity,
      policy: 'deny',
    }
    const store = new MemoryExtensionPointPolicyStore([stored])
    const broker = new ExtensionPointPolicyBroker(descriptors, store)
    broker.register({ source: legacyIdentity.source, id: legacyIdentity.pluginId })

    expect(broker.decision('legacy', 'app', 'outlet')).toMatchObject({
      policy: 'deny', effectivePolicy: 'deny', authorized: false, identity: legacyIdentity,
    })
    expect(broker.pointPolicy({ ...legacyIdentity, source: 'https://plugins.example/mirror' })).toBe('inherit')
    broker.setPolicy({ source: legacyIdentity.source, id: 'legacy' }, 'app', 'inherit')
    expect(broker.decision('legacy', 'app', 'outlet')).toMatchObject({ policy: 'inherit', effectivePolicy: 'allow', authorized: true })
    broker.setPolicy({ source: legacyIdentity.source, id: 'legacy' }, 'app', 'allow')
    expect(broker.decision('legacy', 'app', 'outlet').authorized).toBe(true)
    expect(broker.decision('legacy', 'sidebar.navigation.items', 'outlet')).toMatchObject({ authorized: false, effectivePolicy: 'deny' })
    expect(broker.decision('unbound', 'app', 'outlet')).toMatchObject({ authorized: false, effectivePolicy: 'deny' })
    expect(store.records).toEqual([expect.objectContaining({ identity: legacyIdentity, policy: 'allow' })])
    expect(canonicalExtensionPointSource('https://plugins.example/alpha/')).toBe('https://plugins.example/alpha')
    expect(() => canonicalExtensionPointSource('https://user@example.test/plugin')).toThrow(/without credentials/)
    broker.dispose()
    descriptors.dispose()
  })

  it('emits exact host-generated surface and outlet access origins', () => {
    const descriptors = new ExtensionPointDescriptorRegistry()
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    const identity = { source: 'https://plugins.example/demo', id: 'demo' }
    broker.register(identity)
    broker.setPolicy(identity, 'sidebar.navigation.items', 'deny')

    expect(broker.authorizeSurfaceCommand('demo', 'sidebar.navigation.items', 'demo:navigation', 'demo:open')).toMatchObject({ authorized: false })
    expect(broker.authorizeOutletRoute('demo', 'app', 'demo:route', 'demo:page')).toMatchObject({ authorized: true })
    expect(broker.authorizeOutletPage('demo', 'app', 'demo:route', 'demo:page')).toMatchObject({ authorized: true })
    expect(broker.accessDiagnostics().map(item => item.request)).toEqual([
      expect.objectContaining({
        operation: 'surface.command.invoke',
        identity: { source: identity.source, pluginId: identity.id, pointId: 'sidebar.navigation.items' },
        contributionId: 'demo:navigation', commandId: 'demo:open',
      }),
      expect.objectContaining({ operation: 'outlet.route.navigate', routeId: 'demo:route', pageId: 'demo:page' }),
      expect.objectContaining({ operation: 'outlet.page.mount', routeId: 'demo:route', pageId: 'demo:page' }),
    ])
    broker.dispose()
    descriptors.dispose()
  })

  it('fails closed on duplicate persisted policy tuples until the user replaces them', () => {
    const descriptors = new ExtensionPointDescriptorRegistry()
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const identity = { source: 'https://plugins.example/demo', pluginId: 'demo', pointId: 'app' }
    const record = (policy: 'allow' | 'deny'): CordisXExtensionPointPolicyRecordV1 => ({
      $schema: CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
      schemaVersion: 1,
      identity,
      policy,
    })
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore([record('allow'), record('deny')]))
    broker.register({ source: identity.source, id: identity.pluginId })
    expect(broker.decision('demo', 'app', 'outlet')).toMatchObject({ authorized: false, effectivePolicy: 'deny' })
    expect(broker.policyDiagnostics()).toEqual([expect.objectContaining({ code: 'duplicate-policy', identity })])
    broker.setPolicy({ source: identity.source, id: identity.pluginId }, 'app', 'allow')
    expect(broker.decision('demo', 'app', 'outlet')).toMatchObject({ authorized: true, effectivePolicy: 'allow' })
    expect(broker.policyDiagnostics()).toEqual([])
    broker.dispose()
    descriptors.dispose()
  })
})
