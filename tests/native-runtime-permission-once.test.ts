import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  buildPermissionAuthorizationPlanV2,
  CapabilityRiskCatalog,
} from '../packages/cli/src/capability-risk-catalog.js'
import { createOwnerAdapterPermissionPolicy } from '../packages/cli/src/cli/owner-adapter-permission-policy.js'
import { OwnerAdapterPermissionProof } from '../packages/cli/src/cli/owner-adapter-permission-proof.js'
import { createOwnerAdapterPermissionHistory } from '../packages/cli/src/cli/owner-adapter-permission-history.js'
import { withDeclaredRuntimeAskPolicies } from '../packages/cli/src/cli/permission-decision-history.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 } from '../packages/cli/src/launcher/latest-runtime-manifest.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 } from '../packages/cli/src/runtime-exact-request-permissions.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { nativePermissionPrompt } from '../packages/cli/src/renderer/native-permission-prompt.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { manifestDeclarationsV2 } from '../packages/cli/src/renderer/platform/platform-permission-types.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

it('requires the service to authorize an exact native runtime decision before use', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-native-runtime-once-'))
  const profileId = 'default'
  const generation = 'owner-1'
  const moduleGeneration = 'module-1'
  const rendererId = 'a'.repeat(64)
  const keyId = 'b'.repeat(64)
  const digest = `sha256:${'c'.repeat(64)}` as const
  const identity = { id: 'demo', source: 'file:///demo.js' }
  const declaration = { name: 'models.read' as const, required: false, scope: { providers: ['codex'] } }
  const catalog = new CapabilityRiskCatalog()
  const plan = buildPermissionAuthorizationPlanV2({
    planId: 'runtime-1',
    operation: 'runtime',
    profileId,
    identity: { pluginId: identity.id, source: identity.source },
    binding: { operationId: 'runtime-1', runtimeGeneration: generation, moduleGeneration, requestId: 'runtime-1' },
    declarations: [declaration],
    policies: [],
    contextFor: () => ({
      operation: 'runtime',
      providerKind: 'current-connection',
      providerTrust: 'configured',
      availability: 'supported',
    }),
  }, catalog)
  const declared14 = withDeclaredRuntimeAskPolicies([], profileId, identity, {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
    schemaVersion: 14,
    id: identity.id,
    services: [],
    capabilities: [declaration],
  })
  expect(declared14[0]?.key).toMatchObject({ capability: 'models.read', scope: declaration.scope })
  const view = new PermissionAuthorizationViewModel(plan)
  view.select('models.read', 'allow-once')
  const selected = view.confirm()
  if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 2) throw new Error('fixture failed')
  const signal = new AbortController()
  const context = { rendererId, signal: signal.signal, current: () => true, live: () => true } as never
  const signer = await createStandalonePermissionSigner({ rendererId, profileId, generation }, {
    crypto: webcrypto as unknown as Crypto,
    target: 'native',
  })
  const proof = new OwnerAdapterPermissionProof({ profileId, generation })
  const journal = new PermissionDecisionJournal({ homeDir, profileId })
  const active = {
    recordKind: 'active',
    profileId,
    runtimeGeneration: generation,
    plugins: [{ id: identity.id, version: '1.0.0', digest, moduleGeneration, enabled: true, dependencies: [] }],
  }
  const handler = createOwnerAdapterPermissionPolicy({
    homeDir,
    configPath: path.join(homeDir, 'config.json'),
    profileId,
    generation,
    lifecycle: { snapshot: () => ({ active, registryEpoch: 1 }) } as never,
    loadPolicies: async () => [],
    journal,
    proof,
    loadPackage: async () =>
      ({
        digest,
        identitySource: identity.source,
        browserArtifact: {},
        manifest: {
          id: identity.id,
          version: '1.0.0',
          dependencies: [],
          runtimeManifest: {
            $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
            schemaVersion: 4,
            id: identity.id,
            services: [],
            capabilities: [declaration],
          },
        },
      }) as never,
    runtime: () => ({ bootstrap: {} as never, consumers: {} as never, fence: async () => ({} as never) }),
  })
  try {
    await handler({ kind: 'permission-key-register', keyId, key: signer.publicKey }, context)
    const signed = await signer.signRuntimeOnce('request-1', plan, selected.decision)
    const request = {
      kind: 'permission-once',
      requestId: 'request-1',
      record: signed.record,
      decision: signed.decision,
      proof: { keyId, proof: signed.proof },
    }
    await expect(
      handler({ ...request, record: { ...request.record, key: { ...request.record.key, scope: {} } } }, context),
    )
      .rejects.toThrow()
    expect(await handler(request, context)).toBe(true)
    await expect(handler(request, context)).rejects.toThrow()
    expect(await journal.recent([signed.record])).toMatchObject([{
      entry: { client: 'codex', changes: [{ capability: 'models.read', policy: 'allow-once' }] },
      committedAt: expect.any(String),
    }])
    const history = createOwnerAdapterPermissionHistory({
      profileId,
      journal,
      loadPolicies: async () => [],
      reviewIdentity: async () => ({
        identity,
        manifest: {
          $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
          schemaVersion: 4,
          id: identity.id,
          services: [],
          capabilities: [declaration],
        },
        isCurrent: () => true,
      }),
    })
    expect(await history({ kind: 'permission-history', pluginId: identity.id }, context)).toContainEqual({
      record: signed.record,
      decision: 'allow-once',
      client: 'codex',
      requestedAt: expect.any(String),
      committedAt: expect.any(String),
    })
    expect(await history({ kind: 'plugin-authorization-history', pluginId: identity.id }, context)).toContainEqual({
      operation: 'runtime',
      client: 'codex',
      decisions: [{ capability: 'models.read', decision: 'allow-once' }],
      requestedAt: expect.any(String),
      committedAt: expect.any(String),
    })
    const ordinary = { request: vi.fn(async () => selected.decision) }
    const prompt = nativePermissionPrompt(ordinary as never, { dispose() {} } as never)
    expect(await prompt.request(plan, { ...identity, id: 'other' })).toBeUndefined()
    expect(ordinary.request).not.toHaveBeenCalled()
    expect(await prompt.request(plan, identity)).toBeUndefined()
    expect(await prompt.request(plan, identity, { ownerReviewEligible: false })).toEqual(selected.decision)
    expect(prompt.bindRuntimeDecision(async (currentPlan, decision) => {
      const second = await signer.signRuntimeOnce('request-2', currentPlan, decision)
      return await handler({
        kind: 'permission-once',
        requestId: 'request-2',
        record: second.record,
        decision: second.decision,
        proof: { keyId, proof: second.proof },
      }, context) === true
    })).toBe(true)
    expect(await prompt.request(plan, identity)).toEqual(selected.decision)
    expect(prompt.bindRuntimeDecision(async () => true)).toBe(false)
    prompt.dispose?.()
  } finally {
    signal.abort()
    proof.close()
    signer.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it('records an exact runtime target without exposing its scope or changing older journal entries', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-exact-runtime-once-'))
  const profileId = 'default', generation = 'owner-1', moduleGeneration = 'module-1'
  const rendererId = '1'.repeat(64), keyId = '2'.repeat(64), digest = `sha256:${'3'.repeat(64)}` as const
  const identity = { id: 'exact-demo', source: 'file:///private-fixture.js' }
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
    schemaVersion: 13,
    id: identity.id,
    services: [],
    capabilities: [{ name: 'tasks.create', required: false, scope: { runtime: 'exact-request' } }],
  }
  const catalog = new CapabilityRiskCatalog()
  const makePlan = (providers: string[]) =>
    buildPermissionAuthorizationPlanV2({
      planId: 'runtime-exact',
      operation: 'runtime',
      profileId,
      identity: { pluginId: identity.id, source: identity.source },
      binding: { operationId: 'runtime-exact', runtimeGeneration: generation, moduleGeneration },
      declarations: [{ name: 'tasks.create', required: false, scope: { providers, cwdRoots: ['/private/workspace'] } }],
      policies: [],
      contextFor: () => ({
        operation: 'runtime',
        providerKind: 'current-connection',
        providerTrust: 'configured',
        availability: 'supported',
      }),
    }, catalog)
  const signer = await createStandalonePermissionSigner({ rendererId, profileId, generation }, {
    crypto: webcrypto as unknown as Crypto,
    target: 'native',
  })
  const proof = new OwnerAdapterPermissionProof({ profileId, generation })
  const signal = new AbortController()
  const context = { rendererId, signal: signal.signal, current: () => true, live: () => true } as never
  const journal = new PermissionDecisionJournal({ homeDir, profileId })
  const active = {
    recordKind: 'active',
    profileId,
    runtimeGeneration: generation,
    plugins: [{ id: identity.id, version: '1.0.0', digest, moduleGeneration, enabled: true, dependencies: [] }],
  }
  const handler = createOwnerAdapterPermissionPolicy({
    homeDir,
    configPath: path.join(homeDir, 'config.json'),
    profileId,
    generation,
    lifecycle: { snapshot: () => ({ active, registryEpoch: 1 }) } as never,
    loadPolicies: async () => [],
    journal,
    proof,
    loadPackage: async () =>
      ({
        digest,
        identitySource: identity.source,
        browserArtifact: {},
        manifest: { id: identity.id, version: '1.0.0', dependencies: [], runtimeManifest: manifest },
      }) as never,
    runtime: () => ({ bootstrap: {} as never, consumers: {} as never, fence: async () => ({} as never) }),
  })
  const signed = async (requestId: string, providers: string[]) => {
    const plan = makePlan(providers)
    const view = new PermissionAuthorizationViewModel(plan)
    view.select('tasks.create', 'allow-once')
    const selected = view.confirm()
    if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 2) throw new Error('fixture failed')
    return await signer.signRuntimeOnce(requestId, plan, selected.decision)
  }
  try {
    await handler({ kind: 'permission-key-register', keyId, key: signer.publicKey }, context)
    const broad = await signed('broad-request', ['codex', 'other'])
    await expect(handler({
      kind: 'permission-once',
      requestId: 'broad-request',
      record: broad.record,
      decision: broad.decision,
      proof: { keyId, proof: broad.proof },
    }, context)).rejects.toThrow()
    const valid = await signed('exact-request', ['codex'])
    expect(
      await handler({
        kind: 'permission-once',
        requestId: 'exact-request',
        record: valid.record,
        decision: valid.decision,
        proof: { keyId, proof: valid.proof },
      }, context),
    ).toBe(true)
    expect(await journal.recent([valid.record])).toHaveLength(1)
    const history = await journal.recentRuntime(identity)
    expect(history).toMatchObject([{
      operation: 'runtime',
      client: 'codex',
      decisions: [{ capability: 'tasks.create', decision: 'allow-once' }],
      committedAt: expect.any(String),
    }])
    expect(JSON.stringify(history)).not.toContain('/private/')
    expect(await journal.recentRuntime({ ...identity, source: 'file:///other.js' })).toEqual([])
    const prompt = nativePermissionPrompt({
      request: async currentPlan => {
        const view = new PermissionAuthorizationViewModel(currentPlan)
        view.select('tasks.create', 'allow-once')
        const result = view.confirm()
        return result.status === 'confirmed' && result.decision.schemaVersion === 2 ? result.decision : undefined
      },
    }, { dispose() {} } as never)
    expect(prompt.bindRuntimeDecision(async (plan, decision) => {
      const result = await signer.signRuntimeOnce('broker-request', plan, decision)
      return await handler({
        kind: 'permission-once',
        requestId: 'broker-request',
        record: result.record,
        decision: result.decision,
        proof: { keyId, proof: result.proof },
      }, context) === true
    })).toBe(true)
    const broker = new PermissionBroker(
      new MemoryPermissionPolicyStore(),
      { request: async () => 'deny' },
      () => new Date(),
      30_000,
      profileId,
      generation,
      undefined,
      undefined,
      prompt,
    )
    try {
      broker.register(
        identity,
        normalizePluginManifest(manifest, identity.id),
        { pluginId: identity.id, moduleGeneration },
        undefined,
        { version: '1.0.0', integrity: digest },
      )
      await expect(broker.authorize(identity, 'tasks.create', {
        providerId: 'codex',
        model: { providerId: 'codex', modelId: 'fixture' },
        cwd: '/private/workspace',
      })).resolves.toMatchObject({ ok: true })
      expect(await journal.recentRuntime(identity)).toHaveLength(2)
    } finally {
      broker.dispose()
    }
  } finally {
    signal.abort()
    proof.close()
    signer.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})

