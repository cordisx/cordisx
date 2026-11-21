import { expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import {
  CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
  type CordisXPermissionAuthorizationDecisionV2,
  type CordisXPermissionAuthorizationDecisionV3,
  type CordisXPermissionAuthorizationPlanV2,
  type CordisXPermissionAuthorizationPlanV3,
  type CordisXPluginManifestV4,
} from '../packages/cli/src/permission-contracts.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
  type PermissionPolicyStore,
} from '../packages/cli/src/renderer/platform.js'
import { explicitV3 } from './suites/permission-certified-dom.fixtures.js'

const identity = { source: 'https://plugins.example/fixture', id: 'fixture' }
const manifest = normalizePluginManifest({
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
  schemaVersion: 1,
  id: 'fixture',
  capabilities: [{
    name: 'models.read',
    required: false,
    reason: { key: 'permission.fixture', fallback: 'Read a fixture model' },
    scope: { providers: ['fixture-provider'] },
  }],
}, 'fixture')

it.each(['policy-revoked', 'policy-aba', 'once-cleared', 'registration-replaced', 'broker-disposed'] as const)(
  'does not return a stale allow-once after %s while a prompt is pending',
  async revocation => {
    let answer!: (decision: 'allow-once') => void
    const request = vi.fn(async () =>
      await new Promise<'allow-once'>(resolve => {
        answer = resolve
      })
    )
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request },
      () => new Date(),
      10_000,
      'work',
      'owner-1',
    )
    const unregister = broker.register(identity, manifest)
    try {
      const pending = broker.authorize(identity, 'models.read', { providerId: 'fixture-provider' })
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      if (revocation === 'policy-revoked') await broker.setPolicy(identity, 'models.read', 'deny')
      if (revocation === 'policy-aba') {
        await broker.setPolicy(identity, 'models.read', 'deny')
        await broker.setPolicy(identity, 'models.read', 'ask')
      }
      if (revocation === 'once-cleared') broker.clearOnce(identity)
      if (revocation === 'registration-replaced') {
        unregister()
        broker.register(identity, manifest)
      }
      if (revocation === 'broker-disposed') broker.dispose()
      answer('allow-once')
      expect((await pending).ok).toBe(false)
    } finally {
      broker.dispose()
    }
  },
)

it.each(['allow-once', 'allow'] as const)(
  'does not return or persist a stale Agent %s after once grants are cleared',
  async choice => {
    let answer!: (decision: typeof choice) => void
    const request = vi.fn(async () =>
      await new Promise<typeof choice>(resolve => {
        answer = resolve
      })
    )
    const store = new MemoryPermissionPolicyStore()
    const broker = new PermissionBroker(store, { request }, () => new Date(), 10_000, 'work', 'owner-1')
    broker.register(identity, {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
      schemaVersion: 5,
      id: identity.id,
      services: [],
      capabilities: [{ name: 'agents.create', required: false, scope: {} }],
    })
    const connection = { connectionId: 'fixture-transport', generation: 1 }
    broker.replaceAgentRuntimeConnection(connection)
    try {
      const pending = broker.authorizeAgentRuntime({
        identity,
        capability: 'agents.create',
        sessionId: 'fixture-session',
        scopeSource: { kind: 'host-create', reservedSessionId: 'fixture-session' },
        connection,
      })
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      broker.clearOnce(identity)
      answer(choice)
      expect((await pending).authorized).toBe(false)
      expect(store.readV4().some(record => record.policy === 'allow-persistent')).toBe(false)
    } finally {
      broker.dispose()
    }
  },
)

const manifestV4 = normalizePluginManifest({
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  schemaVersion: 4,
  id: identity.id,
  services: [],
  capabilities: [{
    name: 'models.read',
    required: false,
    rationale: {
      title: { key: 'title', fallback: 'Read a fixture model' },
      description: { key: 'description', fallback: 'Read a fixture model' },
      feature: { key: 'feature', fallback: 'Fixture' },
      deniedBehavior: { key: 'denied', fallback: 'Unavailable' },
    },
    security: { dataUse: 'ephemeral', retention: 'none', externalTransfer: false },
    scope: { providers: ['fixture-provider'] },
  }],
}, identity.id) as CordisXPluginManifestV4

