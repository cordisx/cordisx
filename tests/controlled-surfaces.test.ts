import { describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { Context } from '@deepseek-ai/cordis'
import {
  CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
  CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1,
  CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
  type CordisXExtensionPointControlAuthorizationV1,
  type CordisXExtensionPointControlClaimOptions,
  type CordisXHostExtensionPointControlCatalogV1,
} from '../packages/cli/src/contracts.js'
import {
  ControlledSurfaceCoordinator,
  ControlledSurfacePolicyBroker,
  BrowserControlledSurfacePolicyStore,
  MemoryControlledSurfacePolicyStore,
  normalizeControlledSurfaceDeclaration,
} from '../packages/cli/src/renderer/controlled-surfaces.js'
import { CORDISX_PLUGIN_GENERATION, CORDISX_PLUGIN_ID, CORDISX_PLUGIN_SOURCE } from '../packages/cli/src/renderer/ownership.js'
import { SurfaceRegistry } from '../packages/cli/src/renderer/surfaces.js'
import type { ExtensionPointAccessResolver } from '../packages/cli/src/renderer/extension-points.js'
import { GenerationVisibilityCoordinator } from '../packages/cli/src/renderer/generation-visibility.js'
import { HostContextStore } from '../packages/cli/src/renderer/validation.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const catalog: CordisXHostExtensionPointControlCatalogV1 = {
  $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1,
  schemaVersion: 1,
  points: [
    {
      id: 'model.overlay',
      modes: [
        { id: 'compose', stacking: 'ordered', coexistsWith: [], defaultAuthorization: 'allow' },
        { id: 'replace', stacking: 'exclusive', exclusiveGroup: 'ownership', coexistsWith: [], defaultAuthorization: 'deny' },
      ],
      exclusiveGroups: [{ id: 'ownership', modes: ['replace'], cardinality: 'one', selection: 'user', nativeFallback: true }],
      safeProperties: [], safeCommands: [], safeEvents: [],
      ownership: { scope: 'subtree', suppressesDescendantsWhenModes: ['replace'] },
    },
    {
      id: 'model.reasoning-intensity', parentPointId: 'model.overlay',
      modes: [
        { id: 'compose', stacking: 'ordered', coexistsWith: ['overlay', 'proxy'], defaultAuthorization: 'allow' },
        { id: 'replace', stacking: 'exclusive', exclusiveGroup: 'renderer', coexistsWith: ['overlay'], defaultAuthorization: 'deny' },
        { id: 'overlay', stacking: 'ordered', coexistsWith: ['compose', 'replace', 'proxy'], defaultAuthorization: 'deny' },
        { id: 'proxy', stacking: 'ordered', coexistsWith: ['compose', 'overlay'], defaultAuthorization: 'deny' },
        { id: 'hide-native', stacking: 'exclusive', exclusiveGroup: 'renderer', coexistsWith: [], defaultAuthorization: 'deny' },
      ],
      exclusiveGroups: [{ id: 'renderer', modes: ['replace', 'hide-native'], cardinality: 'one', selection: 'user', nativeFallback: true }],
      safeProperties: [{ id: 'reasoningIntensity', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, visibility: 'renderer-safe', mutable: false }],
      safeCommands: [{ id: 'setReasoningIntensity', dispatch: 'host-brokered', arguments: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }] }],
      safeEvents: [{ id: 'reasoningIntensityChanged', delivery: 'host-projected', payload: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }] }],
      ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
    },
  ],
}

const generation = (pluginId: string, moduleGeneration = `${pluginId}-v1`, origin: 'explicit' | 'legacy-structured' = 'explicit') => ({
  principalHandle: `principal:${pluginId}:${origin}`, principalOrigin: origin, source: `https://plugins.example/${pluginId}`, pluginId, moduleGeneration,
})

function declaration(pluginId: string, pointId: string, contributionId: string, control?: CordisXExtensionPointControlClaimOptions, order?: number) {
  return normalizeControlledSurfaceDeclaration({
    principalHandle: `principal:${pluginId}:${control === undefined ? 'legacy-structured' : 'explicit'}`,
    source: `https://plugins.example/${pluginId}`, pluginId, pointId, contributionId, control, order,
  })
}

function authorization(pluginId: string, pointId: string, claimId: string, mode: CordisXExtensionPointControlAuthorizationV1['mode'], policy: 'allow' | 'deny', origin: 'explicit' | 'legacy-structured' = 'explicit'): CordisXExtensionPointControlAuthorizationV1 {
  return {
    $schema: CORDISX_EXTENSION_POINT_CONTROL_AUTHORIZATION_SCHEMA_V1,
    schemaVersion: 1,
    principalHandle: `principal:${pluginId}:${origin}`,
    identity: { source: `https://plugins.example/${pluginId}`, pluginId, pointId },
    claimId, mode, policy,
  }
}

