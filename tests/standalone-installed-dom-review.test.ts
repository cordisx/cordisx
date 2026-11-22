import { expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { createStandaloneDomReviewModel } from '../packages/cli/src/renderer/standalone-dom-review-model.js'
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

function fixture() {
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
    metadata: () => ({ hostKind: 'standalone', profileId: 'default', standaloneReviewSession: verify }),
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