it.skipIf(!archive)('attributes a declared runtime choice for the exact configured Channel archive', async () => {
  const f = await fixture({ channelArchive: archive })
  const signal = new AbortController()
  const rendererId = 'd'.repeat(64)
  const keyId = 'e'.repeat(64)
  const context = { rendererId, signal: signal.signal, secret: 'fixture', current: () => true, live: () => true }
  const signer = await createStandalonePermissionSigner({
    rendererId,
    profileId: f.profileId,
    generation: f.generation,
  }, { crypto: webcrypto as unknown as Crypto, target: 'native' })
  const proof = new OwnerAdapterPermissionProof({ profileId: f.profileId, generation: f.generation })
  try {
    const config = await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })
    const plugin = config.plugins.find(item => item.id === 'channel')!
    const declaration = manifestDeclarationsV2(plugin.manifest as Parameters<typeof manifestDeclarationsV2>[0])[0]!
    const catalog = new CapabilityRiskCatalog()
    const plan = buildPermissionAuthorizationPlanV2({
      planId: 'runtime-channel',
      operation: 'runtime',
      profileId: f.profileId,
      identity: { pluginId: plugin.id, source: plugin.source! },
      binding: { operationId: 'runtime-channel', runtimeGeneration: f.generation, moduleGeneration: 'native-graph-1' },
      declarations: [declaration],
      policies: [],
      contextFor: item => ({
        operation: 'runtime',
        providerKind: catalog.get(item.name).providerFamily === 'platform' ? 'current-connection' : 'host-local',
        providerTrust: 'configured',
        availability: 'supported',
      }),
    }, catalog)
    const view = new PermissionAuthorizationViewModel(plan)
    view.select(declaration.name, 'allow-once')
    const selected = view.confirm()
    if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 2) throw new Error('fixture failed')
    const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
    let peerGeneration = 'wrong-graph'
    const release = vi.fn(() => true)
    const handler = createOwnerAdapterPermissionPolicy({
      homeDir: f.homeDir,
      configPath: f.configPath,
      profileId: f.profileId,
      generation: f.generation,
      lifecycle: f.lifecycle,
      loadPolicies: async () =>
        (await loadHomeConfig(f.configPath)).permissions.filter(record => record.key.profileId === f.profileId),
      journal,
      proof,
      configured: () => ({ config, signal: signal.signal }),
      runtime: () => ({
        bootstrap: {} as never,
        consumers: {} as never,
        fence: async () => ({
          rendererId,
          isCurrent: () => true,
          release,
          fence: () => {},
          additionalPeers: [{
            identity: { rendererId },
            closed: false,
            request: async () => ({
              available: true,
              rendererId,
              ownerGeneration: f.generation,
              snapshot: f.lifecycle.snapshot(),
              identity: { id: plugin.id, source: plugin.source },
              artifact: plugin.distributionArtifact,
              moduleGeneration: peerGeneration,
            }),
          }],
        } as never),
      }),
    })
    await handler({ kind: 'permission-key-register', keyId, key: signer.publicKey }, context)
    const rejected = await signer.signRuntimeOnce('request-stale', plan, selected.decision)
    await expect(handler({
      kind: 'permission-once',
      requestId: 'request-stale',
      record: rejected.record,
      decision: rejected.decision,
      proof: { keyId, proof: rejected.proof },
    }, context)).rejects.toThrow()
    expect(release).toHaveBeenCalledTimes(1)
    peerGeneration = 'native-graph-1'
    const signed = await signer.signRuntimeOnce('request-channel', plan, selected.decision)
    expect(
      await handler({
        kind: 'permission-once',
        requestId: 'request-channel',
        record: signed.record,
        decision: signed.decision,
        proof: { keyId, proof: signed.proof },
      }, context),
    ).toBe(true)
    expect(release).toHaveBeenCalledTimes(2)
    expect(await journal.recent([signed.record])).toMatchObject([{
      entry: { client: 'codex', changes: [{ capability: declaration.name, policy: 'allow-once' }] },
      committedAt: expect.any(String),
    }])
  } finally {
    signal.abort()
    proof.close()
    signer.close()
    await f.close()
  }
})
