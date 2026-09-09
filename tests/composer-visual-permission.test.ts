import { normalizeTaskManifest } from '../packages/cli/src/agent-task-permission-manifest.js'
import { describe, expect, it, vi } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
  normalizeVisualManifestV10,
} from '../packages/cli/src/extension-point-interaction-permissions.js'
import { visualInteractionPlan } from '../packages/cli/src/extension-point-interaction-authorization.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import { CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { CORDISX_PERMISSION_LOCALE_CATALOGS } from '../packages/cli/src/permission-locales.js'

const identity = { source: 'file:///animal.js', id: 'animal' }
const points = ['composer.primary-action.visual', 'composer.frame.overlay'] as const
const interaction = {
  name: 'ui.extension-points.interact',
  required: false,
  scope: { extensionPoints: [points[1]], events: ['pointer.observe'] },
} as const
function manifest(id = 'animal') {
  return normalizeVisualManifestV10({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
    schemaVersion: 10,
    id,
    name: 'Animal',
    services: [],
    capabilities: [
      { name: 'ui.extension-points.render', required: true, scope: { extensionPoints: points } },
      interaction,
    ],
  }, id)
}
describe('Composer visual authority', () => {
  it('preserves exact manifest capabilities and rejects broad or malformed interaction scopes', () => {
    expect(manifest().capabilities.map(item => item.name)).toEqual([
      'ui.extension-points.render',
      'ui.extension-points.interact',
    ])
    for (
      const scope of [{ events: ['pointer.observe'] }, { extensionPoints: ['*'], events: ['pointer.observe'] }, {
        extensionPoints: points,
        events: ['click'],
      }, { extensionPoints: points, events: ['pointer.observe'], selectors: ['body'] }]
    ) {
      expect(() => normalizeVisualManifestV10({ ...manifest(), capabilities: [{ ...interaction, scope }] }, 'animal'))
        .toThrow()
    }
  })
  it('offers only explicit generation-bound interaction decisions with complete locale copy', () => {
    const plan = visualInteractionPlan({
      planId: 'visual-1',
      operation: 'runtime',
      profileId: 'test',
      catalogVersion: 'test',
      identity: { source: identity.source, pluginId: identity.id },
      binding: {
        operationId: 'visual-1',
        runtimeGeneration: 'runtime',
        moduleGeneration: 'module',
        requestId: 'visual-1',
      },
    }, interaction)
    const model = new PermissionAuthorizationViewModel(plan)
    expect(plan.declarations[0]).toMatchObject({
      certifiedImplicitApproval: false,
      authorizationMode: 'explicit-user',
      allowedDecisions: ['allow-once', 'deny-once'],
    })
    expect(() => model.select('ui.extension-points.interact', 'allow-persistent')).toThrow()
    model.select('ui.extension-points.interact', 'allow-once')
    expect(model.confirm()).toMatchObject({
      status: 'confirmed',
      decision: {
        schemaVersion: 5,
        binding: plan.binding,
        decisions: [{ scope: interaction.scope, decision: 'allow-once' }],
      },
    })
    for (const catalog of CORDISX_PERMISSION_LOCALE_CATALOGS) {
      for (const text of Object.values(plan.declarations[0]!.presentation)) {
        expect(catalog.messages[text.key]).toBeTypeOf('string')
      }
    }
  })
  it.each([10, 11, 12])('serializes point prompts and revokes on unload for manifest v%s', async version => {
    const seen: string[] = []
    let concurrent = 0, maximum = 0
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date(),
      500,
      'test',
      'runtime-'.repeat(8),
      undefined,
      undefined,
      {
        request: async () => undefined,
        requestV3: async plan => {
          concurrent++
          maximum = Math.max(maximum, concurrent)
          expect(plan.planId.length).toBeLessThanOrEqual(128)
          seen.push(plan.declarations[0]!.scope.extensionPoints![0]!)
          await new Promise(resolve => setTimeout(resolve, 5))
          concurrent--
          return {
            $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V3,
            schemaVersion: 3,
            origin: 'explicit-user',
            planId: plan.planId,
            operation: plan.operation,
            profileId: plan.profileId,
            identity: plan.identity,
            binding: plan.binding,
            decisions: plan.declarations.map(item => ({
              capability: item.capability,
              scope: item.scope,
              securityFingerprint: item.securityFingerprint,
              decision: 'allow-once' as const,
            })),
          }
        },
      },
    )
    const generation = 'vite-'.repeat(15)
    const candidate = version === 10 ? manifest() : normalizeTaskManifest({
      ...manifest(),
      schemaVersion: version,
      $schema:
        `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v${version}.schema.json`,
    }, identity.id)
    const unregister = broker.register(identity, candidate, { pluginId: identity.id, moduleGeneration: generation })
    try {
      const authorities = points.map(point => broker.visualAuthority(identity, generation, point, () => true))
      expect(authorities.map(item => item.render())).toEqual([false, false])
      await vi.waitFor(() => expect(authorities.map(item => item.render())).toEqual([true, true]))
      expect(seen).toEqual(points)
      expect(maximum).toBe(1)
      expect(authorities[0]!.observePointer()).toBe(false)
      unregister()
      expect(authorities.map(item => item.render())).toEqual([false, false])
    } finally {
      unregister()
      broker.dispose()
    }
  })
})

