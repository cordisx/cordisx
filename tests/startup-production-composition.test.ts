import { expect, it } from 'vitest'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { createStartupHostBridge } from '../packages/cli/src/cli/startup-host-bridge.js'
import { startupTerminalRequests } from '../packages/cli/src/launcher/startup-provider-admission.js'

it('publishes Host observation and answers ordinary caller requirements before deferred adoption', async () => {
  let adopt!: () => void
  const pending = new Promise<void>(resolve => {
    adopt = resolve
  })
  const lifecycle = new ManagedServicePluginLifecycleRuntime({
    runtime: {} as never,
    profileId: 'profile',
    runtimeGeneration: 'host',
    readStartupAdmissions: async () => [{
      pluginId: 'plugin',
      pluginGeneration: 'plugin-generation',
      source: 'test',
      sourceRevision: 'test',
      dependencies: [],
      services: [],
      startup: { contract: 'cordisx.startup-declaration/v1', capabilities: [], pages: [] },
    }],
    activate: async () => {
      await pending
      return undefined
    },
  })
  const record = {
    schemaVersion: 1,
    revision: 1,
    runtimeGeneration: 'host',
    plugins: [{ id: 'plugin', moduleGeneration: 'plugin-generation', enabled: true }],
  } as never
  const session = await lifecycle.initialize(record)
  const bridge = createStartupHostBridge(lifecycle, 'profile', 'host')
  try {
    const response = await bridge.handleBindingValue(JSON.stringify({
      version: 1,
      requestId: 'read',
      token: bridge.capability.token,
      scope: { profileId: 'profile', runtimeGeneration: 'host' },
      operation: 'startupRead',
    }))
    expect(response.ok).toBe(true)
    const wait = startupTerminalRequests(session.authority, () => undefined)
    expect(await wait({ kind: 'wait' })).toEqual({ kind: 'ready' })
  } finally {
    adopt()
    await session.adopted
    await bridge.close()
    await lifecycle.dispose()
  }
})

it('ordinary callers have independent cancellation without cancelling the shared authority', async () => {
  const controllers = new Set<AbortSignal>()
  let ready = false
  const resolvers = new Set<() => void>()
  const target = { pluginId: 'required', capabilityId: 'always' }
  const authority = {
    providerReference: () => undefined,
    targets: () => [target],
    availability: () => ready ? { available: true } : { available: false, reason: 'preparing' },
    wait: async (_target: unknown, options: { signal: AbortSignal }) =>
      await new Promise(resolve => {
        controllers.add(options.signal)
        const done = () => {
          controllers.delete(options.signal)
          resolvers.delete(done)
          resolve({ available: true })
        }
        resolvers.add(done)
        options.signal.addEventListener('abort', () => {
          controllers.delete(options.signal)
          resolvers.delete(done)
        }, { once: true })
      }),
  } as unknown as import('../packages/cli/src/launcher/managed-service-startup-authority.js').ManagedServiceStartupAuthority
  const request = startupTerminalRequests(authority, () => undefined)
  const first = request({ kind: 'wait', waiterId: 'first' })
  const second = request({ kind: 'wait', waiterId: 'second' })
  await request({ kind: 'cancel-wait', waiterId: 'first' })
  expect(await first).toMatchObject({ kind: 'unavailable', startup: { status: 'cancelled' } })
  expect(controllers.size).toBe(1)
  ready = true
  for (const done of [...resolvers]) done()
  expect(await second).toEqual({ kind: 'ready' })
  expect(controllers.size).toBe(0)
})
