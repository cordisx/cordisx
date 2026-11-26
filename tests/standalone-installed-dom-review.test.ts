import { expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { createStandaloneDomReviewModel } from '../packages/cli/src/renderer/standalone-dom-review-model.js'
import { createRuntimeCandidateController } from '../packages/cli/src/renderer/runtime-authorization-mutations.js'
import { bindStandaloneDomReview, StandaloneDomReview } from '../packages/cli/src/renderer/standalone-dom-review.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'

const identity = { id: 'fixture-service', source: `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}` }
const point = 'manager.content'
const packageItem = {
  version: '1.2.3',
  digest: `sha256:${'b'.repeat(64)}` as const,
  moduleGeneration: 'plugin-generation-1',
  canonicalSource: identity.source,
  dependencies: [],
}

function fixture(persistentAvailable = false) {
  const decisions: string[][] = []
  const gate = new StandaloneDomReview(() => ({
    request: async () => undefined,
    requestV3: async plan => {
      decisions.push([...plan.declarations[0]!.allowedDecisions])
      const view = new PermissionAuthorizationViewModel(plan)
      view.select('ui.extension-points.render', 'allow-once')
      const result = view.confirm()
      return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
    },
  }))
  const persistent = vi.fn(() => true)
  gate.bindPersistentDecision(persistent)
  gate.bindPersistentReset(() => () => {})
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    'default',
    'owner-1',
    undefined,
    undefined,
    gate,
  )
  bindStandaloneDomReview(broker, gate)
  const manifest = normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: identity.id,
    capabilities: [],
    services: [],
  }, identity.id)
  broker.register(identity, manifest, { pluginId: identity.id, moduleGeneration: packageItem.moduleGeneration })
  const controller = {
    identity,
    status: 'active',
    principalLive: true,
    item: { id: identity.id, standaloneInstalledGraph: true, package: { ...packageItem } },
  }
  const verify = vi.fn(async () => true)
  const scope = {
    disposed: false,
    metadata: () => ({
      hostKind: 'standalone',
      profileId: 'default',
      standaloneReviewSession: verify,
      ...(persistentAvailable ? { standaloneInstalledPolicyReview: true } : {}),
    }),
    broker: () => broker,
    generation: () => 'owner-1',
    activeController: () => (id: string, source: string) =>
      id === identity.id && source === identity.source ? controller : undefined,
    activeControllers: () => () => [controller],
    moduleGenerationOf: () => () => controller.item.package.moduleGeneration,
    currentActivation: {
      recordKind: 'active',
      profileId: 'default',
      runtimeGeneration: 'owner-1',
      plugins: [{ id: identity.id, enabled: true, ...packageItem }],
    },
  }
  const model = createStandaloneDomReviewModel(scope as never)!
  return { broker, controller, decisions, model, persistent, scope, verify }
}

function configuredFixture() {
  const f = fixture(true)
  const item = f.controller.item as unknown as {
    standaloneInstalledGraph?: boolean
    standaloneConfiguredGraph?: boolean
    package?: typeof packageItem
    distributionArtifact?: { version: string; integrity: string }
  }
  item.standaloneInstalledGraph = false
  item.standaloneConfiguredGraph = true
  delete item.package
  item.distributionArtifact = { version: packageItem.version, integrity: packageItem.digest }
  f.scope.moduleGenerationOf = () => () => packageItem.moduleGeneration
  f.scope.metadata = () => ({
    hostKind: 'standalone',
    profileId: 'default',
    standaloneReviewSession: f.verify,
    standaloneConfiguredPolicyReview: true,
    standaloneInstalledPolicyReview: true,
  })
  return { ...f, item, model: createStandaloneDomReviewModel(f.scope as never)! }
}

it('makes a newly projected installed graph eligible for the same scoped review as a reloaded graph', () => {
  const test = fixture(true)
  const runtime = {
    metadata: () => ({ hostKind: 'standalone' }),
    activeController: () => () => undefined,
    pluginConsole: () => ({ issue: () => ({}), generation: 'owner-1' }),
    moduleGenerationOf: () => () => packageItem.moduleGeneration,
    generationVisibility: () => ({ context: () => ({}), view: () => ({}) }),
    ctx: { extend: () => ({}) },
  }
  const mutation = {
    operation: 'install',
    targetId: identity.id,
    candidate: { plugins: [{ id: identity.id, enabled: true, ...packageItem }] },
    package: {
      identitySource: identity.source,
      digest: packageItem.digest,
      manifest: {
        id: identity.id,
        version: packageItem.version,
        runtimeManifest: {
          $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
          schemaVersion: 4,
          id: identity.id,
          capabilities: [],
          services: [],
        },
      },
    },
  }
  try {
    const { controller } = createRuntimeCandidateController(
      runtime as never,
      {} as never,
      mutation as never,
      identity.id,
      undefined,
      undefined,
      { [identity.id]: { apply() {} } } as never,
    )
    const scope = {
      ...test.scope,
      activeController: () => () => controller,
      activeControllers: () => () => [controller],
    }
    expect(createStandaloneDomReviewModel(scope as never)!.describe(identity, point)).toMatchObject({
      version: packageItem.version,
      persistentAvailable: true,
    })
    const unprojected = createRuntimeCandidateController(
      runtime as never,
      {} as never,
      mutation as never,
      identity.id,
      { apply() {} } as never,
    )
    expect(unprojected.controller.item.standaloneInstalledGraph).toBeUndefined()
  } finally {
    test.broker.dispose()
  }
})

