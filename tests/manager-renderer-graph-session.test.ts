import { expect, it } from 'vitest'
import { createManagerRendererGraphSession } from '../packages/cli/src/cli/manager-renderer-graph-session.js'
import { managerFixtureActivation, managerRendererGraphFixture } from './fixtures/manager-renderer-graph.js'
import { EMPTY_PROJECTION } from '../packages/cli/src/renderer/channel-manager-projection.js'
import { exactDomPermissionPolicies } from './helpers/dom-permission.js'

const forbidden = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]
const rendererId = '4'.repeat(64)
const baseInput = {
  managerOrigin: 'http://127.0.0.1:43124',
  profileId: 'fixture',
  generation: 'generation',
  rendererId,
  isCurrent: () => true,
  forbiddenSecrets: forbidden,
}

function descriptor(lease: Awaited<ReturnType<Awaited<ReturnType<typeof managerRendererGraphFixture>>['lease']>>) {
  return {
    leaseId: lease.leaseId,
    pluginId: lease.pluginId,
    moduleGeneration: lease.moduleGeneration,
    baseUrl: lease.baseUrl,
    entryUrl: lease.entryUrl,
    initialStyleUrls: [...lease.initialStyleUrls],
  }
}

function command(method: string, sequence: number, payload: unknown) {
  return { id: (sequence === 1 ? 'e' : 'f').repeat(64), sequence, method, payload }
}

function stage(previousGeneration: string, nextGeneration: string, graph: unknown) {
  return {
    rendererId,
    transactionId: 'transaction',
    transactionEpoch: 'transaction:epoch',
    expectedRegistryEpoch: 0,
    afterRegistryEpoch: 1,
    operation: 'update',
    previous: managerFixtureActivation('active', previousGeneration),
    candidate: managerFixtureActivation('candidate', nextGeneration),
    targetId: 'fixture',
    affectedPluginIds: ['fixture'],
    privateGraphs: [graph],
  }
}

it('forwards only a bounded owner quiescence fence', () => {
  const session = createManagerRendererGraphSession(baseInput)
  session.projectInitial([])
  const value = command('quiesce', 1, { fenceId: 'c'.repeat(64) })
  expect(session.projectCommand(value)).toEqual(value)
  session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
  session.close()

  const invalid = createManagerRendererGraphSession(baseInput)
  invalid.projectInitial([])
  expect(() => invalid.projectCommand(command('quiesce', 1, { fenceId: 'invalid' })))
    .toThrow('MANAGER_RENDERER_GRAPH_INVALID')
  expect(invalid.closed).toBe(true)
})

it.each(['channel', 'fixture-service'])(
  'projects a %s permission handoff only for its active graph and session alias',
  async pluginId => {
    const fixture = await managerRendererGraphFixture()
    try {
      const lease = await fixture.lease('channel-generation')
      const graph = { ...descriptor(lease), pluginId }
      const identity = { id: pluginId, source: `https://renderer.cordisx.invalid/plugin/${'a'.repeat(64)}` }
      const [record] = exactDomPermissionPolicies(baseInput.profileId, [{
        id: identity.id,
        entry: '/fixture.js',
        pointIds: ['manager.content'],
      }])
      const candidate = [{
        ...record!,
        key: { ...record!.key, identity: { ...record!.key.identity, source: identity.source } },
      }]
      const payload = {
        rendererId,
        ownerGeneration: baseInput.generation,
        handoffId: 'b'.repeat(64),
        requestId: 'request-1',
        origin: false,
        identity,
        moduleGeneration: 'channel-generation',
        expected: [],
        updates: candidate,
        candidate,
      }
      const session = createManagerRendererGraphSession(baseInput)
      session.projectInitial([graph])
      expect(session.projectCommand(command('permission-policy', 1, payload))).toEqual(
        command('permission-policy', 1, payload),
      )
      session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
      session.close()
      for (
        const bad of [
          { ...payload, rendererId: '5'.repeat(64) },
          { ...payload, moduleGeneration: 'other' },
          { ...payload, requestId: 'wrong request' },
          { ...payload, identity: { ...identity, source: 'https://example.test/private' } },
          { ...payload, candidate: [candidate[0]!, candidate[0]!] },
          { ...payload, updates: [] },
          { ...payload, candidate: [] },
        ]
      ) {
        const target = createManagerRendererGraphSession(baseInput)
        target.projectInitial([graph])
        expect(() => target.projectCommand(command('permission-policy', 1, bad)))
          .toThrow('MANAGER_RENDERER_GRAPH_INVALID')
        expect(target.closed).toBe(true)
      }
    } finally {
      await fixture.close()
    }
  },
)

