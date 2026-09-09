import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
  normalizePluginManifestV13,
} from '../packages/cli/src/runtime-exact-request-permissions.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
  normalizeTaskManifest,
} from '../packages/cli/src/agent-task-permission-manifest.js'
import { usagePermissionAvailability } from '../packages/cli/src/renderer/usage-availability.js'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../packages/cli/src/usage-permissions.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import {
  type UsagePermissionAuthorizationPlanV6,
  usagePermissionPlan,
} from '../packages/cli/src/usage-authorization.js'
import { MemoryPermissionPolicyStore, PermissionBroker } from '../packages/cli/src/renderer/platform.js'
import { CordisXUsageService } from '../packages/cli/src/renderer/usage.js'
import {
  CORDISX_PLUGIN_GENERATION,
  CORDISX_PLUGIN_ID,
  CORDISX_PLUGIN_SOURCE,
} from '../packages/cli/src/renderer/service.js'
const identity = { id: 'pet', source: 'file:///pet.js' }
const declaration = { name: 'usage.read', required: false, scope: { profile: 'current' } } as const
const manifest = normalizeUsageManifestV11({
  $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
  schemaVersion: 11,
  id: 'pet',
  capabilities: [declaration],
  services: [],
}, 'pet')
function confirm(plan: UsagePermissionAuthorizationPlanV6) {
  const model = new PermissionAuthorizationViewModel(plan)
  model.select('usage.read', 'allow-once')
  const result = model.confirm()
  if (result.status !== 'confirmed') throw new Error('Expected confirmation')
  return result.decision as import('../packages/cli/src/usage-authorization.js').UsagePermissionAuthorizationDecisionV6
}
function broker(requestUsageV6 = async (plan: UsagePermissionAuthorizationPlanV6) => confirm(plan)) {
  return new PermissionBroker(
    new MemoryPermissionPolicyStore(),
    { request: async () => 'deny' },
    () => new Date(),
    500,
    'test',
    'runtime',
    undefined,
    undefined,
    { request: async () => undefined, requestUsageV6 },
  )
}
describe.each([11, 12, 13])('public usage permission v%s', version => {
  const activeManifest = version === 13
    ? normalizePluginManifestV13({
      ...manifest,
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
      schemaVersion: 13,
    }, identity.id)
    : version === 11
    ? manifest
    : normalizeTaskManifest({
      ...manifest,
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V12,
      schemaVersion: 12,
    }, identity.id)
  it('offers current-profile explicit generation-only authorization', () => {
    const plan = usagePermissionPlan({
      planId: 'usage-1',
      operation: 'runtime',
      profileId: 'test',
      catalogVersion: 'usage-v1',
      identity: { source: identity.source, pluginId: identity.id },
      binding: {
        operationId: 'usage-1',
        runtimeGeneration: 'runtime',
        moduleGeneration: 'module',
        requestId: 'usage-1',
      },
    }, declaration)
    expect(confirm(plan)).toMatchObject({
      schemaVersion: 6,
      origin: 'explicit-user',
      decisions: [{ capability: 'usage.read', scope: { profile: 'current' }, decision: 'allow-once' }],
    })
    expect(() => new PermissionAuthorizationViewModel(plan).select('usage.read', 'allow-persistent')).toThrow()
  })
  it('deduplicates concurrent prompts and revokes/rechecks on policy and generation changes', async () => {
    const request = vi.fn(async (plan: UsagePermissionAuthorizationPlanV6) => confirm(plan))
    const host = broker(request),
      dispose = host.register(identity, activeManifest, { pluginId: identity.id, moduleGeneration: 'module' })
    expect(await Promise.all([host.authorizeUsage(identity), host.authorizeUsage(identity)])).toEqual([true, true])
    expect(request).toHaveBeenCalledTimes(1)
    host.setUsagePolicy(identity, false)
    expect(await host.authorizeUsage(identity)).toBe(false)
    host.setUsagePolicy(identity, true)
    expect(await host.authorizeUsage(identity)).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    dispose()
    expect(host.usageAllowed(identity)).toBe(false)
    host.dispose()
  })
  it('uses verified local-development authority across HMR without minting explicit-user decisions', async () => {
    const request = vi.fn(async (plan: UsagePermissionAuthorizationPlanV6) => confirm(plan))
    const host = broker(request)
    const remove = host.register(
      identity,
      activeManifest,
      { pluginId: identity.id, moduleGeneration: 'dev-1' },
      undefined,
      undefined,
      true,
    )
    expect(await host.authorizeUsage(identity)).toBe(true)
    const oldFence = host.usageFence(identity, 'dev-1')
    host.setUsagePolicy(identity, false)
    expect(await host.authorizeUsage(identity)).toBe(false)
    remove()
    expect(oldFence()).toBe(false)
    expect(host.usageAllowed(identity)).toBe(false)
    const removeNew = host.register(
      identity,
      activeManifest,
      { pluginId: identity.id, moduleGeneration: 'dev-2' },
      undefined,
      undefined,
      true,
    )
    expect(await host.authorizeUsage(identity)).toBe(true)
    expect(request).not.toHaveBeenCalled()
    removeNew()
    host.dispose()
  })
  it('does not infer development authority from file URLs or matching ids', async () => {
    const request = vi.fn(async (plan: UsagePermissionAuthorizationPlanV6) => confirm(plan))
    const host = broker(request)
    const remove = host.register(identity, activeManifest, { pluginId: identity.id, moduleGeneration: 'production' })
    expect(await host.authorizeUsage(identity)).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    remove()
    host.dispose()
  })
  it('requires a declared usage capability even for verified development identities', async () => {
    const request = vi.fn(async (plan: UsagePermissionAuthorizationPlanV6) => confirm(plan))
    const host = broker(request)
    const remove = host.register(
      identity,
      { ...activeManifest, capabilities: [] },
      {
        pluginId: identity.id,
        moduleGeneration: 'dev',
      },
      undefined,
      undefined,
      true,
    )
    expect(await host.authorizeUsage(identity)).toBe(false)
    expect(request).not.toHaveBeenCalled()
    remove()
    host.dispose()
  })
  it('retires an old context even when the same artifact generation is enabled again', () => {
    const host = broker()
    const remove = host.register(identity, activeManifest, { pluginId: identity.id, moduleGeneration: 'same-artifact' })
    const old = host.usageFence(identity, 'same-artifact')
    expect(old()).toBe(true)
    remove()
    const removeNew = host.register(identity, activeManifest, {
      pluginId: identity.id,
      moduleGeneration: 'same-artifact',
    })
    expect(old()).toBe(false)
    expect(host.usageFence(identity, 'same-artifact')()).toBe(true)
    removeNew()
    host.dispose()
  })
  it('rejects late decisions for an unloaded registration', async () => {
    let release!: (value: ReturnType<typeof confirm>) => void
    let pending!: UsagePermissionAuthorizationPlanV6
    const host = broker(plan => {
      pending = plan
      return new Promise(resolve => {
        release = resolve
      })
    })
    const dispose = host.register(identity, activeManifest, { pluginId: identity.id, moduleGeneration: 'module' })
    const result = host.authorizeUsage(identity)
    dispose()
    release(confirm(pending))
    expect(await result).toBe(false)
    host.dispose()
  })
  it('does not deliver data after permission revocation while a read is in flight', async () => {
    const host = broker(),
      unregister = host.register(identity, activeManifest, { pluginId: identity.id, moduleGeneration: 'module' })
    const ctx = new Context()
    let resolve!: (value: any) => void
    const readUsage = vi.fn(() =>
      new Promise<any>(done => {
        resolve = done
      })
    )
    const fiber = ctx.plugin(CordisXUsageService, { broker: host, adapter: { readUsage } })
    await fiber
    const scoped = ctx.extend({
      [CORDISX_PLUGIN_ID]: identity.id,
      [CORDISX_PLUGIN_SOURCE]: identity.source,
      [CORDISX_PLUGIN_GENERATION]: 'module',
    })
    const result = scoped.usage.read()
    await vi.waitFor(() => expect(readUsage).toHaveBeenCalledTimes(1))
    host.setUsagePolicy(identity, false)
    resolve({ schemaVersion: 1, status: 'ready', eligibleTokens: 999 })
    expect(await result).toMatchObject({ status: 'unavailable', reason: 'permission-denied' })
    unregister()
    host.dispose()
    await fiber.dispose()
  })
})

it('keeps local usage recovery available without a DOM extension point provider', () => {
  const scope = { profile: 'current' }
  expect(usagePermissionAvailability(true, scope)).toMatchObject({
    status: 'supported',
    providers: [{ providerId: 'host-local-usage', scope }],
  })
  expect(usagePermissionAvailability(false, scope)).toMatchObject({ status: 'unavailable', providers: [] })
})
