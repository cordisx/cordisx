import { webcrypto } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { createOwnerAdapterPermissionPolicy } from '../packages/cli/src/cli/owner-adapter-permission-policy.js'
import { OwnerAdapterPermissionProof } from '../packages/cli/src/cli/owner-adapter-permission-proof.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { ensureHomeConfig, loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'

it('writes a native user decision through the owner and records a separate one-time decision', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-native-permission-policy-'))
  const configPath = path.join(homeDir, 'config.json')
  await ensureHomeConfig(configPath)
  const profileId = 'default'
  const generation = 'owner-1'
  const rendererId = 'a'.repeat(64)
  const keyId = 'b'.repeat(64)
  const digest = `sha256:${'c'.repeat(64)}` as const
  const identity = { id: 'demo', source: 'file:///demo.js' }
  const artifact = { version: '1.0.0', integrity: digest }
  const active = {
    recordKind: 'active',
    profileId,
    runtimeGeneration: generation,
    plugins: [{
      id: identity.id,
      version: artifact.version,
      digest,
      moduleGeneration: 'module-1',
      enabled: true,
      dependencies: [],
    }],
  }
  const lifecycle = { snapshot: () => ({ active, registryEpoch: 1 }) }
  const context = { rendererId, signal: new AbortController().signal, current: () => true, live: () => true } as never
  const signer = await createStandalonePermissionSigner({ rendererId, profileId, generation }, {
    crypto: webcrypto as unknown as Crypto,
    target: 'native',
  })
  const proof = new OwnerAdapterPermissionProof({ profileId, generation })
  const journal = new PermissionDecisionJournal({ homeDir, profileId })
  const fence = { fence: vi.fn(), isCurrent: () => true, release: () => true }
  const barrier = {
    isCurrent: () => true,
    run: async (action: () => Promise<unknown>) => await action(),
    complete: async () => true,
    fence: vi.fn(),
  }
  const handler = createOwnerAdapterPermissionPolicy({
    homeDir,
    configPath,
    profileId,
    generation,
    lifecycle: lifecycle as never,
    loadPolicies: async () =>
      (await loadHomeConfig(configPath)).permissions.filter(record => record.key.profileId === profileId),
    journal,
    proof,
    loadPackage: async () =>
      ({
        digest,
        identitySource: identity.source,
        browserArtifact: {},
        manifest: { id: identity.id, version: artifact.version, dependencies: [] },
      }) as never,
    runtime: () => ({
      bootstrap: { permissionAccess: { reserve: async () => barrier } } as never,
      consumers: { reserve: () => fence } as never,
      fence: async () => fence as never,
    }),
  })
  const makePlan = (pointId: string) =>
    buildDomPermissionAuthorizationPlanV3({
      planId: `review-${pointId}`,
      profileId,
      identity: { pluginId: identity.id, source: identity.source },
      binding: { operationId: `review-${pointId}`, runtimeGeneration: generation, moduleGeneration: 'module-1' },
      declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [pointId] } },
      policies: [],
    })
  const review = (pointId: string) => ({
    identity,
    pointId,
    profileId,
    runtimeGeneration: generation,
    moduleGeneration: 'module-1',
    artifact,
  })
  try {
    expect(await handler({ kind: 'permission-key-register', keyId, key: signer.publicKey }, context)).toBe(true)
    const plan = makePlan('manager.content')
    const persistent = new PermissionAuthorizationViewModel(plan)
    persistent.select('ui.extension-points.render', 'allow-persistent')
    const selected = persistent.confirm()
    if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 3) throw new Error('fixture failed')
    expect(signer.noteConfirmed(review('manager.content'), plan, selected.decision)).toBe(true)
    const declaration = plan.declarations[0]!
    const record = {
      $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
      schemaVersion: 3,
      key: {
        profileId,
        identity: plan.identity,
        capability: declaration.capability,
        scope: declaration.scope,
        securityFingerprint: declaration.securityFingerprint,
      },
      policy: 'allow-persistent',
    }
    const signed = { keyId, proof: await signer.sign('persist-1', [record]) }
    expect(
      await handler(
        { kind: 'permission-policy-write', requestId: 'persist-1', records: [record], proof: signed },
        context,
      ),
    )
      .toMatchObject([{ policy: 'allow-persistent' }])
    expect((await loadHomeConfig(configPath)).permissions).toHaveLength(1)
    const oncePlan = makePlan('manager.settings.navigation-items')
    const once = new PermissionAuthorizationViewModel(oncePlan)
    once.select('ui.extension-points.render', 'allow-once')
    const choice = once.confirm()
    if (choice.status !== 'confirmed' || choice.decision.schemaVersion !== 3) throw new Error('fixture failed')
    const onceSigned = await signer.signOnce(
      'once-1',
      review('manager.settings.navigation-items'),
      oncePlan,
      choice.decision,
    )
    expect(
      await handler({
        kind: 'permission-once',
        requestId: 'once-1',
        record: onceSigned.record,
        decision: onceSigned.decision,
        proof: { keyId, proof: onceSigned.proof },
      }, context),
    ).toBe(true)
    expect((await loadHomeConfig(configPath)).permissions).toHaveLength(1)
    const events = await journal.recent([record as never, onceSigned.record])
    expect(events.flatMap(event => event.entry.changes.map(change => change.policy)).sort()).toEqual([
      'allow-once',
      'allow-persistent',
    ])
    expect(events.every(event => event.entry.client === 'codex' && event.committedAt)).toBe(true)
  } finally {
    signer.close()
    proof.close()
    await rm(homeDir, { recursive: true, force: true })
  }
})
