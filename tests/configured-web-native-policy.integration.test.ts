import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { buildDomPermissionAuthorizationPlanV3 } from '../packages/cli/src/capability-risk-catalog.js'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { OwnerAdapterSessions } from '../packages/cli/src/cli/owner-adapter-sessions.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { createServiceRendererPermissionChannel } from '../packages/cli/src/cli/service-renderer-permission-channel.js'
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
  'synchronizes a configured Web %s review to a native peer through the service owner',
  async kind => {
    let f!: Awaited<ReturnType<typeof fixture>>
    let channel!: ReturnType<typeof createServiceRendererPermissionChannel>
    const proof = new ManagerPermissionProofAuthority({
      profileId: 'default',
      generation: 'fixture-owner',
      isCurrent: context => f.participants.peer(context.rendererId) !== undefined,
    })
    f = await fixture({
      channelArchive: archive,
      protectProfileInputs: true,
      channelPermissionPolicy: true,
      permissionProof: proof,
      writeDispatch: async (context, payload) => await channel.prepare(payload, context).dispatch(),
    })
    const signer = await createStandalonePermissionSigner({
      rendererId: f.handle.rendererId,
      profileId: f.profileId,
      generation: f.generation,
    }, { crypto: webcrypto as unknown as Crypto })
    let native: OwnerAdapterSessions | undefined
    let store: BindingPermissionPolicyStore | undefined
    let nativeBroker: PermissionBroker | undefined
    let webBroker: PermissionBroker | undefined
    try {
      const alias = await bootConfiguredChannelManager(f, f.invocation, undefined, undefined, signer.publicKey)
      const graph = await f.sessions.call(f.invocation, 'manager-bootstrap', { action: 'prepare' }) as any
      const webGeneration = graph.value.privateGraphs[0].moduleGeneration as string
      const configured = await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })
      const plugin = configured.plugins.find(item => item.id === 'channel')!
      const ownerIdentity = { id: 'channel', source: plugin.source! }
      const webIdentity = { id: 'channel', source: alias }
      const artifact = plugin.distributionArtifact!
      const nativeGeneration = 'native-graph-2'
      const pointId = 'manager.content'
      const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
      const loadPolicies = async () =>
        (await loadHomeConfig(f.configPath)).permissions.filter(record => record.key.profileId === f.profileId)
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
      channel = createServiceRendererPermissionChannel({
        profileId: f.profileId,
        configPath: f.configPath,
        bootstrap: f.bootstrap,
        proof,
        participants: f.participants,
        lifecycle: f.lifecycle,
        sessions: () => f.sessions,
        decisionJournal: journal,
        reserveAdditionalPeers: async () => await native!.reserveForLifecycle(),
        reserveOtherConsumers: async (origin, evidence) => {
          const reservation = consumers.reserve(origin, {
            identity: evidence.ownerIdentity,
            moduleGeneration: evidence.moduleGeneration,
            kind: evidence.kind,
            artifact: evidence.artifact,
            isCurrent: () => f.bootstrap.permissionAccess.isCurrentEvidence(evidence),
          })
          await reservation.prepare()
          return reservation
        },
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
      if (kind === 'dom') {
        const plan = buildDomPermissionAuthorizationPlanV3({
          planId: 'web-review',
          profileId: f.profileId,
          identity: { pluginId: webIdentity.id, source: webIdentity.source },
          binding: { operationId: 'web-review', runtimeGeneration: f.generation, moduleGeneration: webGeneration },
          declaration: { name: 'ui.extension-points.render', required: false, scope: { extensionPoints: [pointId] } },
          policies: [],
        })
        const choice = new PermissionAuthorizationViewModel(plan)
        choice.select('ui.extension-points.render', 'allow-persistent')
        const selected = choice.confirm()
        if (selected.status !== 'confirmed' || selected.decision.schemaVersion !== 3) throw new Error('fixture failed')
        expect(signer.noteConfirmed(
          {
            identity: webIdentity,
            pointId,
            profileId: f.profileId,
            runtimeGeneration: f.generation,
            moduleGeneration: webGeneration,
            artifact,
          },
          plan,
          selected.decision,
        )).toBe(true)
      }
      const unknown = vi.fn()
      globalThis.__cordisxPermissionPolicyRequestV1 = payload => {
        const requestId = (JSON.parse(payload) as { requestId: string }).requestId
        void f.sessions.call(f.invocation, 'fixture-write', payload).then(result => {
          const response = result.status === 'ok' ? result.value : { requestId, ok: false }
          globalThis.__cordisxPermissionPolicyReceiveV1?.(JSON.stringify(response))
        })
      }
      store = BindingPermissionPolicyStore.connect(STANDALONE_PERMISSION_BINDING_MARKER, [], {
        onUnknown: unknown,
        sign: signer.sign,
      })
      const manifest = normalizePluginManifest(
        kind === 'runtime' ? plugin.manifest : {
          $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
          schemaVersion: 4,
          id: ownerIdentity.id,
          capabilities: [],
          services: [],
        },
        ownerIdentity.id,
      )
      webBroker = new PermissionBroker(
        store,
        { request: async () => 'deny' },
        () => new Date(),
        30_000,
        f.profileId,
        f.generation,
      )
      webBroker.register(webIdentity, manifest, { pluginId: webIdentity.id, moduleGeneration: webGeneration })
      nativeBroker = new PermissionBroker(
        new MemoryPermissionPolicyStore(),
        { request: async () => 'deny' },
        () => new Date(),
        30_000,
        f.profileId,
        f.generation,
      )
      nativeBroker.register(ownerIdentity, manifest, { pluginId: ownerIdentity.id, moduleGeneration: nativeGeneration })
      if (kind === 'runtime') {
        const decision = webBroker.reviewPolicyV2(webIdentity, 'channel.events.receive', 'allow-persistent')
        expect(signer.noteRuntimePolicy(
          {
            identity: webIdentity,
            profileId: f.profileId,
            runtimeGeneration: f.generation,
            moduleGeneration: webGeneration,
            artifact,
          },
          decision.record,
          decision.observed,
        )).toBeTypeOf('function')
      }
      const saving = kind === 'dom'
        ? webBroker.setDomPolicy(webIdentity, pointId, 'allow-persistent')
        : webBroker.setPolicyV2(webIdentity, 'channel.events.receive', 'allow-persistent')
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
            identity: ownerIdentity,
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
      expect(transition).toMatchObject({ origin: false, identity: ownerIdentity, moduleGeneration: nativeGeneration })
      expect(
        await (kind === 'dom'
          ? nativeBroker.adoptOwnerManagerPolicies(transition!)
          : nativeBroker.adoptOwnerRuntimePolicies(transition!)),
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
          ? webBroker.adoptStandaloneDomPolicies({ ...webCommand.payload, onUnknown: unknown })
          : webBroker.adoptOwnerRuntimePolicies({ ...webCommand.payload, onUnknown: unknown })),
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
        expect(webBroker.domPolicy(webIdentity, pointId)).toBe('allow')
        expect(nativeBroker.domPolicy(ownerIdentity, pointId)).toBe('allow')
      } else {
        expect(webBroker.policyV2(webIdentity, 'channel.events.receive')).toBe('allow-persistent')
        expect(nativeBroker.policyV2(ownerIdentity, 'channel.events.receive')).toBe('allow-persistent')
      }
      const persisted = await loadPolicies()
      expect(persisted).toHaveLength(1)
      expect(await journal.recent(persisted)).toMatchObject([{
        entry: { client: 'web', changes: [{ policy: 'allow-persistent' }] },
        committedAt: expect.any(String),
      }])
      expect(unknown).not.toHaveBeenCalled()
      consumers.close()
    } finally {
      delete globalThis.__cordisxPermissionPolicyRequestV1
      store?.dispose()
      nativeBroker?.dispose()
      webBroker?.dispose()
      signer.close()
      native?.close()
      proof.close()
      await f.close()
    }
  },
)