it('forwards only the redacted Channel view for this exact renderer and revision', () => {
  const projection = {
    ...EMPTY_PROJECTION,
    service: { ...EMPTY_PROJECTION.service, revision: 2, lastGoodRevision: 2, writable: true },
  }
  const payload = { rendererId, ownerGeneration: baseInput.generation, revision: 2, projection }
  const session = createManagerRendererGraphSession(baseInput)
  session.projectInitial([])
  const value = command('channel-configuration', 1, payload)
  expect(session.projectCommand(value)).toEqual(value)
  session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
  session.close()
  for (
    const bad of [
      { ...payload, rendererId: '5'.repeat(64) },
      { ...payload, ownerGeneration: 'stale' },
      { ...payload, revision: 3 },
      { ...payload, projection: { ...projection, secretRef: 'private' } },
    ]
  ) {
    const target = createManagerRendererGraphSession(baseInput)
    target.projectInitial([])
    expect(() => target.projectCommand(command('channel-configuration', 1, bad)))
      .toThrow('MANAGER_RENDERER_GRAPH_INVALID')
    expect(target.closed).toBe(true)
  }
})

it('allows managed-service readback only for the active plugin generation of the renderer', async () => {
  const fixture = await managerRendererGraphFixture()
  const session = createManagerRendererGraphSession(baseInput)
  try {
    const lease = await fixture.lease('old')
    session.projectInitial([descriptor(lease)])
    const payload = {
      rendererId,
      ownerGeneration: baseInput.generation,
      pluginId: 'fixture',
      pluginGeneration: 'old',
      serviceId: 'gateway',
      sequence: 3,
      phase: 'prepare',
      action: 'login',
    }
    const value = command('managed-service-state', 1, payload)
    expect(session.projectCommand(value)).toEqual(value)
    session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
    for (
      const bad of [
        { ...payload, pluginGeneration: 'other' },
        { ...payload, rendererId: '5'.repeat(64) },
        { ...payload, action: 'refresh' },
        { ...payload, secret: 'private' },
      ]
    ) {
      const target = createManagerRendererGraphSession(baseInput)
      target.projectInitial([descriptor(lease)])
      expect(() => target.projectCommand(command('managed-service-state', 1, bad)))
        .toThrow('MANAGER_RENDERER_GRAPH_INVALID')
      target.close()
    }
  } finally {
    session.close()
    await fixture.close()
  }
})

it('forwards account adoption only to the active plugin graph and matching renderer', async () => {
  const fixture = await managerRendererGraphFixture()
  const session = createManagerRendererGraphSession(baseInput)
  try {
    const lease = await fixture.lease('old')
    session.projectInitial([descriptor(lease)])
    const binding = {
      bindingId: 'binding-1',
      identity: { pluginId: 'fixture', serviceId: 'gateway' },
      scope: { profileId: baseInput.profileId, generation: baseInput.generation },
    }
    const accounts = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-cli-proxy-accounts.v1.schema.json',
      contract: 'cordisx.managed-service-cli-proxy-accounts/v1',
      schemaVersion: 1,
      binding,
      sequence: 1,
      observedAt: '2026-01-01T00:00:00Z',
      revision: 4,
      serviceGeneration: 'service-1',
      accounts: [],
    }
    const payload = {
      rendererId,
      ownerGeneration: baseInput.generation,
      requestId: 'request-1',
      pluginId: 'fixture',
      pluginGeneration: 'old',
      serviceId: 'gateway',
      phase: 'prepare',
      binding,
      accounts,
    }
    const value = command('managed-service-accounts', 1, payload)
    expect(session.projectCommand(value)).toEqual(value)
    session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
    for (
      const bad of [{ ...payload, pluginGeneration: 'other' }, { ...payload, rendererId: '5'.repeat(64) }, {
        ...payload,
        accounts: { ...accounts, accounts: [{ token: 'private' }] },
      }]
    ) {
      const target = createManagerRendererGraphSession(baseInput)
      target.projectInitial([descriptor(lease)])
      expect(() => target.projectCommand(command('managed-service-accounts', 1, bad)))
        .toThrow('MANAGER_RENDERER_GRAPH_INVALID')
      target.close()
    }
  } finally {
    session.close()
    await fixture.close()
  }
})

