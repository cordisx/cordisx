import { expect, it, vi } from 'vitest'
import { ManagedServiceStartupAuthority } from '../packages/cli/src/launcher/managed-service-startup-authority.js'
import { startupProviderAdmission } from '../packages/cli/src/launcher/startup-provider-admission.js'
import { createTerminalProviderAuthority } from '../packages/cli/src/launcher/terminal-provider.js'
import { createNativeAgentModelsHandler } from '../packages/cli/src/launcher/native-agent-models.js'
import { declaration } from './managed-service-runtime-fixture.js'

it('lists the real startup snapshot separately from an empty execution catalog without inventing models', async () => {
  const authority = new ManagedServiceStartupAuthority({ profileId: 'profile', hostGeneration: 'host' })
  authority.admit([{
    pluginId: 'owner',
    pluginGeneration: 'plugin',
    source: 'test',
    sourceRevision: 'revision',
    dependencies: [],
    services: [declaration('gateway', 'owner', [])],
    startup: {
      contract: 'cordisx.startup-declaration/v1',
      pages: [],
      capabilities: [{
        id: 'models',
        serviceId: 'gateway',
        kind: 'provider',
        providerId: 'exact-provider',
        compositionOrigin: 'api',
        dependsOn: [],
        wait: { interactive: 'background', command: 'when-selected' },
        milestones: [],
        success: { allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }] },
      }],
    },
  }])
  authority.selectOwners([{ pluginId: 'owner', pluginGeneration: 'plugin' }])
  const observer = authority.observer({ scopeId: 'native-lists', authorize: () => true })
  const startup = startupProviderAdmission(authority, observer)
  const prepare = vi.fn()
  const terminal = createTerminalProviderAuthority({
    startup,
    catalog: async () => [],
    owns: () => false,
    resolve: vi.fn(),
    credentials: { prepare, close: async () => {} },
  })
  const native = createNativeAgentModelsHandler({
    startup,
    catalog: async () => [],
    controller: { prepareThreadResume: vi.fn(), completeThreadResume: vi.fn() },
    switchThread: vi.fn(),
    reserve: vi.fn(),
    commit: vi.fn(),
    release: vi.fn(),
  })
  try {
    for (const result of [await terminal.request({ kind: 'list' }), await native('list', {})]) {
      expect(result).toMatchObject({
        providers: [],
        startup: {
          contract: 'cordisx.startup-snapshot/v1',
          entries: [{
            identity: { providerId: 'exact-provider' },
            state: 'declared',
            authentication: 'unknown',
            catalog: { state: 'unknown' },
            actions: { execute: { available: false, reason: 'not-prepared' } },
          }],
        },
      })
    }
    expect(startup.availability('undeclared', 'model')).toBeUndefined()
    expect(startup.availability('exact-provider', 'model')).toMatchObject({ available: false, reason: 'not-prepared' })
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    terminal.close()
    authority.dispose()
  }
})
