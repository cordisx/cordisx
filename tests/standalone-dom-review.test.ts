import { expect, it, vi } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import {
  StandaloneDomReview,
  type StandaloneDomReviewContext,
} from '../packages/cli/src/renderer/standalone-dom-review.js'

const identity = { id: 'channel', source: `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}` }
const pointId = 'manager.content'
const context: StandaloneDomReviewContext = {
  identity,
  pointId,
  profileId: 'default',
  runtimeGeneration: 'owner-1',
  moduleGeneration: 'configured-1',
  artifact: { version: '1.2.3', integrity: `sha256:${'b'.repeat(64)}` },
  isCurrent: () => true,
  verifyCurrent: async () => true,
  invalidate: () => {},
}
const plan = buildDomPermissionAuthorizationPlanV3({
  planId: 'review-1',
  profileId: context.profileId,
  identity: { source: identity.source, pluginId: identity.id },
  binding: {
    operationId: 'review-1',
    runtimeGeneration: context.runtimeGeneration,
    moduleGeneration: context.moduleGeneration,
  },
  declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [pointId] } },
  policies: [],
})

it('requires an owner-selected review and presents only one-time decisions', async () => {
  const dispose = vi.fn()
  const requestV3 = vi.fn(async narrowed => {
    expect(narrowed.declarations[0].allowedDecisions).toEqual(['deny-once', 'allow-once'])
    expect(narrowed.declarations[0].defaultDecision).toBe('deny-once')
    const view = new PermissionAuthorizationViewModel(narrowed)
    view.select('ui.extension-points.render', 'allow-once')
    const result = view.confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
  })
  const gate = new StandaloneDomReview(() => ({ request: async () => undefined, requestV3, dispose }))
  expect(await gate.requestV3(plan, identity)).toBeUndefined()
  expect(
    await gate.review(context, async () => {
      const decision = await gate.requestV3(plan, identity)
      expect(decision?.decisions[0]?.decision).toBe('allow-once')
      expect(await gate.requestV3(plan, identity)).toBeUndefined()
      return true
    }),
  ).toBe(true)
  expect(requestV3).toHaveBeenCalledOnce()
  expect(dispose).toHaveBeenCalledOnce()
  expect(await gate.review(context, async () => true)).toBe(false)
})

it('rejects an answer if the owner no longer recognizes the renderer', async () => {
  let current = true
  const invalidate = vi.fn()
  const gate = new StandaloneDomReview(() => ({
    request: async () => undefined,
    requestV3: async narrowed => {
      const view = new PermissionAuthorizationViewModel(narrowed)
      view.select('ui.extension-points.render', 'allow-once')
      current = false
      const result = view.confirm()
      return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
    },
  }))
  expect(
    await gate.review({
      ...context,
      verifyCurrent: async () => current,
      invalidate,
    }, async () => Boolean(await gate.requestV3(plan, identity))),
  ).toBe(false)
  expect(invalidate).toHaveBeenCalledOnce()
})

it('keeps the new lease hidden until the final owner check completes', async () => {
  let checks = 0
  let release!: (value: boolean) => void
  let entered!: () => void
  const checking = new Promise<void>(resolve => {
    entered = resolve
  })
  const finalCheck = new Promise<boolean>(resolve => {
    release = resolve
  })
  const gate = new StandaloneDomReview(() => ({
    request: async () => undefined,
    requestV3: async narrowed => {
      const view = new PermissionAuthorizationViewModel(narrowed)
      view.select('ui.extension-points.render', 'allow-once')
      const result = view.confirm()
      return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
    },
  }))
  const pending = gate.review({
    ...context,
    verifyCurrent: async () => {
      checks += 1
      if (checks !== 3) return true
      entered()
      return await finalCheck
    },
  }, async () => Boolean(await gate.requestV3(plan, identity)))
  await checking
  expect(gate.isDomLeaseVisible(identity, pointId, context.moduleGeneration)).toBe(false)
  expect(gate.isDomLeaseVisible(identity, 'manager.settings.navigation-items', context.moduleGeneration)).toBe(true)
  release(true)
  expect(await pending).toBe(true)
  expect(gate.isDomLeaseVisible(identity, pointId, context.moduleGeneration)).toBe(true)
})