function decisionV2(
  plan: CordisXPermissionAuthorizationPlanV2,
  choice: CordisXPermissionAuthorizationDecisionV2['decisions'][number]['decision'],
): CordisXPermissionAuthorizationDecisionV2 {
  return {
    $schema: CORDISX_PERMISSION_AUTHORIZATION_DECISION_SCHEMA_V2,
    schemaVersion: 2,
    planId: plan.planId,
    operation: plan.operation,
    profileId: plan.profileId,
    identity: plan.identity,
    binding: plan.binding,
    decisions: plan.declarations.map(item => ({
      capability: item.capability,
      scope: item.scope,
      securityFingerprint: item.securityFingerprint,
      decision: choice,
    })),
  }
}

const v2StaleDecisions = (
  ['policy-revoked', 'policy-aba', 'once-cleared', 'registration-replaced', 'broker-disposed'] as const
).flatMap(revocation => (['allow-once', 'allow-persistent'] as const).map(choice => ({ revocation, choice })))

it.each(v2StaleDecisions)(
  'does not honor stale v2 $choice after $revocation while a prompt is pending',
  async ({ revocation, choice }) => {
    let answer!: (decision: CordisXPermissionAuthorizationDecisionV2) => void
    let plan!: CordisXPermissionAuthorizationPlanV2
    const request = vi.fn(async (next: CordisXPermissionAuthorizationPlanV2) => {
      plan = next
      return await new Promise<CordisXPermissionAuthorizationDecisionV2>(resolve => {
        answer = resolve
      })
    })
    const store = new MemoryPermissionPolicyStore()
    const broker = new PermissionBroker(
      store,
      { request: async () => 'deny' },
      () => new Date(),
      10_000,
      'work',
      'owner-1',
      undefined,
      undefined,
      { request },
    )
    const unregister = broker.register(identity, manifestV4)
    try {
      const pending = broker.authorize(identity, 'models.read', { providerId: 'fixture-provider' })
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
      if (revocation === 'policy-revoked') await broker.setPolicyV2(identity, 'models.read', 'deny-persistent')
      if (revocation === 'policy-aba') {
        await broker.setPolicyV2(identity, 'models.read', 'deny-persistent')
        await broker.setPolicyV2(identity, 'models.read', 'ask')
      }
      if (revocation === 'once-cleared') broker.clearOnce(identity)
      if (revocation === 'registration-replaced') {
        unregister()
        broker.register(identity, manifestV4)
      }
      if (revocation === 'broker-disposed') broker.dispose()
      answer(decisionV2(plan, choice))
      expect((await pending).ok).toBe(false)
      expect(store.readV2().some(record => record.policy === 'allow-persistent')).toBe(false)
    } finally {
      broker.dispose()
    }
  },
)

it.each(['allow-once', 'allow-persistent'] as const)(
  'accepts an unchanged v2 %s decision',
  async choice => {
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date(),
      10_000,
      'work',
      'owner-1',
      undefined,
      undefined,
      { request: async plan => decisionV2(plan, choice) },
    )
    broker.register(identity, manifestV4)
    try {
      expect((await broker.authorize(identity, 'models.read', { providerId: 'fixture-provider' })).ok).toBe(true)
    } finally {
      broker.dispose()
    }
  },
)

it.each(['allow-once', 'allow'] as const)(
  'accepts an unchanged legacy %s decision',
  async choice => {
    const broker = new PermissionBroker(new MemoryPermissionPolicyStore(), { request: async () => choice })
    broker.register(identity, manifest)
    try {
      expect((await broker.authorize(identity, 'models.read', { providerId: 'fixture-provider' })).ok).toBe(true)
    } finally {
      broker.dispose()
    }
  },
)

