import { webcrypto } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ManagerPermissionProofAuthority } from '../packages/cli/src/cli/manager-permission-proof-authority.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { withDeclaredRuntimeAskPolicies } from '../packages/cli/src/cli/permission-decision-history.js'
import { createServiceRendererPermissionOnce } from '../packages/cli/src/cli/service-renderer-permission-once.js'
import type { ManagerRendererChannel } from '../packages/cli/src/cli/manager-renderer-sessions.js'
import { loadHomeConfig } from '../packages/cli/src/config/home-config.js'
import { createStandalonePermissionSigner } from '../packages/cli/src/independent-manager/standalone-permission-signer.js'
import { PermissionAuthorizationViewModel } from '../packages/cli/src/permission-authorization-view-model.js'
import { BrowserPermissionOnceBinding } from '../packages/cli/src/renderer/permission-once-binding.js'
import {
  MemoryPermissionPolicyStore,
  normalizePluginManifest,
  PermissionBroker,
} from '../packages/cli/src/renderer/platform.js'
import { standalonePermissionPrompt } from '../packages/cli/src/renderer/standalone-runtime-prompt.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../packages/cli/src/standalone-permission-contract.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'
import { bootConfiguredChannelManager } from './helpers/configured-channel-manager.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it.skipIf(!archive || process.platform !== 'darwin' && process.platform !== 'linux')(
  'confirms each Web runtime decision against the service and records its origin',
  async () => {
    let f!: Awaited<ReturnType<typeof fixture>>
    let channel!: ManagerRendererChannel
    const proof = new ManagerPermissionProofAuthority({
      profileId: 'default',
      generation: 'fixture-owner',
      isCurrent: context => f.participants.peer(context.rendererId) !== undefined,
    })
    f = await fixture({
      channelArchive: archive,
      protectProfileInputs: true,
      permissionProof: proof,
      channelPermissionPolicy: true,
      writeDispatch: async (context, payload) => await channel.prepare(payload, context).dispatch(),
    })
    const signer = await createStandalonePermissionSigner({
      rendererId: f.handle.rendererId,
      profileId: f.profileId,
      generation: f.generation,
    }, { crypto: webcrypto as unknown as Crypto })
    let once: BrowserPermissionOnceBinding | undefined
    let broker: PermissionBroker | undefined
    try {
      const alias = await bootConfiguredChannelManager(f, f.invocation, undefined, undefined, signer.publicKey)
      const prepared = await f.sessions.call(f.invocation, 'manager-bootstrap', { action: 'prepare' }) as any
      const moduleGeneration = prepared.value.privateGraphs[0].moduleGeneration as string
      const plugin = f.configuredChannel!.plugin
      const artifact = plugin.distributionArtifact!
      const identity = { id: 'channel', source: alias }
      const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
      channel = createServiceRendererPermissionOnce({ profileId: f.profileId, bootstrap: f.bootstrap, proof, journal })
      let sent = ''
      globalThis.__cordisxPermissionOnceRequestV1 = payload => {
        sent = payload
        const requestId = (JSON.parse(payload) as { requestId: string }).requestId
        void f.sessions.call(f.invocation, 'fixture-write', payload).then(result => {
          globalThis.__cordisxPermissionOnceReceiveV1?.(JSON.stringify(
            result.status === 'ok' ? result.value : { requestId, ok: false },
          ))
        })
      }
      once = BrowserPermissionOnceBinding.connect(STANDALONE_PERMISSION_BINDING_MARKER)
      expect(once).toBeDefined()
      const ordinary = {
        request: vi.fn(async plan => {
          const view = new PermissionAuthorizationViewModel(plan)
          view.select('channel.events.receive', 'allow-once')
          const selected = view.confirm()
          return selected.status === 'confirmed' && selected.decision.schemaVersion === 2
            ? selected.decision
            : undefined
        }),
      }
      const review = { isReviewing: () => false, dispose() {}, cancelV3() {}, isDomLeaseVisible: () => true }
      const prompt = standalonePermissionPrompt(ordinary, review as never)
      expect(
        prompt.bindRuntimeDecision(async (plan, decision, currentArtifact) =>
          await once!.authorizeWebRuntime(signer, currentArtifact, plan, decision)
        ),
      ).toBe(true)
      broker = new PermissionBroker(
        new MemoryPermissionPolicyStore(),
        { request: async () => 'deny' },
        () => new Date(),
        30_000,
        f.profileId,
        f.generation,
        undefined,
        undefined,
        prompt,
      )
      broker.register(
        identity,
        normalizePluginManifest(plugin.manifest, identity.id),
        {
          pluginId: identity.id,
          moduleGeneration,
        },
        undefined,
        artifact,
      )
      const requested = { channelTenant: { adapterId: 'simulator', accountId: 'local', tenantId: 'test' } }
      expect(await broker.authorizeChannel(identity, 'channel.events.receive', requested)).toBe(true)
      expect(ordinary.request).toHaveBeenCalledTimes(1)
      const firstPayload = sent
      expect(await broker.authorizeChannel(identity, 'channel.events.receive', requested)).toBe(true)
      expect(ordinary.request).toHaveBeenCalledTimes(2)
      expect((await loadHomeConfig(f.configPath)).permissions).toEqual([])
      const records = withDeclaredRuntimeAskPolicies(
        [],
        f.profileId,
        { id: 'channel', source: plugin.source! },
        plugin.manifest,
      )
      expect(await journal.recent(records)).toMatchObject([
        { entry: { client: 'web', changes: [{ capability: 'channel.events.receive', policy: 'allow-once' }] } },
        { entry: { client: 'web', changes: [{ capability: 'channel.events.receive', policy: 'allow-once' }] } },
      ])
      expect(await f.sessions.call(f.invocation, 'fixture-write', firstPayload)).toMatchObject({ status: 'unknown' })
    } finally {
      broker?.dispose()
      once?.dispose()
      delete globalThis.__cordisxPermissionOnceRequestV1
      delete globalThis.__cordisxPermissionOnceReceiveV1
      signer.close()
      proof.close()
      await f.close()
    }
  },
  60_000,
)
