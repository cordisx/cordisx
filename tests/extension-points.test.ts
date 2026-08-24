import { describe, expect, it } from 'vitest'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_MANAGER_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
  buildExtensionPointRuntimeSnapshot,
  canonicalExtensionPointSource,
} from '../packages/cli/src/renderer/extension-points.js'
import {
  CORDISX_EXTENSION_POINT_POLICY_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3,
  type CordisXExtensionPointPolicyRecordV1,
} from '../packages/cli/src/contracts.js'
import type { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'

describe('extension point runtime contract', () => {
  it('declares the complete v2 catalog and diagnoses cross-family duplicates', () => {
    const registry = new ExtensionPointDescriptorRegistry()
    const remove = registry.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    expect(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG).toMatchObject({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
      schemaVersion: 2,
    })
    expect(registry.descriptors()).toHaveLength(33)
    expect(registry.descriptors().filter(item => item.kind === 'surface')).toHaveLength(28)
    expect(registry.descriptors().filter(item => item.kind === 'outlet')).toHaveLength(5)
    expect(registry.descriptors()
      .filter(item => item.stability === 'stable' && item.availability === 'available')
      .map(item => item.id)
      .sort()).toEqual([
      'app',
      'composer.toolbar.items',
      'environment.panel.header-actions',
      'environment.panel.sections',
      'environment.row.trailing-actions',
      'environment.section.actions',
      'environment.section.rows',
      'main',
      'session.content',
      'session.header.actions',
      'sidebar.account.menu',
      'sidebar.footer.after-control',
      'sidebar.footer.before-control',
      'sidebar.footer.menu',
      'sidebar.navigation.items',
      'workspace.toolbar.items',
    ])
    expect(registry.descriptor('session.content')).toMatchObject({
      kind: 'outlet',
      title: { namespace: 'cordisx.manager.extension-points', key: 'outlet.session.content.title', fallback: 'Session content page' },
      icon: 'host:history',
    })
    expect(registry.descriptor('session.header.actions')).toMatchObject({
      kind: 'surface', payloadFamily: 'contextual-action', stability: 'stable', availability: 'available',
    })
    expect(registry.descriptor('composer.toolbar.items')).toMatchObject({
      kind: 'surface', stability: 'stable', availability: 'available',
      anchors: [
        { id: 'submit', placements: ['before'], availability: 'available' },
        { id: 'leading', availability: 'pending' },
        { id: 'model', availability: 'pending' },
      ],
    })
    expect(registry.descriptor('panel.right.content')).toMatchObject({
      kind: 'outlet', stability: 'reserved', availability: 'unavailable',
      diagnostic: { fallback: expect.stringContaining('Reserved') },
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

  it('normalizes a v1 catalog into stable available descriptors without weakening v2 validation', () => {
    const registry = new ExtensionPointDescriptorRegistry()
    const remove = registry.registerCatalog({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'legacy.surface', kind: 'surface', title: { key: 'legacy.title', fallback: 'Legacy' },
        description: { key: 'legacy.description', fallback: 'Legacy v1 surface' }, icon: 'host:info',
      }],
    })
    expect(registry.descriptor('legacy.surface')).toMatchObject({
      payloadFamily: 'action', stability: 'stable', availability: 'available',
    })
    expect(registry.diagnostics()).toEqual([])
    remove()
    registry.dispose()
  })

  it('registers the manager-neutral v3 surface and isolated outlet with exact policy metadata', () => {
    const registry = new ExtensionPointDescriptorRegistry()
    const remove = registry.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
    expect(CORDISX_MANAGER_EXTENSION_POINT_CATALOG).toMatchObject({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3,
      schemaVersion: 3,
    })
    expect(registry.descriptors()).toHaveLength(2)
    expect(registry.descriptor('manager.settings.tabs')).toMatchObject({
      kind: 'surface', payloadFamily: 'manager-settings-tab', stability: 'stable', availability: 'available',
    })
    expect(registry.descriptor('manager.settings.content')).toMatchObject({
      kind: 'outlet', payloadFamily: 'outlet', routePathFamily: 'manager-settings',
      presentationGroup: 'manager.settings', pageChrome: ['body-only'],
      stability: 'stable', availability: 'available',
    })
    expect(registry.descriptor('manager.settings.tabs')?.description.fallback).toContain('host-rendered')
    expect(registry.descriptor('manager.settings.content')?.description.fallback).toContain('trusted-local page body')
    expect(registry.diagnostics()).toEqual([])
    remove()
    registry.dispose()
  })

  it('projects live surface and anchor availability instead of hardcoding surfaces available', () => {
    const descriptors = new ExtensionPointDescriptorRegistry()
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore(), 'generation-test')
    const i18n = {
      resolveFor: (_owner: string, message: { key: string; fallback?: string }) => ({
        text: message.fallback ?? message.key,
        namespace: 'cordisx.manager.extension-points',
        key: message.key,
      }),
      clearDiagnosticSite: () => {},
    } as unknown as CordisXI18nService
    const snapshot = buildExtensionPointRuntimeSnapshot({
      descriptors,
      broker,
      i18n,
      plugins: [],
      registrations: [],
      commands: [],
      navigation: {
        routes: [], pages: [],
        outlets: [
          { id: 'app', placement: 'application', available: true, mounted: false, presentation: 'inactive' },
          { id: 'main', placement: 'main', available: true, mounted: false, presentation: 'inactive' },
          { id: 'session.content', placement: 'session', available: true, mounted: false, presentation: 'inactive' },
        ],
      },
      surfaceAvailability: [{
        surface: 'session.header.actions', state: 'pending', code: 'session-header-seat-missing', detail: 'No unique native header seat.',
      }, {
        surface: 'composer.toolbar.items', state: 'available', anchors: [
          { id: 'submit', placements: ['before'], state: 'available' },
          { id: 'leading', placements: ['before', 'after'], state: 'pending', code: 'anchor-unverified', detail: 'Leading is not verified.' },
          { id: 'model', placements: ['before', 'after', 'menu'], state: 'pending', code: 'anchor-unverified', detail: 'Model is not verified.' },
        ],
      }],
    })
    expect(snapshot.points.find(item => item.id === 'session.header.actions')).toMatchObject({
      stability: 'stable', availability: 'pending', available: false,
      availabilityCode: 'session-header-seat-missing', availabilityDetail: 'No unique native header seat.',
    })
    expect(snapshot.points.find(item => item.id === 'composer.toolbar.items')?.anchors).toEqual([
      expect.objectContaining({ id: 'submit', availability: 'available', placements: ['before'] }),
      expect.objectContaining({ id: 'leading', availability: 'pending', availabilityCode: 'anchor-unverified' }),
      expect.objectContaining({ id: 'model', availability: 'pending', availabilityCode: 'anchor-unverified' }),
    ])
    expect(snapshot.points.find(item => item.id === 'panel.right.content')).toMatchObject({
      stability: 'reserved', availability: 'unavailable', available: false,
      availabilityDetail: expect.stringContaining('Reserved'),
    })
    broker.dispose()
    descriptors.dispose()
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
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore(), 'generation-test')
    const identity = { source: 'https://plugins.example/demo', id: 'demo' }
    broker.register(identity)
    broker.setPolicy(identity, 'sidebar.navigation.items', 'deny')

    expect(broker.authorizeSurfaceCommand('demo', 'sidebar.navigation.items', 'demo:navigation', 'demo:open')).toMatchObject({ authorized: false })
    expect(broker.authorizeSurfaceRoute('demo', 'session.header.actions', 'demo:trace', 'demo:trace.route')).toMatchObject({ authorized: true })
    expect(broker.authorizeOutletRoute('demo', 'app', 'demo:route', 'demo:page')).toMatchObject({ authorized: true })
    expect(broker.authorizeOutletPage('demo', 'app', 'demo:route', 'demo:page')).toMatchObject({ authorized: true })
    expect(broker.accessDiagnostics().map(item => item.request)).toEqual([
      expect.objectContaining({
        $schema: CORDISX_EXTENSION_POINT_ACCESS_SCHEMA_V2,
        schemaVersion: 2,
        generation: 'generation-test',
        operation: 'surface.command.invoke',
        identity: { source: identity.source, pluginId: identity.id, pointId: 'sidebar.navigation.items' },
        contributionId: 'demo:navigation', commandId: 'demo:open',
      }),
      expect.objectContaining({ operation: 'surface.route.navigate', contributionId: 'demo:trace', routeId: 'demo:trace.route' }),
      expect.objectContaining({ operation: 'outlet.route.navigate', routeId: 'demo:route', pageId: 'demo:page' }),
      expect.objectContaining({ operation: 'outlet.page.mount', routeId: 'demo:route', pageId: 'demo:page' }),
    ])
    broker.setSurfaceAvailability([{
      surface: 'session.header.actions', state: 'pending', code: 'anchor-unresolved', detail: 'No unique seat.',
    }])
    expect(broker.authorizeSurfaceRoute('demo', 'session.header.actions', 'demo:trace', 'demo:trace.route')).toMatchObject({
      authorized: false, reason: 'extension point session.header.actions is pending',
    })
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