it.each(['legacy', 'v2', 'agent', 'agent-connection-aba'] as const)(
  'does not grant a %s request when invalidation races an already-started persistent write',
  async family => {
    let releaseWrite!: () => void
    let markStarted!: () => void
    const writeStarted = new Promise<void>(resolve => {
      markStarted = resolve
    })
    const writeReleased = new Promise<void>(resolve => {
      releaseWrite = resolve
    })
    const memory = new MemoryPermissionPolicyStore()
    const store: PermissionPolicyStore = {
      read: () => memory.read(),
      readV2: () => memory.readV2(),
      readV4: () => memory.readV4(),
      write: async records => {
        markStarted()
        await writeReleased
        memory.write(records)
      },
      writeV2: async records => {
        markStarted()
        await writeReleased
        memory.writeV2(records)
      },
      writeV4: async records => {
        markStarted()
        await writeReleased
        memory.writeV4(records)
      },
    }
    const broker = new PermissionBroker(
      store,
      { request: async () => 'allow' },
      () => new Date(),
      10_000,
      'work',
      'owner-1',
      undefined,
      undefined,
      { request: async plan => decisionV2(plan, 'allow-persistent') },
    )
    const connection = { connectionId: 'fixture-transport', generation: 1 }
    if (family === 'agent' || family === 'agent-connection-aba') {
      broker.register(identity, {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
        schemaVersion: 5,
        id: identity.id,
        services: [],
        capabilities: [{ name: 'agents.create', required: false, scope: {} }],
      })
      broker.replaceAgentRuntimeConnection(connection)
    } else broker.register(identity, family === 'legacy' ? manifest : manifestV4)
    try {
      const pending = family === 'agent' || family === 'agent-connection-aba'
        ? broker.authorizeAgentRuntime({
          identity,
          capability: 'agents.create',
          sessionId: 'fixture-session',
          scopeSource: { kind: 'host-create', reservedSessionId: 'fixture-session' },
          connection,
        }).then(result => result.authorized)
        : broker.authorize(identity, 'models.read', { providerId: 'fixture-provider' }).then(result => result.ok)
      await writeStarted
      if (family === 'agent-connection-aba') {
        broker.replaceAgentRuntimeConnection({ connectionId: 'fixture-transport-2', generation: 2 })
        broker.replaceAgentRuntimeConnection(connection)
      } else broker.clearOnce(identity)
      releaseWrite()
      expect(await pending).toBe(false)
    } finally {
      releaseWrite()
      broker.dispose()
    }
  },
)

const domStaleDecisions = (['policy-revoked', 'policy-aba', 'once-cleared'] as const).flatMap(revocation =>
  (['allow-once', 'allow-persistent'] as const).map(choice => ({ revocation, choice }))
)

it.each(domStaleDecisions)(
  'does not honor stale DOM $choice after $revocation while a prompt is pending',
  async ({ revocation, choice }) => {
    let answer!: (decision: CordisXPermissionAuthorizationDecisionV3) => void
    let plan!: CordisXPermissionAuthorizationPlanV3
    const requestV3 = vi.fn(async (next: CordisXPermissionAuthorizationPlanV3) => {
      plan = next
      return await new Promise<CordisXPermissionAuthorizationDecisionV3>(resolve => {
        answer = resolve
      })
    })
    const store = new MemoryPermissionPolicyStore()
    const broker = new PermissionBroker(
      store,
      { request: async () => 'deny' },
      () => new Date(),
      10_000,
      'work',
      'owner-1',
      undefined,
      undefined,
      { request: async () => undefined, requestV3 },
    )
    broker.register(identity, manifestV4, { pluginId: identity.id, moduleGeneration: 'fixture-generation' })
    try {
      const pending = broker.requestDomAccess(identity, 'manager.content')
      await vi.waitFor(() => expect(requestV3).toHaveBeenCalledOnce())
      if (revocation === 'policy-revoked') await broker.setDomPolicy(identity, 'manager.content', 'deny-persistent')
      if (revocation === 'policy-aba') {
        await broker.setDomPolicy(identity, 'manager.content', 'deny-persistent')
        await broker.setDomPolicy(identity, 'manager.content', 'ask')
      }
      if (revocation === 'once-cleared') broker.clearOnce(identity)
      answer(explicitV3(plan, choice))
      expect((await pending).authorized).toBe(false)
      expect(store.readV3().some(record => record.policy === 'allow-persistent')).toBe(false)
    } finally {
      broker.dispose()
    }
  },
)