it('reviews an installed graph only for this tab and never offers a persistent decision', async () => {
  const first = fixture()
  const other = fixture()
  try {
    expect(first.model.describe(identity, point)).toMatchObject({
      version: packageItem.version,
      integrity: packageItem.digest,
      persistentAvailable: false,
      resetAvailable: false,
      authorized: false,
    })
    expect(await first.model.request(identity, point)).toBe(true)
    expect(first.decisions).toEqual([['deny-once', 'allow-once']])
    expect(first.persistent).not.toHaveBeenCalled()
    expect(first.broker.hasDomLease(identity, point)).toBe(true)
    expect(first.broker.domPolicy(identity, point)).toBe('inherit')
    expect(other.broker.hasDomLease(identity, point)).toBe(false)
  } finally {
    first.broker.dispose()
    other.broker.dispose()
  }
})

it('offers persistent choices only when the service owner provides their handoff', async () => {
  const f = fixture(true)
  try {
    expect(f.model.describe(identity, point)?.persistentAvailable).toBe(true)
    expect(await f.model.request(identity, point)).toBe(true)
    expect(f.decisions[0]).toEqual(expect.arrayContaining(['allow-once', 'allow-persistent', 'deny-persistent']))
  } finally {
    f.broker.dispose()
  }
})

it('reviews a configured plugin only in the current session even when persistent review is enabled elsewhere', async () => {
  const first = configuredFixture()
  const other = configuredFixture()
  try {
    expect(first.model.describe(identity, point)).toMatchObject({
      version: packageItem.version,
      integrity: packageItem.digest,
      persistentAvailable: false,
      resetAvailable: false,
    })
    expect(await first.model.request(identity, point)).toBe(true)
    expect(first.decisions).toEqual([['deny-once', 'allow-once']])
    expect(first.persistent).not.toHaveBeenCalled()
    expect(first.broker.hasDomLease(identity, point)).toBe(true)
    expect(other.broker.hasDomLease(identity, point)).toBe(false)
  } finally {
    first.broker.dispose()
    other.broker.dispose()
  }
})

it('offers a persistent review only for the configured graph selected by the owner', () => {
  const f = configuredFixture()
  try {
    const existing = f.scope.metadata()
    f.scope.metadata = () => ({ ...existing, standaloneConfiguredPluginPolicyReview: ['other-plugin'] })
    expect(createStandaloneDomReviewModel(f.scope as never)!.describe(identity, point)?.persistentAvailable).toBe(false)
    f.scope.metadata = () => ({ ...existing, standaloneConfiguredPluginPolicyReview: [identity.id] })
    expect(createStandaloneDomReviewModel(f.scope as never)!.describe(identity, point)?.persistentAvailable).toBe(true)
  } finally {
    f.broker.dispose()
  }
})

it('rejects a configured graph that changes during the owner review', async () => {
  const f = configuredFixture()
  try {
    f.verify.mockImplementationOnce(async () => {
      f.item.distributionArtifact = { version: packageItem.version, integrity: `sha256:${'d'.repeat(64)}` }
      return true
    })
    expect(await f.model.request(identity, point)).toBe(false)
    expect(f.broker.hasDomLease(identity, point)).toBe(false)
    expect(f.decisions).toHaveLength(0)
  } finally {
    f.broker.dispose()
  }
})

it('requires the owner-issued graph and the exact active package identity', () => {
  const test = fixture()
  try {
    expect(test.model.describe({ ...identity, source: 'https://example.test/plugin' }, point)).toBeUndefined()
    expect(test.model.describe(identity, 'native.sidebar')).toBeUndefined()
    test.controller.item.standaloneInstalledGraph = false
    expect(test.model.describe(identity, point)).toBeUndefined()
    test.controller.item.standaloneInstalledGraph = true
    test.scope.currentActivation.plugins[0]!.digest = `sha256:${'c'.repeat(64)}`
    expect(test.model.describe(identity, point)).toBeUndefined()
  } finally {
    test.broker.dispose()
  }
})

it('does not release a one-time lease if the package changes during the owner check', async () => {
  const test = fixture()
  try {
    test.verify.mockImplementationOnce(async () => {
      test.scope.currentActivation.plugins[0]!.moduleGeneration = 'replacement-generation'
      return true
    })
    expect(await test.model.request(identity, point)).toBe(false)
    expect(test.broker.hasDomLease(identity, point)).toBe(false)
    expect(test.decisions).toHaveLength(0)
  } finally {
    test.broker.dispose()
  }
})

it('rejects a changed staged package even when its version and generation are unchanged', async () => {
  const test = fixture()
  try {
    test.verify.mockImplementationOnce(async () => {
      const replacement = `sha256:${'d'.repeat(64)}` as const
      test.scope.currentActivation.plugins[0]!.digest = replacement
      test.controller.item.package.digest = replacement
      return true
    })
    expect(await test.model.request(identity, point)).toBe(false)
    expect(test.broker.hasDomLease(identity, point)).toBe(false)
  } finally {
    test.broker.dispose()
  }
})
