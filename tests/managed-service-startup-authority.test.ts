import { createHash } from 'node:crypto'
import type { StartupEventV1, StartupMilestoneReportV1 } from '@cordisx/protocol/startup/v1'
import type { ManagedServiceProjectionV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import { describe, expect, it } from 'vitest'
import { ManagedServiceStartupAuthority } from '../packages/cli/src/launcher/managed-service-startup-authority.js'
import type { StartupPluginAdmission } from '../packages/cli/src/launcher/managed-service-startup-admission.js'
import { declaration } from './managed-service-runtime-fixture.js'

const owner = { pluginId: 'plugin', pluginGeneration: 'one', serviceId: 'gateway', serviceGeneration: 'service-one' }
const ref = { pluginId: 'plugin', capabilityId: 'gateway-provider' }
function admission(generation = 'one'): StartupPluginAdmission {
  return {
    pluginId: 'plugin',
    pluginGeneration: generation,
    source: 'https://example.test/plugin',
    sourceRevision: 'sha256:source',
    dependencies: [],
    services: [declaration('gateway', 'plugin', [])],
    startup: {
      contract: 'cordisx.startup-declaration/v1',
      pages: [],
      capabilities: [{
        id: 'gateway-provider',
        serviceId: 'gateway',
        kind: 'provider',
        providerId: 'provider',
        compositionOrigin: 'api',
        dependsOn: [],
        wait: { interactive: 'background', command: 'when-selected' },
        milestones: ['catalog-checked'],
        success: {
          allOf: [{ kind: 'service-ready' }, { kind: 'catalog-known' }, { kind: 'provider-published' }, {
            kind: 'milestone',
            milestoneId: 'catalog-checked',
          }],
        },
      }],
    },
  }
}
function service(
  authentication: ManagedServiceProjectionV1['authentication'] = { state: 'not-required' },
): ManagedServiceProjectionV1 {
  return {
    contract: 'cordisx.managed-service-projection/v1',
    schemaVersion: 1,
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-projection.v1.schema.json',
    binding: {
      registrationHandle: 'msr_test',
      serviceHandle: 'mss_test',
      hostGeneration: 'host-one',
      serviceGeneration: 'service-one',
      identity: { source: 'https://example.test/plugin', pluginId: 'plugin', serviceId: 'gateway' },
    },
    state: 'ready',
    health: 'ready',
    processOwnership: 'borrowed',
    configuration: { state: 'not-required' },
    authentication,
    httpAuthorization: { state: 'not-required' },
  }
}
function report(sequence = 1): StartupMilestoneReportV1 {
  return {
    contract: 'cordisx.startup-milestone/v1',
    target: ref,
    generation: { host: 'host-one', plugin: 'one', service: 'service-one' },
    milestoneId: 'catalog-checked',
    sequence,
    state: 'satisfied',
  }
}
function setup() {
  const authority = new ManagedServiceStartupAuthority({ profileId: 'profile', hostGeneration: 'host-one' })
  authority.selectOwners([owner])
  authority.admit([admission()])
  const observer = authority.observer({ scopeId: 'host-selector', authorize: () => true })
  return { authority, observer }
}

describe('startup authority', () => {
  it('revokes only the retired plugin observer while keeping the Host scope open', async () => {
    const { authority, observer } = setup()
    const plugin = authority.observer({
      scopeId: 'plugin',
      owner: { pluginId: 'plugin', pluginGeneration: 'one' },
      authorize: () => true,
    })
    const pluginEvents: StartupEventV1[] = []
    const hostEvents: StartupEventV1[] = []
    await plugin.subscribe(event => pluginEvents.push(event))
    await observer.subscribe(event => hostEvents.push(event))
    authority.retireOwner('plugin', 'one')
    expect(pluginEvents.at(-1)).toMatchObject({ kind: 'closed', reason: 'scope-revoked' })
    expect(hostEvents.at(-1)?.kind).toBe('snapshot')
    await expect(plugin.read()).rejects.toThrow('scope-revoked')
    authority.dispose()
  })

  it('fences retry reporters independently of unchanged generations and monotonic report sequences', async () => {
    const { authority, observer } = setup()
    authority.bindService(owner)
    authority.adopt(owner)
    authority.updateService(owner, service(), false)
    const old = authority.beginAttempt(owner, ref.capabilityId, new AbortController().signal)
    const empty = {
      state: 'known' as const,
      generation: 'empty',
      modelIds: [],
      digest: `sha256:${createHash('sha256').update(JSON.stringify(['empty', []])).digest('hex')}` as const,
    }
    const catalog = {
      contract: 'cordisx.startup-catalog-report/v1' as const,
      target: ref,
      generation: report().generation,
      sequence: 1,
      catalog: empty,
    }
    expect(await old.reporter.reportCatalog(catalog)).toEqual({ status: 'accepted' })
    old.finish()
    expect(await authority.wait(ref)).toEqual({ available: false, reason: 'catalog-empty' })
    expect((await observer.read()).entries[0]).toMatchObject({
      state: 'failed',
      service: 'ready',
      process: 'running',
      health: 'ready',
    })
    const next = authority.beginAttempt(owner, ref.capabilityId, new AbortController().signal)
    expect(await old.reporter.report(report(99))).toMatchObject({ status: 'rejected', reason: 'revoked' })
    old.finish()
    expect(await next.reporter.reportCatalog(catalog)).toMatchObject({ reason: 'stale-sequence' })
    expect(await next.reporter.reportCatalog({ ...catalog, sequence: 2, catalog: { ...empty, digest: 'sha256:bad' } }))
      .toMatchObject({ reason: 'invalid-catalog' })
    expect(await next.reporter.reportCatalog({ ...catalog, sequence: 2 })).toMatchObject({ status: 'accepted' })
    authority.dispose()
  })

  it('exposes declared identity before execution registration, with no private binding data', async () => {
    const { authority, observer } = setup()
    const snapshot = await observer.read()
    expect(snapshot.entries[0]).toMatchObject({
      identity: { providerId: 'provider' },
      state: 'declared',
      generation: { service: null },
      actions: { execute: { available: false } },
    })
    expect(JSON.stringify(snapshot)).not.toMatch(/registrationHandle|sourceRevision|example\.test|"port"/)
    expect(authority.declaration(ref)?.sourceRevision).toBe('sha256:source')
    expect(authority.targets('interactive')).toEqual([])
    expect(authority.targets('command', ref)).toEqual([ref])
    authority.dispose()
  })

  it('requires adoption, actual readiness, catalog, publication and owner milestones independently', async () => {
    const { authority } = setup()
    const reporter = authority.bindService(owner)
    authority.preparing(owner)
    authority.updateService(owner, service(), false)
    expect(authority.acceptsPublication(owner, 'provider', 'api')).toBe(false)
    authority.adopt(owner)
    expect(authority.acceptsPublication(owner, 'provider', 'api')).toBe(true)
    expect(authority.acceptsPublication(owner, 'other', 'api')).toBe(false)
    await reporter.reportCatalog({
      contract: 'cordisx.startup-catalog-report/v1',
      target: ref,
      generation: report().generation,
      sequence: 1,
      catalog: {
        state: 'known',
        generation: 'catalog-one',
        modelIds: ['model'],
        digest: `sha256:${createHash('sha256').update(JSON.stringify(['catalog-one', ['model']])).digest('hex')}`,
      },
    })
    authority.publication(owner, 'provider', { state: 'known', generation: 'catalog-one', modelIds: ['model'] })
    authority.settled(owner)
    expect(authority.availability(ref)).toMatchObject({ available: false, reason: 'milestone-pending' })
    expect(await reporter.report(report())).toEqual({ status: 'accepted' })
    expect(authority.availability(ref)).toEqual({ available: true })
    expect(authority.availability(ref, 'missing')).toMatchObject({ reason: 'model-unavailable' })
    await reporter.report({ ...report(2), state: 'failed' })
    expect(authority.availability(ref)).toMatchObject({ reason: 'failed' })
    await reporter.report(report(3))
    expect(authority.availability(ref)).toEqual({ available: true })
    authority.publication(owner, 'provider', undefined)
    expect(authority.availability(ref)).toMatchObject({ reason: 'provider-unpublished' })
    authority.dispose()
  })

  it('keeps authentication available while target wait reports authentication-required', async () => {
    const { authority, observer } = setup()
    authority.bindService(owner)
    authority.adopt(owner)
    authority.updateService(owner, {
      ...service({ state: 'missing' }),
      state: 'authentication-required',
      health: 'stopped',
    }, true)
    expect(await authority.wait(ref)).toMatchObject({ reason: 'authentication-required' })
    expect((await observer.read()).entries[0]?.actions.authenticate).toEqual({ available: true })
    authority.dispose()
  })

  it('rejects spoofed, stale and revoked milestone reports without changing revision', async () => {
    const { authority, observer } = setup()
    const reporter = authority.bindService(owner)
    const before = (await observer.read()).cursor.sequence
    expect(await reporter.report({ ...report(), target: { ...ref, pluginId: 'foreign' } })).toMatchObject({
      reason: 'not-owner',
    })
    expect(await reporter.report({ ...report(), generation: { ...report().generation, service: 'stale' } }))
      .toMatchObject({ reason: 'stale-generation' })
    expect((await observer.read()).cursor.sequence).toBe(before)
    await reporter.report(report())
    expect(await reporter.report(report())).toMatchObject({ reason: 'stale-sequence' })
    authority.revoke(owner)
    expect(await reporter.report(report(2))).toMatchObject({ reason: 'revoked' })
    authority.dispose()
  })

  it('replays snapshot gaps, rejects cross-scope cursors and closes exactly once', async () => {
    const { authority, observer } = setup()
    const before = await observer.read()
    authority.bindService(owner)
    authority.preparing(owner)
    const events: StartupEventV1[] = []
    const subscription = await observer.subscribe(event => events.push(event), { after: before.cursor })
    expect(events.map(event => event.kind === 'snapshot' ? event.snapshot.cursor.sequence : -1)).toEqual([1, 2])
    await expect(observer.subscribe(() => {}, { after: { ...before.cursor, scopeId: 'different' } })).rejects.toThrow(
      'scope mismatch',
    )
    subscription.close()
    subscription.close()
    authority.adopt(owner)
    expect(events.filter(event => event.kind === 'closed')).toHaveLength(1)
    expect(events).toHaveLength(3)
    authority.dispose()
  })

  it('keeps replacement candidate evidence private until owner selection switches', async () => {
    const { authority, observer } = setup()
    authority.admit([admission('two')])
    const candidate = authority.observer({
      scopeId: 'candidate',
      owner: { pluginId: 'plugin', pluginGeneration: 'two' },
      authorize: () => true,
    })
    expect((await observer.read()).entries[0]?.generation.plugin).toBe('one')
    expect((await candidate.read()).entries[0]?.generation.plugin).toBe('two')
    authority.selectOwners([{ pluginId: 'plugin', pluginGeneration: 'two' }])
    expect((await observer.read()).entries[0]?.generation.plugin).toBe('two')
    authority.dispose()
  })

  it('rejects duplicate provider identity and dependency cycles before state changes', () => {
    const { authority } = setup()
    const value = admission('two')
    const first = value.startup.capabilities[0]!
    expect(() =>
      authority.admit([{ ...value, startup: { ...value.startup, capabilities: [first, { ...first, id: 'second' }] } }])
    ).toThrow('duplicate startup provider')
    expect(() =>
      authority.admit([{ ...value, startup: { ...value.startup, capabilities: [{ ...first, dependsOn: [ref] }] } }])
    ).toThrow('cycle')
    authority.dispose()
  })
})
