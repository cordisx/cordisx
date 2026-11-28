import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { fenceAdapterOrigin } from '../packages/cli/src/cli/manager-origin-fence.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { createOwnerAdapterPermissionPolicy } from '../packages/cli/src/cli/owner-adapter-permission-policy.js'
import { OwnerAdapterPermissionProof } from '../packages/cli/src/cli/owner-adapter-permission-proof.js'
import { OwnerAdapterSessions } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { ServiceOwnerPermissionConsumers } from '../packages/cli/src/cli/service-owner-permission-consumers.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { attachmentHomeDigest } from '../packages/cli/src/launcher/renderer-lifecycle-peer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V4 } from '../packages/cli/src/permission-contracts.js'
import { BindingPermissionPolicyStore } from '../packages/cli/src/renderer/permission-binding.js'
import { verifyOwnerPolicyPacket } from '../packages/cli/src/renderer/owner-policy-verification.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux').each(['dom', 'runtime'] as const)(
  'synchronizes a configured native %s review to a Web peer through the service owner',
  async kind => {
    let f!: Awaited<ReturnType<typeof fixture>>
    const authority = new ManagerPermissionProofAuthority({
      profileId: 'default',
      generation: 'fixture-owner',
      isCurrent: context => f.participants.peer(context.rendererId) !== undefined,
    })
    f = await fixture({
      channelArchive: archive,
      protectProfileInputs: true,
      channelPermissionPolicy: true,
      permissionProof: authority,
    })
    const webSigner = await createStandalonePermissionSigner({
      rendererId: f.handle.rendererId,
      profileId: f.profileId,
      generation: f.generation,
    }, { crypto: webcrypto as unknown as Crypto })
    let native: OwnerAdapterSessions | undefined
    let nativeSigner: Awaited<ReturnType<typeof createStandalonePermissionSigner>> | undefined
    let proof: OwnerAdapterPermissionProof | undefined
    let store: BindingPermissionPolicyStore | undefined
    let nativeBroker: PermissionBroker | undefined
    let webBroker: PermissionBroker | undefined
    try {
      const alias = await bootConfiguredChannelManager(f, f.invocation, undefined, undefined, webSigner.publicKey)
      const graph = await f.sessions.call(f.invocation, 'manager-bootstrap', { action: 'prepare' }) as any
      const webGeneration = graph.value.privateGraphs[0].moduleGeneration as string
      const configured = await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })
      const plugin = configured.plugins.find(item => item.id === 'channel')!
      const identity = { id: 'channel', source: plugin.source! }
      const artifact = plugin.distributionArtifact!
      const nativeGeneration = 'native-graph-1'
      const pointId = 'manager.content'
      const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
      proof = new OwnerAdapterPermissionProof({ profileId: f.profileId, generation: f.generation })
      const loadPolicies = async () =>
        (await loadHomeConfig(f.configPath)).permissions.filter(record => record.key.profileId === f.profileId)
      let handler!: ReturnType<typeof createOwnerAdapterPermissionPolicy>
      native = new OwnerAdapterSessions({
        scope: {
          homeDigest: attachmentHomeDigest(f.homeDir),
          ownerAppId: 'codex',
          profileId: f.profileId,
          generation: f.generation,
        },
        adapter: { appId: 'codex', adapterId: 'codex-desktop' },
        snapshot: () => f.lifecycle.snapshot(),
        attach: async peer => await f.lifecycle.attach(peer),
        acquirePermissionFence: async () => await f.bootstrap.permissionAccess.acquireAdapterPermissionFence(),
        ownerCurrent: () => true,
        identify: async () => 'alive',
        management: async (value, context) => await handler(value, context),
      })
      const consumers = new ServiceOwnerPermissionConsumers({
        profileId: f.profileId,
        generation: f.generation,
        participants: f.participants,
        lifecycle: f.lifecycle,
        nativeAdapters: native,
        ownerCurrent: () => true,
        loadPolicies,
      })
      handler = createOwnerAdapterPermissionPolicy({
        homeDir: f.homeDir,
        configPath: f.configPath,
        profileId: f.profileId,
        generation: f.generation,
        lifecycle: f.lifecycle,
        loadPolicies,
        journal,
        proof,
        configured: () => ({ config: configured, signal: new AbortController().signal }),
        runtime: () => ({
          bootstrap: f.bootstrap,
          consumers,
          fence: async rendererId =>
            await fenceAdapterOrigin({
              sessions: f.sessions,
              participants: f.participants,
              lifecycle: f.lifecycle,
              originRendererId: rendererId,
              reserveAdditionalPeers: async () => await native!.reserveForLifecycle(),
            }),
        }),
      })
      const opened = (await native.open({ pid: 123, processStartedAt: 'fixture' }))!
      const admitting = native.admit(opened.sessionId, opened.grant)
      const sync = (await native.poll(opened.sessionId, opened.grant, 3_000))!.command!
      expect(sync.method).toBe('synchronize')
      expect(
        await native.acknowledge(opened.sessionId, opened.grant, {
          id: sync.id,
          sequence: sync.sequence,
          ok: true,
          value: sync.payload,
        }),
      ).toBe(true)
      expect(await admitting).toBe(true)
      nativeSigner = await createStandalonePermissionSigner({
        rendererId: opened.rendererId,
        profileId: f.profileId,
        generation: f.generation,
      }, { crypto: webcrypto as unknown as Crypto, target: 'native' })
      const keyId = 'a'.repeat(64)
      expect(
        await native.requestManagement(opened.sessionId, opened.grant, {
          kind: 'permission-key-register',
          keyId,
          key: nativeSigner.publicKey,
        }),
      ).toMatchObject({ available: true, value: true })
      if (kind === 'dom') {
        const plan = buildDomPermissionAuthorizationPlanV3({
          planId: 'native-review',
          profileId: f.profileId,
          identity: { pluginId: identity.id, source: identity.source },
          binding: {
            operationId: 'native-review',
            runtimeGeneration: f.generation,
            moduleGeneration: nativeGeneration,
          },
          declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [pointId] } },
          policies: [],
        })
        const choice = new PermissionAuthorizationViewModel(plan)
        choice.select('ui.extension-points.render', 'allow-persistent')
        const selected = choice.confirm()
        if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 3) throw new Error('fixture failed')
        expect(nativeSigner.noteConfirmed(
          {
            identity,
            pointId,
            profileId: f.profileId,
            runtimeGeneration: f.generation,
            moduleGeneration: nativeGeneration,
            artifact,
          },
          plan,
          selected.decision,
        )).toBe(true)
      }
      const unknown = vi.fn()
      globalThis.__cordisxPermissionPolicyRequestV1 = payload => {
        const request = JSON.parse(payload) as { requestId: string; records: unknown; proof: unknown }
        void native!.requestManagement(opened.sessionId, opened.grant, {
          kind: 'permission-policy-write',
          requestId: request.requestId,
          records: request.records,
          proof: request.proof,
        }).then(result => {
          globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify({
            requestId: request.requestId,
            ok: result.available,
            value: result.available ? result.value : undefined,
          }))
        })
      }
      store = BindingPermissionPolicyStore.connect(STANDALONE_PERMISSION_BINDING_MARKER, [], {
        onUnknown: unknown,
        sign: async (requestId, records) => ({ keyId, proof: await nativeSigner!.sign(requestId, records) }),
      })
      const manifest = normalizePluginManifest(
        kind === 'runtime' ? plugin.manifest : {
          $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
          schemaVersion: 4,
          id: identity.id,
          capabilities: [],
          services: [],
        },
        identity.id,
      )
      nativeBroker = new PermissionBroker(
        store,
        { request: async () => 'deny' },
        () => new Date(),
        30_000,
        f.profileId,
        f.generation,
      )
      nativeBroker.register(identity, manifest, { pluginId: identity.id, moduleGeneration: nativeGeneration })
      webBroker = new PermissionBroker(
        new MemoryPermissionPolicyStore(),
        { request: async () => 'deny' },
        () => new Date(),
        30_000,
        f.profileId,
        f.generation,
      )
      webBroker.register({ id: identity.id, source: alias }, manifest, {
        pluginId: identity.id,
        moduleGeneration: webGeneration,
      })
      if (kind === 'runtime') {
        const decision = nativeBroker.reviewPolicyV2(identity, 'channel.events.receive', 'allow-persistent')
        expect(nativeSigner.noteRuntimePolicy(
          {
            identity,
            profileId: f.profileId,
            runtimeGeneration: f.generation,
            moduleGeneration: nativeGeneration,
            artifact,
          },
          decision.record,
          decision.observed,
        )).toBeTypeOf('function')
      }
      const saving = kind === 'dom'
        ? nativeBroker.setDomPolicy(identity, pointId, 'allow-persistent')
        : nativeBroker.setPolicyV2(identity, 'channel.events.receive', 'allow-persistent')
      const provenance = (await native.poll(opened.sessionId, opened.grant, 5_000))!.command!
      expect(provenance.method).toBe('permission-provenance')
      expect(
        await native.acknowledge(opened.sessionId, opened.grant, {
          id: provenance.id,
          sequence: provenance.sequence,
          ok: true,
          value: {
            available: true,
            rendererId: opened.rendererId,
            ownerGeneration: f.generation,
            snapshot: f.lifecycle.snapshot(),
            identity,
            artifact,
            moduleGeneration: nativeGeneration,
          },
        }),
      ).toBe(true)
      const nativeCommand = (await native.poll(opened.sessionId, opened.grant, 5_000))!.command!
      const transition = await verifyOwnerPolicyPacket(nativeCommand.payload, {
        profileId: f.profileId,
        generation: f.generation,
        rendererId: opened.rendererId,
        key: opened.policyPublicKey,
      })
      expect(transition).toMatchObject({ origin: true, identity, moduleGeneration: nativeGeneration })
      expect(
        await (kind === 'dom'
          ? nativeBroker.adoptOwnerManagerPolicies({ ...transition!, onUnknown: unknown })
          : nativeBroker.adoptOwnerRuntimePolicies({ ...transition!, onUnknown: unknown })),
      ).toBe(true)
      const webPoll = f.sessions.poll(f.invocation, 5_000)
      expect(
        await native.acknowledge(opened.sessionId, opened.grant, {
          id: nativeCommand.id,
          sequence: nativeCommand.sequence,
          ok: true,
          value: {
            rendererId: opened.rendererId,
            ownerGeneration: f.generation,
            handoffId: transition!.handoffId,
            requestId: transition!.requestId,
            moduleGeneration: nativeGeneration,
            adopted: true,
          },
        }),
      ).toBe(true)
      const webCommand = (await webPoll as any).value.command
      expect(webCommand.method).toBe('permission-policy')
      expect(
        await (kind === 'dom'
          ? webBroker.adoptStandaloneDomPolicies(webCommand.payload)
          : webBroker.adoptOwnerRuntimePolicies(webCommand.payload)),
      ).toBe(true)
      expect(
        await f.sessions.acknowledge(f.invocation, {
          id: webCommand.id,
          sequence: webCommand.sequence,
          ok: true,
          value: {
            rendererId: f.handle.rendererId,
            ownerGeneration: f.generation,
            handoffId: webCommand.payload.handoffId,
            requestId: webCommand.payload.requestId,
            moduleGeneration: webGeneration,
            adopted: true,
          },
        }),
      ).toEqual({ status: 'ok', value: { accepted: true } })
      await saving
      if (kind === 'dom') {
        expect(nativeBroker.domPolicy(identity, pointId)).toBe('allow')
        expect(webBroker.domPolicy({ id: identity.id, source: alias }, pointId)).toBe('allow')
      } else {
        expect(nativeBroker.policyV2(identity, 'channel.events.receive')).toBe('allow-persistent')
        expect(webBroker.policyV2({ id: identity.id, source: alias }, 'channel.events.receive')).toBe(
          'allow-persistent',
        )
      }
      const persisted = await loadPolicies()
      expect(persisted).toHaveLength(1)
      expect(await journal.recent(persisted)).toMatchObject([{
        entry: { client: 'codex', changes: [{ policy: 'allow-persistent' }] },
        committedAt: expect.any(String),
      }])
      expect(unknown).not.toHaveBeenCalled()
      consumers.close()
    } finally {
      delete globalThis.__cordisxPermissionPolicyRequestV1
      store?.dispose()
      nativeBroker?.dispose()
      webBroker?.dispose()
      nativeSigner?.close()
      webSigner.close()
      proof?.close()
      native?.close()
      authority.close()
      await f.close()
    }
  },
)
