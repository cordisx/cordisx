import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surfaces.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID } from '../packages/cli/src/renderer/ownership.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, type CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { partitionDirectActions } from '../packages/cli/src/renderer/adapter.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  CORDISX_EXTENSION_POINT_LOCALE_CATALOGS,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'

describe('SurfaceRegistry', () => {
  it('isolates same-id generations and rejects a retiring render token', () => {
    const activation = (revision: number, generation: string): CordisXPluginActivationRecordV1 => ({
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1, schemaVersion: 1,
      recordKind: revision === 1 ? 'active' : 'candidate',
      ...(revision === 1 ? {} : { transactionId: 'update-demo' }),
      profileId: 'default', revision, lastGoodRevision: 1, runtimeGeneration: 'runtime-1',
      plugins: [{ id: 'demo', version: '1.0.0', digest: `sha256:${(revision === 1 ? 'a' : 'b').repeat(64)}`, moduleGeneration: generation, enabled: true, dependencies: [] }],
    })
    const previous = activation(1, 'demo-1')
    const candidate = activation(2, 'demo-2')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts, visibility)
    registry.setResolvers({
      command: (_owner, reference, view) => reference.id === 'open'
        || (reference.id === 'candidate-only' && view?.moduleGeneration === 'demo-2'),
      route: () => true,
    })
    const oldContext = new Context().extend({ [CORDISX_PLUGIN_ID]: 'demo', [CORDISX_PLUGIN_GENERATION]: 'demo-1' })
    registry.register(oldContext, { name: 'sidebar.footer.before-control', id: 'open' }, { label: { key: 'old' }, command: { id: 'open' } })
    const oldToken = registry.renderToken('sidebar.footer.before-control', 'demo:open')!

    const handle = visibility.begin('update-demo', previous, candidate)
    const candidateContext = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'demo', [CORDISX_PLUGIN_GENERATION]: 'demo-2', ...visibility.context(handle, 'demo'),
    })
    registry.register(candidateContext, { name: 'sidebar.footer.before-control', id: 'open' }, { label: { key: 'new' }, command: { id: 'candidate-only' } })
    expect((registry.snapshot()[0]?.item as { label: { key: string } }).label.key).toBe('old')
    expect((registry.snapshot(visibility.view(candidateContext))[0]?.item as { label: { key: string } }).label.key).toBe('new')
    expect(registry.snapshot(visibility.view(candidateContext))[0]).toMatchObject({ valid: true })

    visibility.publish(visibility.preparePublish(handle, visibility.confirmReadiness(handle)))
    const newToken = registry.renderToken('sidebar.footer.before-control', 'demo:open')!
    expect(newToken).not.toBe(oldToken)
    registry.markRendered('sidebar.footer.before-control', 'demo:open', oldToken, true)
    expect(registry.snapshot()[0]?.rendered).toBe(false)
    registry.markRendered('sidebar.footer.before-control', 'demo:open', newToken, true)
    expect(registry.snapshot()[0]?.rendered).toBe(true)
    registry.dispose()
    contexts.dispose()
  })

  it('partitions deterministic registry order into host-owned direct and overflow actions', () => {
    const partition = partitionDirectActions(['action-1', 'action-2', 'utility-1', 'utility-2'], 3)
    expect(partition).toEqual({ direct: ['action-1', 'action-2', 'utility-1'], overflow: ['utility-2'] })
    expect(Object.isFrozen(partition)).toBe(true)
    expect(partitionDirectActions(['composer-1', 'composer-2', 'composer-3'], 2)).toEqual({
      direct: ['composer-1', 'composer-2'],
      overflow: ['composer-3'],
    })
  })
  it('retains immutable data, sorts deterministically, and replaces snapshots through an owned handle', () => {
    const contexts = new HostContextStore()
    contexts.replace({ enabled: true })
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({ command: () => true, route: () => true })
    const later = registry.register('demo', {
      name: 'environment.section.rows', id: 'later', group: 'status', order: 20, when: { key: 'enabled', equals: true },
    }, { sectionId: 'runtime', rowId: 'later', label: { key: 'later' }, value: 1 })
    registry.register('demo', {
      name: 'environment.panel.sections', id: 'runtime', group: 'status', order: 10,
    }, { sectionId: 'runtime', title: { key: 'runtime' } })

    const initial = registry.snapshot()
    expect(initial.map(item => item.id)).toEqual(['runtime', 'later'])
    expect(initial[1]).toMatchObject({ visible: true, pending: false, valid: true })
    expect(Object.isFrozen(initial[1]?.item)).toBe(true)

    later.update({ sectionId: 'runtime', rowId: 'later', label: { key: 'updated' }, value: 2 })
    expect((registry.snapshot()[1]?.item as { value: number }).value).toBe(2)
    later()
    expect(() => later.update({ sectionId: 'runtime', rowId: 'later', label: { key: 'late' } })).toThrow(/disposed/)
    registry.dispose()
    contexts.dispose()
  })

  it('diagnoses dangling activation, unknown context, target, anchor, icon, and free DOM data', () => {
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({ command: () => false, route: () => false })
    registry.register('demo', { name: 'sidebar.navigation.items', id: 'missing' }, {
      label: { key: 'missing' }, command: { id: 'missing' },
    })
    registry.register('demo', { name: 'workspace.toolbar.items', id: 'toolbar' }, {
      anchor: 'workspace.primary', placement: 'menu', label: { key: 'toolbar' }, icon: 'host:info', command: { id: 'missing' },
    })
    registry.register('demo', { name: 'environment.section.rows', id: 'orphan' }, {
      sectionId: 'missing', rowId: 'orphan', label: { key: 'orphan' },
    })
    registry.register('demo', { name: 'sidebar.footer.before-control', id: 'dom', when: { key: 'unknown', exists: true } }, {
      label: { key: 'dom' }, command: { id: 'missing' }, node: (() => undefined) as never,
    } as never)

    const snapshots = registry.snapshot()
    expect(snapshots.find(item => item.id === 'missing')?.error).toMatch(/command missing/)
    expect(snapshots.find(item => item.id === 'toolbar')).toMatchObject({ valid: false, pending: true })
    expect(snapshots.find(item => item.id === 'orphan')).toMatchObject({ valid: true, pending: true })
    expect(snapshots.find(item => item.id === 'dom')?.error).toMatch(/structured contribution/)
    registry.dispose()
    contexts.dispose()
  })

  it('uses command precedence while validating independent navigation actions', () => {
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({
      command: (_owner, reference) => ['primary', 'quick'].includes(reference.id),
      route: () => false,
    })
    registry.register('demo', { name: 'sidebar.navigation.items', id: 'row' }, {
      label: { key: 'row' },
      command: { id: 'primary' },
      route: { id: 'missing-route' },
      actions: [{ id: 'quick', label: { key: 'quick' }, command: { id: 'quick' } }],
    })
    expect(registry.snapshot()[0]).toMatchObject({ valid: true, visible: true })
    registry.dispose()
    contexts.dispose()
  })

  it('accepts structured route toggles and rejects command or parameterless toggle ambiguity', () => {
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({ command: () => true, route: () => true })
    registry.register('demo', { name: 'session.header.actions', id: 'trace' }, {
      label: { key: 'trace' }, route: { id: 'trace' }, routeBehavior: 'toggle',
    })
    registry.register('demo', { name: 'session.header.actions', id: 'ambiguous' }, {
      label: { key: 'ambiguous' }, command: { id: 'toggle' }, route: { id: 'trace' }, routeBehavior: 'toggle',
    } as never)
    registry.register('demo', { name: 'session.header.actions', id: 'missing-route' }, {
      label: { key: 'missing-route' }, command: { id: 'toggle' }, routeBehavior: 'navigate',
    } as never)

    expect(registry.snapshot().find(item => item.id === 'trace')).toMatchObject({ valid: true })
    expect(registry.snapshot().find(item => item.id === 'ambiguous')?.error).toMatch(/cannot also reference a command/)
    expect(registry.snapshot().find(item => item.id === 'missing-route')?.error).toMatch(/requires a route reference/)
    registry.dispose()
    contexts.dispose()
  })

  it('retains denied contributions while removing them from authorized projection', () => {
    const contexts = new HostContextStore()
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    const identity = { source: 'https://plugins.example/demo', id: 'demo' }
    broker.register(identity)
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({ command: () => true, route: () => true })
    registry.setAccessResolver(broker)
    registry.register('demo', { name: 'sidebar.footer.before-control', id: 'open' }, {
      label: { key: 'open' }, command: { id: 'open' },
    })
    registry.markRendered(
      'sidebar.footer.before-control',
      'demo:open',
      registry.renderToken('sidebar.footer.before-control', 'demo:open')!,
      true,
    )
    expect(registry.snapshot()[0]).toMatchObject({ authorized: true, pointPolicy: 'inherit', rendered: true })

    broker.setPolicy(identity, 'sidebar.footer.before-control', 'deny')
    registry.invalidatePointPolicies()
    expect(registry.snapshot()[0]).toMatchObject({
      valid: true, visible: true, authorized: false, pointPolicy: 'deny', effectivePointPolicy: 'deny', rendered: true,
    })
    registry.markRendered(
      'sidebar.footer.before-control',
      'demo:open',
      registry.renderToken('sidebar.footer.before-control', 'demo:open')!,
      false,
    )
    expect(registry.snapshot()[0]).toMatchObject({ authorized: false, rendered: false })
    expect(registry.snapshot()).toHaveLength(1)
    registry.dispose()
    broker.dispose()
    descriptors.dispose()
    contexts.dispose()
  })

  it('fails closed on static anchor support and keeps current mount state out of policy', () => {
    const contexts = new HostContextStore()
    const descriptors = new ExtensionPointDescriptorRegistry(CORDISX_EXTENSION_POINT_LOCALE_CATALOGS)
    descriptors.registerCatalog(CORDISX_BUILTIN_EXTENSION_POINT_CATALOG)
    const broker = new ExtensionPointPolicyBroker(descriptors, new MemoryExtensionPointPolicyStore())
    broker.register({ source: 'https://plugins.example/demo', id: 'demo' })
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({ command: () => true, route: () => true })
    registry.setAccessResolver(broker)
    registry.setSurfaceAnchors('composer.toolbar.items', [
      { id: 'submit', placements: ['before'] },
      { id: 'leading', placements: ['before'] },
    ])
    registry.setCurrentContext([{
      surface: 'composer.toolbar.items', state: 'active', anchors: [
        { id: 'submit', placements: ['before'], state: 'active' },
        { id: 'leading', placements: ['before'], state: 'active' },
      ],
    }])
    registry.register('demo', { name: 'composer.toolbar.items', id: 'submit' }, {
      anchor: 'submit', placement: 'before', label: { key: 'submit' }, command: { id: 'submit' },
    })
    registry.register('demo', { name: 'composer.toolbar.items', id: 'leading' }, {
      anchor: 'leading', placement: 'before', label: { key: 'leading' }, command: { id: 'leading' },
    })
    expect(registry.snapshot().find(item => item.id === 'submit')).toMatchObject({
      authorized: true, pending: false, currentContext: 'active',
    })
    expect(registry.snapshot().find(item => item.id === 'leading')).toMatchObject({
      authorized: false, pointPolicyReason: expect.stringContaining('adapter support is unverified'),
    })

    registry.setCurrentContext([{
      surface: 'composer.toolbar.items', state: 'not-mounted', code: 'composer.not-mounted',
      detail: { key: 'composer.not-mounted', fallback: 'Composer is not mounted.' },
    }])
    expect(registry.snapshot().find(item => item.id === 'submit')).toMatchObject({
      authorized: true, pending: true, currentContext: 'not-mounted',
      availabilityCode: 'composer.not-mounted', availabilityDetail: 'Composer is not mounted.',
    })
    registry.dispose()
    broker.dispose()
    descriptors.dispose()
    contexts.dispose()
  })

  it('validates manager settings tabs as structured headers and keeps envelope order as the single source', () => {
    const contexts = new HostContextStore()
    contexts.replace({ enabled: true })
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({
      command: () => false,
      route: () => false,
      managerSettingsRoute: (_owner, id) => id === 'ready'
        ? { state: 'available' }
        : { state: 'pending', detail: `route ${id} is pending` },
    })

    const ready = registry.register('zeta', {
      name: 'manager.settings.tabs', id: 'ready', order: 120, when: { key: 'enabled', equals: true },
    }, {
      title: { key: 'title', fallback: 'Ready' }, icon: 'host:settings', route: { id: 'ready' },
    })
    registry.register('alpha', {
      name: 'manager.settings.tabs', id: 'pending', order: 110,
      disabled: { value: true, reason: { key: 'disabled', fallback: 'Unavailable' } },
    }, {
      title: { key: 'pending', fallback: 'Pending' }, icon: 'host:info', route: { id: 'pending' },
    })

    expect(registry.snapshot().map(item => item.qualifiedId)).toEqual(['alpha:pending', 'zeta:ready'])
    expect(registry.snapshot()[0]).toMatchObject({ pending: true, valid: true, disabled: true })
    expect(registry.snapshot()[0]?.disabledReason).toEqual({ key: 'disabled', fallback: 'Unavailable' })
    expect(registry.snapshot()[1]).toMatchObject({ order: 120, visible: true, pending: false, valid: true })

    ready.updateOptions({ order: 90, when: { key: 'enabled', equals: false }, disabled: { value: true } })
    expect(registry.snapshot()[0]).toMatchObject({ qualifiedId: 'zeta:ready', order: 90, visible: false, disabled: true })
    expect(ready).not.toHaveProperty('order')
    expect(() => ready.update({
      title: { key: 'bad' }, icon: 'plugin:settings' as never, route: { id: 'ready' },
    })).not.toThrow()
    expect(registry.snapshot().find(item => item.qualifiedId === 'zeta:ready')?.error).toMatch(/host icon token/)
    expect(() => ready.updateOptions({ group: 'header' })).toThrow(/does not accept a contribution group/)
    ready.dispose()
    expect(() => ready.updateOptions({ order: 1 })).toThrow(/disposed/)

    registry.dispose()
    contexts.dispose()
  })

  it('rejects manager settings header DOM fields, cross-owner routes, and conflicting identities', () => {
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setResolvers({ command: () => false, route: () => false })
    registry.register('demo', { name: 'manager.settings.tabs', id: 'settings' }, {
      title: { key: 'settings' }, icon: 'host:settings', route: { id: 'other:settings' },
    } as never)
    registry.register('demo', { name: 'manager.settings.tabs', id: 'dom' }, {
      title: { key: 'dom' }, icon: 'host:settings', route: { id: 'settings' }, html: '<b>owned</b>',
    } as never)
    expect(registry.snapshot().find(item => item.id === 'settings')?.error).toMatch(/invalid manager settings tab route id/)
    expect(registry.snapshot().find(item => item.id === 'dom')?.error).toMatch(/unknown field html/)
    expect(() => registry.register('demo', { name: 'manager.settings.tabs', id: 'dom' }, {
      title: { key: 'again' }, icon: 'host:settings', route: { id: 'settings' },
    })).toThrow(/already registered/)
    registry.dispose()
    contexts.dispose()
  })
})
