import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
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
  CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V2,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V3,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V6,
  CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7,
  type CordisXExtensionPointPolicyRecordV1,
} from '../packages/cli/src/contracts.js'
import type { CordisXI18nService } from '../packages/cli/src/renderer/i18n.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

describe('extension point runtime contract', () => {
  it('keeps candidate source policy private until the shared generation flip', () => {
    const activation = (revision: number, moduleGeneration: string, sourceDigest: string): CordisXPluginActivationRecordV1 => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      ...(revision === 1 ? {} : { transactionId: 'update-demo' }),
      profileId: 'default', revision, lastGoodRevision: 1, runtimeGeneration: 'runtime-1',
      plugins: [{
        id: 'demo', version: '1.0.0', digest: `sha256:${sourceDigest.repeat(64)}`,
        moduleGeneration, enabled: true, dependencies: [],
      }],
    })
    const previous = activation(1, 'demo-1', 'a')
    const candidate = activation(2, 'demo-2', 'b')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore(), 'runtime-1', visibility)
    broker.register({ source: 'https://plugins.example/old', id: 'demo' }, { pluginId: 'demo', moduleGeneration: 'demo-1' })
    let notifications = 0
    broker.subscribe(() => { notifications += 1 })

    const handle = visibility.begin('update-demo', previous, candidate)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'demo',
      [CORDISX_PLUGIN_GENERATION]: 'demo-2',
      ...visibility.context(handle, 'demo'),
    })
    const candidateView = visibility.view(candidateContext)
    broker.register(
      { source: 'https://plugins.example/new', id: 'demo' },
      visibility.effect(candidateContext),
      candidateView,
    )
    expect(broker.decision('demo', 'app', 'outlet').identity?.source).toBe('https://plugins.example/old')
    expect(broker.decision('demo', 'app', 'outlet', candidateView).identity?.source).toBe('https://plugins.example/new')
    expect(notifications).toBe(0)

    const publication = visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    expect(broker.decision('demo', 'app', 'outlet').identity?.source).toBe('https://plugins.example/new')
    expect(notifications).toBe(1)
    visibility.rollback(publication)
    expect(broker.decision('demo', 'app', 'outlet').identity?.source).toBe('https://plugins.example/old')
    broker.dispose()
    descriptors.dispose()
  })

  it('declares the complete v7 catalog with static maturity and adapter support', () => {
    const registry = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    const remove = registry.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    expect(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG).toMatchObject({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V7,
      schemaVersion: 7,
    })
    expect(registry.descriptors()).toHaveLength(35)
    expect(registry.descriptors().filter(item => item.kind === 'surface')).toHaveLength(30)
    expect(registry.descriptors().filter(item => item.kind === 'outlet')).toHaveLength(5)
    expect(registry.descriptors()
      .filter(item => item.maturity === 'stable' && item.adapterSupport === 'supported')
      .map(item => item.id)
      .sort()).toEqual([
      'app',
      'composer.reasoning-intensity',
      'composer.toolbar.items',
      'environment.panel.header-actions',
      'environment.panel.sections',
      'environment.row.trailing-actions',
      'environment.section.actions',
      'environment.section.rows',
      'main',
      'session.backdrop',
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
      kind: 'surface', payloadFamily: 'contextual-action', maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.descriptor('session.header.actions')).not.toHaveProperty('availability')
    expect(registry.descriptor('session.header.actions')).not.toHaveProperty('currentContext')
    expect(registry.descriptor('composer.toolbar.items')).toMatchObject({
      kind: 'surface', maturity: 'stable', adapterSupport: 'supported',
      anchors: [
        { id: 'submit', placements: ['before'], adapterSupport: 'supported' },
        { id: 'leading', adapterSupport: 'unverified' },
        { id: 'model', adapterSupport: 'unverified' },
      ],
    })
    expect(registry.descriptor('composer.reasoning-intensity')).toMatchObject({
      kind: 'surface', payloadFamily: 'reasoning-intensity-presentation', maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.descriptor('session.backdrop')).toMatchObject({
      kind: 'surface', payloadFamily: 'session-backdrop-presentation', maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.descriptor('panel.right.content')).toMatchObject({
      kind: 'outlet', maturity: 'reserved', adapterSupport: 'unsupported',
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

  it('normalizes a v1 catalog into stable supported descriptors without weakening v5 validation', () => {
    const legacyCatalogs = [
      ...CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
      { namespace: 'host', locale: 'en', default: true, messages: { 'legacy.title': 'Legacy', 'legacy.description': 'Legacy v1 surface' } },
      { namespace: 'host', locale: 'zh-CN', messages: { 'legacy.title': '旧版点位', 'legacy.description': '旧版 v1 界面点位' } },
    ]
    const registry = new ExtensionPointDescriptorRegistry(legacyCatalogs)
    const remove = registry.registerCatalog({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'legacy.surface', kind: 'surface', title: { key: 'legacy.title', fallback: 'Legacy' },
        description: { key: 'legacy.description', fallback: 'Legacy v1 surface' }, icon: 'host:info',
      }],
    })
    expect(registry.descriptor('legacy.surface')).toMatchObject({
      payloadFamily: 'action', maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.diagnostics()).toEqual([])
    remove()
    const removeInvalidV5 = registry.registerCatalog({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
      schemaVersion: 5,
      points: [{
        id: 'stable.unverified', kind: 'surface',
        title: { key: 'stable.unverified.title', fallback: 'Stable unverified' },
        description: { key: 'stable.unverified.description', fallback: 'Invalid v5 point' },
        icon: 'host:info', payloadFamily: 'action', maturity: 'stable', adapterSupport: 'unverified',
        diagnostic: { key: 'stable.unverified.diagnostic', fallback: 'Not verified' },
      }],
    })
    expect(registry.diagnostics()).toEqual([
      expect.objectContaining({ code: 'invalid-descriptor', pointId: 'stable.unverified', message: expect.stringContaining('must be supported') }),
    ])
    removeInvalidV5()
    registry.dispose()
  })

  it('rejects a public descriptor when either required Host locale is missing', () => {
    const registry = new ExtensionPointDescriptorRegistry([
      { namespace: 'host', locale: 'en', default: true, messages: { 'missing.title': 'Title', 'missing.description': 'Description' } },
    ])
    const remove = registry.registerCatalog({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'missing.locale', kind: 'surface',
        title: { key: 'missing.title', fallback: 'Title' },
        description: { key: 'missing.description', fallback: 'Description' },
        icon: 'host:info',
      }],
    })
    expect(registry.descriptor('missing.locale')).toBeUndefined()
    expect(registry.diagnostics()).toEqual([
      expect.objectContaining({
        code: 'invalid-descriptor',
        pointId: 'missing.locale',
        message: expect.stringContaining('requires zh-CN localization'),
      }),
    ])
    remove()
    registry.dispose()
  })

  it('registers distinct Manager content-tab and first-level navigation points in the v5 catalog', () => {
    const registry = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    const remove = registry.registerCatalog(CORDISX_MANAGER_EXTENSION_POINT_CATALOG)
    expect(CORDISX_MANAGER_EXTENSION_POINT_CATALOG).toMatchObject({
      $schema: CORDISX_HOST_EXTENSION_POINT_CATALOG_SCHEMA_V5,
      schemaVersion: 5,
    })
    expect(registry.descriptors()).toHaveLength(4)
    expect(registry.descriptor('manager.settings.tabs')).toMatchObject({
      kind: 'surface', payloadFamily: 'manager-settings-content-tab', maturity: 'stable', adapterSupport: 'supported',
      title: { fallback: 'Manager settings content tabs' },
    })
    expect(registry.descriptor('manager.settings.content')).toMatchObject({
      kind: 'outlet', payloadFamily: 'outlet', routePathFamily: 'manager-settings',
      presentationGroup: 'manager.settings', pageChrome: ['body-only'],
      maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.descriptor('manager.settings.navigation-items')).toMatchObject({
      kind: 'surface', payloadFamily: 'manager-settings-navigation-item',
      title: { fallback: 'Manager settings navigation items' },
      maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.descriptor('manager.content')).toMatchObject({
      kind: 'outlet', payloadFamily: 'outlet', routePathFamily: 'manager',
      presentationGroup: 'manager', pageChrome: ['standard'],
      maturity: 'stable', adapterSupport: 'supported',
    })
    expect(registry.descriptor('manager.settings.tabs')?.description.fallback).toContain('not mounted')
    expect(registry.descriptor('manager.settings.content')?.description.fallback).toContain('not mounted')
    expect(registry.descriptor('manager.settings.navigation-items')?.description.fallback).toContain('settings extension seam')
    expect(registry.descriptor('manager.content')?.description.fallback).toContain('standard Host-owned Manager page header')
    const zh = CORDISX_EXTENSION_POINT_LOCALE_CATALOGS.find(item => item.locale === 'zh-CN')!
    expect(zh.messages['manager.settings.tabs.title']).toBe('管理器配置内容标签页')
    expect(zh.messages['manager.settings.tabs.description']).toContain('当前管理器布局未挂载')
    expect(zh.messages['manager.settings.navigation-items.title']).toBe('管理器配置导航条目')
    expect(zh.messages['manager.settings.navigation-items.description']).toContain('配置扩展缝隙')
    expect(zh.messages['manager.content.description']).toContain('标准管理器页面标题')
    expect(registry.diagnostics()).toEqual([])
    remove()
    registry.dispose()
  })

  it('projects current context separately from maturity and adapter support', () => {
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
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
      surfaceCurrentContext: [{
        surface: 'session.header.actions', state: 'not-mounted', code: 'session.not-mounted', detail: { key: 'session.not-mounted', fallback: 'No native session header is mounted.' },
      }, {
        surface: 'workspace.toolbar.items', state: 'inactive', code: 'anchor.unresolved', detail: { key: 'workspace.unresolved', fallback: 'Workspace anchor is ambiguous.' },
      }, {
        surface: 'composer.toolbar.items', state: 'active', anchors: [
          { id: 'submit', placements: ['before'], state: 'active' },
          { id: 'leading', placements: ['before', 'after'], state: 'not-mounted', code: 'anchor.not-mounted', detail: { key: 'leading.not-mounted', fallback: 'Leading is not mounted.' } },
          { id: 'model', placements: ['before', 'after', 'menu'], state: 'not-mounted', code: 'anchor.not-mounted', detail: { key: 'model.not-mounted', fallback: 'Model is not mounted.' } },
        ],
      }],
    })
    expect(snapshot.points.find(item => item.id === 'session.header.actions')).toMatchObject({
      maturity: 'stable', adapterSupport: 'supported', currentContext: 'not-mounted',
      effectiveAdapterSupport: 'supported', availability: 'available', available: true,
      availabilityCode: 'session.not-mounted', availabilityDetail: 'No native session header is mounted.',
    })
    expect(snapshot.points.find(item => item.id === 'composer.toolbar.items')?.anchors).toEqual([
      expect.objectContaining({ id: 'submit', adapterSupport: 'supported', currentContext: 'active', availability: 'available', placements: ['before'] }),
      expect.objectContaining({ id: 'leading', adapterSupport: 'unverified', effectiveAdapterSupport: 'unverified', currentContext: 'not-mounted', availability: 'pending', availabilityCode: 'anchor.not-mounted' }),
      expect.objectContaining({ id: 'model', adapterSupport: 'unverified', effectiveAdapterSupport: 'unverified', currentContext: 'not-mounted', availability: 'pending', availabilityCode: 'anchor.not-mounted' }),
    ])
    expect(snapshot.points.find(item => item.id === 'panel.right.content')).toMatchObject({
      maturity: 'reserved', adapterSupport: 'unsupported', currentContext: 'not-mounted', availability: 'unavailable', available: false,
      availabilityDetail: expect.stringContaining('Reserved'),
    })
    expect(snapshot.points.find(item => item.id === 'workspace.toolbar.items')).toMatchObject({
      adapterSupport: 'supported', effectiveAdapterSupport: 'unverified', currentContext: 'inactive',
      availability: 'pending', availabilityCode: 'anchor.unresolved',
    })
    expect(descriptors.descriptor('workspace.toolbar.items')).toMatchObject({ adapterSupport: 'supported' })
    expect(snapshot.currentContext).toMatchObject({
      $schema: CORDISX_EXTENSION_POINT_RUNTIME_CONTEXT_SCHEMA_V1,
      schemaVersion: 1,
      points: expect.arrayContaining([
        expect.objectContaining({ id: 'session.header.actions', state: 'not-mounted', code: 'session.not-mounted' }),
        expect.objectContaining({ id: 'composer.toolbar.items', state: 'active' }),
      ]),
    })
    broker.dispose()
    descriptors.dispose()
  })

  it('keys inherit/allow/deny by canonical source, plugin id, and point id', () => {
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
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
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
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
    // Current mount state is not a policy input: supported points remain authorized while not mounted.
    expect(broker.authorizeSurfaceRoute('demo', 'session.header.actions', 'demo:trace', 'demo:trace.route')).toMatchObject({
      authorized: true,
    })
    expect(broker.authorizeSurfaceRoute('demo', 'sidebar.workspace.menu', 'demo:workspace', 'demo:workspace.route')).toMatchObject({
      authorized: false, reason: 'extension point sidebar.workspace.menu adapter support is unverified',
    })
    broker.dispose()
    descriptors.dispose()
  })

  it('fails closed on duplicate persisted policy tuples until the user replaces them', () => {
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
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
