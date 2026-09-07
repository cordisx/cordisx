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
function manifest() {
  return normalizeVisualManifestV10({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V10,
    schemaVersion: 10,
    id: 'animal',
    name: 'Animal',
    services: [],
    capabilities: [
      { name: 'ui.extension-points.render', required: true, scope: { extensionPoints: points } },
      interaction,
    ],
  }, 'animal')
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
  it('serializes point prompts, accepts long HMR generations, and revokes on unload', async () => {
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
    const unregister = broker.register(identity, manifest(), { pluginId: identity.id, moduleGeneration: generation })
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
