import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  hasSessionExecutionToken,
  restrictedExecutionToken,
  ServiceRendererManagementPlans,
} from '../packages/cli/src/cli/service-renderer-management-plans.js'
import {
  allowsManagementWrite,
  type ManagementProjectionEntry,
  projectManagementRequest,
} from '../packages/cli/src/cli/service-renderer-management-projection.js'

const ownerToken = () => `management-execution-${randomUUID()}`
const intent = { kind: 'plugin-disable', pluginId: 'first' } as const

it('binds plans to one session, evicts old plans and drains all owner plans on close', () => {
  const discarded: string[] = []
  const first = new ServiceRendererManagementPlans(token => discarded.push(token))
  const second = new ServiceRendererManagementPlans(token => discarded.push(token))
  const original = ownerToken()
  const token = first.issue(original, { intent, managementRevision: 4, activationRevision: 2 })!
  expect(token).not.toBe(original)
  expect(second.peek(token)).toBeUndefined()
  expect(first.take(token)?.ownerToken).toBe(original)
  expect(first.take(token)).toBeUndefined()
  for (let index = 0; index < 17; index++) {
    first.issue(ownerToken(), { intent, managementRevision: 4, activationRevision: 2 })
  }
  expect(discarded).toHaveLength(1)
  first.close()
  expect(discarded).toHaveLength(17)
  expect(first.available).toBe(false)
  expect(hasSessionExecutionToken({ kind: 'plugin-execute-plan', executionToken: token, extra: true })).toBe(true)
  expect(restrictedExecutionToken({ kind: 'plugin-execute-plan', executionToken: token, extra: true })).toBeUndefined()
})

it('continues cleaning owner plans if one cleanup fails', () => {
  const attempts: string[] = []
  const first = ownerToken()
  const second = ownerToken()
  const plans = new ServiceRendererManagementPlans(token => {
    attempts.push(token)
    if (token === first) throw new Error('synthetic failure')
  })
  const input = { intent, managementRevision: 4, activationRevision: 2 }
  plans.issue(first, input)
  plans.issue(second, input)
  expect(() => plans.close()).toThrow('renderer-management-plan-cleanup-unavailable')
  expect(attempts).toEqual([first, second])
})