it('forwards a configuration receipt only for an active package and the exact renderer', async () => {
  const fixture = await managerRendererGraphFixture()
  try {
    const lease = await fixture.lease('old')
    const payload = {
      rendererId,
      ownerGeneration: baseInput.generation,
      requestId: 'request-1',
      pluginId: 'fixture',
      expectedRevision: 1,
      revision: 2,
      origin: true,
      operations: [{ op: 'set', path: ['label'], value: 'updated' }],
      value: { label: 'updated' },
    }
    const session = createManagerRendererGraphSession(baseInput)
    session.projectInitial([descriptor(lease)])
    expect(session.projectCommand(command('desktop-package-configuration', 1, payload)))
      .toEqual(command('desktop-package-configuration', 1, payload))
    session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
    session.close()
    for (
      const bad of [
        { ...payload, rendererId: '5'.repeat(64) },
        { ...payload, pluginId: 'other' },
        { ...payload, revision: 3 },
        { ...payload, origin: 'peer' },
        { ...payload, operations: [{ op: 'set', path: ['__proto__'], value: 'bad' }] },
        { ...payload, value: { label: forbidden[0] } },
      ]
    ) {
      const target = createManagerRendererGraphSession(baseInput)
      target.projectInitial([descriptor(lease)])
      expect(() => target.projectCommand(command('desktop-package-configuration', 1, bad)))
        .toThrow('MANAGER_RENDERER_GRAPH_INVALID')
      expect(target.closed).toBe(true)
    }
  } finally {
    await fixture.close()
  }
})

it('keeps initial graphs active through staging and rollback, without exposing owner secrets', async () => {
  const fixture = await managerRendererGraphFixture()
  const session = createManagerRendererGraphSession(baseInput)
  try {
    const previous = await fixture.lease('old')
    const candidate = await fixture.lease('new')
    const [initial] = session.projectInitial([descriptor(previous)])
    const result = session.projectCommand(command('stage', 1, stage('old', 'new', descriptor(candidate)))) as {
      payload: { graphs: Array<{ leaseId: string; entryUrl: string }> }
    }
    const graph = result.payload.graphs[0]!
    expect(graph.leaseId).not.toBe(candidate.leaseId)
    expect(JSON.stringify(result)).not.toContain(candidate.leaseId)
    expect(JSON.stringify(result)).not.toContain(candidate.baseUrl)
    expect(JSON.stringify(result)).not.toContain(new URL(candidate.baseUrl).pathname.split('/')[2]!)
    for (const item of forbidden) expect(JSON.stringify(result)).not.toContain(item)
    expect((await session.resolve({ method: 'GET', target: new URL(initial!.entryUrl).pathname })).status).toBe(200)
    expect((await session.resolve({ method: 'GET', target: new URL(graph.entryUrl).pathname })).status).toBe(200)
    session.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
    session.projectCommand(command('rollback', 2, { transactionId: 'transaction', expected: {} }))
    session.acknowledge({ id: 'f'.repeat(64), sequence: 2, ok: true })
    expect((await session.resolve({ method: 'GET', target: new URL(initial!.entryUrl).pathname })).status).toBe(200)
    expect((await session.resolve({ method: 'GET', target: new URL(graph.entryUrl).pathname })).status).toBe(404)
  } finally {
    session.close()
    await fixture.close()
  }
})

