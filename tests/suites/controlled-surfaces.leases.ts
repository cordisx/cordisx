import { Context } from '@deepseek-ai/cordis'
import { JSDOM } from 'jsdom'
import { expect, it, vi } from 'vitest'
import {
  CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
  type CordisXHostExtensionPointControlCatalogV1,
} from '../../packages/cli/src/contracts.js'
import {
  BrowserControlledSurfacePolicyStore,
  ControlledSurfaceCoordinator,
  ControlledSurfacePolicyBroker,
  MemoryControlledSurfacePolicyStore,
} from '../../packages/cli/src/renderer/controlled-surfaces.js'
import type { ExtensionPointAccessResolver } from '../../packages/cli/src/renderer/extension-points.js'
import { GenerationVisibilityCoordinator } from '../../packages/cli/src/renderer/generation-visibility.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../../packages/cli/src/renderer/ownership.js'
import { SurfaceRegistry } from '../../packages/cli/src/renderer/surfaces.js'
import { HostContextStore } from '../../packages/cli/src/renderer/validation.js'
import { activation, authorization, catalog, declaration, generation, setup } from './controlled-surfaces.fixtures.js'

export function registerLeasesTests() {
  it('keeps Manager policy CAS independent from runtime snapshot revisions', () => {
    const { coordinator } = setup()
    coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'policy', {
        claimId: 'policy',
        mode: 'proxy',
      }),
      generation: generation('overlay'),
      presenter: {},
    })
    coordinator.invalidate()
    coordinator.invalidate()
    const before = coordinator.managerSnapshot()
    expect(before.revision).toBeGreaterThan(before.policyRevision)
    expect(before.policyRevision).toBe(0)
    coordinator.setAuthorization(
      before.policyRevision,
      authorization('overlay', 'model.reasoning-intensity', 'policy', 'proxy', 'allow'),
    )
    expect(coordinator.managerSnapshot().policyRevision).toBe(1)
    expect(() =>
      coordinator.setAuthorization(
        before.policyRevision,
        authorization('overlay', 'model.reasoning-intensity', 'policy', 'proxy', 'deny'),
      )
    ).toThrow(/stale controlled surface policy revision/)
  })

  it('provides a claim-scoped safe lease and revokes it on denial and unload', async () => {
    const { coordinator, dispatch } = setup()
    const normalized = declaration('overlay', 'model.reasoning-intensity', 'lease', {
      claimId: 'lease',
      mode: 'proxy',
      requestedBindings: {
        properties: ['reasoningIntensity'],
        commands: ['setReasoningIntensity'],
        events: ['reasoningIntensityChanged'],
      },
    })
    const owner = generation('overlay')
    let hostAuthorized = true
    const registration = coordinator.register({
      declaration: normalized,
      generation: owner,
      presenter: { kind: 'safe' },
      hostAccess: () => ({ authorized: hostAuthorized, policy: hostAuthorized ? 'allow' : 'deny' }),
    })
    const lease = coordinator.createLease(normalized, owner)
    coordinator.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'lease', 'proxy', 'allow'))
    expect(lease.snapshot()).toMatchObject({ state: 'selected', properties: { reasoningIntensity: 'high' } })
    expect(JSON.stringify(lease.snapshot())).not.toMatch(/principal|selector|native|presenter/)
    const changed = vi.fn()
    lease.subscribe(changed)
    coordinator.publishEvent('model.reasoning-intensity', 'reasoningIntensityChanged', { value: 'medium' })
    expect(lease.snapshot().events).toEqual([{
      id: 'reasoningIntensityChanged',
      sequence: 1,
      payload: { value: 'medium' },
    }])
    await expect(lease.invoke('setReasoningIntensity', { value: 'medium' })).resolves.toMatchObject({
      outcome: 'accepted',
    })
    expect(dispatch).toHaveBeenCalled()
    hostAuthorized = false
    coordinator.invalidate()
    expect(lease.snapshot()).toMatchObject({ state: 'denied', properties: {}, commands: [], events: [] })
    await expect(lease.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'authorization.denied',
    })
    registration.dispose()
    lease.dispose()
    expect(lease.snapshot()).toMatchObject({ state: 'revoked', reason: 'lease.revoked' })
    expect(changed).toHaveBeenCalled()
  })

  it('persists only Host policy and stable principals across profile cold starts', () => {
    const store = new MemoryControlledSurfacePolicyStore()
    const first = new ControlledSurfacePolicyBroker(store)
    const principalHandle = first.principalHandle('https://plugins.example/theme', 'theme', 'explicit')
    expect(first.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).toBe(principalHandle)
    expect(first.principalHandle('https://plugins.example/theme', 'theme', 'legacy-structured')).not.toBe(
      principalHandle,
    )
    first.setAuthorization(0, {
      ...authorization('theme', 'model.reasoning-intensity', 'paint', 'overlay', 'allow'),
      principalHandle,
    })
    first.setGroupChoice(first.revision(), {
      pointId: 'model.reasoning-intensity',
      groupId: 'renderer',
      outcome: 'selected',
      selectedClaim: {
        principalHandle,
        identity: { source: 'https://plugins.example/theme', pluginId: 'theme', pointId: 'model.reasoning-intensity' },
        claimId: 'paint',
        mode: 'overlay',
      },
    })
    const serialized = JSON.stringify(store.value)
    expect(serialized).not.toMatch(/reasoningIntensity|presenter|selector|nativeNode|moduleGeneration/)
    first.dispose()

    const cold = new ControlledSurfacePolicyBroker(store)
    expect(cold.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).toBe(principalHandle)
    expect(
      cold.authorization({
        principalHandle,
        identity: { source: 'https://plugins.example/theme', pluginId: 'theme', pointId: 'model.reasoning-intensity' },
        claimId: 'paint',
        mode: 'overlay',
      }),
    ).toMatchObject({ policy: 'allow' })
    expect(cold.choice('model.reasoning-intensity', 'renderer')).toMatchObject({ outcome: 'selected' })
    const isolated = new ControlledSurfacePolicyBroker(new MemoryControlledSurfacePolicyStore())
    expect(isolated.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).not.toBe(principalHandle)
  })

  it('scopes browser policy by profile key and ignores a missing plugin without leaking state', () => {
    const dom = new JSDOM('', { url: 'https://codex.local/' })
    vi.stubGlobal('localStorage', dom.window.localStorage)
    try {
      const first = new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore('profile-a'))
      const handle = first.principalHandle('https://plugins.example/theme', 'theme', 'explicit')
      first.setAuthorization(0, {
        ...authorization('theme', 'model.reasoning-intensity', 'paint', 'overlay', 'allow'),
        principalHandle: handle,
      })
      expect([...Array(dom.window.localStorage.length)].map((_, index) => dom.window.localStorage.key(index))).toEqual([
        'cordisx.extension-point-control.v1:profile-a',
      ])
      const stored = dom.window.localStorage.getItem('cordisx.extension-point-control.v1:profile-a')!
      expect(stored).not.toMatch(/presenter|selector|native|reasoningIntensity|moduleGeneration/)
      const cold = new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore('profile-a'))
      expect(cold.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).toBe(handle)
      const isolated = new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore('profile-b'))
      expect(isolated.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).not.toBe(handle)
      const missing = new ControlledSurfaceCoordinator(
        catalog,
        {
          'model.overlay': {
            currentState: () => ({ state: 'active', reason: 'point.mounted' }),
            readProperty: () => null,
            dispatch: () => undefined,
          },
          'model.reasoning-intensity': {
            currentState: () => ({ state: 'active', reason: 'point.mounted' }),
            readProperty: () => 'high',
            dispatch: () => undefined,
          },
        },
        'cold-host',
        cold,
      )
      expect(missing.snapshot().points.every(point => point.candidates.length === 0)).toBe(true)
      missing.dispose()
      isolated.dispose()
      cold.dispose()
      first.dispose()
    } finally {
      vi.unstubAllGlobals()
      dom.window.close()
    }
  })

  it('keeps Manager diagnostics read-only and excludes presenter, property values, callbacks, and native data', () => {
    const { coordinator } = setup()
    coordinator.register({
      declaration: declaration('legacy', 'model.reasoning-intensity', 'legacy'),
      generation: generation('legacy', 'legacy-v1', 'legacy-structured'),
      presenter: { secret: 'presenter-data' },
    })
    const serialized = JSON.stringify(coordinator.managerSnapshot())
    expect(serialized).not.toContain('presenter-data')
    expect(serialized).not.toContain('"high"')
    expect(serialized).not.toContain('function')
    expect(coordinator.managerSnapshot().points.find(item => item.id === 'model.reasoning-intensity')?.selected[0])
      .toMatchObject({ claimId: 'legacy', mode: 'compose' })
  })

  it('rejects plugin identity forgery, free DOM presenters, hierarchy cycles, and unknown bindings closed', () => {
    const { coordinator } = setup()
    expect(() =>
      coordinator.register({
        declaration: declaration('legacy', 'model.reasoning-intensity', 'forged'),
        generation: generation('overlay'),
        presenter: {},
      })
    ).toThrow(/principal handle/)
    const domHandle = coordinator.register({
      declaration: declaration('legacy', 'model.reasoning-intensity', 'dom'),
      generation: generation('legacy', 'legacy-v1', 'legacy-structured'),
      presenter: { node: new Date(0) },
    })
    const unknownHandle = coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'unknown', {
        claimId: 'unknown',
        mode: 'overlay',
        requestedBindings: { properties: ['rawNode'] },
      }),
      generation: generation('overlay'),
      presenter: {},
    })
    const states = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates
    expect(states.filter(item => ['forged', 'dom', 'unknown'].includes(item.contributionId))).toEqual([])
    expect(coordinator.managerSnapshot().diagnostics.map(item => item.contributionId)).toEqual(['dom', 'unknown'])
    domHandle()
    unknownHandle()

    const cyclic = structuredClone(catalog) as CordisXHostExtensionPointControlCatalogV1 & {
      points: { parentPointId?: string }[]
    }
    cyclic.points[0]!.parentPointId = 'model.reasoning-intensity'
    expect(() =>
      new ControlledSurfaceCoordinator(cyclic, {
        'model.overlay': {
          currentState: () => ({ state: 'active', reason: 'point.mounted' }),
          readProperty: () => null,
          dispatch: () => undefined,
        },
        'model.reasoning-intensity': {
          currentState: () => ({ state: 'active', reason: 'point.mounted' }),
          readProperty: () => null,
          dispatch: () => undefined,
        },
      }, 'host')
    ).toThrow(/cycle/)
  })

  it('normalizes the public slots.register control shorthand and gates the existing Host renderer', () => {
    const pointCatalog: CordisXHostExtensionPointControlCatalogV1 = {
      $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'composer.reasoning-intensity',
        modes: [
          { id: 'compose', stacking: 'ordered', coexistsWith: ['overlay'], defaultAuthorization: 'allow' },
          { id: 'overlay', stacking: 'ordered', coexistsWith: ['compose'], defaultAuthorization: 'deny' },
        ],
        exclusiveGroups: [],
        safeProperties: [],
        safeCommands: [],
        safeEvents: [],
        ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
      }],
    }
    const policies = new ControlledSurfacePolicyBroker()
    const controls = new ControlledSurfaceCoordinator(
      pointCatalog,
      {
        'composer.reasoning-intensity': {
          currentState: () => ({ state: 'active', reason: 'point.mounted' }),
          readProperty: () => null,
          dispatch: () => undefined,
        },
      },
      'host-1',
      policies,
      item => item.moduleGeneration === 'theme-v1',
    )
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setControlCoordinator(controls)
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'theme',
      [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme',
      [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
    })
    const registered = registry.register(plugin, {
      name: 'composer.reasoning-intensity',
      id: 'theme',
      control: { claimId: 'presentation', mode: 'overlay', priority: 10 },
    }, {
      variant: 'imperium',
      title: { key: 'title' },
      stages: [
        { label: { key: 'low' }, material: 'plastic' },
        { label: { key: 'high' }, material: 'gold' },
      ],
    })
    expect(registry.snapshot()[0]).toMatchObject({
      authorized: true,
      control: { state: 'selected', identity: { pluginId: 'theme' } },
    })
    expect(registered.control?.snapshot()).toMatchObject({ state: 'selected', properties: {} })
    const controlled = registry.snapshot()[0]!.control!
    policies.setAuthorization(0, {
      ...authorization('theme', 'composer.reasoning-intensity', 'presentation', 'overlay', 'allow'),
      principalHandle: controlled.principalHandle,
    })
    expect(registry.snapshot()[0]).toMatchObject({ authorized: true, control: { state: 'selected', priority: 10 } })
    expect(registered.control?.snapshot()).toMatchObject({ state: 'selected' })
    expect(() =>
      registry.register(plugin, {
        name: 'composer.reasoning-intensity',
        id: 'raw',
        control: { claimId: 'raw', mode: 'overlay', selector: '.native' } as never,
      }, {
        variant: 'imperium',
        title: { key: 'title' },
        stages: [
          { label: { key: 'low' }, material: 'plastic' },
          { label: { key: 'high' }, material: 'gold' },
        ],
      })
    ).toThrow(/unknown field selector/)
    registry.dispose()
    expect(registered.control?.snapshot()).toMatchObject({ state: 'revoked' })
    contexts.dispose()
  })

  it('keeps lifecycle subscription while point-local denial scrubs a selected lease and restores it on inherit', async () => {
    const pointCatalog: CordisXHostExtensionPointControlCatalogV1 = {
      $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'composer.reasoning-intensity',
        modes: [
          { id: 'compose', stacking: 'ordered', coexistsWith: ['proxy'], defaultAuthorization: 'allow' },
          { id: 'proxy', stacking: 'ordered', coexistsWith: ['compose'], defaultAuthorization: 'deny' },
        ],
        exclusiveGroups: [],
        safeProperties: [{
          id: 'reasoningIntensity',
          schema: { type: 'string', enum: ['low', 'medium', 'high'] },
          visibility: 'renderer-safe',
          mutable: false,
        }],
        safeCommands: [{
          id: 'setReasoningIntensity',
          dispatch: 'host-brokered',
          arguments: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }],
        }],
        safeEvents: [{
          id: 'reasoningIntensityChanged',
          delivery: 'host-projected',
          payload: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }],
        }],
        ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
      }],
    }
    const dispatch = vi.fn(async () => undefined)
    let pointState: 'pending' | 'active' = 'pending'
    const policies = new ControlledSurfacePolicyBroker()
    const controls = new ControlledSurfaceCoordinator(
      pointCatalog,
      {
        'composer.reasoning-intensity': {
          currentState: () => ({
            state: pointState,
            reason: pointState === 'active' ? 'point.mounted' : 'point.pending',
          }),
          readProperty: () => 'high',
          dispatch,
        },
      },
      'host-1',
      policies,
    )
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setControlCoordinator(controls)
    let pointAllowed = true
    registry.setAccessResolver({
      decision: () => ({
        policy: pointAllowed ? 'inherit' : 'deny',
        effectivePolicy: pointAllowed ? 'allow' : 'deny',
        authorized: pointAllowed,
        ...(!pointAllowed ? { reason: 'point.local-deny' } : {}),
      }),
    } as unknown as ExtensionPointAccessResolver)
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'theme',
      [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme',
      [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
    })
    const registered = registry.register(plugin, {
      name: 'composer.reasoning-intensity',
      id: 'theme',
      control: {
        claimId: 'presentation',
        mode: 'proxy',
        requestedBindings: {
          properties: ['reasoningIntensity'],
          commands: ['setReasoningIntensity'],
          events: ['reasoningIntensityChanged'],
        },
      },
    }, {
      variant: 'imperium',
      title: { key: 'title' },
      stages: [
        { label: { key: 'low' }, material: 'plastic' },
        { label: { key: 'high' }, material: 'gold' },
      ],
    })
    const claim = registry.snapshot()[0]!.control!
    policies.setAuthorization(0, {
      ...authorization('theme', 'composer.reasoning-intensity', 'presentation', 'proxy', 'allow'),
      principalHandle: claim.principalHandle,
    })
    const lease = registered.control!
    const changed = vi.fn()
    lease.subscribe(changed)
    expect(lease.snapshot()).toMatchObject({ state: 'pending', properties: {}, commands: [], events: [] })
    pointState = 'active'
    controls.invalidate()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(lease.snapshot()).toMatchObject({ state: 'selected', properties: { reasoningIntensity: 'high' } })
    controls.publishEvent('composer.reasoning-intensity', 'reasoningIntensityChanged', { value: 'high' })
    expect(lease.snapshot().events).toEqual([{
      id: 'reasoningIntensityChanged',
      sequence: 1,
      payload: { value: 'high' },
    }])
    expect(changed).toHaveBeenCalledTimes(2)
    const policyRevision = policies.revision()

    pointAllowed = false
    registry.invalidatePointPolicies()
    expect(policies.revision()).toBe(policyRevision)
    expect(registry.snapshot()[0]).toMatchObject({
      authorized: false,
      effectivePointPolicy: 'deny',
      control: { authorization: 'denied', state: 'denied', reason: 'point.local-deny' },
    })
    expect(lease.snapshot()).toMatchObject({
      state: 'denied',
      reason: 'point.local-deny',
      properties: {},
      commands: [],
      events: [],
    })
    const deniedChanged = vi.fn()
    expect(() => lease.subscribe(deniedChanged)).not.toThrow()
    await expect(lease.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'authorization.denied',
    })
    expect(controls.publishEvent('composer.reasoning-intensity', 'reasoningIntensityChanged', { value: 'low' }))
      .toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(3)

    pointAllowed = true
    registry.invalidatePointPolicies()
    expect(changed).toHaveBeenCalledTimes(4)
    expect(deniedChanged).toHaveBeenCalledTimes(1)
    expect(lease.snapshot()).toMatchObject({ state: 'selected', properties: { reasoningIntensity: 'high' } })
    await expect(lease.invoke('setReasoningIntensity', { value: 'medium' })).resolves.toMatchObject({
      outcome: 'accepted',
    })
    expect(dispatch).toHaveBeenCalledWith(
      'setReasoningIntensity',
      { value: 'medium' },
      expect.objectContaining({
        caller: expect.objectContaining({ pluginId: 'theme', moduleGeneration: 'theme-v1' }),
        declaration: expect.objectContaining({ claimId: 'presentation' }),
      }),
    )
    registry.dispose()
    contexts.dispose()
  })

  it('projects one exact generation through same-module stage, publish, rollback, and unload', async () => {
    const previous = activation(1, 'a')
    const candidate = activation(2, 'b')
    const visibility = new GenerationVisibilityCoordinator(previous)
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts, visibility)
    const dispatch = vi.fn(async () => undefined)
    const policies = new ControlledSurfacePolicyBroker()
    const generationCatalog: CordisXHostExtensionPointControlCatalogV1 = {
      $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
      schemaVersion: 1,
      points: [{
        id: 'composer.reasoning-intensity',
        modes: [{ id: 'compose', stacking: 'ordered', coexistsWith: [], defaultAuthorization: 'allow' }],
        exclusiveGroups: [],
        safeProperties: [],
        safeCommands: [{
          id: 'setReasoningIntensity',
          dispatch: 'host-brokered',
          arguments: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }],
        }],
        safeEvents: [],
        ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
      }],
    }
    const controls = new ControlledSurfaceCoordinator(
      generationCatalog,
      {
        'composer.reasoning-intensity': {
          currentState: () => ({ state: 'active', reason: 'point.mounted' }),
          readProperty: () => 'high',
          commandAvailability: () => ({ available: true }),
          dispatch,
        },
      },
      'host-generation',
      policies,
      (owner, view) => registry.controlGenerationVisible(owner, view),
      owner => registry.controlGenerationCallable(owner),
    )
    registry.setControlCoordinator(controls)
    const root = new Context()
    const oldContext = root.extend({
      [CORDISX_PLUGIN_ID]: 'theme',
      [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme',
      [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
    })
    const item = (label: string) => ({
      variant: 'imperium' as const,
      title: { key: label },
      stages: [
        { label: { key: 'low' }, material: 'plastic' as const },
        { label: { key: 'high' }, material: 'gold' as const },
      ],
    })
    const options = {
      name: 'composer.reasoning-intensity' as const,
      id: 'theme',
      control: {
        claimId: 'theme',
        mode: 'compose' as const,
        requestedBindings: { commands: ['setReasoningIntensity'] },
      },
    }
    const old = registry.register(oldContext, options, item('old'))
    expect(registry.snapshot()).toHaveLength(1)
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates)
      .toHaveLength(1)

    const transition = visibility.begin('retry-theme', previous, candidate, 'retry-theme:exact')
    const newContext = root.extend({
      [CORDISX_PLUGIN_ID]: 'theme',
      [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme',
      [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
      ...visibility.context(transition, 'theme'),
    })
    const next = registry.register(newContext, options, item('new'))
    expect((registry.snapshot()[0]?.item as { title: { key: string } }).title.key).toBe('old')
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates)
      .toHaveLength(1)
    const candidateView = visibility.view(newContext)
    expect((registry.snapshot(candidateView)[0]?.item as { title: { key: string } }).title.key).toBe('new')
    expect(
      controls.snapshot(candidateView).points.find(point => point.id === 'composer.reasoning-intensity')?.candidates,
    ).toHaveLength(1)
    expect(next.control?.snapshot()).toMatchObject({ state: 'revoked' })

    const publication = visibility.publish(
      visibility.preparePublish(transition, visibility.confirmReadiness(transition)),
    )
    expect((registry.snapshot()[0]?.item as { title: { key: string } }).title.key).toBe('new')
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates)
      .toHaveLength(1)
    expect(old.control?.snapshot()).toMatchObject({ state: 'revoked' })
    expect(next.control?.snapshot()).toMatchObject({ state: 'selected' })
    await expect(next.control?.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({
      outcome: 'accepted',
    })

    visibility.rollback(publication)
    expect((registry.snapshot()[0]?.item as { title: { key: string } }).title.key).toBe('old')
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates)
      .toHaveLength(1)
    expect(old.control?.snapshot()).toMatchObject({ state: 'selected' })
    expect(next.control?.snapshot()).toMatchObject({ state: 'revoked' })
    await expect(next.control?.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({
      outcome: 'rejected',
    })
    next.dispose()
    visibility.completeRollback(publication)
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates)
      .toHaveLength(1)
    old.dispose()
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates)
      .toHaveLength(0)
    registry.dispose()
    contexts.dispose()
  })
}