it('projects only a safe dependency closure and consumes the originating page plan once', async () => {
  const item = (id: string, dependencies: readonly { id: string; version: string }[] = []) => ({
    id,
    version: '1.0.0',
    digest: `sha256:${'a'.repeat(64)}`,
    moduleGeneration: `generation-${id}`,
    enabled: true,
    dependencies,
  })
  let active = {
    profileId: 'default',
    revision: 2,
    plugins: [item('first'), item('second', [{ id: 'first', version: '1.0.0' }])],
  }
  const snapshot = () => ({ active, registryEpoch: 3 }) as any
  const managementSnapshot = () =>
    ({
      profileId: 'default',
      revision: 4,
      activationRevision: active.revision,
      sources: [],
      hiddenCatalogEntries: [],
      migrations: { legacyBrowserSourcesV2: false },
      runtime: { kind: 'active', runtimeGeneration: 'owner', mode: 'service' },
      plugins: active.plugins.map(plugin => ({
        ...plugin,
        dependencies: plugin.dependencies.map(dependency => dependency.id),
        dependents: [],
        name: plugin.id,
        status: plugin.enabled ? 'active' : 'disabled',
        favorite: false,
        availableOperations: plugin.enabled ? ['disable', 'uninstall'] : ['enable', 'uninstall'],
      })),
    }) as any
  const discard = vi.fn()
  const plans = new ServiceRendererManagementPlans(discard)
  const otherPlans = new ServiceRendererManagementPlans(discard)
  const ids = new Set(['first', 'second'])
  const entry = (book: ServiceRendererManagementPlans): ManagementProjectionEntry => ({
    confirmed: true,
    current: () => true,
    unchanged: async () => true,
    identity: undefined,
    aliases: undefined,
    snapshot: snapshot(),
    scopedLifecycle: true,
    restricted: { writableIds: ids, plans: book },
  })
  const context = {
    profileId: 'default',
    rendererId: 'one',
    ownerGeneration: 'owner',
    signal: new AbortController().signal,
    admitted: true,
  }
  const planOperation = { kind: 'plan', request: intent } as const
  const unsafe = { ...entry(plans), restricted: { writableIds: new Set(['first']), plans } }
  expect(allowsManagementWrite(unsafe, planOperation)).toBe(false)
  expect(allowsManagementWrite(entry(plans), {
    kind: 'plan',
    request: { ...intent, extra: true } as any,
  })).toBe(false)
  expect(allowsManagementWrite({ ...entry(plans), restricted: undefined }, planOperation)).toBe(false)
  const unscoped = [
    { kind: 'plan', request: { kind: 'plugin-plan-local', sourceDirectory: '/fixture' } },
    { kind: 'plan', request: { kind: 'plugin-plan-marketplace', pluginId: 'new' } },
    { kind: 'plan', request: { ...intent, extra: true } },
    { kind: 'execute', request: intent, expectedRevision: 4 },
    {
      kind: 'execute',
      request: { kind: 'plugin-execute-plan', executionToken: ownerToken() },
      expectedRevision: 4,
    },
  ] as const
  const unscopedDispatch = vi.fn()
  for (const operation of unscoped) {
    expect(allowsManagementWrite(entry(plans), operation as any)).toBe(false)
    await expect(projectManagementRequest({
      context,
      operation: operation as any,
      dispatch: unscopedDispatch,
      entry: () => entry(plans),
      ownerSnapshot: snapshot,
    })).rejects.toThrow('renderer-management-projection-unavailable')
  }
  expect(unscopedDispatch).not.toHaveBeenCalled()
  expect(allowsManagementWrite(entry(plans), {
    kind: 'plan',
    request: { kind: 'source-remove', url: 'https://example.test/' },
  })).toBe(true)
  const owner = ownerToken()
  const dispatchPlan = vi.fn(async () => ({
    status: 'planned',
    request: intent,
    snapshot: managementSnapshot(),
    executionRequest: { kind: 'plugin-execute-plan', executionToken: owner },
    affectedPluginIds: ['first', 'second'],
  }))
  const projected = await projectManagementRequest({
    context,
    operation: planOperation,
    dispatch: dispatchPlan,
    entry: () => entry(plans),
    ownerSnapshot: snapshot,
  }) as any
  expect(projected.status).toBe('planned')
  expect(JSON.stringify(projected)).not.toContain(owner)
  const execute = { kind: 'execute', request: projected.executionRequest, expectedRevision: 4 } as const
  expect(allowsManagementWrite(entry(otherPlans), execute)).toBe(false)
  expect(allowsManagementWrite(entry(plans), { ...execute, expectedRevision: 5 })).toBe(false)
  expect(allowsManagementWrite(entry(plans), execute)).toBe(true)
  const dispatchExecute = vi.fn(async operation => {
    expect(operation.request.executionToken).toBe(owner)
    active = { ...active, revision: 3, plugins: active.plugins.map(plugin => ({ ...plugin, enabled: false })) }
    return { status: 'applied', request: intent, snapshot: managementSnapshot(), pendingActivation: false }
  })
  const applied = await projectManagementRequest({
    context,
    operation: execute,
    dispatch: dispatchExecute,
    entry: () => entry(plans),
    ownerSnapshot: snapshot,
  }) as any
  expect(applied.status).toBe('applied')
  expect(dispatchExecute).toHaveBeenCalledOnce()
  expect(allowsManagementWrite(entry(plans), execute)).toBe(false)
  expect(discard).toHaveBeenCalledWith(owner)
  const anotherOwner = ownerToken()
  const enabling = { kind: 'plugin-enable', pluginId: 'first' } as const
  const enablingToken = plans.issue(anotherOwner, {
    intent: enabling,
    managementRevision: 4,
    activationRevision: 3,
  })!
  let revoked = false
  await expect(projectManagementRequest({
    context,
    operation: {
      kind: 'execute',
      request: { kind: 'plugin-execute-plan', executionToken: enablingToken },
      expectedRevision: 4,
    },
    dispatch: async () => {
      revoked = true
      return { status: 'applied', request: enabling, snapshot: managementSnapshot(), pendingActivation: false }
    },
    entry: () => revoked ? { ...entry(plans), restricted: undefined } : entry(plans),
    ownerSnapshot: snapshot,
  })).rejects.toThrow('renderer-management-projection-unavailable')
  expect(discard).toHaveBeenCalledWith(anotherOwner)
  plans.close()
  otherPlans.close()
})