it('bounds interaction request identifiers even for a maximum-length plugin id', async () => {
  let planId: string | undefined
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    500,
    'test',
    'runtime',
    undefined,
    undefined,
    {
      request: async () => undefined,
      requestVisualV5: async plan => {
        planId = plan.planId
        return undefined
      },
    },
  )
  const identity = { source: 'file:///long-visual.js', id: 'a'.repeat(96) }
  const unregister = broker.register(identity, manifest(identity.id), {
    pluginId: identity.id,
    moduleGeneration: 'module',
  })
  try {
    await broker.setDomPolicy(identity, points[1], 'allow-persistent')
    const authority = broker.visualAuthority(identity, 'module', points[1], () => true)
    authority.observePointer()
    await vi.waitFor(() => expect(planId).toBeTypeOf('string'))
    expect(planId!.length).toBeLessThanOrEqual(128)
  } finally {
    unregister()
    broker.dispose()
  }
})

it('auto-authorizes only Host-enrolled local development identities and keeps revocation and generation fences', () => {
  const request = vi.fn(async () => 'deny' as const)
  const promptVisual = vi.fn(async () => undefined)
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request },
    () => new Date(),
    500,
    'dev',
    'runtime',
    undefined,
    undefined,
    { request: async () => undefined, requestVisualV5: promptVisual },
  )
  const unregister = broker.register(
    identity,
    manifest(),
    { pluginId: identity.id, moduleGeneration: 'dev-one' },
    undefined,
    undefined,
    true,
  )
  const authority = broker.visualAuthority(identity, 'dev-one', points[1], () => true)
  expect(authority.render()).toBe(true)
  expect(authority.observePointer()).toBe(true)
  expect(broker.visualAuthority(identity, 'dev-one', points[0], () => true).observePointer()).toBe(false)
  broker.setVisualInteractionPolicy(identity, false)
  expect(authority.observePointer()).toBe(false)
  broker.setVisualInteractionPolicy(identity, true)
  expect(authority.observePointer()).toBe(true)
  unregister()
  expect(authority.observePointer()).toBe(false)
  expect(request).not.toHaveBeenCalled()
  expect(promptVisual).not.toHaveBeenCalled()
  broker.dispose()
})

it('gates overlay drag and activation independently and rejects required unsupported point/event pairs', () => {
  for (const events of [['pointer.observe'], ['drag'], ['activate'], ['pointer.observe', 'drag', 'activate']]) {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: async () => 'deny' })
    const declaration = { ...interaction, scope: { extensionPoints: points, events } }
    const candidate = normalizeVisualManifestV10({
      ...manifest(),
      capabilities: [manifest().capabilities[0], declaration],
    }, identity.id)
    const unregister = broker.register(
      identity,
      candidate,
      { pluginId: identity.id, moduleGeneration: 'events' },
      undefined,
      undefined,
      true,
    )
    const primary = broker.visualAuthority(identity, 'events', points[0], () => true)
    const overlay = broker.visualAuthority(identity, 'events', points[1], () => true)
    expect(primary.observePointer()).toBe(events.includes('pointer.observe'))
    expect(primary.drag?.()).toBe(false)
    expect(primary.activate?.()).toBe(false)
    expect(overlay.observePointer()).toBe(events.includes('pointer.observe'))
    expect(overlay.drag?.()).toBe(events.includes('drag'))
    expect(overlay.activate?.()).toBe(events.includes('activate'))
    broker.setVisualInteractionPolicy(identity, false)
    expect(overlay.drag?.()).toBe(false)
    expect(overlay.activate?.()).toBe(false)
    unregister()
    expect(overlay.drag?.()).toBe(false)
    const required = normalizeVisualManifestV10({
      ...manifest(),
      capabilities: [manifest().capabilities[0], { ...declaration, required: true }],
    }, identity.id)
    const retire = broker.register(identity, required, { pluginId: identity.id, moduleGeneration: 'required' })
    expect(broker.visualDeclarationSupported(identity, 'required')).toBe(
      events.length === 1 && events[0] === 'pointer.observe',
    )
    retire()
    const overlayRequired = normalizeVisualManifestV10({
      ...manifest(),
      capabilities: [manifest().capabilities[0], {
        ...declaration,
        required: true,
        scope: { extensionPoints: [points[1]], events },
      }],
    }, identity.id)
    const retireOverlay = broker.register(identity, overlayRequired, {
      pluginId: identity.id,
      moduleGeneration: 'overlay-required',
    })
    expect(broker.visualDeclarationSupported(identity, 'overlay-required')).toBe(true)
    retireOverlay()
    broker.dispose()
  }
})

it('reviews only declared supported events without widening a drag-only grant to pointer or activation', async () => {
  const plans: ReturnType<typeof visualInteractionPlan>[] = []
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    500,
    'test',
    'runtime',
    undefined,
    undefined,
    {
      request: async () => undefined,
      requestVisualV5: async plan => {
        plans.push(plan)
        const model = new PermissionAuthorizationViewModel(plan)
        model.select('ui.extension-points.interact', 'allow-once')
        const result = model.confirm()
        return result.status === 'confirmed' ? result.decision : undefined
      },
    },
  )
  const candidate = normalizeVisualManifestV10({
    ...manifest(),
    capabilities: [manifest().capabilities[0], {
      ...interaction,
      scope: { extensionPoints: points, events: ['drag'] },
    }],
  }, identity.id)
  const unregister = broker.register(identity, candidate, { pluginId: identity.id, moduleGeneration: 'drag' })
  try {
    await broker.setDomPolicy(identity, points[1], 'allow-persistent')
    const authority = broker.visualAuthority(identity, 'drag', points[1], () => true)
    expect(authority.drag?.()).toBe(false)
    await vi.waitFor(() => expect(authority.drag?.()).toBe(true))
    expect(plans).toHaveLength(1)
    expect(plans[0]!.declarations[0]!.scope).toEqual({ extensionPoints: [...points].sort(), events: ['drag'] })
    expect(authority.observePointer()).toBe(false)
    expect(authority.activate?.()).toBe(false)
  } finally {
    unregister()
    broker.dispose()
  }
})