it('isolates the same owner lease between sessions and retires only the previous graph on confirmed finalize', async () => {
  const fixture = await managerRendererGraphFixture()
  const first = createManagerRendererGraphSession(baseInput)
  const second = createManagerRendererGraphSession({ ...baseInput, rendererId: '5'.repeat(64) })
  try {
    const previous = await fixture.lease('old')
    const candidate = await fixture.lease('new')
    const [initial] = first.projectInitial([descriptor(previous)])
    const [other] = second.projectInitial([descriptor(previous)])
    expect(initial!.leaseId).not.toBe(other!.leaseId)
    expect(initial!.baseUrl).not.toBe(other!.baseUrl)
    expect((await second.resolve({ method: 'GET', target: new URL(initial!.entryUrl).pathname })).status).toBe(404)
    const result = first.projectCommand(command('stage', 1, stage('old', 'new', descriptor(candidate)))) as {
      payload: { graphs: Array<{ entryUrl: string }> }
    }
    const next = result.payload.graphs[0]!
    first.acknowledge({ id: 'e'.repeat(64), sequence: 1, ok: true })
    first.projectCommand(command('finalize', 2, { transactionId: 'transaction' }))
    first.acknowledge({ id: 'f'.repeat(64), sequence: 2, ok: true })
    expect((await first.resolve({ method: 'GET', target: new URL(initial!.entryUrl).pathname })).status).toBe(404)
    expect((await first.resolve({ method: 'GET', target: new URL(next.entryUrl).pathname })).status).toBe(200)
    expect((await second.resolve({ method: 'GET', target: new URL(other!.entryUrl).pathname })).status).toBe(200)
    first.close()
    expect((await first.resolve({ method: 'GET', target: new URL(next.entryUrl).pathname })).status).toBe(404)
  } finally {
    first.close()
    second.close()
    await fixture.close()
  }
})

it('closes on off-host graphs, unexpected fields, or a leaked private value', async () => {
  const fixture = await managerRendererGraphFixture()
  try {
    const previous = await fixture.lease('old')
    const candidate = await fixture.lease('new')
    for (
      const bad of [
        { ...descriptor(previous), baseUrl: 'https://example.test/private/' },
        { ...descriptor(previous), extra: 'rejected' },
      ]
    ) {
      const target = createManagerRendererGraphSession(baseInput)
      expect(() => target.projectInitial([bad])).toThrow('MANAGER_RENDERER_GRAPH_INVALID')
      expect(target.closed).toBe(true)
    }
    const target = createManagerRendererGraphSession(baseInput)
    target.projectInitial([descriptor(previous)])
    const payload = { ...stage('old', 'new', descriptor(candidate)), package: { secret: candidate.baseUrl } }
    expect(() => target.projectCommand(command('stage', 1, payload))).toThrow('MANAGER_RENDERER_GRAPH_INVALID')
    expect(target.closed).toBe(true)
  } finally {
    await fixture.close()
  }
})

it('does not forward owner service or document capabilities before per-session projection exists', async () => {
  const fixture = await managerRendererGraphFixture()
  try {
    const previous = await fixture.lease('old')
    const candidate = await fixture.lease('new')
    for (const field of ['managedServiceUICapabilities', 'ownerDocumentBindings', 'developmentPackage']) {
      const target = createManagerRendererGraphSession(baseInput)
      target.projectInitial([descriptor(previous)])
      const payload = { ...stage('old', 'new', descriptor(candidate)), [field]: [{ token: 'private' }] }
      expect(() => target.projectCommand(command('stage', 1, payload))).toThrow('MANAGER_RENDERER_GRAPH_INVALID')
      expect(target.closed).toBe(true)
    }
  } finally {
    await fixture.close()
  }
})
