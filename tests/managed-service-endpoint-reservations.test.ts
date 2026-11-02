import { describe, expect, it } from 'vitest'
import { ManagedServiceRuntime } from '../packages/cli/src/launcher/managed-service-runtime.js'
import { ManagedServiceEndpointReservations } from '../packages/cli/src/launcher/managed-service-endpoint-reservations.js'
import { declaration, deferred, definition, fixture, owner } from './managed-service-runtime-fixture.js'

describe('generation endpoint reservations', () => {
  it('protects a pending borrowed endpoint before process preparation and releases only its own generation', async () => {
    const { root, home } = await fixture()
    const endpointReservations = new ManagedServiceEndpointReservations()
    const entered = deferred<void>()
    const release = deferred<void>()
    const first = new ManagedServiceRuntime({
      homeDir: home,
      endpointReservations,
      projectEnvironment: async () => {
        entered.resolve()
        await release.promise
        return {}
      },
    })
    const second = new ManagedServiceRuntime({ homeDir: home, endpointReservations })
    const access = (generation: string) => ({
      owner: owner('reserved', generation),
      source: 'https://example.test/plugin' as const,
      declaration: declaration('gateway', 'reserved', []),
      artifactDirectory: root,
    })
    const a = first.bind(access('one'), new AbortController().signal)
    const b = second.bind(access('two'), new AbortController().signal)
    const pending = a.registry.register(definition('gateway', { fixedPort: 43412 }), {
      revision: `sha256:${'a'.repeat(64)}`,
    })
    await entered.promise
    await expect(
      b.registry.register(definition('gateway', { fixedPort: 43412 }), { revision: `sha256:${'b'.repeat(64)}` }),
    ).rejects.toThrow('reserved')
    release.resolve()
    await pending
    await b.dispose() // A failed candidate cannot release the previous generation's reservation.
    const c = second.bind(access('three'), new AbortController().signal)
    await expect(
      c.registry.register(definition('gateway', { fixedPort: 43412 }), { revision: `sha256:${'c'.repeat(64)}` }),
    ).rejects.toThrow('reserved')
    await a.dispose()
    await expect(
      c.registry.register(definition('gateway', { fixedPort: 43412 }), { revision: `sha256:${'c'.repeat(64)}` }),
    ).resolves.toBeDefined()
    await c.dispose()
  })
})
