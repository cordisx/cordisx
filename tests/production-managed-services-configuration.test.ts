import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { createProductionManagedServiceLifecycle } from '../packages/cli/src/cli/production-managed-services.js'

const spies = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  load: vi.fn(),
  access: vi.fn(),
  activate: vi.fn(),
}))
vi.mock('../packages/cli/src/launcher/managed-service-plugin-lifecycle.js', () => ({
  ManagedServicePluginLifecycleRuntime: class {
    constructor(input: unknown) {
      spies.lifecycle(input)
    }
  },
}))
vi.mock('../packages/cli/src/launcher/plugin-composition.js', () => ({ loadPluginComposition: spies.load }))
vi.mock('../packages/cli/src/launcher/packages/managed-backend-service-access.js', () => ({
  managedBackendRuntimeServiceAccess: spies.access,
}))
vi.mock('../packages/cli/src/launcher/managed-service-candidate.js', () => ({
  activateManagedServiceCandidate: spies.activate,
}))

function plugin(config: unknown, generation = 'plugin-1', schemaVersion = 15) {
  return {
    id: 'aiden',
    enabled: true,
    config,
    package: { version: '1', digest: `sha256:${'a'.repeat(64)}`, moduleGeneration: generation },
    manifest: { schemaVersion, services: [{ kind: 'managed-backend', id: 'gateway' }] },
  }
}
function owner(profileId: string, generation = 'host-1', dryRun = false) {
  const store = { profileId, homeDir: '/isolated', runtimeGeneration: generation } as PluginActivationStore
  createProductionManagedServiceLifecycle({
    homeDir: '/isolated',
    profileId,
    generation,
    store,
    dryRun,
    environment: {},
    runtime: {} as Parameters<typeof createProductionManagedServiceLifecycle>[0]['runtime'],
  })
  const captured = spies.lifecycle.mock.lastCall![0] as {
    activate: (activation: unknown, options: { pluginIds: string[] }) => Promise<unknown>
  }
  return { store, activate: captured.activate }
}
beforeEach(() => {
  vi.clearAllMocks()
  spies.access.mockImplementation(async (...args: unknown[]) => ({ args }))
  spies.activate.mockResolvedValue({ ready: 'fixture' })
})

describe('production selected managed-service configuration wiring', () => {
  it('passes only the current profile composition config, preserving snapshot identity', async () => {
    const one = owner('profile-one'), two = owner('profile-two')
    const first = Object.freeze({ account: { root: '/account-one' } })
    const second = Object.freeze({ account: { root: '/account-two' } })
    spies.load.mockImplementation(async store => [plugin(store === one.store ? first : second)])
    const activationOne = { revision: 1 }, activationTwo = { revision: 9 }
    await one.activate(activationOne, { pluginIds: ['aiden'] })
    await two.activate(activationTwo, { pluginIds: ['aiden'] })
    expect(spies.load.mock.calls).toEqual([[one.store, activationOne], [two.store, activationTwo]])
    expect(spies.access.mock.calls[0]![4]).toBe(first)
    expect(spies.access.mock.calls[1]![4]).toBe(second)
    expect(spies.activate.mock.calls[0]![1]).toMatchObject({ profileId: 'profile-one' })
    expect(spies.activate.mock.calls[1]![1]).toMatchObject({ profileId: 'profile-two' })
  })

  it('reloads selected config for each initial/update activation with its selected module generation', async () => {
    const current = owner('cold')
    const initial = plugin({ value: 'initial' }, 'module-initial')
    const updated = plugin({ value: 'updated' }, 'module-update')
    spies.load.mockResolvedValueOnce([initial]).mockResolvedValueOnce([updated])
    await current.activate({ revision: 1 }, { pluginIds: ['aiden'] })
    await current.activate({ revision: 2 }, { pluginIds: ['aiden'] })
    expect(spies.access.mock.calls[0]![1]).toMatchObject({ moduleGeneration: 'module-initial' })
    expect(spies.access.mock.calls[0]![4]).toBe(initial.config)
    expect(spies.access.mock.calls[1]![1]).toMatchObject({ moduleGeneration: 'module-update' })
    expect(spies.access.mock.calls[1]![4]).toBe(updated.config)
    expect(spies.access.mock.calls.map(call => call[3])).toEqual(['host-1', 'host-1'])
  })

  it.each([14, 15])('preserves undefined config for schema %s and does not synthesize a default', async schema => {
    const current = owner('cold')
    spies.load.mockResolvedValue([plugin(undefined, 'module-1', schema)])
    await current.activate({}, { pluginIds: ['aiden'] })
    expect(spies.access.mock.calls[0]).toHaveLength(5)
    expect(spies.access.mock.calls[0]![4]).toBeUndefined()
  })

  it('does not admit disabled/unselected services or await unrelated provider preparation', async () => {
    const current = owner('cold')
    spies.load.mockResolvedValue([plugin({ selected: true }), { ...plugin({ unrelated: true }), id: 'traex' }, {
      ...plugin({ disabled: true }),
      id: 'disabled',
      enabled: false,
    }])
    await current.activate({}, { pluginIds: ['aiden', 'disabled'] })
    expect(spies.access).toHaveBeenCalledTimes(1)
    expect(spies.access.mock.calls[0]![1].id).toBe('aiden')
    expect(spies.activate).toHaveBeenCalledTimes(1)
  })

  it('keeps dry-run free of composition and service access', async () => {
    await owner('cold', 'host-1', true).activate({}, { pluginIds: ['aiden'] })
    expect(spies.load).not.toHaveBeenCalled()
    expect(spies.access).not.toHaveBeenCalled()
    expect(spies.activate).not.toHaveBeenCalled()
  })
})
