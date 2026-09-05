import { describe, expect, it } from 'vitest'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPluginManifestV4,
} from '../packages/cli/src/permission-contracts.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  type PermissionAuthorizationPromptV2,
  PermissionBroker,
  type PermissionPrompt,
} from '../packages/cli/src/renderer/platform.js'

const identity = { source: 'https://plugins.example/permission-v4', id: 'permission-v4' }
const session = { providerId: 'codex', remoteSessionId: 'task-1' }

const legacyPrompt: PermissionPrompt = { request: async () => 'deny' }
const cancelledV2: PermissionAuthorizationPromptV2 = { request: async () => undefined }

function manifest(capability: 'models.read' | 'tasks.control', scope: object): CordisXPluginManifestV4 {
  return normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: identity.id,
    capabilities: [{
      name: capability,
      required: true,
      rationale: {
        title: { key: 'title', fallback: 'Use an authorized Host capability' },
        description: { key: 'description', fallback: 'Uses only the selected Host scope.' },
        feature: { key: 'feature', fallback: 'Permission test feature' },
        deniedBehavior: { key: 'denied', fallback: 'The feature remains disabled.' },
      },
      security: { dataUse: 'ephemeral', retention: 'none', externalTransfer: false },
      scope,
    }],
    services: [],
  }, identity.id) as CordisXPluginManifestV4
}

function decision(
  plan: CordisXPermissionAuthorizationPlanV2,
  choice: CordisXPermissionAuthorizationDecisionV2['decisions'][number]['decision'],
  requestId?: string,
): CordisXPermissionAuthorizationDecisionV2 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: { ...plan.binding, ...(requestId === undefined ? {} : { requestId }) },
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: choice,
    })),
  }
}

describe('PermissionBroker permission-v2 integration', () => {
  it('binds lifecycle allow-once to one exact profile/identity/scope/fingerprint/generation grant', async () => {
    const store = new MemoryPermissionPolicyStore()
    const broker = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date(),
      50,
      'work',
      'runtime-1',
      undefined,
      undefined,
      cancelledV2,
    )
    broker.register(identity, manifest('tasks.control', { sessions: [session] }), {
      pluginId: identity.id,
      moduleGeneration: 'module-1',
    })
    const plan = broker.authorizationPlanV2(identity, 'install')
    await broker.authorizeActivationV2(identity, decision(plan, 'allow-once', 'candidate-1'), 'install')
    expect(broker.requiredDenied(identity)).toEqual([])
    await expect(broker.authorize(identity, 'tasks.control', { session })).resolves.toMatchObject({ ok: true })
    await expect(broker.authorize(identity, 'tasks.control', { session })).resolves.toMatchObject({
      ok: false,
      error: { code: 'permission-denied' },
    })
    expect(store.readV2()).toEqual([])
  })

  it('persists an exact allowed grant in the same store and restores it in a fresh Broker', async () => {
    const store = new MemoryPermissionPolicyStore()
    const first = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date(),
      50,
      'work',
      'runtime-1',
      undefined,
      undefined,
      cancelledV2,
    )
    first.register(identity, manifest('models.read', { providers: ['codex'] }), {
      pluginId: identity.id,
      moduleGeneration: 'module-1',
    })
    const plan = first.authorizationPlanV2(identity, 'install')
    await first.authorizeActivationV2(identity, decision(plan, 'allow-persistent', 'candidate-1'), 'install')
    expect(store.read()).toEqual([])
    expect(store.readV2()).toHaveLength(1)

    const restored = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date(),
      50,
      'work',
      'runtime-2',
      undefined,
      undefined,
      cancelledV2,
    )
    restored.register(identity, manifest('models.read', { providers: ['codex'] }), {
      pluginId: identity.id,
      moduleGeneration: 'module-2',
    })
    expect(restored.authorizationPlanV2(identity).declarations[0]).toMatchObject({
      policy: 'allow-persistent',
      decisionRequired: false,
    })
    expect(restored.requiredDenied(identity)).toEqual([])
  })

  it('fails an expanded scope back to ask without modifying the narrower persistent record', async () => {
    const store = new MemoryPermissionPolicyStore()
    const narrow = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date(),
      50,
      'work',
      'runtime-1',
      undefined,
      undefined,
      cancelledV2,
    )
    narrow.register(identity, manifest('models.read', { providers: ['codex'] }))
    const plan = narrow.authorizationPlanV2(identity, 'enable')
    await narrow.authorizeActivationV2(identity, decision(plan, 'allow-persistent'), 'enable')

    const expanded = new PermissionBroker(
      store,
      legacyPrompt,
      () => new Date(),
      50,
      'work',
      'runtime-2',
      undefined,
      undefined,
      cancelledV2,
    )
    expanded.register(identity, manifest('models.read', { providers: ['codex', 'external'] }))
    expect(expanded.authorizationPlanV2(identity).declarations[0]).toMatchObject({
      policy: 'ask',
      decisionRequired: true,
    })
    expect(store.readV2()[0]?.key.scope).toEqual({ providers: ['codex'] })
  })
})