function activation(revision: number, digestCharacter: string, moduleGeneration = 'theme-v1'): CordisXPluginActivationRecordV1 {
  return {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1,
    recordKind: revision === 1 ? 'active' : 'candidate',
    ...(revision === 1 ? {} : { transactionId: 'retry-theme' }),
    profileId: 'default',
    revision,
    lastGoodRevision: 1,
    runtimeGeneration: 'runtime-1',
    plugins: [{
      id: 'theme', version: '1.0.0', digest: `sha256:${digestCharacter.repeat(64)}`,
      moduleGeneration, enabled: true, dependencies: [],
    }],
  }
}

function setup() {
  let intensity = 'high'
  let reasoningState: 'active' | 'pending' = 'active'
  const dispatch = vi.fn(async (_id: string, args: Readonly<Record<string, unknown>>) => { intensity = String(args.value) })
  const active = new Set(['outer-v1', 'legacy-v1', 'overlay-v1', 'replace-v1', 'denied-v1'])
  const plugins = ['outer', 'legacy', 'overlay', 'replace', 'denied']
  const policies = new ControlledSurfacePolicyBroker(new MemoryControlledSurfacePolicyStore({
    schemaVersion: 1,
    principals: plugins.flatMap(pluginId => (['explicit', 'legacy-structured'] as const).map(origin => ({
      handle: `principal:${pluginId}:${origin}`, source: `https://plugins.example/${pluginId}`, pluginId, origin,
    }))),
    authorizations: [], choices: [],
  }))
  const coordinator = new ControlledSurfaceCoordinator(catalog, {
    'model.overlay': {
      currentState: () => ({ state: 'active', reason: 'point.mounted' }),
      readProperty: () => null,
      dispatch: () => undefined,
    },
    'model.reasoning-intensity': {
      currentState: () => ({ state: reasoningState, reason: reasoningState === 'active' ? 'point.mounted' : 'point.pending' }),
      readProperty: id => id === 'reasoningIntensity' ? intensity : null,
      commandAvailability: () => ({ available: true }),
      eventAvailability: () => ({ available: true }),
      dispatch,
    },
  }, 'host-1', policies, item => active.has(item.moduleGeneration ?? ''))
  return { coordinator, policies, dispatch, active, intensity: () => intensity, setReasoningState: (state: 'active' | 'pending') => { reasoningState = state } }
}