it.each([true, false])('holds a new lease until the owner check returns %s', async current => {
  let checks = 0
  let release!: (value: boolean) => void
  let entered!: () => void
  const checking = new Promise<void>(resolve => {
    entered = resolve
  })
  const finalCheck = new Promise<boolean>(resolve => {
    release = resolve
  })
  const gate = new StandaloneDomReview(() => ({
    request: async () => undefined,
    requestV3: async narrowed => {
      const view = new PermissionAuthorizationViewModel(narrowed)
      view.select('ui.extension-points.render', 'allow-once')
      const result = view.confirm()
      return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
    },
  }))
  const broker = new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    30_000,
    context.profileId,
    context.runtimeGeneration,
    undefined,
    undefined,
    gate,
  )
  const manifest = normalizePluginManifest({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: identity.id,
    capabilities: [],
    services: [],
  }, identity.id)
  broker.register(
    identity,
    manifest,
    { pluginId: identity.id, moduleGeneration: context.moduleGeneration },
    undefined,
    context.artifact,
  )
  const pending = gate.review({
    ...context,
    verifyCurrent: async () => {
      checks += 1
      if (checks !== 3) return true
      entered()
      return await finalCheck
    },
    invalidate: () => broker.clearOnce(identity),
  }, async () => (await broker.requestDomAccess(identity, pointId)).authorized)
  await checking
  expect(broker.hasDomLease(identity, pointId)).toBe(false)
  expect(broker.domAccess(identity, pointId)).toMatchObject({ authorized: false, state: 'pending' })
  release(current)
  expect(await pending).toBe(current)
  expect(broker.domAccess(identity, pointId)).toMatchObject({ authorized: current })
  broker.dispose()
})

it('rejects mismatched sources, points, generations and persistent answers', async () => {
  const requestV3 = vi.fn(async () => {
    const view = new PermissionAuthorizationViewModel(plan)
    view.select('ui.extension-points.render', 'allow-persistent')
    const result = view.confirm()
    return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
  })
  const gate = new StandaloneDomReview(() => ({ request: async () => undefined, requestV3 }))
  expect(
    await gate.review(
      { ...context, identity: { ...identity, source: 'https://example.test/plugin' } },
      async () => true,
    ),
  )
    .toBe(false)
  expect(await gate.review({ ...context, pointId: 'native.sidebar' }, async () => true)).toBe(false)
  expect(
    await gate.review(
      { ...context, moduleGeneration: 'other' },
      async () => Boolean(await gate.requestV3(plan, identity)),
    ),
  ).toBe(false)
  expect(requestV3).not.toHaveBeenCalled()
  expect(await gate.review(context, async () => Boolean(await gate.requestV3(plan, identity)))).toBe(false)
  expect(requestV3).toHaveBeenCalledOnce()
})

it('drops a pending answer when the owner-selected renderer is no longer current', async () => {
  let current = true
  let finish!: (value: ReturnType<PermissionAuthorizationViewModel['confirm']>) => void
  let entered!: () => void
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const gate = new StandaloneDomReview(() => ({
    request: async () => undefined,
    requestV3: async narrowed => {
      const view = new PermissionAuthorizationViewModel(narrowed)
      view.select('ui.extension-points.render', 'allow-once')
      entered()
      const result = await new Promise<ReturnType<PermissionAuthorizationViewModel['confirm']>>(resolve => {
        finish = resolve
      })
      return result.status === 'confirmed' && result.decision.schemaVersion === 3 ? result.decision : undefined
    },
  }))
  const pending = gate.review(
    { ...context, isCurrent: () => current },
    async () => Boolean(await gate.requestV3(plan, identity)),
  )
  await started
  current = false
  const view = new PermissionAuthorizationViewModel(plan)
  view.select('ui.extension-points.render', 'allow-once')
  finish(view.confirm())
  expect(await pending).toBe(false)
})
