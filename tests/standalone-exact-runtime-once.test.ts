import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import {
  buildPermissionAuthorizationPlanV2,
  CapabilityRiskCatalog,
} from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { createServiceRendererPermissionOnce } from '../packages/cli/src/cli/service-renderer-permission-once.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V13 } from '../packages/cli/src/runtime-exact-request-permissions.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'

it('confirms only one exact Web runtime target against the owner manifest and current policy', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-web-exact-once-'))
  const scope = { rendererId: 'a'.repeat(64), profileId: 'default', generation: 'owner-1' }
  const alias = `https://renderer.cordisx.invalid/plugin/${'b'.repeat(64)}`
  const digest = `sha256:${'c'.repeat(64)}` as const
  const artifact = { version: '1.0.0', integrity: digest }
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V13,
    schemaVersion: 13,
    id: 'demo',
    services: [],
    capabilities: [{ name: 'tasks.create', required: false, scope: { runtime: 'exact-request' } }],
  }
  const controller = new AbortController()
  const context = {
    rendererId: scope.rendererId,
    profileId: scope.profileId,
    ownerGeneration: scope.generation,
    signal: controller.signal,
  }
  const evidence = {
    kind: 'installed',
    identity: { id: 'demo', source: alias },
    ownerIdentity: { id: 'demo', source: 'file:///private-demo.js' },
    moduleGeneration: 'graph-1',
    digest,
    artifact,
    policies: [],
    isCurrent: () => true,
  }
  let policies: any[] = []
  const access = {
    evidence: () => evidence,
    isCurrentEvidence: () => !controller.signal.aborted,
    snapshot: () => structuredClone(policies),
    resolve: vi.fn(() => {
      throw new Error('dynamic targets cannot use persistent resolution')
    }),
    project: vi.fn(() => {
      throw new Error('dynamic targets cannot use persistent projection')
    }),
  }
  const proof = new ManagerPermissionProofAuthority({
    profileId: scope.profileId,
    generation: scope.generation,
    isCurrent: () => true,
  })
  const signer = await createStandalonePermissionSigner(scope, { crypto: webcrypto as unknown as Crypto })
  const journal = new PermissionDecisionJournal({ homeDir, profileId: scope.profileId })
  const channel = createServiceRendererPermissionOnce({
    homeDir,
    profileId: scope.profileId,
    bootstrap: { permissionAccess: access } as never,
    proof,
    journal,
    loadPackage: (async () => ({
      digest,
      identitySource: evidence.ownerIdentity.source,
      artifactIntegrity: digest,
      manifest: { id: 'demo', version: artifact.version, runtimeManifest: manifest },
    })) as never,
  })
  const admitted = { ...context, admitted: true }
  const signed = async (requestId: string, providers: string[]) => {
    const plan = buildPermissionAuthorizationPlanV2({
      planId: 'exact-runtime',
      operation: 'runtime',
      profileId: scope.profileId,
      identity: { pluginId: 'demo', source: alias },
      binding: { operationId: requestId, requestId, runtimeGeneration: scope.generation, moduleGeneration: 'graph-1' },
      declarations: [{ name: 'tasks.create', required: false, scope: { providers, cwdRoots: ['/workspace'] } }],
      policies: [],
      contextFor: () => ({
        operation: 'runtime',
        providerKind: 'current-connection',
        providerTrust: 'configured',
        availability: 'supported',
      }),
    }, new CapabilityRiskCatalog())
    const view = new PermissionAuthorizationViewModel(plan)
    view.select('tasks.create', 'allow-once')
    const selected = view.confirm()
    if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 2) throw new Error('fixture failed')
    return await signer.signWebRuntimeOnce(requestId, artifact, plan, selected.decision)
  }
  const payload = (requestId: string, value: Awaited<ReturnType<typeof signed>>) =>
    JSON.stringify({
      requestId,
      token: STANDALONE_PERMISSION_BINDING_MARKER,
      ...value,
    })
  try {
    proof.register(context, signer.publicKey)
    const broad = await signed('broad', ['codex', 'other'])
    await expect(channel.prepare(payload('broad', broad), admitted).dispatch()).rejects.toThrow()
    const valid = await signed('valid', ['codex'])
    policies = [{
      ...valid.record,
      key: { ...valid.record.key, identity: { pluginId: 'demo', source: evidence.ownerIdentity.source } },
      policy: 'deny-persistent',
    }]
    await expect(channel.prepare(payload('valid', valid), admitted).dispatch()).rejects.toThrow()
    policies = []
    expect(await channel.prepare(payload('valid', valid), admitted).dispatch()).toEqual({
      requestId: 'valid',
      ok: true,
      value: true,
    })
    await expect(channel.prepare(payload('valid', valid), admitted).dispatch()).rejects.toThrow()
    expect(await journal.recentRuntime(evidence.ownerIdentity)).toMatchObject([{
      client: 'web',
      decisions: [{ capability: 'tasks.create', decision: 'allow-once' }],
    }])
    expect(JSON.stringify(await journal.recentRuntime(evidence.ownerIdentity))).not.toContain('/workspace')
    expect(access.resolve).not.toHaveBeenCalled()
    expect(access.project).not.toHaveBeenCalled()
  } finally {
    controller.abort()
    signer.close()
    proof.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})
