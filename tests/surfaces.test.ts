import { describe, expect, it } from 'vitest'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surfaces.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import {
  CORDISX_BUILTIN_EXTENSION_POINT_CATALOG,
  ExtensionPointDescriptorRegistry,
  ExtensionPointPolicyBroker,
  MemoryExtensionPointPolicyStore,
} from '../packages/cli/src/renderer/extension-points.js'

describe('SurfaceRegistry', () => {
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

  it('retains denied contributions while removing them from authorized projection', () => {
    const contexts = new HostContextStore()
    const descriptors = new ExtensionPointDescriptorRegistry()
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
    registry.markRendered('sidebar.footer.before-control', 'demo:open', true)
    expect(registry.snapshot()[0]).toMatchObject({ authorized: true, pointPolicy: 'inherit', rendered: true })

    broker.setPolicy(identity, 'sidebar.footer.before-control', 'deny')
    registry.invalidatePointPolicies()
    expect(registry.snapshot()[0]).toMatchObject({
      valid: true, visible: true, authorized: false, pointPolicy: 'deny', effectivePointPolicy: 'deny', rendered: true,
    })
    registry.markRendered('sidebar.footer.before-control', 'demo:open', false)
    expect(registry.snapshot()[0]).toMatchObject({ authorized: false, rendered: false })
    expect(registry.snapshot()).toHaveLength(1)
    registry.dispose()
    broker.dispose()
    descriptors.dispose()
    contexts.dispose()
  })
})
