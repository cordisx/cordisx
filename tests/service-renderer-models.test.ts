import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  buildPermissionAuthorizationPlanV2,
  CapabilityRiskCatalog,
} from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { createServiceRendererModels } from '../packages/cli/src/cli/service-renderer-models.js'
import { createServiceRendererPermissionOnce } from '../packages/cli/src/cli/service-renderer-permission-once.js'
import { isServiceRendererOptionalModelManifest } from '../packages/cli/src/cli/service-renderer-optional-model-manifest.js'
import { ServiceRendererRuntimeGrants } from '../packages/cli/src/cli/service-renderer-runtime-grants.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'

it('admits only optional model access for the service-free model bridge', () => {
  const declaration = { name: 'models.read', required: false, scope: { providers: ['codex'] } }
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: 'demo',
    services: [],
    capabilities: [declaration],
  }
  expect(isServiceRendererOptionalModelManifest(manifest, 'demo')).toBe(true)
  expect(
    isServiceRendererOptionalModelManifest({ ...manifest, capabilities: [{ ...declaration, required: true }] }, 'demo'),
  ).toBe(false)
  expect(
    isServiceRendererOptionalModelManifest({
      ...manifest,
      capabilities: [declaration, { name: 'tasks.create', required: false, scope: {} }],
    }, 'demo'),
  ).toBe(false)
})

it('consumes a plugin-scoped one-time model grant and filters the owner catalog', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-web-models-'))
  const scope = { rendererId: 'a'.repeat(64), profileId: 'default', generation: 'owner-1' }
  const alias = `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}`
  const digest = `sha256:${'c'.repeat(64)}` as const
  const token = 'd'.repeat(64)
  const identity = { id: 'demo', source: alias }
  const ownerIdentity = { id: 'demo', source: 'https://example.test/plugin' }
  const artifact = { version: '1.0.0', integrity: digest }
  const declaration = { name: 'models.read' as const, required: false, scope: { providers: ['codex'] } }
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: 'demo',
    services: [],
    capabilities: [declaration],
  }
  const staged = {
    digest,
    artifactIntegrity: digest,
    identitySource: ownerIdentity.source,
    manifest: { id: 'demo', version: artifact.version, runtimeManifest: manifest },
  }
  const controller = new AbortController()
  const context = {
    rendererId: scope.rendererId,
    profileId: scope.profileId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const admitted = { ...context, admitted: true }
  const evidence = { identity, ownerIdentity, moduleGeneration: 'graph-1', digest, artifact }
  let snapshot: any[] = []
  const access = {
    evidence: () => evidence,
    isCurrentEvidence: () => !controller.signal.aborted,
    snapshot: () => structuredClone(snapshot),
    project: (records: any[]) =>
      records.map(record => ({ ...record, key: { ...record.key, identity: { pluginId: 'demo', source: alias } } })),
    resolve: (records: any[]) =>
      records.map(record => ({
        ...record,
        key: { ...record.key, identity: { pluginId: 'demo', source: ownerIdentity.source } },
      })),
  }
  const bootstrap = { permissionAccess: { ...access, runtimeOnceGrants: new ServiceRendererRuntimeGrants() } }
  const proof = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const journal = new PermissionDecisionJournal({ homeDir, profileId: scope.profileId })
  const loadPackage = (async () => staged) as never
  const once = createServiceRendererPermissionOnce({
    homeDir,
    profileId: scope.profileId,
    bootstrap: bootstrap as never,
    proof,
    journal,
    loadPackage,
  })
  const models = createServiceRendererModels({
    homeDir,
    profileId: scope.profileId,
    bootstrap: bootstrap as never,
    documents: {
      principal: (_context: unknown, value: string) => {
        if (value !== token) throw new Error('invalid token')
        return { identity, ownerIdentity, moduleGeneration: 'graph-1', isCurrent: () => !controller.signal.aborted }
      },
    } as never,
    catalog: async () => [
      { providerId: 'codex', pluginId: 'fixture', models: [{ id: 'model-a', label: 'Model A', aliases: [] }] },
      { providerId: 'other', pluginId: 'fixture', models: [{ id: 'model-b', label: 'Model B', aliases: [] }] },
    ],
    loadPackage,
  })
  const request = (requestId: string, authorizationRequestId: string, providerIds?: string[]) =>
    JSON.stringify({
      version: 1,
      requestId,
      token,
      authorizationRequestId,
      ...(providerIds === undefined ? {} : { providerIds }),
    })
  try {
    proof.register(context, signer.publicKey)
    const plan = buildPermissionAuthorizationPlanV2({
      planId: 'auth-1',
      operation: 'runtime',
      profileId: scope.profileId,
      identity: { pluginId: identity.id, source: identity.source },
      binding: {
        operationId: 'auth-1',
        requestId: 'auth-1',
        runtimeGeneration: scope.generation,
        moduleGeneration: 'graph-1',
      },
      declarations: [declaration],
      policies: [],
      contextFor: () => ({
        operation: 'runtime',
        providerKind: 'current-connection',
        providerTrust: 'configured',
        availability: 'supported',
      }),
    }, new CapabilityRiskCatalog())
    const view = new PermissionAuthorizationViewModel(plan)
    view.select('models.read', 'allow-once')
    const selected = view.confirm()
    if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 2) throw new Error('fixture failed')
    const signed = await signer.signWebRuntimeOnce('auth-1', artifact, plan, selected.decision)
    expect(
      await once.prepare(
        JSON.stringify({ requestId: 'auth-1', token: STANDALONE_PERMISSION_BINDING_MARKER, ...signed }),
        admitted,
      ).dispatch(),
    ).toMatchObject({ ok: true, value: true })
    expect(await models.prepare(request('list-1', 'auth-1'), admitted).dispatch()).toMatchObject({
      ok: true,
      value: { ok: true, value: { models: [{ ref: { providerId: 'codex', modelId: 'model-a' } }] } },
    })
    expect(await models.prepare(request('replay', 'auth-1'), admitted).dispatch()).toMatchObject({
      ok: true,
      value: { ok: false },
    })
    snapshot = [{
      ...signed.record,
      key: { ...signed.record.key, identity: { pluginId: 'demo', source: ownerIdentity.source } },
      policy: 'allow-persistent',
    }]
    expect(await models.prepare(request('persistent', 'other-id'), admitted).dispatch()).toMatchObject({
      ok: true,
      value: { ok: true, value: { models: [{ ref: { providerId: 'codex', modelId: 'model-a' } }] } },
    })
    expect(await models.prepare(request('out-of-scope', 'other-id', ['other']), admitted).dispatch()).toMatchObject({
      ok: true,
      value: { ok: false },
    })
    snapshot = [{ ...snapshot[0], policy: 'deny-persistent' }]
    expect(await models.prepare(request('denied', 'other-id'), admitted).dispatch()).toMatchObject({
      ok: true,
      value: { ok: false },
    })
  } finally {
    controller.abort()
    proof.close()
    signer.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})
