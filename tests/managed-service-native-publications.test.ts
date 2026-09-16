import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { ManagedNativeProviderPublicationInputV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import { ManagedNativeProviderPublications } from '../packages/cli/src/launcher/managed-service-native-publications.js'
import type { ManagedServiceRecord } from '../packages/cli/src/launcher/managed-service-runtime-record.js'
import { declaration, definition, owner } from './managed-service-runtime-fixture.js'

function catalog() {
  const generation = 'catalog-one'
  const defaultAlias = 'source/region/primary'
  const routes = [
    { alias: 'source/region/secondary', gatewayModelId: 'gateway/models/family/model-two' },
    { alias: defaultAlias, gatewayModelId: 'gateway/models/family/model-one' },
  ]
  const sorted = [...routes].sort((left, right) =>
    Buffer.compare(
      Buffer.from(JSON.stringify([left.alias, left.gatewayModelId])),
      Buffer.from(JSON.stringify([right.alias, right.gatewayModelId])),
    )
  )
  const digest = `sha256:${
    createHash('sha256').update(
      JSON.stringify([generation, defaultAlias, sorted.map(route => [route.alias, route.gatewayModelId])]),
    ).digest('hex')
  }` as const
  return { generation, digest, defaultAlias, routes }
}

function record(options: { readonly serviceGeneration?: string; readonly state?: ManagedServiceRecord['state'] } = {}) {
  const serviceId = 'gateway-service'
  return {
    access: {
      owner: owner('synthetic-plugin', 'plugin-one'),
      source: 'https://plugins.example.test/gateway',
      declaration: declaration(serviceId, 'synthetic-plugin', []),
      artifactDirectory: '/synthetic/plugin',
    },
    binding: {
      identity: { source: 'https://plugins.example.test/gateway', pluginId: 'synthetic-plugin', serviceId },
      registrationHandle: 'msr_synthetic',
      serviceHandle: 'mss_synthetic',
      hostGeneration: 'host-one',
      serviceGeneration: options.serviceGeneration ?? 'service-one',
    },
    definition: definition(serviceId),
    disposed: false,
    state: options.state ?? 'ready',
  } as unknown as ManagedServiceRecord
}

function malformed(value: unknown): ManagedNativeProviderPublicationInputV1 {
  return value as ManagedNativeProviderPublicationInputV1
}

describe('managed native provider publications', () => {
  it('publishes an exact frozen projection while preserving opaque model ids', () => {
    const publications = new ManagedNativeProviderPublications()
    const input = {
      providerId: 'synthetic/provider',
      compositionOrigin: 'api',
      catalog: catalog(),
    }
    const publication = publications.publish(record(), input)
    expect(publication.status).toBe('accepted')
    if (publication.status !== 'accepted') throw new Error('publication was rejected')
    expect(publication.publication.publication).toEqual({
      providerId: 'synthetic/provider',
      owner: { pluginId: 'synthetic-plugin', hostGeneration: 'host-one', pluginGeneration: 'plugin-one' },
      service: { serviceId: 'gateway-service', serviceGeneration: 'service-one' },
      compositionOrigin: 'api',
      catalog: input.catalog,
      state: 'active',
    })
    expect(publication.publication.publication.catalog.routes[1]?.gatewayModelId).toBe(
      'gateway/models/family/model-one',
    )
    expect(Object.isFrozen(publication.publication.publication)).toBe(true)
    expect(Object.isFrozen(publication.publication.publication.catalog)).toBe(true)
    expect(Object.isFrozen(publication.publication.publication.catalog.routes)).toBe(true)
    expect(Object.isFrozen(publication.publication.publication.catalog.routes[0])).toBe(true)
    expect(publications.listProviderIds()).toEqual(['synthetic/provider'])
    expect(publications.resolve('synthetic/provider')).toEqual({
      record: expect.any(Object),
      projection: publication.publication.publication,
    })
    expect(Object.isFrozen(publications.listProviderIds())).toBe(true)
    expect(Object.isFrozen(publications.resolve('synthetic/provider'))).toBe(true)
  })

  it('rejects unknown authority fields at every input boundary', () => {
    const catalogValue = catalog()
    const invalidInputs = [
      { providerId: 'synthetic-input', compositionOrigin: 'api', catalog: catalogValue, owner: { pluginId: 'spoof' } },
      {
        providerId: 'synthetic-catalog',
        compositionOrigin: 'api',
        catalog: { ...catalogValue, materializationHandle: 'msm_spoof' },
      },
      {
        providerId: 'synthetic-route',
        compositionOrigin: 'api',
        catalog: {
          ...catalogValue,
          routes: [{ ...catalogValue.routes[0], endpoint: 'http://127.0.0.1:1' }, catalogValue.routes[1]],
        },
      },
    ]
    for (const input of invalidInputs) {
      expect(new ManagedNativeProviderPublications().publish(record(), malformed(input))).toEqual({
        status: 'rejected',
        diagnostic: { code: 'invalid-catalog', retryable: false },
      })
    }
  })

  it('rejects malformed runtime values with bounded diagnostics', () => {
    const valid = { providerId: 'synthetic-provider', compositionOrigin: 'api', catalog: catalog() }
    const invalidInputs: unknown[] = [
      null,
      [],
      { ...valid, providerId: 1 },
      { ...valid, compositionOrigin: null },
      { ...valid, catalog: null },
      { ...valid, catalog: { ...catalog(), routes: null } },
      { ...valid, catalog: { ...catalog(), routes: [null] } },
      { ...valid, catalog: { ...catalog(), routes: [{ alias: 'primary', gatewayModelId: 1 }] } },
      { ...valid, catalog: { ...catalog(), digest: `sha256:${'A'.repeat(64)}` } },
    ]
    for (const input of invalidInputs) {
      expect(() => new ManagedNativeProviderPublications().publish(record(), malformed(input))).not.toThrow()
      expect(new ManagedNativeProviderPublications().publish(record(), malformed(input))).toMatchObject({
        status: 'rejected',
        diagnostic: { code: 'invalid-catalog' },
      })
    }
  })

  it('keeps explicit disposal idempotent and retirement stale', async () => {
    const publications = new ManagedNativeProviderPublications()
    const registration = record()
    const publication = publications.publish(registration, {
      providerId: 'synthetic-provider',
      compositionOrigin: 'api',
      catalog: catalog(),
    })
    if (publication.status !== 'accepted') throw new Error('publication was rejected')
    expect(await publication.publication.dispose()).toMatchObject({
      status: 'disposed',
      projection: { state: 'revoked' },
    })
    expect(publications.listProviderIds()).toEqual([])
    expect(publications.resolve('synthetic-provider')).toBeUndefined()
    expect(await publication.publication.dispose()).toMatchObject({
      status: 'disposed',
      projection: { state: 'revoked' },
    })
  })

  it('does not let a retired handle delete its replacement', async () => {
    const publications = new ManagedNativeProviderPublications()
    const firstRecord = record({ serviceGeneration: 'service-one' })
    const first = publications.publish(firstRecord, {
      providerId: 'synthetic-provider',
      compositionOrigin: 'api',
      catalog: catalog(),
    })
    if (first.status !== 'accepted') throw new Error('first publication was rejected')

    publications.revoke(firstRecord)
    const replacement = publications.publish(record({ serviceGeneration: 'service-two' }), {
      providerId: 'synthetic-provider',
      compositionOrigin: 'api',
      catalog: catalog(),
    })
    expect(replacement.status).toBe('accepted')
    expect(await first.publication.dispose()).toMatchObject({
      status: 'stale',
      diagnostic: { code: 'stale-generation' },
    })
    expect(publications.publish(record(), {
      providerId: 'synthetic-provider',
      compositionOrigin: 'api',
      catalog: catalog(),
    })).toMatchObject({ status: 'rejected', diagnostic: { code: 'duplicate-provider' } })
  })
})
