import { expect, it, vi } from 'vitest'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PERMISSION_POLICY_SCHEMA_V2,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
} from '../packages/cli/src/permission-contracts.js'
import {
  normalizePermissionPolicyRecordV2,
  permissionSecurityFingerprint,
} from '../packages/cli/src/permission-model-v2.js'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'
import { createStandaloneRuntimePolicyModel } from '../packages/cli/src/renderer/standalone-runtime-policy-model.js'
import { bindStandaloneRuntimePolicyReviewer } from '../packages/cli/src/renderer/standalone-runtime-policy-review.js'

const identity = { id: 'demo', source: 'https://example.test/demo' }
const declaration = { name: 'models.read' as const, required: false, scope: { providers: ['codex'] } }
const record = (policy: 'ask' | 'allow-persistent' | 'deny-persistent') =>
  normalizePermissionPolicyRecordV2({
    $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V2,
    schemaVersion: 2,
    key: {
      profileId: 'default',
      identity: { pluginId: identity.id, source: identity.source },
      capability: declaration.name,
      scope: declaration.scope,
      securityFingerprint: permissionSecurityFingerprint(CORDISX_CAPABILITY_CATALOG_VERSION, declaration),
    },
    policy,
  })

function brokerFor(store: ConstructorParameters<typeof PermissionBroker>[0]) {
  const broker = new PermissionBroker(
    store,
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'owner-1',
  )
  broker.register(
    identity,
    normalizePluginManifest({
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      schemaVersion: 4,
      id: identity.id,
      services: [],
      capabilities: [declaration],
    }, identity.id),
    { pluginId: identity.id, moduleGeneration: 'graph-1' },
  )
  return broker
}

it('adopts a peer decision only for the current declared scope and owner snapshot', async () => {
  const allowed = record('allow-persistent')
  const denied = record('deny-persistent')
  const store = new MemoryPermissionPolicyStore([], [allowed])
  const broker = brokerFor(store)
  const input = {
    requestId: 'request-1',
    origin: false,
    identity,
    moduleGeneration: 'graph-1',
    expected: [allowed],
    updates: [denied],
    candidate: [denied],
  }
  try {
    expect(await broker.adoptOwnerRuntimePolicies({ ...input, expected: [] })).toBe(false)
    expect(await broker.adoptOwnerRuntimePolicies({ ...input, moduleGeneration: 'old-graph' })).toBe(false)
    const broader = { ...denied, key: { ...denied.key, scope: {} } }
    expect(await broker.adoptOwnerRuntimePolicies({ ...input, updates: [broader], candidate: [broader] })).toBe(false)
    expect(broker.policyV2(identity, declaration.name)).toBe('allow-persistent')
    expect(await broker.adoptOwnerRuntimePolicies(input)).toBe(true)
    expect(broker.policyV2(identity, declaration.name)).toBe('deny-persistent')
    expect(await broker.adoptOwnerRuntimePolicies(input)).toBe(false)
    expect(store.readV2()).toEqual([allowed])
  } finally {
    broker.dispose()
  }
})

it('does not publish a writer policy until the owner acknowledges its exact pending write', async () => {
  let sent!: (value: { requestId: string; records: readonly unknown[] }) => void
  const request = new Promise<{ requestId: string; records: readonly unknown[] }>(resolve => sent = resolve)
  globalThis.__cordisxPermissionPolicyRequestV1 = payload => sent(JSON.parse(payload))
  const onUnknown = vi.fn()
  const store = BindingPermissionPolicyStore.connect(STANDALONE_PERMISSION_BINDING_MARKER, [], {
    onUnknown,
    sign: async () => ({}),
  })
  const broker = brokerFor(store)
  try {
    const writing = broker.setPolicyV2(identity, declaration.name, 'deny-persistent')
    const pending = await request
    const denied = record('deny-persistent')
    expect(pending.records).toEqual([denied])
    expect(broker.policyV2(identity, declaration.name)).toBe('ask')
    const transition = {
      requestId: pending.requestId,
      origin: true,
      identity,
      moduleGeneration: 'graph-1',
      expected: [],
      updates: [denied],
      candidate: [denied],
      onUnknown,
    }
    expect(await broker.adoptOwnerRuntimePolicies({ ...transition, requestId: 'other' })).toBe(false)
    expect(broker.policyV2(identity, declaration.name)).toBe('ask')
    expect(await broker.adoptOwnerRuntimePolicies(transition)).toBe(true)
    expect(broker.policyV2(identity, declaration.name)).toBe('deny-persistent')
    globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
      requestId: pending.requestId,
      ok: true,
      value: [denied],
    }))
    await writing
    expect(onUnknown).not.toHaveBeenCalled()
  } finally {
    broker.dispose()
    store.dispose()
    delete globalThis.__cordisxPermissionPolicyRequestV1
    delete globalThis.__cordisxPermissionPolicyReceiveV1
  }
})

it('offers settings only for an owner-verified active graph and rejects synthetic clicks', async () => {
  const alias = { id: identity.id, source: `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}` }
  const manifest = normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: alias.id,
    services: [],
    capabilities: [declaration],
  }, alias.id)
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'owner-1',
  )
  const pkg = {
    version: '1.0.0',
    digest: `sha256:${'b'.repeat(64)}` as const,
    moduleGeneration: 'graph-1',
    canonicalSource: alias.source,
  }
  broker.register(alias, manifest, { pluginId: alias.id, moduleGeneration: pkg.moduleGeneration })
  const authorize = vi.fn(() => () => {})
  bindStandaloneRuntimePolicyReviewer(broker, authorize)
  const controller = {
    identity: alias,
    manifest,
    status: 'active',
    principalLive: true,
    item: { id: alias.id, standaloneInstalledGraph: true, package: pkg },
  }
  const scope = {
    disposed: false,
    metadata: () => ({
      hostKind: 'standalone',
      profileId: 'default',
      standaloneReviewSession: async () => true,
      standaloneInstalledPolicyReview: true,
    }),
    broker: () => broker,
    generation: () => 'owner-1',
    activeController: () => () => controller,
    activeControllers: () => () => [controller],
    moduleGenerationOf: () => () => pkg.moduleGeneration,
    currentActivation: {
      recordKind: 'active',
      profileId: 'default',
      runtimeGeneration: 'owner-1',
      plugins: [{ id: alias.id, enabled: true, ...pkg }],
    },
  }
  const model = createStandaloneRuntimePolicyModel(scope as never)!
  const fingerprint = record('ask').key.securityFingerprint
  try {
    expect(model.describe(alias, declaration.name, fingerprint)).toEqual({
      policy: 'ask',
      options: ['ask', 'allow-persistent', 'deny-persistent'],
    })
    expect(model.describe(alias, declaration.name, `sha256:${'f'.repeat(64)}`)).toBeUndefined()
    expect(
      await model.set(alias, declaration.name, fingerprint, 'allow-persistent', {
        type: 'click',
        isTrusted: false,
      } as Event),
    ).toBe(false)
    expect(authorize).not.toHaveBeenCalled()
    controller.principalLive = false
    expect(model.describe(alias, declaration.name, fingerprint)).toBeUndefined()
  } finally {
    broker.dispose()
  }
})