describe('controlled extension point runtime', () => {
  it('normalizes legacy contributions as compose-only with priority=-order and no bindings', () => {
    expect(declaration('legacy', 'model.reasoning-intensity', 'control', undefined, 17)).toMatchObject({
      origin: 'legacy-structured', claimId: 'control', contributionId: 'control', mode: 'compose', priority: -17,
      requestedBindings: { properties: [], commands: [], events: [] },
      identity: { pluginId: 'legacy', pointId: 'model.reasoning-intensity' },
    })
  })

  it('accepts explicit compose claims and resolves their catalog-authorized safe bindings', () => {
    const { coordinator } = setup()
    const normalized = declaration('overlay', 'model.reasoning-intensity', 'compose', {
      claimId: 'compose', mode: 'compose', priority: 12,
      requestedBindings: { properties: ['reasoningIntensity'] },
    })
    coordinator.register({ declaration: normalized, generation: generation('overlay'), presenter: { kind: 'compose' } })
    expect(coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')?.candidates[0]).toMatchObject({
      origin: 'explicit', mode: 'compose', authorization: 'allowed', state: 'selected',
      bindings: { properties: [{ id: 'reasoningIntensity', value: 'high' }] },
    })
  })

  it('resolves exclusive groups first, then selects compatible ordered claims deterministically', () => {
    const { coordinator, policies, setReasoningState } = setup()
    coordinator.register({ declaration: declaration('legacy', 'model.reasoning-intensity', 'legacy', undefined, 10), generation: generation('legacy', 'legacy-v1', 'legacy-structured'), presenter: { kind: 'legacy' } })
    coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'overlay', {
      claimId: 'theme', mode: 'overlay', priority: 30, requestedBindings: { properties: ['reasoningIntensity'] },
    }), generation: generation('overlay'), presenter: { kind: 'theme' } })
    coordinator.register({ declaration: declaration('replace', 'model.reasoning-intensity', 'replace', {
      claimId: 'renderer', mode: 'replace', priority: 20, requestedBindings: { properties: ['reasoningIntensity'] },
    }), generation: generation('replace'), presenter: { kind: 'renderer' } })
    let revision = policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'theme', 'overlay', 'allow'))
    revision = policies.setAuthorization(revision, authorization('replace', 'model.reasoning-intensity', 'renderer', 'replace', 'allow'))
    policies.setGroupChoice(revision, {
      pointId: 'model.reasoning-intensity', groupId: 'renderer', outcome: 'selected',
      selectedClaim: { principalHandle: 'principal:replace:explicit', identity: { source: 'https://plugins.example/replace', pluginId: 'replace', pointId: 'model.reasoning-intensity' }, claimId: 'renderer', mode: 'replace' },
    })

    const point = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
    expect(point.groupDecisions[0]).toMatchObject({ outcome: 'selected', authority: 'user', selectedClaim: { claimId: 'renderer' } })
    expect(point.candidates.map(item => [item.identity.pluginId, item.state])).toEqual([
      ['overlay', 'selected'], ['replace', 'selected'], ['legacy', 'conflicted'],
    ])
    expect(point.candidates.find(item => item.identity.pluginId === 'overlay')?.selection).toMatchObject({ authority: 'host-policy', rank: 0 })
    expect(point.candidates.find(item => item.identity.pluginId === 'replace')?.selection).not.toHaveProperty('rank')
    expect(coordinator.selectedPresenters(point.id).map(item => item.presenter)).toEqual([{ kind: 'theme' }, { kind: 'renderer' }])
    let managerGroup = coordinator.managerSnapshot().points.find(item => item.id === point.id)?.groups.find(group => group.id === 'renderer')
    expect(managerGroup?.decision).toMatchObject({
      outcome: 'selected', selectedClaim: { identity: { pluginId: 'replace' }, claimId: 'renderer', mode: 'replace' },
    })
    expect(managerGroup?.policyChoice).toMatchObject({
      outcome: 'selected', selectedClaim: { identity: { pluginId: 'replace' }, claimId: 'renderer', mode: 'replace' },
    })
    setReasoningState('pending')
    coordinator.invalidate()
    managerGroup = coordinator.managerSnapshot().points.find(item => item.id === point.id)?.groups.find(group => group.id === 'renderer')
    expect(managerGroup?.decision).toMatchObject({ outcome: 'none' })
    expect(managerGroup?.policyChoice).toMatchObject({ outcome: 'selected', selectedClaim: { claimId: 'renderer' } })
    coordinator.setGroupChoice(coordinator.managerSnapshot().policyRevision, {
      pointId: point.id, groupId: 'renderer', outcome: 'native',
    })
    managerGroup = coordinator.managerSnapshot().points.find(item => item.id === point.id)?.groups.find(group => group.id === 'renderer')
    expect(managerGroup?.decision).toMatchObject({ outcome: 'native' })
    expect(managerGroup?.policyChoice).toMatchObject({ outcome: 'native' })
  })

  it('keeps equal-priority winner order stable when profile-local principal handles change', () => {
    const resolveOrder = (handles: readonly [string, string]): readonly string[] => {
      const principals = ['alpha', 'beta'].map((pluginId, index) => ({
        handle: handles[index]!, source: `https://plugins.example/${pluginId}`, pluginId, origin: 'explicit' as const,
      }))
      const policies = new ControlledSurfacePolicyBroker(new MemoryControlledSurfacePolicyStore({ schemaVersion: 1, principals, authorizations: [], choices: [] }))
      const coordinator = new ControlledSurfaceCoordinator(catalog, {
        'model.overlay': { currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => null, dispatch: () => undefined },
        'model.reasoning-intensity': { currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => 'high', dispatch: () => undefined },
      }, 'host', policies)
      for (const [index, pluginId] of ['beta', 'alpha'].entries()) {
        const principalHandle = handles[pluginId === 'alpha' ? 0 : 1]!
        coordinator.register({
          declaration: normalizeControlledSurfaceDeclaration({
            principalHandle, source: `https://plugins.example/${pluginId}`, pluginId,
            pointId: 'model.reasoning-intensity', contributionId: 'same',
            control: { claimId: 'same', mode: 'compose', priority: 5 },
          }),
          generation: { principalHandle, principalOrigin: 'explicit', source: `https://plugins.example/${pluginId}`, pluginId, moduleGeneration: `${pluginId}-${index}` },
          presenter: {},
        })
      }
      const order = coordinator.snapshot().points.find(point => point.id === 'model.reasoning-intensity')!.candidates.map(item => item.identity.pluginId)
      coordinator.dispose(); policies.dispose()
      return order
    }
    expect(resolveOrder(['principal:zzz', 'principal:aaa'])).toEqual(['alpha', 'beta'])
    expect(resolveOrder(['principal:aaa', 'principal:zzz'])).toEqual(['alpha', 'beta'])
  })

  it('keeps exact partial denial separate from another claim at the same point', () => {
    const { coordinator, policies } = setup()
    coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'one', { claimId: 'one', mode: 'overlay' }), generation: generation('overlay'), presenter: {} })
    coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'two', { claimId: 'two', mode: 'overlay' }), generation: generation('overlay'), presenter: {} })
    const revision = policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'one', 'overlay', 'allow'))
    policies.setAuthorization(revision, authorization('overlay', 'model.reasoning-intensity', 'two', 'overlay', 'deny'))
    const states = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates
    expect(states.map(item => [item.claimId, item.authorization, item.state])).toEqual([
      ['one', 'allowed', 'selected'], ['two', 'denied', 'denied'],
    ])
  })

  it('suppresses the complete descendant closure while preserving denial and reevaluates on restore', () => {
    const { coordinator, policies } = setup()
    coordinator.register({ declaration: declaration('outer', 'model.overlay', 'shell', { claimId: 'shell', mode: 'replace' }), generation: generation('outer'), presenter: {} })
    coordinator.register({ declaration: declaration('denied', 'model.reasoning-intensity', 'control'), generation: generation('denied', 'denied-v1', 'legacy-structured'), presenter: {} })
    let revision = policies.setAuthorization(0, authorization('outer', 'model.overlay', 'shell', 'replace', 'allow'))
    revision = policies.setAuthorization(revision, authorization('denied', 'model.reasoning-intensity', 'control', 'compose', 'deny', 'legacy-structured'))
    policies.setGroupChoice(revision, {
      pointId: 'model.overlay', groupId: 'ownership', outcome: 'selected',
      selectedClaim: { principalHandle: 'principal:outer:explicit', identity: { source: 'https://plugins.example/outer', pluginId: 'outer', pointId: 'model.overlay' }, claimId: 'shell', mode: 'replace' },
    })
    let child = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
    expect(child).toMatchObject({ state: 'suppressed', suppression: { ancestorPointId: 'model.overlay', path: ['model.overlay', 'model.reasoning-intensity'] } })
    expect(child.candidates[0]).toMatchObject({ authorization: 'denied', state: 'suppressed' })

    policies.setGroupChoice(policies.revision(), { pointId: 'model.overlay', groupId: 'ownership', outcome: 'native' })
    child = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
    expect(child.candidates[0]).toMatchObject({ authorization: 'denied', state: 'denied' })
  })

  it('projects allowlisted scalars and dispatches only current selected claim with no-data result', async () => {
    const { coordinator, policies, dispatch, intensity } = setup()
    const control = { claimId: 'sync', mode: 'proxy' as const, requestedBindings: {
      properties: ['reasoningIntensity'], commands: ['setReasoningIntensity'], events: ['reasoningIntensityChanged'],
    } }
    coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'sync', control), generation: generation('overlay'), presenter: { kind: 'sync' } })
    policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'sync', 'proxy', 'allow'))
    const candidate = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates[0]!
    expect(candidate.bindings).toEqual({
      properties: [{ id: 'reasoningIntensity', value: 'high' }],
      commands: [{ id: 'setReasoningIntensity', available: true }],
      events: [{ id: 'reasoningIntensityChanged', available: true }],
    })
    const request = {
      $schema: CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1, schemaVersion: 1 as const,
      invocationId: 'invoke-1', hostGeneration: 'host-1', operation: 'point.host-command.invoke' as const,
      principalHandle: candidate.principalHandle,
      identity: candidate.identity, claimId: candidate.claimId, contributionId: candidate.contributionId,
      mode: candidate.mode, commandId: 'setReasoningIntensity', arguments: { value: 'medium' },
    }
    const result = await coordinator.invoke(generation('overlay'), request)
    expect(result).toMatchObject({ authority: 'host', outcome: 'accepted', reason: 'command.accepted' })
    expect(result).not.toHaveProperty('payload')
    expect(dispatch).toHaveBeenCalledWith('setReasoningIntensity', { value: 'medium' })
    expect(intensity()).toBe('medium')
    expect(coordinator.publishEvent('model.reasoning-intensity', 'reasoningIntensityChanged', { value: 'medium' })[0]).toMatchObject({
      authority: 'host', sequence: 1, identity: { pluginId: 'overlay' }, eventId: 'reasoningIntensityChanged', payload: { value: 'medium' },
    })
    await expect(coordinator.invoke(generation('overlay'), { ...request, arguments: { value: 'unsafe' } })).resolves.toMatchObject({ outcome: 'rejected', reason: 'arguments.invalid' })
  })

  it('fences owner, generation, policy CAS, forged identity, and unload cleanup', async () => {
    const { coordinator, policies, active } = setup()
    const handle = coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'sync', {
      claimId: 'sync', mode: 'proxy', requestedBindings: { commands: ['setReasoningIntensity'] },
    }), generation: generation('overlay'), presenter: {} })
    policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'sync', 'proxy', 'allow'))
    expect(() => policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'sync', 'proxy', 'deny'))).toThrow(/stale/)
    const selected = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates[0]!
    const request = {
      $schema: CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1, schemaVersion: 1 as const,
      invocationId: 'invoke', hostGeneration: 'host-1', operation: 'point.host-command.invoke' as const,
      principalHandle: selected.principalHandle,
      identity: selected.identity, claimId: selected.claimId, contributionId: selected.contributionId,
      mode: selected.mode, commandId: 'setReasoningIntensity', arguments: { value: 'low' },
    }
    await expect(coordinator.invoke(generation('replace'), request)).resolves.toMatchObject({ outcome: 'rejected', reason: 'caller.stale' })
    active.delete('overlay-v1')
    await expect(coordinator.invoke(generation('overlay'), request)).resolves.toMatchObject({ outcome: 'rejected', reason: 'caller.stale' })
    handle.dispose()
    expect(coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates).toEqual([])
    expect(() => handle.updatePresenter({ late: true })).toThrow(/disposed/)
  })

  it('keeps Manager policy CAS independent from runtime snapshot revisions', () => {
    const { coordinator } = setup()
    coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'policy', {
      claimId: 'policy', mode: 'proxy',
    }), generation: generation('overlay'), presenter: {} })
    coordinator.invalidate()
    coordinator.invalidate()
    const before = coordinator.managerSnapshot()
    expect(before.revision).toBeGreaterThan(before.policyRevision)
    expect(before.policyRevision).toBe(0)
    coordinator.setAuthorization(before.policyRevision, authorization('overlay', 'model.reasoning-intensity', 'policy', 'proxy', 'allow'))
    expect(coordinator.managerSnapshot().policyRevision).toBe(1)
    expect(() => coordinator.setAuthorization(before.policyRevision, authorization('overlay', 'model.reasoning-intensity', 'policy', 'proxy', 'deny'))).toThrow(/stale controlled surface policy revision/)
  })

  it('provides a claim-scoped safe lease and revokes it on denial and unload', async () => {
    const { coordinator, dispatch } = setup()
    const normalized = declaration('overlay', 'model.reasoning-intensity', 'lease', {
      claimId: 'lease', mode: 'proxy', requestedBindings: {
        properties: ['reasoningIntensity'], commands: ['setReasoningIntensity'], events: ['reasoningIntensityChanged'],
      },
    })
    const owner = generation('overlay')
    const registration = coordinator.register({ declaration: normalized, generation: owner, presenter: { kind: 'safe' } })
    const lease = coordinator.createLease(normalized, owner)
    coordinator.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'lease', 'proxy', 'allow'))
    expect(lease.snapshot()).toMatchObject({ state: 'selected', properties: { reasoningIntensity: 'high' } })
    expect(JSON.stringify(lease.snapshot())).not.toMatch(/principal|selector|native|presenter/)
    const changed = vi.fn()
    lease.subscribe(changed)
    coordinator.publishEvent('model.reasoning-intensity', 'reasoningIntensityChanged', { value: 'medium' })
    expect(lease.snapshot().events).toEqual([{ id: 'reasoningIntensityChanged', sequence: 1, payload: { value: 'medium' } }])
    await expect(lease.invoke('setReasoningIntensity', { value: 'medium' })).resolves.toMatchObject({ outcome: 'accepted' })
    expect(dispatch).toHaveBeenCalled()
    coordinator.setAuthorization(coordinator.policies.revision(), authorization('overlay', 'model.reasoning-intensity', 'lease', 'proxy', 'deny'))
    expect(lease.snapshot()).toMatchObject({ state: 'denied', properties: {}, commands: [], events: [] })
    await expect(lease.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({ outcome: 'rejected', reason: 'claim.not-selected' })
    registration.dispose(); lease.dispose()
    expect(lease.snapshot()).toMatchObject({ state: 'revoked', reason: 'lease.revoked' })
    expect(changed).toHaveBeenCalled()
  })

  it('persists only Host policy and stable principals across profile cold starts', () => {
    const store = new MemoryControlledSurfacePolicyStore()
    const first = new ControlledSurfacePolicyBroker(store)
    const principalHandle = first.principalHandle('https://plugins.example/theme', 'theme', 'explicit')
    expect(first.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).toBe(principalHandle)
    expect(first.principalHandle('https://plugins.example/theme', 'theme', 'legacy-structured')).not.toBe(principalHandle)
    first.setAuthorization(0, {
      ...authorization('theme', 'model.reasoning-intensity', 'paint', 'overlay', 'allow'), principalHandle,
    })
    first.setGroupChoice(first.revision(), {
      pointId: 'model.reasoning-intensity', groupId: 'renderer', outcome: 'selected',
      selectedClaim: { principalHandle, identity: { source: 'https://plugins.example/theme', pluginId: 'theme', pointId: 'model.reasoning-intensity' }, claimId: 'paint', mode: 'overlay' },
    })
    const serialized = JSON.stringify(store.value)
    expect(serialized).not.toMatch(/reasoningIntensity|presenter|selector|nativeNode|moduleGeneration/)
    first.dispose()

    const cold = new ControlledSurfacePolicyBroker(store)
    expect(cold.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).toBe(principalHandle)
    expect(cold.authorization({ principalHandle, identity: { source: 'https://plugins.example/theme', pluginId: 'theme', pointId: 'model.reasoning-intensity' }, claimId: 'paint', mode: 'overlay' })).toMatchObject({ policy: 'allow' })
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
      first.setAuthorization(0, { ...authorization('theme', 'model.reasoning-intensity', 'paint', 'overlay', 'allow'), principalHandle: handle })
      expect([...Array(dom.window.localStorage.length)].map((_, index) => dom.window.localStorage.key(index))).toEqual(['cordisx.extension-point-control.v1:profile-a'])
      const stored = dom.window.localStorage.getItem('cordisx.extension-point-control.v1:profile-a')!
      expect(stored).not.toMatch(/presenter|selector|native|reasoningIntensity|moduleGeneration/)
      const cold = new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore('profile-a'))
      expect(cold.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).toBe(handle)
      const isolated = new ControlledSurfacePolicyBroker(new BrowserControlledSurfacePolicyStore('profile-b'))
      expect(isolated.principalHandle('https://plugins.example/theme', 'theme', 'explicit')).not.toBe(handle)
      const missing = new ControlledSurfaceCoordinator(catalog, {
        'model.overlay': { currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => null, dispatch: () => undefined },
        'model.reasoning-intensity': { currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => 'high', dispatch: () => undefined },
      }, 'cold-host', cold)
      expect(missing.snapshot().points.every(point => point.candidates.length === 0)).toBe(true)
      missing.dispose(); isolated.dispose(); cold.dispose(); first.dispose()
    } finally {
      vi.unstubAllGlobals()
      dom.window.close()
    }
  })

  it('keeps Manager diagnostics read-only and excludes presenter, property values, callbacks, and native data', () => {
    const { coordinator } = setup()
    coordinator.register({ declaration: declaration('legacy', 'model.reasoning-intensity', 'legacy'), generation: generation('legacy', 'legacy-v1', 'legacy-structured'), presenter: { secret: 'presenter-data' } })
    const serialized = JSON.stringify(coordinator.managerSnapshot())
    expect(serialized).not.toContain('presenter-data')
    expect(serialized).not.toContain('"high"')
    expect(serialized).not.toContain('function')
    expect(coordinator.managerSnapshot().points.find(item => item.id === 'model.reasoning-intensity')?.selected[0]).toMatchObject({ claimId: 'legacy', mode: 'compose' })
  })

  it('rejects plugin identity forgery, free DOM presenters, hierarchy cycles, and unknown bindings closed', () => {
    const { coordinator } = setup()
    expect(() => coordinator.register({ declaration: declaration('legacy', 'model.reasoning-intensity', 'forged'), generation: generation('overlay'), presenter: {} })).toThrow(/principal handle/)
    const domHandle = coordinator.register({ declaration: declaration('legacy', 'model.reasoning-intensity', 'dom'), generation: generation('legacy', 'legacy-v1', 'legacy-structured'), presenter: { node: new Date(0) } })
    const unknownHandle = coordinator.register({ declaration: declaration('overlay', 'model.reasoning-intensity', 'unknown', {
      claimId: 'unknown', mode: 'overlay', requestedBindings: { properties: ['rawNode'] },
    }), generation: generation('overlay'), presenter: {} })
    const states = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates
    expect(states.filter(item => ['forged', 'dom', 'unknown'].includes(item.contributionId))).toEqual([])
    expect(coordinator.managerSnapshot().diagnostics.map(item => item.contributionId)).toEqual(['dom', 'unknown'])
    domHandle(); unknownHandle()

    const cyclic = structuredClone(catalog) as CordisXHostExtensionPointControlCatalogV1 & { points: { parentPointId?: string }[] }
    cyclic.points[0]!.parentPointId = 'model.reasoning-intensity'
    expect(() => new ControlledSurfaceCoordinator(cyclic, {
      'model.overlay': { currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => null, dispatch: () => undefined },
      'model.reasoning-intensity': { currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => null, dispatch: () => undefined },
    }, 'host')).toThrow(/cycle/)
  })

  it('normalizes the public slots.register control shorthand and gates the existing Host renderer', () => {
    const pointCatalog: CordisXHostExtensionPointControlCatalogV1 = {
      $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1, schemaVersion: 1,
      points: [{
        id: 'composer.reasoning-intensity',
        modes: [
          { id: 'compose', stacking: 'ordered', coexistsWith: ['overlay'], defaultAuthorization: 'allow' },
          { id: 'overlay', stacking: 'ordered', coexistsWith: ['compose'], defaultAuthorization: 'deny' },
        ],
        exclusiveGroups: [], safeProperties: [], safeCommands: [], safeEvents: [],
        ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
      }],
    }
    const policies = new ControlledSurfacePolicyBroker()
    const controls = new ControlledSurfaceCoordinator(pointCatalog, {
      'composer.reasoning-intensity': {
        currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => null, dispatch: () => undefined,
      },
    }, 'host-1', policies, item => item.moduleGeneration === 'theme-v1')
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setControlCoordinator(controls)
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'theme', [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme', [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
    })
    const registered = registry.register(plugin, {
      name: 'composer.reasoning-intensity', id: 'theme',
      control: { claimId: 'presentation', mode: 'overlay', priority: 10 },
    }, {
      variant: 'imperium', title: { key: 'title' }, stages: [
        { label: { key: 'low' }, material: 'plastic' }, { label: { key: 'high' }, material: 'gold' },
      ],
    })
    expect(registry.snapshot()[0]).toMatchObject({ authorized: false, control: { state: 'denied', identity: { pluginId: 'theme' } } })
    expect(registered.control?.snapshot()).toMatchObject({ state: 'denied', properties: {} })
    const controlled = registry.snapshot()[0]!.control!
    policies.setAuthorization(0, {
      ...authorization('theme', 'composer.reasoning-intensity', 'presentation', 'overlay', 'allow'),
      principalHandle: controlled.principalHandle,
    })
    expect(registry.snapshot()[0]).toMatchObject({ authorized: true, control: { state: 'selected', priority: 10 } })
    expect(registered.control?.snapshot()).toMatchObject({ state: 'selected' })
    expect(() => registry.register(plugin, {
      name: 'composer.reasoning-intensity', id: 'raw',
      control: { claimId: 'raw', mode: 'overlay', selector: '.native' } as never,
    }, {
      variant: 'imperium', title: { key: 'title' }, stages: [
        { label: { key: 'low' }, material: 'plastic' }, { label: { key: 'high' }, material: 'gold' },
      ],
    })).toThrow(/unknown field selector/)
    registry.dispose()
    expect(registered.control?.snapshot()).toMatchObject({ state: 'revoked' })
    contexts.dispose()
  })

  it('keeps lifecycle subscription while point-local denial scrubs a selected lease and restores it on inherit', async () => {
    const pointCatalog: CordisXHostExtensionPointControlCatalogV1 = {
      $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1, schemaVersion: 1,
      points: [{
        id: 'composer.reasoning-intensity',
        modes: [
          { id: 'compose', stacking: 'ordered', coexistsWith: ['proxy'], defaultAuthorization: 'allow' },
          { id: 'proxy', stacking: 'ordered', coexistsWith: ['compose'], defaultAuthorization: 'deny' },
        ],
        exclusiveGroups: [],
        safeProperties: [{ id: 'reasoningIntensity', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, visibility: 'renderer-safe', mutable: false }],
        safeCommands: [{ id: 'setReasoningIntensity', dispatch: 'host-brokered', arguments: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }] }],
        safeEvents: [{ id: 'reasoningIntensityChanged', delivery: 'host-projected', payload: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }] }],
        ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
      }],
    }
    const dispatch = vi.fn(async () => undefined)
    let pointState: 'pending' | 'active' = 'pending'
    const policies = new ControlledSurfacePolicyBroker()
    const controls = new ControlledSurfaceCoordinator(pointCatalog, {
      'composer.reasoning-intensity': {
        currentState: () => ({ state: pointState, reason: pointState === 'active' ? 'point.mounted' : 'point.pending' }),
        readProperty: () => 'high', dispatch,
      },
    }, 'host-1', policies)
    const contexts = new HostContextStore()
    const registry = new SurfaceRegistry(contexts)
    registry.setControlCoordinator(controls)
    let pointAllowed = true
    registry.setAccessResolver({
      decision: () => ({ policy: pointAllowed ? 'inherit' : 'deny', effectivePolicy: pointAllowed ? 'allow' : 'deny', authorized: pointAllowed, ...(!pointAllowed ? { reason: 'point.local-deny' } : {}) }),
    } as unknown as ExtensionPointAccessResolver)
    const plugin = new Context().extend({
      [CORDISX_PLUGIN_ID]: 'theme', [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme', [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
    })
    const registered = registry.register(plugin, {
      name: 'composer.reasoning-intensity', id: 'theme',
      control: { claimId: 'presentation', mode: 'proxy', requestedBindings: {
        properties: ['reasoningIntensity'], commands: ['setReasoningIntensity'], events: ['reasoningIntensityChanged'],
      } },
    }, {
      variant: 'imperium', title: { key: 'title' }, stages: [
        { label: { key: 'low' }, material: 'plastic' }, { label: { key: 'high' }, material: 'gold' },
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
    expect(lease.snapshot().events).toEqual([{ id: 'reasoningIntensityChanged', sequence: 1, payload: { value: 'high' } }])
    expect(changed).toHaveBeenCalledTimes(2)
    const policyRevision = policies.revision()

    pointAllowed = false
    registry.invalidatePointPolicies()
    expect(policies.revision()).toBe(policyRevision)
    expect(registry.snapshot()[0]).toMatchObject({ authorized: false, effectivePointPolicy: 'deny', control: { authorization: 'denied', state: 'denied', reason: 'point.local-deny' } })
    expect(lease.snapshot()).toMatchObject({ state: 'denied', reason: 'point.local-deny', properties: {}, commands: [], events: [] })
    const deniedChanged = vi.fn()
    expect(() => lease.subscribe(deniedChanged)).not.toThrow()
    await expect(lease.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({ outcome: 'rejected', reason: 'claim.not-selected' })
    expect(controls.publishEvent('composer.reasoning-intensity', 'reasoningIntensityChanged', { value: 'low' })).toEqual([])
    expect(dispatch).not.toHaveBeenCalled()
    expect(changed).toHaveBeenCalledTimes(3)

    pointAllowed = true
    registry.invalidatePointPolicies()
    expect(changed).toHaveBeenCalledTimes(4)
    expect(deniedChanged).toHaveBeenCalledTimes(1)
    expect(lease.snapshot()).toMatchObject({ state: 'selected', properties: { reasoningIntensity: 'high' } })
    await expect(lease.invoke('setReasoningIntensity', { value: 'medium' })).resolves.toMatchObject({ outcome: 'accepted' })
    expect(dispatch).toHaveBeenCalledWith('setReasoningIntensity', { value: 'medium' })
    registry.dispose(); contexts.dispose()
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
      $schema: CORDISX_HOST_EXTENSION_POINT_CONTROL_CATALOG_SCHEMA_V1, schemaVersion: 1,
      points: [{
        id: 'composer.reasoning-intensity',
        modes: [{ id: 'compose', stacking: 'ordered', coexistsWith: [], defaultAuthorization: 'allow' }],
        exclusiveGroups: [], safeProperties: [],
        safeCommands: [{ id: 'setReasoningIntensity', dispatch: 'host-brokered', arguments: [{ id: 'value', schema: { type: 'string', enum: ['low', 'medium', 'high'] }, required: true }] }],
        safeEvents: [], ownership: { scope: 'point', suppressesDescendantsWhenModes: [] },
      }],
    }
    const controls = new ControlledSurfaceCoordinator(generationCatalog, {
      'composer.reasoning-intensity': {
        currentState: () => ({ state: 'active', reason: 'point.mounted' }), readProperty: () => 'high',
        commandAvailability: () => ({ available: true }), dispatch,
      },
    }, 'host-generation', policies,
    (owner, view) => registry.controlGenerationVisible(owner, view),
    owner => registry.controlGenerationCallable(owner))
    registry.setControlCoordinator(controls)
    const root = new Context()
    const oldContext = root.extend({
      [CORDISX_PLUGIN_ID]: 'theme', [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme', [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
    })
    const item = (label: string) => ({
      variant: 'imperium' as const, title: { key: label }, stages: [
        { label: { key: 'low' }, material: 'plastic' as const }, { label: { key: 'high' }, material: 'gold' as const },
      ],
    })
    const options = {
      name: 'composer.reasoning-intensity' as const, id: 'theme',
      control: { claimId: 'theme', mode: 'compose' as const, requestedBindings: { commands: ['setReasoningIntensity'] } },
    }
    const old = registry.register(oldContext, options, item('old'))
    expect(registry.snapshot()).toHaveLength(1)
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(1)

    const transition = visibility.begin('retry-theme', previous, candidate, 'retry-theme:exact')
    const newContext = root.extend({
      [CORDISX_PLUGIN_ID]: 'theme', [CORDISX_PLUGIN_SOURCE]: 'https://plugins.example/theme', [CORDISX_PLUGIN_GENERATION]: 'theme-v1',
      ...visibility.context(transition, 'theme'),
    })
    const next = registry.register(newContext, options, item('new'))
    expect((registry.snapshot()[0]?.item as { title: { key: string } }).title.key).toBe('old')
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(1)
    const candidateView = visibility.view(newContext)
    expect((registry.snapshot(candidateView)[0]?.item as { title: { key: string } }).title.key).toBe('new')
    expect(controls.snapshot(candidateView).points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(1)
    expect(next.control?.snapshot()).toMatchObject({ state: 'revoked' })

    const publication = visibility.publish(visibility.preparePublish(transition, visibility.confirmReadiness(transition)))
    expect((registry.snapshot()[0]?.item as { title: { key: string } }).title.key).toBe('new')
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(1)
    expect(old.control?.snapshot()).toMatchObject({ state: 'revoked' })
    expect(next.control?.snapshot()).toMatchObject({ state: 'selected' })
    await expect(next.control?.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({ outcome: 'accepted' })

    visibility.rollback(publication)
    expect((registry.snapshot()[0]?.item as { title: { key: string } }).title.key).toBe('old')
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(1)
    expect(old.control?.snapshot()).toMatchObject({ state: 'selected' })
    expect(next.control?.snapshot()).toMatchObject({ state: 'revoked' })
    await expect(next.control?.invoke('setReasoningIntensity', { value: 'low' })).resolves.toMatchObject({ outcome: 'rejected' })
    next.dispose()
    visibility.completeRollback(publication)
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(1)
    old.dispose()
    expect(controls.snapshot().points.find(point => point.id === 'composer.reasoning-intensity')?.candidates).toHaveLength(0)
    registry.dispose(); contexts.dispose()
  })
})
