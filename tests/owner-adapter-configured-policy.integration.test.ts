import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { createOwnerAdapterPermissionPolicy } from '../packages/cli/src/cli/owner-adapter-permission-policy.js'
import { OwnerAdapterPermissionProof } from '../packages/cli/src/cli/owner-adapter-permission-proof.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it.skipIf(!archive)(
  'accepts an exact native review for the owner-configured Channel archive',
  async () => {
    const f = await fixture({ channelArchive: archive })
    const signal = new AbortController()
    const rendererId = 'a'.repeat(64)
    const keyId = 'b'.repeat(64)
    const proof = new OwnerAdapterPermissionProof({ profileId: f.profileId, generation: f.generation })
    const signer = await createStandalonePermissionSigner({
      rendererId,
      profileId: f.profileId,
      generation: f.generation,
    }, { crypto: webcrypto as unknown as Crypto, target: 'native' })
    try {
      const config = await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })
      const plugin = config.plugins.find(item => item.id === 'channel')!
      const identity = { id: 'channel', source: plugin.source! }
      const artifact = plugin.distributionArtifact!
      const moduleGeneration = 'native-graph-1'
      const context = { rendererId, signal: signal.signal, secret: 'fixture', current: () => true, live: () => true }
      const prepare = vi.fn(async () => {})
      const fence = { prepare, fence: vi.fn(), isCurrent: () => true, release: () => true }
      const barrier = {
        isCurrent: () => true,
        run: async (action: () => Promise<unknown>) => await action(),
        complete: async () => true,
        fence: vi.fn(),
      }
      const reserve = vi.fn(() => fence)
      const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
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
          bootstrap: { permissionAccess: { reserve: async () => barrier } } as never,
          consumers: { reserve } as never,
          fence: async () => fence as never,
        }),
      })
      expect(await handler({ kind: 'permission-key-register', keyId, key: signer.publicKey }, context)).toBe(true)
      const plan = buildDomPermissionAuthorizationPlanV3({
        planId: 'review-channel',
        profileId: f.profileId,
        identity: { pluginId: identity.id, source: identity.source },
        binding: { operationId: 'review-channel', runtimeGeneration: f.generation, moduleGeneration },
        declaration: {
          name: 'ui.extension-points.render',
          required: false,
          scope: { extensionPoints: ['manager.content'] },
        },
        policies: [],
      })
      const choice = new PermissionAuthorizationViewModel(plan)
      choice.select('ui.extension-points.render', 'allow-persistent')
      const selected = choice.confirm()
      if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 3) throw new Error('fixture failed')
      expect(signer.noteConfirmed(
        {
          identity,
          pointId: 'manager.content',
          profileId: f.profileId,
          runtimeGeneration: f.generation,
          moduleGeneration,
          artifact,
        },
        plan,
        selected.decision,
      )).toBe(true)
      const declaration = plan.declarations[0]!
      const record = {
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
        schemaVersion: 3,
        key: {
          profileId: f.profileId,
          identity: plan.identity,
          capability: declaration.capability,
          scope: declaration.scope,
          securityFingerprint: declaration.securityFingerprint,
        },
        policy: 'allow-persistent',
      }
      const signed = { keyId, proof: await signer.sign('persist-channel', [record]) }
      expect(
        await handler({
          kind: 'permission-policy-write',
          requestId: 'persist-channel',
          records: [record],
          proof: signed,
        }, context),
      ).toMatchObject([{ policy: 'allow-persistent' }])
      expect(reserve).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          kind: 'configured-channel',
          identity,
          moduleGeneration,
          artifact,
        }),
      )
      expect(prepare).toHaveBeenCalledOnce()
      expect((await loadHomeConfig(f.configPath)).permissions).toContainEqual(record)

      const oncePlan = buildDomPermissionAuthorizationPlanV3({
        planId: 'review-navigation',
        profileId: f.profileId,
        identity: plan.identity,
        binding: { operationId: 'review-navigation', runtimeGeneration: f.generation, moduleGeneration },
        declaration: {
          name: 'ui.extension-points.render',
          required: false,
          scope: { extensionPoints: ['manager.settings.navigation-items'] },
        },
        policies: [],
      })
      const once = new PermissionAuthorizationViewModel(oncePlan)
      once.select('ui.extension-points.render', 'allow-once')
      const onceChoice = once.confirm()
      if (onceChoice.status !== 'confirmed' || onceChoice.decision.schemaVersion !== 3) {
        throw new Error('fixture failed')
      }
      const onceSigned = await signer.signOnce(
        'once-channel',
        {
          identity,
          pointId: 'manager.settings.navigation-items',
          profileId: f.profileId,
          runtimeGeneration: f.generation,
          moduleGeneration,
          artifact,
        },
        oncePlan,
        onceChoice.decision,
      )
      expect(
        await handler({
          kind: 'permission-once',
          requestId: 'once-channel',
          record: onceSigned.record,
          decision: onceSigned.decision,
          proof: { keyId, proof: onceSigned.proof },
        }, context),
      ).toBe(true)
      expect((await loadHomeConfig(f.configPath)).permissions).toHaveLength(1)
      expect(await journal.recent([onceSigned.record])).toMatchObject([{
        entry: { client: 'codex', changes: [{ policy: 'allow-once' }] },
        committedAt: expect.any(String),
      }])
    } finally {
      signal.abort()
      signer.close()
      proof.close()
      await f.close()
    }
  },
)
