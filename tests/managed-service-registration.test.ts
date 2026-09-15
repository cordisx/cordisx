import { describe, expect, it } from 'vitest'
import { ManagedServiceSchemaRegistry } from '../packages/cli/src/launcher/managed-service-schema.js'
import { declaration, deferred, definition, fixture, owner, runtime } from './managed-service-runtime-fixture.js'

describe('managed service registration', () => {
  it('reuses one handle for concurrent identical registrations', async () => {
    const { root, home } = await fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    class DelayedDefinitionRegistry extends ManagedServiceSchemaRegistry {
      override async validateDefinition(value: unknown): Promise<void> {
        entered.resolve()
        await release.promise
        await super.validateDefinition(value)
      }
    }
    const host = runtime(home, { schemas: new DelayedDefinitionRegistry() })
    const binding = host.bind({
      owner: owner('dedupe-plugin', 'dedupe-one'),
      source: 'https://plugins.example.test/dedupe',
      declaration: declaration('dedupe-service', 'dedupe-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const revision = `sha256:${'1'.repeat(64)}` as const
    const first = binding.registry.register(definition('dedupe-service'), { revision })
    await entered.promise
    const second = binding.registry.register(definition('dedupe-service'), { revision })
    release.resolve()
    const [firstRegistration, secondRegistration] = await Promise.all([first, second])
    expect(firstRegistration.binding.registrationHandle).toBe(secondRegistration.binding.registrationHandle)
    expect(firstRegistration.binding.serviceHandle).toBe(secondRegistration.binding.serviceHandle)
    expect((await secondRegistration.ensureReady()).status).toBe('ready')
    await firstRegistration.dispose()
    expect((await binding.client.acquire(firstRegistration.binding.identity)).status).toBe('unavailable')
    await binding.dispose()
  })

  it('keeps a replacement registration when disposing the superseded record', async () => {
    const { root, home } = await fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    let projectEnvironmentCalls = 0
    const host = runtime(home, {
      projectEnvironment: async () => {
        projectEnvironmentCalls += 1
        if (projectEnvironmentCalls === 2) {
          entered.resolve()
          await release.promise
        }
        return {}
      },
    })
    const binding = host.bind({
      owner: owner('replacement-plugin', 'replacement-one'),
      source: 'https://plugins.example.test/replacement',
      declaration: declaration('replacement-service', 'replacement-plugin', [
        { pluginId: 'replacement-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const first = await binding.registry.register(definition('replacement-service'), {
      revision: `sha256:${'2'.repeat(64)}`,
    })
    const replacing = binding.registry.register(definition('replacement-service'), {
      revision: `sha256:${'3'.repeat(64)}`,
    })
    await entered.promise
    const disposing = first.dispose()
    release.resolve()
    const replacement = await replacing
    await disposing
    expect((await replacement.inspect()).state).toBe('registered')
    expect((await replacement.ensureReady()).status).toBe('ready')
    const acquired = await binding.client.acquire(replacement.binding.identity)
    expect(acquired.status).toBe('ready')
    if (acquired.status === 'ready') binding.client.release(acquired.lease)
    await binding.dispose()
  })

  it('contains a rejected registration cleanup without unhandled rejection noise', async () => {
    const { root, home } = await fixture()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.once('unhandledRejection', onUnhandled)
    try {
      class RejectingDefinitionRegistry extends ManagedServiceSchemaRegistry {
        override async validateDefinition(): Promise<void> {
          throw new Error('synthetic registration failure')
        }
      }
      const host = runtime(home, { schemas: new RejectingDefinitionRegistry() })
      const binding = host.bind({
        owner: owner('reject-plugin', 'reject-one'),
        source: 'https://plugins.example.test/reject',
        declaration: declaration('reject-service', 'reject-plugin', []),
        artifactDirectory: root,
      }, new AbortController().signal)
      await expect(binding.registry.register(definition('reject-service'), {
        revision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      })).rejects.toThrow('synthetic registration failure')
      await new Promise(resolve => setImmediate(resolve))
      expect(unhandled).toEqual([])
      await binding.dispose()
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  })
})
