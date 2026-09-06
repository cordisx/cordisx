import { expect, it } from 'vitest'
import { CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1 } from '../../packages/cli/src/contracts.js'
import {
  ControlledSurfaceCoordinator,
  ControlledSurfacePolicyBroker,
  MemoryControlledSurfacePolicyStore,
  normalizeControlledSurfaceDeclaration,
} from '../../packages/cli/src/renderer/controlled-surfaces.js'
import { authorization, catalog, declaration, generation, setup } from './controlled-surfaces.fixtures.js'

export function registerSelectionTests() {
  it('normalizes legacy contributions as compose-only with priority=-order and no bindings', () => {
    expect(declaration('legacy', 'model.reasoning-intensity', 'control', undefined, 17)).toMatchObject({
      origin: 'legacy-structured',
      claimId: 'control',
      contributionId: 'control',
      mode: 'compose',
      priority: -17,
      requestedBindings: { properties: [], commands: [], events: [] },
      identity: { pluginId: 'legacy', pointId: 'model.reasoning-intensity' },
    })
  })

  it('accepts explicit compose claims and resolves their catalog-authorized safe bindings', () => {
    const { coordinator } = setup()
    const normalized = declaration('overlay', 'model.reasoning-intensity', 'compose', {
      claimId: 'compose',
      mode: 'compose',
      priority: 12,
      requestedBindings: { properties: ['reasoningIntensity'] },
    })
    coordinator.register({ declaration: normalized, generation: generation('overlay'), presenter: { kind: 'compose' } })
    expect(coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')?.candidates[0])
      .toMatchObject({
        origin: 'explicit',
        mode: 'compose',
        authorization: 'allowed',
        state: 'selected',
        bindings: { properties: [{ id: 'reasoningIntensity', value: 'high' }] },
      })
  })

  it('resolves exclusive groups first, then selects compatible ordered claims deterministically', () => {
    const { coordinator, policies, setReasoningState } = setup()
    coordinator.register({
      declaration: declaration('legacy', 'model.reasoning-intensity', 'legacy', undefined, 10),
      generation: generation('legacy', 'legacy-v1', 'legacy-structured'),
      presenter: { kind: 'legacy' },
    })
    coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'overlay', {
        claimId: 'theme',
        mode: 'overlay',
        priority: 30,
        requestedBindings: { properties: ['reasoningIntensity'] },
      }),
      generation: generation('overlay'),
      presenter: { kind: 'theme' },
    })
    coordinator.register({
      declaration: declaration('replace', 'model.reasoning-intensity', 'replace', {
        claimId: 'renderer',
        mode: 'replace',
        priority: 20,
        requestedBindings: { properties: ['reasoningIntensity'] },
      }),
      generation: generation('replace'),
      presenter: { kind: 'renderer' },
    })
    let revision = policies.setAuthorization(
      0,
      authorization('overlay', 'model.reasoning-intensity', 'theme', 'overlay', 'allow'),
    )
    revision = policies.setAuthorization(
      revision,
      authorization('replace', 'model.reasoning-intensity', 'renderer', 'replace', 'allow'),
    )
    policies.setGroupChoice(revision, {
      pointId: 'model.reasoning-intensity',
      groupId: 'renderer',
      outcome: 'selected',
      selectedClaim: {
        principalHandle: 'principal:replace:explicit',
        identity: {
          source: 'https://plugins.example/replace',
          pluginId: 'replace',
          pointId: 'model.reasoning-intensity',
        },
        claimId: 'renderer',
        mode: 'replace',
      },
    })

    const point = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
    expect(point.groupDecisions[0]).toMatchObject({
      outcome: 'selected',
      authority: 'user',
      selectedClaim: { claimId: 'renderer' },
    })
    expect(point.candidates.map(item => [item.identity.pluginId, item.state])).toEqual([
      ['overlay', 'selected'],
      ['replace', 'selected'],
      ['legacy', 'conflicted'],
    ])
    expect(point.candidates.find(item => item.identity.pluginId === 'overlay')?.selection).toMatchObject({
      authority: 'host-policy',
      rank: 0,
    })
    expect(point.candidates.find(item => item.identity.pluginId === 'replace')?.selection).not.toHaveProperty('rank')
    expect(coordinator.selectedPresenters(point.id).map(item => item.presenter)).toEqual([{ kind: 'theme' }, {
      kind: 'renderer',
    }])
    let managerGroup = coordinator.managerSnapshot().points.find(item => item.id === point.id)?.groups.find(group =>
      group.id === 'renderer'
    )
    expect(managerGroup?.decision).toMatchObject({
      outcome: 'selected',
      selectedClaim: { identity: { pluginId: 'replace' }, claimId: 'renderer', mode: 'replace' },
    })
    expect(managerGroup?.policyChoice).toMatchObject({
      outcome: 'selected',
      selectedClaim: { identity: { pluginId: 'replace' }, claimId: 'renderer', mode: 'replace' },
    })
    setReasoningState('pending')
    coordinator.invalidate()
    managerGroup = coordinator.managerSnapshot().points.find(item => item.id === point.id)?.groups.find(group =>
      group.id === 'renderer'
    )
    expect(managerGroup?.decision).toMatchObject({ outcome: 'none' })
    expect(managerGroup?.policyChoice).toMatchObject({ outcome: 'selected', selectedClaim: { claimId: 'renderer' } })
    coordinator.setGroupChoice(coordinator.managerSnapshot().policyRevision, {
      pointId: point.id,
      groupId: 'renderer',
      outcome: 'native',
    })
    managerGroup = coordinator.managerSnapshot().points.find(item => item.id === point.id)?.groups.find(group =>
      group.id === 'renderer'
    )
    expect(managerGroup?.decision).toMatchObject({ outcome: 'native' })
    expect(managerGroup?.policyChoice).toMatchObject({ outcome: 'native' })
  })

  it('keeps equal-priority winner order stable when profile-local principal handles change', () => {
    const resolveOrder = (handles: readonly [string, string]): readonly string[] => {
      const principals = ['alpha', 'beta'].map((pluginId, index) => ({
        handle: handles[index]!,
        source: `https://plugins.example/${pluginId}`,
        pluginId,
        origin: 'explicit' as const,
      }))
      const policies = new ControlledSurfacePolicyBroker(
        new MemoryControlledSurfacePolicyStore({ schemaVersion: 1, principals, authorizations: [], choices: [] }),
      )
      const coordinator = new ControlledSurfaceCoordinator(
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
        'host',
        policies,
      )
      for (const [index, pluginId] of ['beta', 'alpha'].entries()) {
        const principalHandle = handles[pluginId === 'alpha' ? 0 : 1]!
        coordinator.register({
          declaration: normalizeControlledSurfaceDeclaration({
            principalHandle,
            source: `https://plugins.example/${pluginId}`,
            pluginId,
            pointId: 'model.reasoning-intensity',
            contributionId: 'same',
            control: { claimId: 'same', mode: 'compose', priority: 5 },
          }),
          generation: {
            principalHandle,
            principalOrigin: 'explicit',
            source: `https://plugins.example/${pluginId}`,
            pluginId,
            moduleGeneration: `${pluginId}-${index}`,
          },
          presenter: {},
        })
      }
      const order = coordinator.snapshot().points.find(point => point.id === 'model.reasoning-intensity')!.candidates
        .map(item => item.identity.pluginId)
      coordinator.dispose()
      policies.dispose()
      return order
    }
    expect(resolveOrder(['principal:zzz', 'principal:aaa'])).toEqual(['alpha', 'beta'])
    expect(resolveOrder(['principal:aaa', 'principal:zzz'])).toEqual(['alpha', 'beta'])
  })

  it('retains legacy claim records only as migration input and never as a second runtime authorization', () => {
    const { coordinator, policies } = setup()
    coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'one', { claimId: 'one', mode: 'overlay' }),
      generation: generation('overlay'),
      presenter: {},
    })
    coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'two', { claimId: 'two', mode: 'overlay' }),
      generation: generation('overlay'),
      presenter: {},
    })
    const revision = policies.setAuthorization(
      0,
      authorization('overlay', 'model.reasoning-intensity', 'one', 'overlay', 'allow'),
    )
    policies.setAuthorization(revision, authorization('overlay', 'model.reasoning-intensity', 'two', 'overlay', 'deny'))
    const states = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates
    expect(states.map(item => [item.claimId, item.authorization, item.state])).toEqual([
      ['one', 'allowed', 'selected'],
      ['two', 'allowed', 'selected'],
    ])
    expect(policies.legacyAuthorizations()).toHaveLength(2)
  })

  it('suppresses the complete descendant closure while preserving denial and reevaluates on restore', () => {
    const { coordinator, policies } = setup()
    coordinator.register({
      declaration: declaration('outer', 'model.overlay', 'shell', { claimId: 'shell', mode: 'replace' }),
      generation: generation('outer'),
      presenter: {},
    })
    coordinator.register({
      declaration: declaration('denied', 'model.reasoning-intensity', 'control'),
      generation: generation('denied', 'denied-v1', 'legacy-structured'),
      presenter: {},
    })
    let revision = policies.setAuthorization(0, authorization('outer', 'model.overlay', 'shell', 'replace', 'allow'))
    revision = policies.setAuthorization(
      revision,
      authorization('denied', 'model.reasoning-intensity', 'control', 'compose', 'deny', 'legacy-structured'),
    )
    policies.setGroupChoice(revision, {
      pointId: 'model.overlay',
      groupId: 'ownership',
      outcome: 'selected',
      selectedClaim: {
        principalHandle: 'principal:outer:explicit',
        identity: { source: 'https://plugins.example/outer', pluginId: 'outer', pointId: 'model.overlay' },
        claimId: 'shell',
        mode: 'replace',
      },
    })
    let child = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
    expect(child).toMatchObject({
      state: 'suppressed',
      suppression: { ancestorPointId: 'model.overlay', path: ['model.overlay', 'model.reasoning-intensity'] },
    })
    expect(child.candidates[0]).toMatchObject({ authorization: 'allowed', state: 'suppressed' })

    policies.setGroupChoice(policies.revision(), { pointId: 'model.overlay', groupId: 'ownership', outcome: 'native' })
    child = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
    expect(child.candidates[0]).toMatchObject({ authorization: 'allowed', state: 'selected' })
  })

  it('projects allowlisted scalars and dispatches only current selected claim with no-data result', async () => {
    const { coordinator, policies, dispatch, intensity } = setup()
    const control = {
      claimId: 'sync',
      mode: 'proxy' as const,
      requestedBindings: {
        properties: ['reasoningIntensity'],
        commands: ['setReasoningIntensity'],
        events: ['reasoningIntensityChanged'],
      },
    }
    coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'sync', control),
      generation: generation('overlay'),
      presenter: { kind: 'sync' },
    })
    policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'sync', 'proxy', 'allow'))
    const candidate = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!
      .candidates[0]!
    expect(candidate.bindings).toEqual({
      properties: [{ id: 'reasoningIntensity', value: 'high' }],
      commands: [{ id: 'setReasoningIntensity', available: true }],
      events: [{ id: 'reasoningIntensityChanged', available: true }],
    })
    const request = {
      $schema: CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
      schemaVersion: 1 as const,
      invocationId: 'invoke-1',
      hostGeneration: 'host-1',
      operation: 'point.host-command.invoke' as const,
      principalHandle: candidate.principalHandle,
      identity: candidate.identity,
      claimId: candidate.claimId,
      contributionId: candidate.contributionId,
      mode: candidate.mode,
      commandId: 'setReasoningIntensity',
      arguments: { value: 'medium' },
    }
    const result = await coordinator.invoke(generation('overlay'), request)
    expect(result).toMatchObject({ authority: 'host', outcome: 'accepted', reason: 'command.accepted' })
    expect(result).not.toHaveProperty('payload')
    expect(dispatch).toHaveBeenCalledWith(
      'setReasoningIntensity',
      { value: 'medium' },
      expect.objectContaining({
        caller: expect.objectContaining({ pluginId: 'overlay', moduleGeneration: 'overlay-v1' }),
        declaration: expect.objectContaining({ claimId: 'sync' }),
      }),
    )
    expect(intensity()).toBe('medium')
    expect(coordinator.publishEvent('model.reasoning-intensity', 'reasoningIntensityChanged', { value: 'medium' })[0])
      .toMatchObject({
        authority: 'host',
        sequence: 1,
        identity: { pluginId: 'overlay' },
        eventId: 'reasoningIntensityChanged',
        payload: { value: 'medium' },
      })
    await expect(coordinator.invoke(generation('overlay'), { ...request, arguments: { value: 'unsafe' } })).resolves
      .toMatchObject({ outcome: 'rejected', reason: 'arguments.invalid' })
  })

  it('fences owner, generation, policy CAS, forged identity, and unload cleanup', async () => {
    const { coordinator, policies, active } = setup()
    const handle = coordinator.register({
      declaration: declaration('overlay', 'model.reasoning-intensity', 'sync', {
        claimId: 'sync',
        mode: 'proxy',
        requestedBindings: { commands: ['setReasoningIntensity'] },
      }),
      generation: generation('overlay'),
      presenter: {},
    })
    policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'sync', 'proxy', 'allow'))
    expect(() =>
      policies.setAuthorization(0, authorization('overlay', 'model.reasoning-intensity', 'sync', 'proxy', 'deny'))
    ).toThrow(/stale/)
    const selected = coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates[0]!
    const request = {
      $schema: CORDISX_EXTENSION_POINT_CONTROL_ACCESS_SCHEMA_V1,
      schemaVersion: 1 as const,
      invocationId: 'invoke',
      hostGeneration: 'host-1',
      operation: 'point.host-command.invoke' as const,
      principalHandle: selected.principalHandle,
      identity: selected.identity,
      claimId: selected.claimId,
      contributionId: selected.contributionId,
      mode: selected.mode,
      commandId: 'setReasoningIntensity',
      arguments: { value: 'low' },
    }
    await expect(coordinator.invoke(generation('replace'), request)).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'caller.stale',
    })
    active.delete('overlay-v1')
    await expect(coordinator.invoke(generation('overlay'), request)).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'caller.stale',
    })
    handle.dispose()
    expect(coordinator.snapshot().points.find(item => item.id === 'model.reasoning-intensity')!.candidates).toEqual([])
    expect(() => handle.updatePresenter({ late: true })).toThrow(/disposed/)
  })
}
